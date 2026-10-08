// CFO-05 · repositorio en memoria del CFO: la MISMA semántica que el adaptador Postgres (alcance, rangos, errores, base sin migrar,
// versionado de costos, importación SR idempotente por huella) para pruebas de servicio y de API. Sirve las filas del generador sintético de CFO-04
// (o las que la prueba siembre). No hay base: nada de esto es dato real.
//
// Qué replica de la SQL:
//  - rango 1..400 días y lista de sucursales 1..500 (22023); sucursal fuera de la organización o del alcance del actor (42501, el MISMO error
//    para una ajena que para una inexistente);
//  - `propertyIds: null` = todas las permitidas; las filas «No asignado» (`propertyId: null`) solo salen con `null` (o con una lista que cubre
//    TODAS las sucursales de la organización) y con alcance de organización completa;
//  - escrituras: validaciones de cfo_config_guardar / cfo_costo_guardar / sr_importar, alcance de organización completa donde la SQL lo exige,
//    y una bitácora (`auditoria`) con la misma `action` que escribe la SQL;
//  - base sin migrar por bloque: `migraciones: { m081, m082, m083 }` (lecturas -> `disponible: false`, escrituras -> `CfoNoDisponibleError`).
import {
  CfoNoDisponibleError,
  CfoParametroInvalidoError,
  CfoSinAccesoError,
  type CfoRepository,
  type CoberturaSr,
  type CostoCapturadoDetalle,
  type CostoHistorialItem,
  type ErrorImportacionSr,
  type FiltroPedidosDetalle,
  type GuardarCostoEntrada,
  type ImportarSrEntrada,
  type LecturaCanasta,
  type LecturaCfo,
  type LecturaConfig,
  type LecturaPedidosDetalle,
  type LoteSr,
  type ParamsCfo,
  type RangoCfo,
  type RegistrarExportacionEntrada,
  type ResultadoImportacionSr,
  type UmbralesClientes,
} from "./repositorio.ts";
import {
  CFO_CONFIG_POR_DEFECTO,
  type CfoConfig,
  type ConceptoCosto,
  type FilaAgenteDiario,
  type FilaAgotado,
  type FilaCanastaPar,
  type FilaCanastaTicket,
  type FilaCanastaTotales,
  type FilaClientesAltas,
  type FilaClientesCohorte,
  type FilaClientesResumen,
  type FilaClientesSegmentoHora,
  type FilaCobertura,
  type FilaColonia,
  type FilaComandasPos,
  type FilaCortesias,
  type FilaEntregaPercentiles,
  type FilaEntregas,
  type FilaEscalacionHora,
  type FilaPedidoDetalle,
  type FilaProducto,
  type FilaRepartidor,
  type FilaSrResumen,
  type FilaVentasDiarias,
  type FilaVentasHora,
  type TipoServicioSr,
} from "./tipos.ts";
import { diasEntre } from "./util.ts";

export interface DatasetCfoMemoria {
  readonly ventasDiarias: readonly FilaVentasDiarias[];
  readonly cortesias: readonly FilaCortesias[];
  readonly ventasHora: readonly FilaVentasHora[];
  readonly productos: readonly FilaProducto[];
  readonly canastaPares: readonly FilaCanastaPar[];
  readonly canastaTotales: readonly FilaCanastaTotales[];
  readonly canastaTickets: readonly FilaCanastaTicket[];
  readonly pedidosDetalle: readonly (FilaPedidoDetalle & { readonly esVenta?: boolean; readonly horaLocal: number })[];
  readonly cobertura: readonly FilaCobertura[];
  readonly clientesResumen: readonly FilaClientesResumen[];
  readonly clientesCohortes: readonly FilaClientesCohorte[];
  readonly clientesAltas: readonly FilaClientesAltas[];
  readonly clientesSegmentoHora: readonly FilaClientesSegmentoHora[];
  readonly agenteDiario: readonly FilaAgenteDiario[];
  readonly escalacionesHora: readonly FilaEscalacionHora[];
  readonly entregas: readonly FilaEntregas[];
  readonly entregasPercentiles: readonly FilaEntregaPercentiles[];
  readonly repartidores: readonly FilaRepartidor[];
  readonly colonias: readonly FilaColonia[];
  readonly comandasPos: readonly FilaComandasPos[];
  readonly agotados: readonly FilaAgotado[];
  readonly srResumen: readonly FilaSrResumen[];
}

const DATASET_VACIO: DatasetCfoMemoria = {
  ventasDiarias: [], cortesias: [], ventasHora: [], productos: [], canastaPares: [], canastaTotales: [], canastaTickets: [], pedidosDetalle: [], cobertura: [],
  clientesResumen: [], clientesCohortes: [], clientesAltas: [], clientesSegmentoHora: [], agenteDiario: [], escalacionesHora: [], entregas: [], entregasPercentiles: [],
  repartidores: [], colonias: [], comandasPos: [], agotados: [], srResumen: [],
};

export interface OpcionesCfoMemoria {
  readonly dataset?: Partial<DatasetCfoMemoria>;
  /** Todas las sucursales de la organización (las que existen). */
  readonly sucursales: readonly string[];
  /** Sucursales a las que el actor tiene alcance. Por omisión, todas. Un admin acotado pasa su lista. */
  readonly permitidas?: readonly string[];
  /** true (por omisión) = owner/admin sin `property_ids` acotado: ve «No asignado» y puede escribir costos/config de la organización. */
  readonly organizacionCompleta?: boolean;
  /** Migración aplicada por bloque; por omisión las tres. */
  readonly migraciones?: { readonly m081?: boolean; readonly m082?: boolean; readonly m083?: boolean };
  readonly config?: CfoConfig;
  /** Reloj inyectable para `created_at` de costos y lotes. */
  readonly ahora?: () => Date;
}

export interface AuditoriaCfo {
  readonly action: "cfo.config_actualizada" | "cfo.costo_capturado" | "cfo.sr_importado" | "cfo.exportacion";
  readonly detalle: Readonly<Record<string, unknown>>;
}

const RANGOS_CONFIG: Readonly<Record<string, readonly [number, number]>> = {
  frecuente_n: [1, 20], frecuente_dias: [30, 365], activo_dias: [7, 365], perdido_dias: [14, 730], promesa_min: [10, 180], iva_pct: [0, 30], caida_pct: [1, 100],
  ticket_baja_pct: [1, 100], cancelacion_x_mediana: [1, 20], descuento_max_pct: [0, 100], costo_agente_alza_pct: [1, 1000], cierre_baja_pp: [1, 100],
  entrega_p90_max_min: [5, 600], sr_cuadre_verde_pct: [0, 50], sr_cuadre_ambar_pct: [0, 100], sr_cuadre_verde_centavos: [0, 100_000_000],
};
const ENTEROS_CONFIG = new Set(["frecuente_n", "frecuente_dias", "activo_dias", "perdido_dias", "promesa_min", "entrega_p90_max_min", "sr_cuadre_verde_centavos"]);
const CAMEL: Readonly<Record<string, keyof CfoConfig>> = {
  frecuente_n: "frecuenteN", frecuente_dias: "frecuenteDias", activo_dias: "activoDias", perdido_dias: "perdidoDias", promesa_min: "promesaMin", iva_pct: "ivaPct",
  caida_pct: "caidaPct", ticket_baja_pct: "ticketBajaPct", cancelacion_x_mediana: "cancelacionXMediana", descuento_max_pct: "descuentoMaxPct",
  costo_agente_alza_pct: "costoAgenteAlzaPct", cierre_baja_pp: "cierreBajaPp", entrega_p90_max_min: "entregaP90MaxMin", sr_cuadre_verde_pct: "srCuadreVerdePct",
  sr_cuadre_ambar_pct: "srCuadreAmbarPct", sr_cuadre_verde_centavos: "srCuadreVerdeCentavos", comision_terminal_pct: "comisionTerminalPct",
};
const CONCEPTOS: readonly ConceptoCosto[] = ["insumos", "food_cost_objetivo_pct", "nomina", "renta", "servicios", "comision_terminal", "marketing", "mantenimiento", "otros"];
const LLAVES_RESUMEN = ["dia_negocio", "tipo_servicio", "forma_pago", "tickets", "bruta_centavos", "descuento_centavos", "cancelado_centavos", "propina_centavos", "iva_centavos", "neta_centavos"];
const LLAVES_CUENTAS = ["folio", "dia_negocio", "hora_local", "tipo_servicio", "total_centavos", "descuento_centavos", "propina_centavos", "forma_pago", "cancelado"];
const SERVICIOS: readonly TipoServicioSr[] = ["comedor", "para_llevar", "domicilio", "rapido", "otro"];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

interface CostoVersion extends CostoCapturadoDetalle {
  readonly vigente: boolean;
  readonly creadoPor: string | null;
  readonly seq: number;
  readonly org: string;
}

export class InMemoryCfoRepository implements CfoRepository {
  readonly auditoria: AuditoriaCfo[] = [];
  /** Cuántas llamadas recibió cada función (para probar «una sola consulta» o «no se llamó»). */
  readonly llamadas = new Map<string, number>();
  private readonly dataset: DatasetCfoMemoria;
  private readonly sucursalesOrg: ReadonlySet<string>;
  private readonly permitidas: ReadonlySet<string>;
  private readonly orgCompleta: boolean;
  private readonly mig: { m081: boolean; m082: boolean; m083: boolean };
  private config: CfoConfig;
  private configurada = false;
  private readonly costos: CostoVersion[] = [];
  private readonly lotes: LoteSr[] = [];
  private readonly huellas = new Map<string, ResultadoImportacionSr & { propertyId: string }>();
  private srFilas: FilaSrResumen[];
  private seq = 0;
  private readonly ahora: () => Date;

  constructor(opciones: OpcionesCfoMemoria) {
    this.dataset = { ...DATASET_VACIO, ...opciones.dataset };
    this.sucursalesOrg = new Set(opciones.sucursales);
    this.permitidas = new Set(opciones.permitidas ?? opciones.sucursales);
    this.orgCompleta = opciones.organizacionCompleta ?? true;
    this.mig = { m081: opciones.migraciones?.m081 ?? true, m082: opciones.migraciones?.m082 ?? true, m083: opciones.migraciones?.m083 ?? true };
    this.config = opciones.config ?? CFO_CONFIG_POR_DEFECTO;
    this.srFilas = [...this.dataset.srResumen];
    this.ahora = opciones.ahora ?? (() => new Date());
  }

  // ---- alcance y validaciones (espejo de cfo_resolver_sucursales / cfo_validar_rango) ----

  private contar(nombre: string): void {
    this.llamadas.set(nombre, (this.llamadas.get(nombre) ?? 0) + 1);
  }

  private validarRango(r: RangoCfo): void {
    if (!FECHA.test(r.desde) || !FECHA.test(r.hasta) || r.desde > r.hasta) throw new CfoParametroInvalidoError("cfo: rango de fechas invalido");
    if (diasEntre(r.desde, r.hasta) > 400) throw new CfoParametroInvalidoError("cfo: el rango maximo es de 400 dias");
  }

  /** Sucursales efectivas e indicador de «No asignado». */
  private alcance(p: ParamsCfo): { props: ReadonlySet<string>; sinSucursal: boolean } {
    if (p.propertyIds === null) {
      const props = new Set([...this.sucursalesOrg].filter((s) => this.permitidas.has(s)));
      if (props.size === 0) throw new CfoSinAccesoError();
      return { props, sinSucursal: this.orgCompleta };
    }
    if (p.propertyIds.length === 0 || p.propertyIds.length > 500) throw new CfoParametroInvalidoError("cfo: lista de sucursales invalida");
    const props = new Set(p.propertyIds);
    for (const id of props) if (!this.sucursalesOrg.has(id) || !this.permitidas.has(id)) throw new CfoSinAccesoError();
    const cubreTodas = [...this.sucursalesOrg].every((s) => props.has(s));
    return { props, sinSucursal: this.orgCompleta && cubreTodas };
  }

  private filtrar<T extends { readonly propertyId: string | null }>(filas: readonly T[], p: ParamsCfo, dia?: (f: T) => string | undefined, r?: RangoCfo): T[] {
    const { props, sinSucursal } = this.alcance(p);
    return filas.filter((f) => {
      if (f.propertyId === null ? !sinSucursal : !props.has(f.propertyId)) return false;
      if (r && dia) {
        const d = dia(f);
        if (d !== undefined && (d < r.desde || d > r.hasta)) return false;
      }
      return true;
    });
  }

  private lectura<T>(nombre: string, ok: boolean, hacer: () => T[]): LecturaCfo<T> {
    this.contar(nombre);
    if (!ok) return { disponible: false, filas: [] };
    return { disponible: true, filas: hacer() };
  }

  private exigirOrgCompleta(): void {
    if (!this.orgCompleta) throw new CfoSinAccesoError();
  }

  private exigirEscritura(ok: boolean): void {
    if (!ok) throw new CfoNoDisponibleError();
  }

  // ---- 081 ----

  async ventasDiarias(p: ParamsCfo, r: RangoCfo, _promesaMin: number): Promise<LecturaCfo<FilaVentasDiarias>> {
    this.validarRango(r);
    return this.lectura("ventasDiarias", this.mig.m081, () => this.filtrar(this.dataset.ventasDiarias, p, (f) => f.diaNegocio, r));
  }
  async cortesias(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaCortesias>> {
    this.validarRango(r);
    return this.lectura("cortesias", this.mig.m081, () => this.filtrar(this.dataset.cortesias, p, (f) => f.diaNegocio, r));
  }
  async ventasHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaVentasHora>> {
    this.validarRango(r);
    return this.lectura("ventasHora", this.mig.m081, () => this.filtrar(this.dataset.ventasHora, p));
  }
  async productos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaProducto>> {
    this.validarRango(r);
    return this.lectura("productos", this.mig.m081, () => this.filtrar(this.dataset.productos, p, (f) => f.diaNegocio, r));
  }
  async canastaPares(p: ParamsCfo, r: RangoCfo, limite: number): Promise<LecturaCanasta> {
    this.validarRango(r);
    if (!(limite >= 1)) throw new CfoParametroInvalidoError("cfo_canasta_pares: limite invalido");
    this.contar("canastaPares");
    if (!this.mig.m081) return { disponible: false, pares: [], totales: [], tickets: [] };
    const pares = this.filtrar(this.dataset.canastaPares, p).slice(0, Math.min(limite, 500));
    return { disponible: true, pares, totales: this.filtrar(this.dataset.canastaTotales, p), tickets: this.filtrar(this.dataset.canastaTickets, p) };
  }

  async pedidosDetalle(p: ParamsCfo, r: RangoCfo, filtro: FiltroPedidosDetalle, limite: number, cursor: string | null, _promesaMin: number): Promise<LecturaPedidosDetalle> {
    this.validarRango(r);
    this.contar("pedidosDetalle");
    if (!(limite >= 1)) throw new CfoParametroInvalidoError("cfo_pedidos_detalle: limite invalido");
    const permitidas = new Set(["canal", "source", "status", "payment_method", "producto_ref", "es_venta", "es_compensacion", "con_descuento", "entrega_tarde", "hora_local", "dow_negocio"]);
    for (const k of Object.keys(filtro)) if (!permitidas.has(k)) throw new CfoParametroInvalidoError(`cfo_pedidos_detalle: filtro ${k} no permitido`);
    if (cursor !== null && !/^\d{4}-\d{2}-\d{2}\|\d{1,18}$/.test(cursor)) throw new CfoParametroInvalidoError("cfo_pedidos_detalle: cursor invalido");
    if (!this.mig.m081) return { disponible: false, filas: [], cursorSiguiente: null };
    let filas = this.filtrar(this.dataset.pedidosDetalle, p, (f) => f.diaNegocio, r);
    const f = filtro;
    filas = filas.filter(
      (x) =>
        (f.canal === undefined || x.canal === f.canal) &&
        (f.source === undefined || x.source === f.source) &&
        (f.status === undefined || x.status === f.status) &&
        (f.payment_method === undefined || x.paymentMethod === f.payment_method) &&
        (f.es_venta === undefined || (x.esVenta ?? true) === f.es_venta) &&
        (f.es_compensacion === undefined || x.esCompensacion === f.es_compensacion) &&
        (f.con_descuento === undefined || x.descCentavos > 0 === f.con_descuento) &&
        (f.hora_local === undefined || x.horaLocal === f.hora_local),
    );
    filas = [...filas].sort((a, b) => (a.diaNegocio < b.diaNegocio ? 1 : a.diaNegocio > b.diaNegocio ? -1 : Number(b.orderNumber) - Number(a.orderNumber)));
    if (cursor !== null) {
      const [d, n] = cursor.split("|") as [string, string];
      filas = filas.filter((x) => x.diaNegocio < d || (x.diaNegocio === d && Number(x.orderNumber) < Number(n)));
    }
    const tope = Math.min(limite, 200);
    const pagina = filas.slice(0, tope);
    const ultima = pagina[pagina.length - 1];
    return {
      disponible: true,
      filas: pagina,
      cursorSiguiente: filas.length > tope && ultima ? `${ultima.diaNegocio}|${ultima.orderNumber}` : null,
    };
  }

  async cobertura(p: ParamsCfo): Promise<LecturaCfo<FilaCobertura>> {
    return this.lectura("cobertura", this.mig.m081, () => this.filtrar(this.dataset.cobertura, p));
  }

  // ---- 082 ----

  async clientesResumen(p: ParamsCfo, r: RangoCfo, u: UmbralesClientes): Promise<LecturaCfo<FilaClientesResumen>> {
    this.validarRango(r);
    if (u.activoDias < 7 || u.activoDias > 365 || u.perdidoDias < 14 || u.perdidoDias > 730 || u.frecuenteDias < 30 || u.frecuenteDias > 365 || u.frecuenteN < 1)
      throw new CfoParametroInvalidoError("cfo_clientes_resumen: umbral fuera de rango");
    return this.lectura("clientesResumen", this.mig.m082, () => this.filtrar(this.dataset.clientesResumen, p));
  }
  async clientesCohortes(p: ParamsCfo, meses: number): Promise<LecturaCfo<FilaClientesCohorte>> {
    if (!(meses >= 1 && meses <= 24)) throw new CfoParametroInvalidoError("cfo_clientes_cohortes: p_meses de 1 a 24");
    return this.lectura("clientesCohortes", this.mig.m082, () => this.filtrar(this.dataset.clientesCohortes, p));
  }
  async clientesAltas(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaClientesAltas>> {
    this.validarRango(r);
    return this.lectura("clientesAltas", this.mig.m082, () => this.filtrar(this.dataset.clientesAltas, p, (f) => f.semana, { desde: r.desde, hasta: r.hasta }));
  }
  async clientesSegmentoHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaClientesSegmentoHora>> {
    this.validarRango(r);
    return this.lectura("clientesSegmentoHora", this.mig.m082, () => this.filtrar(this.dataset.clientesSegmentoHora, p));
  }
  async agenteDiario(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaAgenteDiario>> {
    this.validarRango(r);
    return this.lectura("agenteDiario", this.mig.m082, () => this.filtrar(this.dataset.agenteDiario, p, (f) => f.diaNegocio, r));
  }
  async escalacionesHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEscalacionHora>> {
    this.validarRango(r);
    return this.lectura("escalacionesHora", this.mig.m082, () => this.filtrar(this.dataset.escalacionesHora, p));
  }
  async entregas(p: ParamsCfo, r: RangoCfo, _promesaMin: number): Promise<LecturaCfo<FilaEntregas>> {
    this.validarRango(r);
    return this.lectura("entregas", this.mig.m082, () => this.filtrar(this.dataset.entregas, p));
  }
  async entregasPercentiles(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEntregaPercentiles>> {
    this.validarRango(r);
    return this.lectura("entregasPercentiles", this.mig.m082, () => {
      // El renglón del conjunto (propertyId null) solo sale cuando el alcance incluye la organización completa.
      const { props } = this.alcance(p);
      return this.dataset.entregasPercentiles.filter((f) => (f.propertyId === null ? true : props.has(f.propertyId)));
    });
  }
  async repartidores(p: ParamsCfo, r: RangoCfo, _promesaMin: number): Promise<LecturaCfo<FilaRepartidor>> {
    this.validarRango(r);
    return this.lectura("repartidores", this.mig.m082, () => this.filtrar(this.dataset.repartidores, p));
  }
  async colonias(p: ParamsCfo, r: RangoCfo, k: number): Promise<LecturaCfo<FilaColonia>> {
    this.validarRango(r);
    if (!(k >= 5)) throw new CfoParametroInvalidoError("cfo_colonias: k minimo 5");
    return this.lectura("colonias", this.mig.m082, () => this.filtrar(this.dataset.colonias, p));
  }
  async comandasPos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaComandasPos>> {
    this.validarRango(r);
    return this.lectura("comandasPos", this.mig.m082, () => this.filtrar(this.dataset.comandasPos, p, (f) => f.diaNegocio, r));
  }
  async agotados(p: ParamsCfo): Promise<LecturaCfo<FilaAgotado>> {
    return this.lectura("agotados", this.mig.m082, () => this.filtrar(this.dataset.agotados, p));
  }

  // ---- 083 ----

  async configLeer(_organizationId: string): Promise<LecturaConfig> {
    this.contar("configLeer");
    if (!this.mig.m083) return { disponible: false, config: CFO_CONFIG_POR_DEFECTO, configurada: false };
    return { disponible: true, config: this.config, configurada: this.configurada };
  }

  async configGuardar(_organizationId: string, cambios: Readonly<Record<string, number | null>>): Promise<void> {
    this.contar("configGuardar");
    this.exigirEscritura(this.mig.m083);
    this.exigirOrgCompleta();
    const nueva: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(cambios)) {
      if (k === "comision_terminal_pct") {
        if (v !== null && typeof v !== "number") throw new CfoParametroInvalidoError(`cfo_config_guardar: ${k} debe ser numero o null`);
        if (v !== null && (v < 0 || v > 20)) throw new CfoParametroInvalidoError("cfo_config_guardar: comision_terminal_pct fuera de rango (0..20)");
      } else if (Object.hasOwn(RANGOS_CONFIG, k)) {
        if (typeof v !== "number") throw new CfoParametroInvalidoError(`cfo_config_guardar: ${k} debe ser un numero`);
        if (ENTEROS_CONFIG.has(k) && !Number.isInteger(v)) throw new CfoParametroInvalidoError(`cfo_config_guardar: ${k} debe ser un entero`);
        const [min, max] = RANGOS_CONFIG[k]!;
        if (v < min || v > max) throw new CfoParametroInvalidoError(`cfo_config_guardar: ${k} fuera de rango (${min}..${max})`);
      } else {
        throw new CfoParametroInvalidoError("cfo_config_guardar: llave desconocida");
      }
      nueva[k] = v;
    }
    const siguiente: Record<string, unknown> = { ...this.config };
    for (const [k, v] of Object.entries(nueva)) siguiente[CAMEL[k]!] = v;
    const c = siguiente as unknown as CfoConfig;
    if (c.activoDias >= c.perdidoDias) throw new CfoParametroInvalidoError("cfo_config_guardar: activo_dias debe ser menor que perdido_dias");
    if (c.srCuadreVerdePct > c.srCuadreAmbarPct) throw new CfoParametroInvalidoError("cfo_config_guardar: sr_cuadre_verde_pct no puede superar a sr_cuadre_ambar_pct");
    const cambiadas = Object.keys(nueva).filter((k) => (this.config as unknown as Record<string, unknown>)[CAMEL[k]!] !== nueva[k]);
    if (this.configurada && cambiadas.length === 0) return;
    this.config = c;
    this.configurada = true;
    this.auditoria.push({ action: "cfo.config_actualizada", detalle: { cambiadas } });
  }

  async costosLeer(p: ParamsCfo, mesDesde: string, mesHasta: string): Promise<LecturaCfo<CostoCapturadoDetalle>> {
    this.validarRango({ desde: mesDesde, hasta: mesHasta });
    this.contar("costosLeer");
    if (!this.mig.m083) return { disponible: false, filas: [] };
    const { props, sinSucursal } = this.alcance(p);
    const d = `${mesDesde.slice(0, 7)}-01`;
    const h = `${mesHasta.slice(0, 7)}-01`;
    const filas = this.costos
      .filter((c) => c.vigente && c.mes >= d && c.mes <= h && (c.propertyId === null ? sinSucursal : props.has(c.propertyId)))
      .sort((a, b) => (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : (a.propertyId ?? "~") < (b.propertyId ?? "~") ? -1 : (a.propertyId ?? "~") > (b.propertyId ?? "~") ? 1 : a.concepto < b.concepto ? -1 : 1))
      .map(({ vigente: _v, creadoPor: _c, seq: _s, org: _o, ...rest }) => rest);
    return { disponible: true, filas };
  }

  async costoGuardar(e: GuardarCostoEntrada): Promise<string> {
    this.contar("costoGuardar");
    this.exigirEscritura(this.mig.m083);
    if (e.propertyId === null) this.exigirOrgCompleta();
    else if (!this.sucursalesOrg.has(e.propertyId) || !this.permitidas.has(e.propertyId)) throw new CfoSinAccesoError();
    if (!CONCEPTOS.includes(e.concepto)) throw new CfoParametroInvalidoError("cfo_costo_guardar: concepto invalido");
    const hoy = this.ahora();
    const tope = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 24, 1)).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-01$/.test(e.mes) || e.mes < "2020-01-01" || e.mes > tope)
      throw new CfoParametroInvalidoError("cfo_costo_guardar: el mes debe ser el dia 1 y estar entre 2020-01 y 24 meses adelante");
    if ((e.montoCentavos !== null) === (e.pct !== null)) throw new CfoParametroInvalidoError("cfo_costo_guardar: manda exactamente uno de monto o porcentaje");
    if ((e.concepto === "food_cost_objetivo_pct") !== (e.pct !== null))
      throw new CfoParametroInvalidoError("cfo_costo_guardar: el porcentaje solo aplica a food_cost_objetivo_pct (y ese concepto exige porcentaje)");
    if (e.montoCentavos !== null && (!Number.isInteger(e.montoCentavos) || e.montoCentavos < 0 || e.montoCentavos > 10_000_000_000_000))
      throw new CfoParametroInvalidoError("cfo_costo_guardar: monto fuera de rango");
    if (e.pct !== null && (e.pct < 0 || e.pct > 100)) throw new CfoParametroInvalidoError("cfo_costo_guardar: porcentaje fuera de rango (0..100)");
    const nota = e.nota === null ? null : e.nota.trim() === "" ? null : e.nota.trim();
    if (nota !== null && nota.length > 300) throw new CfoParametroInvalidoError("cfo_costo_guardar: la nota excede 300 caracteres");
    const id = `costo-${++this.seq}`;
    for (let i = 0; i < this.costos.length; i++) {
      const c = this.costos[i]!;
      if (c.vigente && c.org === e.organizationId && c.propertyId === e.propertyId && c.mes === e.mes && c.concepto === e.concepto) this.costos[i] = { ...c, vigente: false };
    }
    this.costos.push({
      id, org: e.organizationId, propertyId: e.propertyId, mes: e.mes, concepto: e.concepto, montoCentavos: e.montoCentavos, pct: e.pct, nota,
      creadoEn: hoy.toISOString(), vigente: true, creadoPor: null, seq: this.seq,
    });
    this.auditoria.push({ action: "cfo.costo_capturado", detalle: { concepto: e.concepto, mes: e.mes, propertyId: e.propertyId } });
    return id;
  }

  async costoHistorial(organizationId: string, propertyId: string | null, mes: string, concepto: ConceptoCosto): Promise<LecturaCfo<CostoHistorialItem>> {
    this.contar("costoHistorial");
    if (!this.mig.m083) return { disponible: false, filas: [] };
    if (propertyId === null) this.exigirOrgCompleta();
    else if (!this.sucursalesOrg.has(propertyId) || !this.permitidas.has(propertyId)) throw new CfoSinAccesoError();
    const filas = this.costos
      .filter((c) => c.org === organizationId && c.propertyId === propertyId && c.mes === mes && c.concepto === concepto)
      .sort((a, b) => a.seq - b.seq)
      .map((c, i): CostoHistorialItem => ({ id: c.id, version: i + 1, montoCentavos: c.montoCentavos, pct: c.pct, nota: c.nota, creadoPor: c.creadoPor, creadoEn: c.creadoEn, vigente: c.vigente }));
    return { disponible: true, filas };
  }

  async srResumenLeer(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaSrResumen>> {
    this.validarRango(r);
    return this.lectura("srResumenLeer", this.mig.m083, () => this.filtrar(this.srFilas, p, (f) => f.diaNegocio, r));
  }

  async srLotes(p: ParamsCfo, limite: number): Promise<LecturaCfo<LoteSr>> {
    if (!(limite >= 1 && limite <= 200)) throw new CfoParametroInvalidoError("sr_lotes_listar: limite invalido (1..200)");
    return this.lectura("srLotes", this.mig.m083, () => this.filtrar(this.lotes, p).sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1)).slice(0, limite));
  }

  async srCobertura(p: ParamsCfo): Promise<LecturaCfo<CoberturaSr>> {
    return this.lectura("srCobertura", this.mig.m083, () => {
      const { props } = this.alcance(p);
      return [...props].sort().map((id): CoberturaSr => {
        const dias = [...new Set(this.srFilas.filter((f) => f.propertyId === id).map((f) => f.diaNegocio))].sort();
        return { propertyId: id, diasConDato: dias.length, diaMin: dias[0] ?? null, diaMax: dias[dias.length - 1] ?? null, dias };
      });
    });
  }

  async srImportar(e: ImportarSrEntrada): Promise<ResultadoImportacionSr> {
    this.contar("srImportar");
    this.exigirEscritura(this.mig.m083);
    if (!this.sucursalesOrg.has(e.propertyId) || !this.permitidas.has(e.propertyId)) throw new CfoSinAccesoError();
    if (!/^[0-9a-f]{64}$/.test(e.huella)) throw new CfoParametroInvalidoError("sr_importar: huella invalida (sha-256 hexadecimal en minusculas)");
    if (e.tipo !== "resumen_servicio" && e.tipo !== "cuentas") throw new CfoParametroInvalidoError("sr_importar: tipo invalido");
    if (e.nombreArchivo.length < 1 || e.nombreArchivo.length > 120 || /[/\\]/.test(e.nombreArchivo) || [...e.nombreArchivo].some((ch) => ch.charCodeAt(0) < 32)) throw new CfoParametroInvalidoError("sr_importar: nombre de archivo invalido (1 a 120 caracteres, sin ruta)");
    const max = e.tipo === "cuentas" ? 20_000 : 2_000;
    if (e.renglones.length < 1 || e.renglones.length > max) throw new CfoParametroInvalidoError(`sr_importar: entre 1 y ${max} renglones para ${e.tipo}`);
    const previo = this.huellas.get(e.huella);
    if (previo) {
      if (previo.propertyId !== e.propertyId) throw new CfoParametroInvalidoError("sr_importar: ese archivo ya se importo para otra sucursal");
      return { loteId: previo.loteId, creado: false, aceptados: previo.aceptados, rechazados: previo.rechazados, errores: [] };
    }
    const llaves = e.tipo === "cuentas" ? LLAVES_CUENTAS : LLAVES_RESUMEN;
    const mala = e.renglones.findIndex((x) => Object.keys(x).some((k) => !llaves.includes(k)));
    if (mala >= 0) throw new CfoParametroInvalidoError(`sr_importar: el renglon ${mala + 1} trae llaves no permitidas (no se aceptan datos de cliente)`);

    const errores: ErrorImportacionSr[] = [];
    const buenos: Array<Record<string, unknown>> = [];
    const entero = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
    e.renglones.forEach((x, i) => {
      const dia = x["dia_negocio"];
      const serv = typeof x["tipo_servicio"] === "string" ? (x["tipo_servicio"] as string).trim().toLowerCase() : "";
      if (typeof dia !== "string" || !FECHA.test(dia)) return void errores.push({ renglon: i + 1, campo: "dia_negocio", motivo: "fecha invalida (AAAA-MM-DD)" });
      if (!SERVICIOS.includes(serv as TipoServicioSr)) return void errores.push({ renglon: i + 1, campo: "tipo_servicio", motivo: "tipo de servicio desconocido" });
      if (e.tipo === "resumen_servicio") {
        for (const campo of ["tickets", "bruta_centavos", "neta_centavos"]) if (entero(x[campo]) === null) return void errores.push({ renglon: i + 1, campo, motivo: "entero >= 0 requerido" });
      } else if (entero(x["total_centavos"]) === null) {
        return void errores.push({ renglon: i + 1, campo: "total_centavos", motivo: "entero >= 0 requerido (centavos)" });
      }
      buenos.push({ ...x, tipo_servicio: serv });
    });
    const aceptados = buenos.length;
    const rechazados = e.renglones.length - aceptados;
    if (aceptados === 0) return { loteId: null, creado: false, aceptados: 0, rechazados, errores: errores.slice(0, 50) };

    const dias = new Set(buenos.map((x) => x["dia_negocio"] as string));
    this.srFilas = this.srFilas.filter((f) => !(f.propertyId === e.propertyId && dias.has(f.diaNegocio)));
    const acum = new Map<string, FilaSrResumen>();
    for (const x of buenos) {
      const dia = x["dia_negocio"] as string;
      const serv = x["tipo_servicio"] as TipoServicioSr;
      const k = `${dia}|${serv}`;
      const a = acum.get(k) ?? { propertyId: e.propertyId, diaNegocio: dia, tipoServicio: serv, formaPago: null, tickets: 0, brutaCentavos: 0, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: 0 };
      if (e.tipo === "resumen_servicio") {
        acum.set(k, {
          ...a, tickets: a.tickets + (x["tickets"] as number), brutaCentavos: a.brutaCentavos + (x["bruta_centavos"] as number),
          descuentoCentavos: a.descuentoCentavos + ((x["descuento_centavos"] as number | undefined) ?? 0), canceladoCentavos: a.canceladoCentavos + ((x["cancelado_centavos"] as number | undefined) ?? 0),
          propinaCentavos: a.propinaCentavos + ((x["propina_centavos"] as number | undefined) ?? 0), netaCentavos: a.netaCentavos + (x["neta_centavos"] as number),
        });
      } else {
        const total = x["total_centavos"] as number;
        const desc = (x["descuento_centavos"] as number | undefined) ?? 0;
        if (x["cancelado"] === true) acum.set(k, { ...a, canceladoCentavos: a.canceladoCentavos + total });
        else acum.set(k, { ...a, tickets: a.tickets + 1, brutaCentavos: a.brutaCentavos + total + desc, descuentoCentavos: a.descuentoCentavos + desc, propinaCentavos: a.propinaCentavos + ((x["propina_centavos"] as number | undefined) ?? 0), netaCentavos: a.netaCentavos + total });
      }
    }
    this.srFilas.push(...acum.values());
    const id = `lote-${++this.seq}`;
    const ordenados = [...dias].sort();
    this.lotes.push({
      id, propertyId: e.propertyId, tipo: e.tipo, nombreArchivo: e.nombreArchivo, fechaMin: ordenados[0] ?? null, fechaMax: ordenados[ordenados.length - 1] ?? null,
      renglones: e.renglones.length, aceptados, rechazados, estado: "aplicado", origen: "archivo", creadoEn: this.ahora().toISOString(),
    });
    const res: ResultadoImportacionSr = { loteId: id, creado: true, aceptados, rechazados, errores: errores.slice(0, 50) };
    this.huellas.set(e.huella, { ...res, propertyId: e.propertyId });
    this.auditoria.push({ action: "cfo.sr_importado", detalle: { renglones: e.renglones.length, aceptados, rechazados, dias: dias.size } });
    return res;
  }

  async registrarExportacion(e: RegistrarExportacionEntrada): Promise<string> {
    this.contar("registrarExportacion");
    this.exigirEscritura(this.mig.m083);
    this.alcance({ organizationId: e.organizationId, propertyIds: e.propertyIds });
    this.validarRango({ desde: e.desde, hasta: e.hasta });
    if (!["resumen", "ventas", "sucursales", "estado_resultados", "clientes", "platillos", "patrones", "operacion", "softrestaurant"].includes(e.vista))
      throw new CfoParametroInvalidoError("cfo_registrar_exportacion: vista no permitida");
    if (e.formato !== "xlsx" && e.formato !== "pdf") throw new CfoParametroInvalidoError("cfo_registrar_exportacion: formato invalido (xlsx o pdf)");
    this.auditoria.push({ action: "cfo.exportacion", detalle: { vista: e.vista, formato: e.formato, desde: e.desde, hasta: e.hasta, todas: e.propertyIds === null } });
    return `export-${++this.seq}`;
  }
}
