// CFO-05 · servicio del CFO: arma cada vista de `/admin/cfo/*` a partir del repositorio (SQL 081/082/083) y de las fórmulas del dominio (CFO-04).
//
// Principios (diseño §3):
//  - Las llamadas al repositorio son SECUENCIALES (una sesión) y se memoizan por rango: una vista no repite una consulta.
//  - Consolidado = Σ sucursales + «No asignado» (solo organización completa). Los clientes únicos no se suman (conjunto aparte).
//  - Sin dato = `null` (nunca 0): bloque sin migrar -> `bloques.X = false`, cifras en «sin dato» y un aviso honesto.
//  - Ventas del agente ≠ ventas del negocio: con SoftRestaurant importado el titular es el total de SR; nunca se suman ambos.
//  - Sin PII, sin reloj propio (`ahora` se inyecta) y sin `toLocale*`.
import { consolidar, consolidarClientes } from "./consolidar.ts";
import { construirEstadoResultados, type EstadoResultados, type Granularidad } from "./estado-resultados.ts";
import {
  SUMAS_VENTAS_VACIAS,
  cancelacionPct,
  churnPct,
  concentracionPct,
  costoAgente,
  costoPorPedidoAgente,
  cortesias,
  cuadreSr,
  descuentoPct,
  descuentoPromocion,
  compensacion,
  efectoPromocion,
  entregaPromedioMin,
  entregaTardePct,
  frecuentesPct,
  ivaEstimado,
  mixCanalPedidos,
  mixCanalVentas,
  minutosACapturaSr,
  aporteALaVariacion,
  sumarAgente,
  sumarComandas,
  sumarCortesias,
  sumarVentas,
  tasaCapturaSr,
  tasaCierreAgente,
  tasaCierreVoz,
  tasaCierreWhatsApp,
  ticketPromedio,
  topParesCanasta,
  valorDeVidaSimple,
  ventaBruta,
  ventaEnRiesgoAgotado,
  ventaNeta,
  ventaNetaSinIva,
  recompraPct,
  pedidos as cifraPedidos,
  type CostoAgente,
  type SumasAgente,
  type SumasVentas,
} from "./formulas.ts";
import { detectarHallazgos, ordenarHallazgos, promediarSumasAgente, promediarSumasVentas, type MetricasSucursalHallazgos } from "./hallazgos.ts";
import { narrarResumen, type KpisResumen, type ValorKpi } from "./narrativa.ts";
import {
  CfoNoDisponibleError,
  CfoParametroInvalidoError,
  CfoSinAccesoError,
  type CfoRepository,
  type CostoCapturadoDetalle,
  type FiltroPedidosDetalle,
  type LecturaCfo,
  type LecturaConfig,
  type ParamsCfo,
  type RangoCfo,
  type UmbralesClientes,
} from "./repositorio.ts";
import { definicionesSegmentos, resumirSegmentos } from "./segmentos.ts";
import {
  type AgotadoApi,
  type AlcanceApi,
  type AlcanceVista,
  type BloquesCfo,
  type CascadaVentas,
  type ClientesColumna,
  type ClientesVista,
  type CohorteApi,
  type ColoniaApi,
  type CompararCfo,
  type ConfigVista,
  type CostoAgenteApi,
  type CostoHistorialVista,
  type CostoVista,
  type CuadreSrVista,
  type EmbudoAgenteApi,
  type EntregasSucursalApi,
  type EstadoResultadosVista,
  type FilaCuadreApi,
  type FilaSucursalApi,
  type KpiTarjeta,
  type LotesSrVista,
  type OperacionVista,
  type ParCanastaApi,
  type PatronesVista,
  type PedidosVista,
  type PeriodoApi,
  type ProductosVista,
  type PuntoMatriz,
  type RankingProductoApi,
  type ResumenColumna,
  type ResumenVista,
  type Semaforo,
  type SucursalApi,
  type SucursalesVista,
  type TitularApi,
  type TipoValorKpi,
  type VentasColumna,
  type VentasVista,
  type VistaCfoBase,
} from "./tipos-api.ts";
import {
  CFO_CONFIG_POR_DEFECTO,
  type AlcanceSucursales,
  type CfoConfig,
  type Cifra,
  type ConceptoCosto,
  type FilaAgenteDiario,
  type FilaAgotado,
  type FilaClientesResumen,
  type FilaCobertura,
  type FilaComandasPos,
  type FilaCortesias,
  type FilaEntregaPercentiles,
  type FilaProducto,
  type FilaSrResumen,
  type FilaVentasDiarias,
  type FuenteDatosCfo,
  type SucursalCfo,
} from "./tipos.ts";
import {
  corteHHMM,
  detectarOutliers,
  enRango,
  etiquetaAlcance,
  indexarPor,
  rangoAnterior,
  rangoComparativo,
  semaforoAlza,
  semaforoCaida,
  semaforoDescuento,
  semaforoEntrega,
  semaforoPuntos,
  serieDeVentas,
  sumarSumasAgente,
  sumarSumasVentas,
  textoComparado,
  variacion,
  variacionPct,
  ventanas4Semanas,
} from "./servicio-util.ts";
import { AVISO_CFO } from "./estado-resultados.ts";
import { cifra, diaSemanaIso, diasEntre, expandirDias, fechaLocal, mesDe, pct1, promedioMin1, divEntera, sinDato, sumarDiasFecha } from "./util.ts";

export interface EntradaServicioCfo {
  readonly repo: CfoRepository;
  readonly organizationId: string;
  /** Sucursales visibles y consultadas (ya resueltas contra la membresía). */
  readonly alcance: AlcanceSucursales;
  /** Lo que se manda a SQL: null = todas las permitidas del actor. */
  readonly propertyIdsSql: readonly string[] | null;
  /** Nombre y slug de las sucursales del alcance. */
  readonly sucursales: readonly SucursalApi[];
  readonly ahora: Date;
  /** Se llama cuando una lectura falla con un error NO recuperable y la vista degrada ese bloque (la ruta lo registra en el log). */
  readonly onError?: (bloque: string, err: unknown) => void;
}

export interface ConsultaCfo {
  readonly desde: string;
  readonly hasta: string;
  readonly comparar: CompararCfo;
  readonly granularidad: Granularidad;
}

export const RANGOS_CONFIG_CFO: Readonly<Record<string, readonly [number, number]>> = {
  frecuenteN: [1, 20], frecuenteDias: [30, 365], activoDias: [7, 365], perdidoDias: [14, 730], promesaMin: [10, 180], ivaPct: [0, 30], caidaPct: [1, 100],
  ticketBajaPct: [1, 100], cancelacionXMediana: [1, 20], descuentoMaxPct: [0, 100], costoAgenteAlzaPct: [1, 1000], cierreBajaPp: [1, 100],
  entregaP90MaxMin: [5, 600], srCuadreVerdePct: [0, 50], srCuadreAmbarPct: [0, 100], srCuadreVerdeCentavos: [0, 100_000_000], comisionTerminalPct: [0, 20],
};

export const CONCEPTOS_COSTO: readonly ConceptoCosto[] = ["insumos", "food_cost_objetivo_pct", "nomina", "renta", "servicios", "comision_terminal", "marketing", "mantenimiento", "otros"];

const COLUMNAS_VENTAS_ADITIVAS = [
  "pedidos", "brutaCentavos", "descPromoCentavos", "descCompCentavos", "netaCentavos", "propinaCentavos", "cancelados", "canceladosCentavos", "noRecogidos", "noRecogidosCentavos",
  "reposiciones", "entregados", "entregaMinSuma", "entregaTarde",
] as const;

/** Hasta cuántos días de periodo se evalúan los hallazgos comparativos (4 semanas previas, participación). */
export const DIAS_MAX_HALLAZGOS_COMPARATIVOS = 62;

const DIAS_SEMANA = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

interface BaseColumna {
  readonly ventas: SumasVentas | null;
  readonly agente: SumasAgente | null;
}

type Bloque = "ventas" | "clientes" | "captura";

const AVISO_BLOQUE: Readonly<Record<Bloque, string>> = {
  ventas: "Las ventas todavía no están disponibles en esta base de datos (falta la actualización 081): las cifras de ventas aparecen sin dato.",
  clientes: "Clientes, agente y operación todavía no están disponibles en esta base de datos (falta la actualización 082).",
  captura: "La captura de costos, la configuración y SoftRestaurant todavía no están disponibles en esta base de datos (falta la actualización 083).",
};

/** `01:00:00` -> milisegundos. */
function corteMs(corte: string | null | undefined): number {
  const m = corte ? /^(\d{1,2}):(\d{2})/.exec(corte) : null;
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 60_000 : 0;
}

function sinCifra(fuente: string): Cifra {
  return sinDato(fuente);
}

export class ServicioCfo {
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly usados = new Set<Bloque>();
  private readonly caidos = new Set<Bloque>();
  private readonly fuentes = new Map<string, FuenteDatosCfo>();
  private readonly idsAlcance: ReadonlySet<string>;
  private readonly nombres: ReadonlyMap<string, string>;

  constructor(private readonly e: EntradaServicioCfo) {
    this.idsAlcance = new Set(e.alcance.propertyIds);
    this.nombres = new Map(e.sucursales.map((s) => [s.propertyId, s.nombre]));
  }

  // ---- infraestructura ----------------------------------------------------------------------------------------------------------------

  private get params(): ParamsCfo {
    return { organizationId: this.e.organizationId, propertyIds: this.e.propertyIdsSql };
  }

  private cached<T>(clave: string, f: () => Promise<T>): Promise<T> {
    const previo = this.memo.get(clave);
    if (previo) return previo as Promise<T>;
    const p = f();
    this.memo.set(clave, p);
    return p;
  }

  private nombre(id: string | null): string {
    return id === null ? "No asignado" : (this.nombres.get(id) ?? "Sucursal");
  }

  private get verNoAsignado(): boolean {
    return this.e.alcance.organizacionCompleta && this.e.alcance.todas;
  }

  /** Errores que NUNCA se degradan: cortan la vista (autorización) o son un parámetro inválido del llamador. */
  private static esFatal(err: unknown): boolean {
    return err instanceof CfoSinAccesoError || err instanceof CfoParametroInvalidoError;
  }

  /**
   * Registra qué bloque usó la vista y si estaba disponible. DEGRADACIÓN POR BLOQUE: si la lectura falla con un error no recuperable (timeout,
   * fallo de una función…), el bloque queda `false` y la vista devuelve el resto; los errores de autorización y de parámetros sí cortan.
   */
  private async marcar<T>(bloque: Bloque, p: Promise<LecturaCfo<T>>): Promise<LecturaCfo<T>> {
    this.usados.add(bloque);
    try {
      const l = await p;
      if (!l.disponible) this.caidos.add(bloque);
      return l;
    } catch (err) {
      if (ServicioCfo.esFatal(err)) throw err;
      this.caidos.add(bloque);
      this.e.onError?.(bloque, err);
      return { disponible: false, filas: [] };
    }
  }

  private enAlcance<T extends { readonly propertyId: string | null }>(filas: readonly T[]): T[] {
    return filas.filter((f) => (f.propertyId === null ? this.verNoAsignado : this.idsAlcance.has(f.propertyId)));
  }

  private soloSucursales<T extends { readonly propertyId: string }>(filas: readonly T[]): T[] {
    return filas.filter((f) => this.idsAlcance.has(f.propertyId));
  }

  // ---- cargas memoizadas --------------------------------------------------------------------------------------------------------------

  private cfg(): Promise<LecturaConfig> {
    return this.cached("cfg", async () => {
      this.usados.add("captura");
      try {
        return await this.e.repo.configLeer(this.e.organizationId);
      } catch (err) {
        if (ServicioCfo.esFatal(err)) throw err;
        this.caidos.add("captura");
        this.e.onError?.("captura", err);
        return { disponible: false, config: CFO_CONFIG_POR_DEFECTO, configurada: false };
      }
    });
  }

  private async config(): Promise<CfoConfig> {
    return (await this.cfg()).config;
  }

  private cobertura(): Promise<LecturaCfo<FilaCobertura>> {
    return this.cached("cobertura", async () => {
      const l = await this.marcar("ventas", this.e.repo.cobertura(this.params));
      const filas = this.soloSucursales(l.filas);
      const desde = filas.map((f) => f.primerDia).filter((x): x is string => x != null).sort()[0] ?? null;
      const hasta = filas.map((f) => f.ultimoDia).filter((x): x is string => x != null).sort().reverse()[0] ?? null;
      this.fuentes.set("pedidos", { id: "pedidos", nombre: "Pedidos del agente (WhatsApp y voz)", confianza: "medido", cobertura: { desde, hasta }, disponible: l.disponible });
      return { disponible: l.disponible, filas };
    });
  }

  private ventas(r: RangoCfo): Promise<LecturaCfo<FilaVentasDiarias>> {
    return this.cached(`v:${r.desde}:${r.hasta}`, async () => {
      const cfg = await this.config();
      const l = await this.marcar("ventas", this.e.repo.ventasDiarias(this.params, r, cfg.promesaMin));
      return { disponible: l.disponible, filas: this.soloSucursales(l.filas) };
    });
  }

  private cortesiasDe(r: RangoCfo): Promise<LecturaCfo<FilaCortesias>> {
    return this.cached(`c:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("ventas", this.e.repo.cortesias(this.params, r));
      return { disponible: l.disponible, filas: this.soloSucursales(l.filas) };
    });
  }

  private agente(r: RangoCfo): Promise<LecturaCfo<FilaAgenteDiario>> {
    return this.cached(`a:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("clientes", this.e.repo.agenteDiario(this.params, r));
      const filas = this.enAlcance(l.filas);
      const dias = filas.map((f) => f.diaNegocio).sort();
      this.fuentes.set("agente", {
        id: "agente", nombre: "Embudo y costo del agente", confianza: "medido", cobertura: { desde: dias[0] ?? null, hasta: dias[dias.length - 1] ?? null }, disponible: l.disponible,
      });
      return { disponible: l.disponible, filas };
    });
  }

  private clientesRes(r: RangoCfo, cfg: CfoConfig): Promise<LecturaCfo<FilaClientesResumen>> {
    const u: UmbralesClientes = { frecuenteN: cfg.frecuenteN, frecuenteDias: cfg.frecuenteDias, activoDias: cfg.activoDias, perdidoDias: cfg.perdidoDias };
    return this.cached(`cl:${r.desde}:${r.hasta}:${u.frecuenteN}:${u.frecuenteDias}:${u.activoDias}:${u.perdidoDias}`, async () => {
      const l = await this.marcar("clientes", this.e.repo.clientesResumen(this.params, r, u));
      return { disponible: l.disponible, filas: l.filas.filter((f) => f.alcance === "conjunto" || (f.propertyId !== null && this.idsAlcance.has(f.propertyId))) };
    });
  }

  private percentiles(r: RangoCfo): Promise<LecturaCfo<FilaEntregaPercentiles>> {
    return this.cached(`p:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("clientes", this.e.repo.entregasPercentiles(this.params, r));
      return { disponible: l.disponible, filas: l.filas.filter((f) => f.alcance === "conjunto" || (f.propertyId !== null && this.idsAlcance.has(f.propertyId))) };
    });
  }

  private comandas(r: RangoCfo): Promise<LecturaCfo<FilaComandasPos>> {
    return this.cached(`cm:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("clientes", this.e.repo.comandasPos(this.params, r));
      return { disponible: l.disponible, filas: this.soloSucursales(l.filas) };
    });
  }

  private productosDe(r: RangoCfo): Promise<LecturaCfo<FilaProducto>> {
    return this.cached(`pr:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("ventas", this.e.repo.productos(this.params, r));
      return { disponible: l.disponible, filas: this.soloSucursales(l.filas) };
    });
  }

  private srResumen(r: RangoCfo): Promise<LecturaCfo<FilaSrResumen>> {
    return this.cached(`sr:${r.desde}:${r.hasta}`, async () => {
      const l = await this.marcar("captura", this.e.repo.srResumenLeer(this.params, r));
      const filas = this.soloSucursales(l.filas);
      const dias = filas.map((f) => f.diaNegocio).sort();
      this.fuentes.set("softrestaurant", {
        id: "softrestaurant", nombre: "SoftRestaurant (reporte importado)", confianza: "importado", cobertura: { desde: dias[0] ?? null, hasta: dias[dias.length - 1] ?? null }, disponible: l.disponible && filas.length > 0,
      });
      return { disponible: l.disponible, filas };
    });
  }

  private costosCapturados(r: RangoCfo): Promise<LecturaCfo<CostoCapturadoDetalle>> {
    const mesDesde = `${mesDe(r.desde)}-01`;
    const mesHasta = `${mesDe(r.hasta)}-01`;
    return this.cached(`co:${mesDesde}:${mesHasta}`, async () => {
      const l = await this.marcar("captura", this.e.repo.costosLeer(this.params, mesDesde, mesHasta));
      const filas = this.enAlcance(l.filas);
      const meses = filas.map((f) => f.mes).sort();
      this.fuentes.set("costos_capturados", {
        id: "costos_capturados", nombre: "Costos capturados por el dueño", confianza: "capturado", cobertura: { desde: meses[0] ?? null, hasta: meses[meses.length - 1] ?? null }, disponible: l.disponible,
      });
      return { disponible: l.disponible, filas };
    });
  }

  // ---- cabecera común ------------------------------------------------------------------------------------------------------------------

  private bloques(): BloquesCfo {
    return { ventas: !this.caidos.has("ventas"), clientes: !this.caidos.has("clientes"), captura: !this.caidos.has("captura") };
  }

  private alcanceApi(): AlcanceApi {
    const a = this.e.alcance;
    return { ...a, propertyIds: [...a.propertyIds], etiqueta: etiquetaAlcance(a.propertyIds.length, a.todas, a.organizacionCompleta, a.propertyIds.map((id) => this.nombre(id))) };
  }

  private periodo(q: ConsultaCfo): PeriodoApi {
    const c = rangoComparativo({ desde: q.desde, hasta: q.hasta }, q.comparar);
    return {
      desde: q.desde, hasta: q.hasta, dias: diasEntre(q.desde, q.hasta), comparar: q.comparar, granularidad: q.granularidad,
      comparadoDesde: c?.desde ?? null, comparadoHasta: c?.hasta ?? null,
    };
  }

  private avisosBase(): string[] {
    const out: string[] = [];
    for (const b of ["ventas", "clientes", "captura"] as const) if (this.caidos.has(b)) out.push(AVISO_BLOQUE[b]);
    if (!this.e.alcance.organizacionCompleta) out.push("Las cifras corresponden solo a las sucursales que usted administra; no incluyen costos de la organización.");
    return out;
  }

  /** Cabecera de toda vista. Debe llamarse AL FINAL, cuando ya se hicieron todas las cargas (`bloques` y `fuentes` dependen de ellas). */
  private async cabecera(q: ConsultaCfo, avisos: readonly string[] = []): Promise<VistaCfoBase> {
    await this.cobertura();
    const bloques = this.bloques();
    return {
      alcance: this.alcanceApi(),
      sucursales: this.e.sucursales,
      periodo: this.periodo(q),
      disponible: !(this.caidos.size > 0),
      bloques,
      fuentes: [...this.fuentes.values()],
      avisos: [...this.avisosBase(), ...avisos],
      avisoLegal: AVISO_CFO,
    };
  }

  // ---- bases de comparación -----------------------------------------------------------------------------------------------------------

  /**
   * Las 4 ventanas del mismo tramo de las 4 semanas previas. Una sola lectura del tramo [desde−28, hasta−7] (si cabe en los 400 días de la SQL) y se
   * reparte por ventana, en vez de 4 barridos de la longitud completa; `conCortesias: false` omite las cortesías (solo las usan los hallazgos).
   */
  private async ventanas4(q: ConsultaCfo, conCortesias = true): Promise<{ rango: RangoCfo; ventas: FilaVentasDiarias[]; agente: FilaAgenteDiario[]; cortesias: FilaCortesias[] }[]> {
    const ventanas = ventanas4Semanas({ desde: q.desde, hasta: q.hasta });
    const union: RangoCfo = { desde: sumarDiasFecha(q.desde, -28), hasta: sumarDiasFecha(q.hasta, -7) };
    const cabe = diasEntre(union.desde, union.hasta) <= 400;
    const out: { rango: RangoCfo; ventas: FilaVentasDiarias[]; agente: FilaAgenteDiario[]; cortesias: FilaCortesias[] }[] = [];
    // Secuencial a propósito (una sesión).
    const uv = cabe ? await this.ventas(union) : null;
    const ua = cabe ? await this.agente(union) : null;
    const uc = cabe && conCortesias ? await this.cortesiasDe(union) : null;
    for (const rango of ventanas) {
      const v = uv ?? (await this.ventas(rango));
      const a = ua ?? (await this.agente(rango));
      const c = conCortesias ? (uc ?? (await this.cortesiasDe(rango))) : null;
      out.push({
        rango,
        ventas: v.filas.filter((f) => enRango(f.diaNegocio, rango)),
        agente: a.filas.filter((f) => enRango(f.diaNegocio, rango)),
        cortesias: c ? c.filas.filter((f) => enRango(f.diaNegocio, rango)) : [],
      });
    }
    return out;
  }

  private async baseComparacion(q: ConsultaCfo): Promise<{ porProp: Map<string, BaseColumna>; total: BaseColumna; disponible: boolean }> {
    const ids = [...this.idsAlcance];
    const porProp = new Map<string, BaseColumna>();
    const r = { desde: q.desde, hasta: q.hasta };
    const cobertura = (await this.cobertura()).filas;
    const primerDia = new Map(cobertura.map((c) => [c.propertyId, c.primerDia]));
    if (q.comparar === "mismo_dia_semana_4") {
      const ventanas = await this.ventanas4(q, false);
      for (const id of ids) {
        const primer = primerDia.get(id) ?? null;
        // Una ventana anterior al primer día con pedidos no es una semana «sin ventas»: no existe, y no debe bajar el promedio.
        const validas = ventanas.filter((w) => primer !== null && w.rango.desde >= primer);
        const vs = validas.map((w) => sumarVentas(w.ventas.filter((f) => f.propertyId === id)));
        const ag = validas.map((w) => sumarAgente(w.agente.filter((f) => f.propertyId === id)));
        porProp.set(id, { ventas: promediarSumasVentas(vs), agente: promediarSumasAgente(ag) });
      }
    } else {
      const base = rangoComparativo(r, q.comparar) as RangoCfo;
      const v = await this.ventas(base);
      const a = await this.agente(base);
      const primerGlobal = cobertura.map((c) => c.primerDia).filter((x): x is string => x != null).sort()[0] ?? null;
      for (const id of ids) {
        const primer = primerDia.get(id) ?? primerGlobal;
        const hay = primer !== null && base.hasta >= primer;
        porProp.set(id, hay ? { ventas: sumarVentas(v.filas.filter((f) => f.propertyId === id)), agente: sumarAgente(a.filas.filter((f) => f.propertyId === id)) } : { ventas: null, agente: null });
      }
    }
    const conBase = ids.map((id) => porProp.get(id)!).filter((b) => b.ventas !== null);
    const total: BaseColumna = conBase.length === 0 ? { ventas: null, agente: null } : { ventas: sumarSumasVentas(conBase.map((b) => b.ventas!)), agente: sumarSumasAgente(conBase.map((b) => b.agente).filter((x): x is SumasAgente => x !== null)) };
    return { porProp, total, disponible: !this.caidos.has("ventas") };
  }

  // ---- /alcance -------------------------------------------------------------------------------------------------------------------------

  async alcanceVista(): Promise<AlcanceVista> {
    const cob = await this.cobertura();
    const hoy = fechaLocal(this.e.ahora, null);
    const ayer = sumarDiasFecha(hoy, -1);
    const cmd = await this.comandas({ desde: ayer, hasta: hoy });
    const sr = await this.marcar("captura", this.e.repo.srCobertura(this.params));
    const cfg = await this.cfg();
    const inicioCostos = `${mesDe(sumarDiasFecha(hoy, -365))}-01`;
    const costos = await this.marcar("captura", this.e.repo.costosLeer(this.params, inicioCostos, `${mesDe(hoy)}-01`));
    const cmdFilas = cmd.filas;
    const modo = cmdFilas.length === 0 ? null : sumarComandas(cmdFilas).modo;
    const zonaDe = new Map(cob.filas.map((f) => [f.propertyId, f]));
    const base = await this.cabecera({ desde: hoy, hasta: hoy, comparar: "periodo_anterior", granularidad: "dia" });
    const avisos = [...base.avisos];
    if (modo === "apagado") avisos.push("Envío de comandas a SoftRestaurant apagado.");
    return {
      alcance: base.alcance,
      sucursales: this.e.sucursales.map((s) => ({ ...s, zona: zonaDe.get(s.propertyId)?.zona ?? null, corte: corteHHMM(zonaDe.get(s.propertyId)?.corte) })),
      disponible: base.disponible,
      bloques: base.bloques,
      cobertura: {
        pedidos: cob.filas.map((f) => ({ propertyId: f.propertyId, primerDia: f.primerDia, ultimoDia: f.ultimoDia })),
        softrestaurant: this.soloSucursales(sr.filas).map((f) => ({ propertyId: f.propertyId, diasConDato: f.diasConDato, diaMin: f.diaMin, diaMax: f.diaMax })),
        costosMeses: [...new Set(this.enAlcance(costos.filas).map((c) => c.mes))].sort(),
      },
      modoSr: modo,
      organizacionCompleta: this.e.alcance.organizacionCompleta,
      configurada: cfg.configurada,
      fuentes: base.fuentes,
      avisos,
      avisoLegal: AVISO_CFO,
    };
  }

  // ---- KPIs ---------------------------------------------------------------------------------------------------------------------------------

  private kpisDe(args: {
    s: SumasVentas;
    ag: SumasAgente | null;
    costoAg: CostoAgente | null;
    base: BaseColumna;
    incluirLlm: boolean;
    margen: Cifra | null;
    clientes: FilaClientesResumen | null;
    p90: number | null;
    ventasOk: boolean;
    clientesOk: boolean;
    cfg: CfoConfig;
  }): KpiTarjeta[] {
    const { s, ag, base, cfg } = args;
    const ok = args.ventasOk;
    const bs = base.ventas;
    const bag = base.agente;
    const baseCosto = bag ? costoAgente(bag, args.incluirLlm).total.valor : null;
    const costoAct = args.costoAg ? args.costoAg.total.valor : null;
    const cposAct = costoPorPedidoAgente(costoAct, s.pedidosAgente);
    const cposBase = bs && bag ? costoPorPedidoAgente(baseCosto, bs.pedidosAgente) : null;
    const k = (
      id: string,
      etiqueta: string,
      tipo: TipoValorKpi,
      valor: Cifra,
      baseValor: number | null,
      mejorSi: KpiTarjeta["mejorSi"],
      semaforo: (v: ReturnType<typeof variacion>) => Semaforo,
    ): KpiTarjeta => {
      const v = valor.valor == null ? variacion(tipo, null, null) : variacion(tipo, valor.valor, baseValor);
      return { id, etiqueta, tipo, valor, base: baseValor, variacion: v, semaforo: valor.valor == null ? "sin_dato" : semaforo(v), mejorSi };
    };
    const sd = (fuente: string): Cifra => sinCifra(fuente);
    const neutro = (): Semaforo => "sin_dato";

    const ventasN = ok ? ventaNeta(s) : sd("cfo_ventas_diarias");
    const pedidosN = ok ? cifraPedidos(s) : sd("cfo_ventas_diarias");
    const ticketN = ok ? ticketPromedio(s) : sd("cfo_ventas_diarias");
    const mixN = ok ? mixCanalPedidos(s.pedidosDomicilio, s.pedidos) : sd("cfo_ventas_diarias");
    const descN = ok ? descuentoPct(s) : sd("cfo_ventas_diarias");
    const cancN = ok ? cancelacionPct(s) : sd("cfo_ventas_diarias");
    const baseTicket = bs ? ticketPromedio(bs).valor : null;
    const baseMix = bs ? mixCanalPedidos(bs.pedidosDomicilio, bs.pedidos).valor : null;
    const baseDesc = bs ? descuentoPct(bs).valor : null;
    const baseCanc = bs ? cancelacionPct(bs).valor : null;
    const cierre = args.clientesOk && ag ? tasaCierreAgente(ag) : sd("cfo_agente_diario");
    const baseCierre = bag ? tasaCierreAgente(bag).valor : null;
    const activos = args.clientes ? cifra(args.clientes.activos, "medido", "cfo_clientes_resumen") : sd("cfo_clientes_resumen");
    const frec = args.clientes ? frecuentesPct(args.clientes.frecuentes, args.clientes.activos) : sd("cfo_clientes_resumen");
    const p90 = args.p90 != null ? cifra(args.p90, "medido", "cfo_entregas_percentiles") : sd("cfo_entregas_percentiles");
    const costoPedido = args.clientesOk && ok ? cposAct : sd("formula:cac_agente");

    return [
      k("ventas_netas", "Ventas netas", "centavos", ventasN, bs ? bs.netaCentavos : null, "mayor", (v) => semaforoCaida(v.valor, cfg.caidaPct)),
      k("pedidos", "Pedidos", "entero", pedidosN, bs ? bs.pedidos : null, "mayor", (v) => semaforoCaida(v.valor, cfg.caidaPct)),
      k("ticket", "Ticket promedio", "centavos", ticketN, baseTicket, "mayor", (v) => semaforoCaida(v.valor, cfg.ticketBajaPct)),
      k("mix_domicilio", "Mix domicilio (pedidos)", "pct", mixN, baseMix, "neutral", neutro),
      k("descuento_pct", "Descuento sobre venta bruta", "pct", descN, baseDesc, "menor", () => semaforoDescuento(descN.valor, cfg)),
      k("cancelacion_pct", "Cancelación", "pct", cancN, baseCanc, "menor", (v) => semaforoAlza(v.valor, 5)),
      k("costo_pedido_agente", "Costo del agente por pedido", "centavos", costoPedido, cposBase ? cposBase.valor : null, "menor", () => semaforoAlza(variacionPct(costoPedido.valor, cposBase?.valor ?? null), cfg.costoAgenteAlzaPct)),
      k("margen_contribucion", "Margen de contribución", "centavos", args.margen ?? sd("formula:margen_contribucion"), null, "mayor", neutro),
      k("clientes_activos", "Clientes activos", "entero", activos, null, "mayor", neutro),
      k("frecuentes_pct", "% de frecuentes", "pct", frec, null, "mayor", neutro),
      k("tasa_cierre_agente", "Tasa de cierre del agente", "pct", cierre, baseCierre, "mayor", (v) => semaforoPuntos(v.valor, cfg.cierreBajaPp)),
      k("entrega_p90", "Entrega p90", "minutos", p90, null, "menor", () => semaforoEntrega(args.p90, cfg)),
    ];
  }

  // ---- /resumen -----------------------------------------------------------------------------------------------------------------------

  async resumen(q: ConsultaCfo, orden: "impacto" | "urgencia" = "impacto"): Promise<ResumenVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ids = [...this.idsAlcance];
    const ventas = await this.ventas(r);
    const agente = await this.agente(r);
    const cortAct = await this.cortesiasDe(r);
    const base = await this.baseComparacion(q);
    const anteriorRango = rangoAnterior(r);
    // Periodos largos: los hallazgos que comparan contra las 4 semanas previas (y la participación) no se evalúan; evita ~6 barridos extra de la longitud del rango.
    const largo = diasEntre(q.desde, q.hasta) > DIAS_MAX_HALLAZGOS_COMPARATIVOS;
    const ventasAnt = !largo || q.comparar === "periodo_anterior" ? await this.ventas(anteriorRango) : null;
    const ventanas = largo ? [] : await this.ventanas4(q);
    const cob = (await this.cobertura()).filas;
    const clientes = await this.clientesRes(r, cfg);
    const percentiles = await this.percentiles(r);
    const comandas = await this.comandas(r);
    const escalaciones = await this.marcar("clientes", this.e.repo.escalacionesHora(this.params, r));
    const agotadosFilas = await this.agotadosConRanking();
    const sr = await this.srResumen(r);
    const costos = await this.costosCapturados(r);
    const pyl = this.estadoResultadosDe(q, ventas.filas, cortAct.filas, agente.filas, costos.filas, sr.filas, cfg);
    const acumulado = pyl.acumulado;

    // Consolidación: el total sale de las filas (camino independiente); `consolidar` lanza si total ≠ Σ sucursales.
    consolidar(ventas.filas as FilaVentasDiarias[], { propertyId: "propertyId" }, COLUMNAS_VENTAS_ADITIVAS, { sucursales: ids, permitirNoAsignado: false });
    const sumasProp = new Map(ids.map((id) => [id, sumarVentas(ventas.filas.filter((f) => f.propertyId === id))]));
    const sumasTotal = sumarVentas(ventas.filas);

    const agPorProp = indexarPor(agente.filas, (f) => f.propertyId);
    const clientesProp = new Map(clientes.filas.filter((f) => f.alcance === "sucursal" && f.propertyId !== null).map((f) => [f.propertyId as string, f]));
    const conjunto = consolidarClientes(clientes.filas).conjunto;
    const p90Prop = new Map(percentiles.filas.filter((f) => f.alcance === "sucursal" && f.propertyId !== null).map((f) => [f.propertyId as string, f.p90Min]));
    const p90Conjunto = percentiles.filas.find((f) => f.alcance === "conjunto")?.p90Min ?? null;
    const ventasOk = ventas.disponible;
    const clientesOk = clientes.disponible && agente.disponible;
    const incluirLlm = this.verNoAsignado;

    const colSucursal = (id: string): ResumenColumna => {
      const s = sumasProp.get(id) ?? SUMAS_VENTAS_VACIAS;
      const ag = sumarAgente(agPorProp.get(id) ?? []);
      const col = acumulado.columnas.find((c) => c.propertyId === id);
      return {
        sumas: s,
        kpis: this.kpisDe({
          s, ag, costoAg: costoAgente(ag, false), base: base.porProp.get(id) ?? { ventas: null, agente: null }, incluirLlm: false,
          margen: col ? col.margenContribucion.cifra : null, clientes: clientesProp.get(id) ?? null, p90: p90Prop.get(id) ?? null, ventasOk, clientesOk, cfg,
        }),
      };
    };
    const agTotal = sumarAgente(agente.filas);
    const colTotal: ResumenColumna = {
      sumas: sumasTotal,
      kpis: this.kpisDe({
        s: sumasTotal, ag: agTotal, costoAg: costoAgente(agTotal, incluirLlm), base: base.total, incluirLlm,
        margen: acumulado.columnas.find((c) => c.clave === "total")?.margenContribucion.cifra ?? null, clientes: conjunto, p90: p90Conjunto, ventasOk, clientesOk, cfg,
      }),
    };
    const agNoAsig = agente.filas.filter((f) => f.propertyId === null);
    const noAsignado = this.verNoAsignado && agNoAsig.length > 0 ? { costoAgenteCentavos: costoAgente(sumarAgente(agNoAsig), true).total, llmTexto: costoAgente(sumarAgente(agNoAsig), true).llmTexto } : null;
    const porSucursal = ids.map((id) => ({ propertyId: id, nombre: this.nombre(id), ...colSucursal(id) }));

    // Hallazgos
    const sucursalesCfo: SucursalCfo[] = ids.map((id) => ({ propertyId: id, nombre: this.nombre(id) }));
    const agotadosPor = indexarPor(agotadosFilas, (f) => f.propertyId);
    const comandasPor = indexarPor(comandas.filas, (f) => f.propertyId);
    const escPor = indexarPor(escalaciones.filas, (f) => f.propertyId);
    const metricas: MetricasSucursalHallazgos[] = ids.map((id) => {
      const primer = cob.find((c) => c.propertyId === id)?.primerDia ?? null;
      const validas = ventanas.filter((w) => primer !== null && w.rango.desde >= primer);
      const ag = sumarAgente(agPorProp.get(id) ?? []);
      const baseAg = promediarSumasAgente(validas.map((w) => sumarAgente(w.agente.filter((f) => f.propertyId === id))));
      const cortBase = validas.length === 0 ? null : divEntera(validas.reduce((s, w) => s + sumarCortesias(w.cortesias.filter((f) => f.propertyId === id)).valorListaCentavos, 0), validas.length);
      const cm = comandasPor.get(id) ?? [];
      const dom = this.cuadreDomicilio(id, ventas.filas, sr.filas, cfg);
      return {
        propertyId: id,
        actual: sumasProp.get(id) ?? SUMAS_VENTAS_VACIAS,
        base4Semanas: promediarSumasVentas(validas.map((w) => sumarVentas(w.ventas.filter((f) => f.propertyId === id)))),
        anterior: ventasAnt && primer !== null && anteriorRango.hasta >= primer ? sumarVentas(ventasAnt.filas.filter((f) => f.propertyId === id)) : null,
        cortesiasCentavos: sumarCortesias(cortAct.filas.filter((f) => f.propertyId === id)).valorListaCentavos,
        cortesiasBase4SemanasCentavos: cortBase,
        agente: agente.disponible ? ag : null,
        agenteBase4Semanas: baseAg,
        costoAgenteCentavos: costoAgente(ag, false).total.valor,
        costoAgenteBase4SemanasCentavos: baseAg ? costoAgente(baseAg, false).total.valor : null,
        descuentoPctP90Historico: null,
        entregaP90Min: p90Prop.get(id) ?? null,
        // La SQL no expone «frecuentes sin pedir ≥ 30 días»: sin dato, el motor no dispara ese hallazgo (nunca se inventa).
        frecuentesDormidos: null,
        agotados: agotadosPor.get(id) ?? [],
        comandas: cm.length > 0 ? sumarComandas(cm) : null,
        escalacionesPorFranja: escPor.get(id) ?? [],
        cuadreSr: dom,
      };
    });
    const hallazgosTodos = ventasOk ? detectarHallazgos({ ahora: this.e.ahora, periodo: r, sucursales: sucursalesCfo, metricas }, cfg) : [];
    const hallazgos = ordenarHallazgos(hallazgosTodos, orden);

    // Narrativa
    const kpiTotal = (id: string): KpiTarjeta => colTotal.kpis.find((x) => x.id === id) as KpiTarjeta;
    const vk = (id: string, tipo: ValorKpi["tipo"]): ValorKpi => ({ cifra: kpiTotal(id).valor, tipo });
    const varVentas = kpiTotal("ventas_netas").variacion.valor;
    const aportes = aporteALaVariacion(
      ids.flatMap((id) => {
        const b = base.porProp.get(id)?.ventas;
        return b ? [{ propertyId: id, actualCentavos: (sumasProp.get(id) ?? SUMAS_VENTAS_VACIAS).netaCentavos, baseCentavos: b.netaCentavos }] : [];
      }),
    );
    const mejor = [...aportes].filter((a) => a.aportePct != null && a.aportePct > 0).sort((a, b) => (b.aportePct as number) - (a.aportePct as number))[0];
    const cc = consolidarClientes(clientes.filas);
    const metaNoMedido = agente.disponible && agente.filas.length > 0 && sumarAgente(agente.filas).metaEventos === 0;
    const kpisNarr: KpisResumen = {
      titularOrigen: "agente",
      periodo: `el periodo del ${q.desde} al ${q.hasta}`,
      comparadoContra: textoComparado(q.comparar),
      alcanceEtiqueta: this.alcanceApi().etiqueta.toLowerCase(),
      ventasNetas: vk("ventas_netas", "centavos"),
      pedidos: vk("pedidos", "entero"),
      ticket: vk("ticket", "centavos"),
      variacionVentas: { cifra: varVentas == null ? sinDato("formula:crecimiento") : cifra(varVentas, "medido", "formula:crecimiento"), tipo: "pct" },
      descuentoPct: vk("descuento_pct", "pct"),
      cancelacionPct: vk("cancelacion_pct", "pct"),
      costoPorPedidoAgente: vk("costo_pedido_agente", "centavos"),
      metaNoMedido,
      margenContribucion: vk("margen_contribucion", "centavos"),
      margenParcial: acumulado.columnas.find((c) => c.clave === "total")?.margenContribucion.parcial ?? false,
      multiSucursal: clientes.disponible ? cc.clientesVariasSucursales : null,
      mayorAporte: mejor ? { sucursal: this.nombre(mejor.propertyId), aportePct: cifra(mejor.aportePct, "medido", "formula:aporte_variacion") } : null,
    };
    const narrativa = narrarResumen(kpisNarr, hallazgos, this.e.alcance);

    // Avisos
    const avisos: string[] = [];
    if (ventasOk && sumasTotal.pedidos === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    if (base.total.ventas === null && ventasOk) avisos.push("No hay un periodo de comparación con datos.");
    if (largo) avisos.push(`En periodos de más de ${DIAS_MAX_HALLAZGOS_COMPARATIVOS} días no se evalúan los hallazgos que comparan contra las 4 semanas previas; use un periodo menor para verlos.`);
    this.avisosFuentes(avisos, { sr: sr.filas, comandas: comandas.filas, agente: agente.filas, agenteOk: agente.disponible });
    const totalPyl = acumulado.columnas.find((c) => c.clave === "total");
    if (totalPyl && totalPyl.incompleto.length > 0) avisos.push("Faltan costos por capturar para el EBITDA: el margen de contribución es parcial.");

    const titular: TitularApi = totalPyl
      ? { etiqueta: totalPyl.titular.etiqueta, origen: totalPyl.titular.origen, cifra: ventasOk || totalPyl.titular.origen === "softrestaurant" ? totalPyl.titular.cifra : sinDato("cfo_ventas_diarias") }
      : { etiqueta: "Ventas por el agente (WhatsApp y voz)", origen: "agente", cifra: sinDato("cfo_ventas_diarias") };

    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      titular,
      kpis: { porSucursal, noAsignado, total: colTotal },
      hallazgos,
      orden,
      narrativa,
      multiSucursal: { clientes: clientes.disponible ? cc.clientesVariasSucursales : null, texto: clientes.disponible ? cc.texto : null },
    };
  }

  private avisosFuentes(avisos: string[], d: { sr: readonly FilaSrResumen[]; comandas: readonly FilaComandasPos[]; agente: readonly FilaAgenteDiario[]; agenteOk: boolean }): void {
    if (d.sr.length === 0) avisos.push("Sin datos de mostrador de SoftRestaurant: suba el reporte de ventas por tipo de servicio o el listado de cuentas.");
    if (d.comandas.length > 0 && sumarComandas(d.comandas).modo === "apagado") avisos.push("Envío de comandas a SoftRestaurant apagado.");
    if (d.agenteOk && d.agente.length > 0 && sumarAgente(d.agente).metaEventos === 0) avisos.push("Costo de Meta no medido: el costo del agente no lo incluye (no se muestra como $0).");
    if (d.agenteOk && d.agente.some((f) => f.propertyId !== null && (f.costoVozCentavos === null || f.costoTelefoniaCentavos === null) && (f.costoVozMicroUsd > 0 || f.costoTelefoniaMicroUsd > 0)))
      avisos.push("Parte del costo del agente no se pudo convertir a pesos (falta el tipo de cambio de esos días).");
  }

  /** Cuadre del domicilio de una sucursal en el periodo, solo sobre los días que SR trae. null = sin SR importado. */
  private cuadreDomicilio(id: string, ventas: readonly FilaVentasDiarias[], sr: readonly FilaSrResumen[], cfg: CfoConfig) {
    const srProp = sr.filter((f) => f.propertyId === id && f.tipoServicio === "domicilio");
    if (srProp.length === 0) return null;
    const dias = new Set(sr.filter((f) => f.propertyId === id).map((f) => f.diaNegocio));
    const nuestras = ventas.filter((f) => f.propertyId === id && f.canal === "domicilio" && dias.has(f.diaNegocio));
    return cuadreSr(
      {
        nuestroCentavos: nuestras.reduce((s, f) => s + f.netaCentavos, 0),
        srCentavos: srProp.reduce((s, f) => s + f.netaCentavos, 0),
        pedidosNuestros: nuestras.reduce((s, f) => s + f.pedidos, 0),
        ticketsSr: srProp.reduce((s, f) => s + f.tickets, 0),
      },
      cfg,
    );
  }

  // ---- agotados con ranking --------------------------------------------------------------------------------------------------------------

  /** Agotados vigentes con su posición por unidades (últimos 28 días de negocio) entre los productos de su sucursal. */
  private agotadosConRanking(): Promise<FilaAgotado[]> {
    return this.cached("agotados", async () => {
      const l = await this.marcar("clientes", this.e.repo.agotados(this.params));
      const filas = this.soloSucursales(l.filas);
      if (filas.length === 0) return [];
      const cob = (await this.cobertura()).filas;
      // Día de negocio «hoy» de cada sucursal: fecha local menos el corte. Se pide la ventana común más amplia y se filtra por sucursal.
      const hoyPor = new Map<string, string>();
      for (const c of cob) hoyPor.set(c.propertyId, fechaLocal(new Date(this.e.ahora.getTime() - corteMs(c.corte)), c.zona));
      const fallback = fechaLocal(this.e.ahora, null);
      const hoys = [...new Set([...hoyPor.values(), fallback])].sort();
      const r: RangoCfo = { desde: sumarDiasFecha(hoys[0]!, -28), hasta: sumarDiasFecha(hoys[hoys.length - 1]!, -1) };
      const prod = await this.productosDe(r);
      return filas.map((a) => {
        const hoy = hoyPor.get(a.propertyId) ?? fallback;
        const ventana = { desde: sumarDiasFecha(hoy, -28), hasta: sumarDiasFecha(hoy, -1) };
        const unidades = new Map<string, number>();
        for (const p of prod.filas) if (p.propertyId === a.propertyId && enRango(p.diaNegocio, ventana)) unidades.set(p.productoRef.toLowerCase(), (unidades.get(p.productoRef.toLowerCase()) ?? 0) + p.unidades);
        const orden = [...unidades.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
        const pos = orden.findIndex(([ref]) => ref === a.productId.toLowerCase());
        return { ...a, rankingUnidades: pos >= 0 ? pos + 1 : null };
      });
    });
  }

  // ---- estado de resultados --------------------------------------------------------------------------------------------------------------

  private estadoResultadosDe(
    q: ConsultaCfo,
    ventas: readonly FilaVentasDiarias[],
    cortes: readonly FilaCortesias[],
    agente: readonly FilaAgenteDiario[],
    costos: readonly CostoCapturadoDetalle[],
    sr: readonly FilaSrResumen[],
    cfg: CfoConfig,
  ): EstadoResultados {
    return construirEstadoResultados({
      ventas, cortesias: cortes, costosAgente: agente, costosCapturados: costos, config: cfg, srResumen: sr, granularidad: q.granularidad, rango: { desde: q.desde, hasta: q.hasta },
      alcance: this.e.alcance, sucursales: [...this.nombres.entries()].map(([propertyId, nombre]) => ({ propertyId, nombre })),
    });
  }

  async estadoResultados(q: ConsultaCfo): Promise<EstadoResultadosVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ventas = await this.ventas(r);
    const cort = await this.cortesiasDe(r);
    const agente = await this.agente(r);
    const costos = await this.costosCapturados(r);
    const sr = await this.srResumen(r);
    const er = this.estadoResultadosDe(q, ventas.filas, cort.filas, agente.filas, costos.filas, sr.filas, cfg);
    const avisos: string[] = [];
    if (ventas.disponible && ventas.filas.length === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    this.avisosFuentes(avisos, { sr: sr.filas, comandas: [], agente: agente.filas, agenteOk: agente.disponible });
    if (er.acumulado.columnas.some((c) => c.incompleto.length > 0)) avisos.push("Hay líneas con captura pendiente: use «Capturar costos» para completar el estado de resultados.");
    return { ...(await this.cabecera(q, avisos)), estadoResultados: er };
  }

  // ---- /ventas ------------------------------------------------------------------------------------------------------------------------

  async ventasVista(q: ConsultaCfo): Promise<VentasVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ids = [...this.idsAlcance];
    const ventas = await this.ventas(r);
    const cort = await this.cortesiasDe(r);
    const hora = await this.marcar("ventas", this.e.repo.ventasHora(this.params, r));
    const agente = await this.agente(r);
    const sr = await this.srResumen(r);
    const costos = await this.costosCapturados(r);
    const er = this.estadoResultadosDe(q, ventas.filas, cort.filas, agente.filas, costos.filas, sr.filas, cfg);
    const comp = rangoComparativo(r, q.comparar);
    const ventasComp = comp ? await this.ventas(comp) : null;

    const cascada = (s: SumasVentas): CascadaVentas => {
      const neta = ventaNeta(s);
      const iva = ivaEstimado(s.netaCentavos, cfg.ivaPct);
      return {
        brutaCentavos: ventaBruta(s), descuentoPromocionCentavos: descuentoPromocion(s), compensacionesCentavos: compensacion(s), netaCentavos: neta,
        ivaEstimadoCentavos: iva, netaSinIvaCentavos: ventaNetaSinIva(s.netaCentavos, iva.valor),
        descuadreCentavos: s.brutaCentavos - s.descPromoCentavos - s.descCompCentavos - s.netaCentavos,
      };
    };
    const columna = (filas: readonly FilaVentasDiarias[], cortes: readonly FilaCortesias[]): VentasColumna => {
      const s = sumarVentas(filas);
      return {
        sumas: s, serie: serieDeVentas(filas, r, q.granularidad), cascada: cascada(s), cancelacionPct: cancelacionPct(s),
        cortesias: cortesias(sumarCortesias(cortes).valorListaCentavos),
      };
    };
    const porSucursal = ids.map((id) => ({ propertyId: id, nombre: this.nombre(id), ...columna(ventas.filas.filter((f) => f.propertyId === id), cort.filas.filter((f) => f.propertyId === id)) }));
    consolidar(ventas.filas as FilaVentasDiarias[], { propertyId: "propertyId" }, COLUMNAS_VENTAS_ADITIVAS, { sucursales: ids, permitirNoAsignado: false });
    const total = columna(ventas.filas, cort.filas);

    const sTot = total.sumas;
    const canales = new Map<string, { canal: FilaVentasDiarias["canal"]; source: FilaVentasDiarias["source"]; pedidos: number; neta: number }>();
    for (const f of ventas.filas) {
      const k = `${f.canal}|${f.source}`;
      const a = canales.get(k) ?? { canal: f.canal, source: f.source, pedidos: 0, neta: 0 };
      a.pedidos += f.pedidos;
      a.neta += f.netaCentavos;
      canales.set(k, a);
    }
    const porCanal = [...canales.values()]
      .sort((a, b) => b.neta - a.neta || (a.canal + a.source < b.canal + b.source ? -1 : 1))
      .map((c) => ({ canal: c.canal, source: c.source, pedidos: c.pedidos, netaCentavos: c.neta, mixPedidosPct: mixCanalPedidos(c.pedidos, sTot.pedidos).valor, mixVentasPct: mixCanalVentas(c.neta, sTot.netaCentavos).valor }));

    const celdas = new Map<string, { dow: number; hora: number; pedidos: number; netaCentavos: number }>();
    for (const h of this.soloSucursales(hora.filas)) {
      const k = `${h.dowNegocio}|${h.horaLocal}`;
      const c = celdas.get(k) ?? { dow: h.dowNegocio, hora: h.horaLocal, pedidos: 0, netaCentavos: 0 };
      c.pedidos += h.pedidos;
      c.netaCentavos += h.netaCentavos;
      celdas.set(k, c);
    }
    const heatmap = [...celdas.values()].sort((a, b) => a.dow - b.dow || a.hora - b.hora);

    const pagos = new Map<"efectivo" | "tarjeta" | "sin_dato", { pedidos: number; neta: number }>();
    for (const f of ventas.filas) {
      const k = f.paymentMethod ?? "sin_dato";
      const a = pagos.get(k) ?? { pedidos: 0, neta: 0 };
      a.pedidos += f.pedidos;
      a.neta += f.netaCentavos;
      pagos.set(k, a);
    }
    const formaPago = (["efectivo", "tarjeta", "sin_dato"] as const).filter((k) => pagos.has(k)).map((k) => ({ formaPago: k, pedidos: pagos.get(k)!.pedidos, netaCentavos: pagos.get(k)!.neta }));

    const avisos: string[] = [];
    if (ventas.disponible && ventas.filas.length === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    this.avisosFuentes(avisos, { sr: sr.filas, comandas: [], agente: agente.filas, agenteOk: agente.disponible });
    const totalPyl = er.acumulado.columnas.find((c) => c.clave === "total");
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      titular: totalPyl ? { etiqueta: totalPyl.titular.etiqueta, origen: totalPyl.titular.origen, cifra: totalPyl.titular.cifra } : { etiqueta: "Ventas por el agente (WhatsApp y voz)", origen: "agente", cifra: sinDato("cfo_ventas_diarias") },
      ventas: { porSucursal, noAsignado: null, total },
      serieComparativo: ventasComp ? serieDeVentas(ventasComp.filas, comp as RangoCfo, q.granularidad) : null,
      porCanal,
      heatmap,
      formaPago,
      propinas: {
        tarjetaCentavos: cifra(sTot.propinaTarjetaCentavos, "medido", "cfo_ventas_diarias"),
        nota: "Solo se mide la propina con tarjeta que capturó el agente; la propina en efectivo entregada en mano no se registra. La propina no es ingreso del negocio.",
      },
      cancelaciones: {
        cancelados: sTot.cancelados, canceladosCentavos: sTot.canceladosCentavos, noRecogidos: sTot.noRecogidos, noRecogidosCentavos: sTot.noRecogidosCentavos, cancelacionPct: cancelacionPct(sTot),
      },
    };
  }

  // ---- /sucursales --------------------------------------------------------------------------------------------------------------------

  async sucursalesVista(q: ConsultaCfo): Promise<SucursalesVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const ids = [...this.idsAlcance];
    const ventas = await this.ventas(r);
    const agente = await this.agente(r);
    const percentiles = await this.percentiles(r);
    const total = sumarVentas(ventas.filas);
    const agPor = indexarPor(agente.filas, (f) => f.propertyId);
    const p90 = new Map(percentiles.filas.filter((f) => f.alcance === "sucursal" && f.propertyId !== null).map((f) => [f.propertyId as string, f.p90Min]));
    const tabla: FilaSucursalApi[] = ids.map((id) => {
      const fs = ventas.filas.filter((f) => f.propertyId === id);
      const s = sumarVentas(fs);
      const ag = sumarAgente(agPor.get(id) ?? []);
      return {
        propertyId: id, nombre: this.nombre(id), pedidos: s.pedidos, netaCentavos: s.netaCentavos,
        participacionPct: mixCanalVentas(s.netaCentavos, total.netaCentavos), ticket: ticketPromedio(s), descuentoPct: descuentoPct(s), cancelacionPct: cancelacionPct(s),
        entregaPromedioMin: entregaPromedioMin(s),
        entregaP90Min: p90.has(id) && p90.get(id) != null ? cifra(p90.get(id) ?? null, "medido", "cfo_entregas_percentiles") : sinDato("cfo_entregas_percentiles"),
        costoPorPedidoAgente: costoPorPedidoAgente(costoAgente(ag, false).total.valor, s.pedidosAgente),
        miniTendencia: serieDeVentas(fs, r, q.granularidad === "dia" && diasEntre(q.desde, q.hasta) > 31 ? "semana" : q.granularidad).map((p) => p.netaCentavos),
      };
    });
    consolidar(ventas.filas as FilaVentasDiarias[], { propertyId: "propertyId" }, COLUMNAS_VENTAS_ADITIVAS, { sucursales: ids, permitirNoAsignado: false });
    const ranking = [...tabla].sort((a, b) => b.netaCentavos - a.netaCentavos || (a.nombre < b.nombre ? -1 : 1)).map((t, i) => ({ posicion: i + 1, propertyId: t.propertyId, nombre: t.nombre, netaCentavos: t.netaCentavos }));
    const outliers = [
      ...detectarOutliers("netaCentavos", tabla.map((t) => ({ propertyId: t.propertyId, nombre: t.nombre, valor: t.pedidos > 0 ? t.netaCentavos : null }))),
      ...detectarOutliers("ticket", tabla.map((t) => ({ propertyId: t.propertyId, nombre: t.nombre, valor: t.ticket.valor }))),
      ...detectarOutliers("cancelacionPct", tabla.map((t) => ({ propertyId: t.propertyId, nombre: t.nombre, valor: t.cancelacionPct.valor }))),
      ...detectarOutliers("descuentoPct", tabla.map((t) => ({ propertyId: t.propertyId, nombre: t.nombre, valor: t.descuentoPct.valor }))),
    ];
    const noAsig = this.verNoAsignado ? agente.filas.filter((f) => f.propertyId === null) : [];
    const avisos: string[] = [];
    if (ventas.disponible && ventas.filas.length === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    if (ids.length === 1) avisos.push("Solo hay una sucursal en el alcance: la comparación entre sucursales no aplica.");
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      tabla,
      total: { pedidos: total.pedidos, netaCentavos: total.netaCentavos, ticket: ticketPromedio(total), descuentoPct: descuentoPct(total), cancelacionPct: cancelacionPct(total) },
      noAsignado: noAsig.length > 0 ? { costoAgenteCentavos: costoAgente(sumarAgente(noAsig), true).total } : null,
      ranking,
      outliers,
    };
  }

  // ---- /clientes ----------------------------------------------------------------------------------------------------------------------

  async clientesVista(q: ConsultaCfo): Promise<ClientesVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ventas = await this.ventas(r);
    const res = await this.clientesRes(r, cfg);
    const coh = await this.marcar("clientes", this.e.repo.clientesCohortes(this.params, 6));
    const altas = await this.marcar("clientes", this.e.repo.clientesAltas(this.params, r));
    const seg = await this.marcar("clientes", this.e.repo.clientesSegmentoHora(this.params, r, { frecuenteN: cfg.frecuenteN, frecuenteDias: cfg.frecuenteDias }));
    const ticketTotal = ticketPromedio(sumarVentas(ventas.filas));

    const columna = (f: FilaClientesResumen): ClientesColumna => {
      const sucursalTicket = f.propertyId === null ? ticketTotal.valor : ticketPromedio(sumarVentas(ventas.filas.filter((x) => x.propertyId === f.propertyId))).valor;
      return {
        resumen: f,
        segmentos: resumirSegmentos(f),
        churn: churnPct(f.activosAlInicio, f.pasanAPerdidos),
        concentracion: concentracionPct(f.netaTop10pctCentavos, f.netaTotalCentavos),
        valorDeVida: valorDeVidaSimple(sucursalTicket, f.pedidosPorCliente12mPromedio),
        diasEntrePedidosMediana: cifra(f.diasEntrePedidosMediana, "medido", "cfo_clientes_resumen"),
        winBack: { recuperados: f.recuperados, recuperadosPorCampana: f.recuperadosPorCampana },
      };
    };
    const cc = consolidarClientes(res.filas);
    const porSucursal = cc.porSucursal.filter((f) => f.propertyId !== null && this.idsAlcance.has(f.propertyId)).map((f) => ({ propertyId: f.propertyId as string, nombre: this.nombre(f.propertyId), ...columna(f) }));
    const cohortes: CohorteApi[] = this.enAlcance(coh.filas).map((c) => {
      const t = (con: number, obs: number) => ({ con, observables: obs, pct: recompraPct(obs, con) });
      return { propertyId: c.propertyId, mesCohorte: c.mesCohorte, clientes: c.clientes, recompra30: t(c.conRecompra30, c.observables30), recompra60: t(c.conRecompra60, c.observables60), recompra90: t(c.conRecompra90, c.observables90) };
    });
    const altasFilas = this.enAlcance(altas.filas);
    const porMes = new Map<string, { propertyId: string | null; mes: string; altas: number }>();
    for (const a of altasFilas) {
      const k = `${a.propertyId ?? "*"}|${mesDe(a.semana)}`;
      const x = porMes.get(k) ?? { propertyId: a.propertyId, mes: mesDe(a.semana), altas: 0 };
      x.altas += a.altas;
      porMes.set(k, x);
    }
    const sh = new Map<string, { segmento: string; dow: number; hora: number; pedidos: number; netaCentavos: number; clientes: number }>();
    for (const f of this.enAlcance(seg.filas).filter((x) => x.propertyId !== null)) {
      const k = `${f.segmento}|${f.dowNegocio}|${f.horaLocal}`;
      const x = sh.get(k) ?? { segmento: f.segmento, dow: f.dowNegocio, hora: f.horaLocal, pedidos: 0, netaCentavos: 0, clientes: 0 };
      x.pedidos += f.pedidos;
      x.netaCentavos += f.netaCentavos;
      // Clientes únicos NO se suman entre sucursales: se reporta el máximo de una sucursal como cota inferior solo si hay UNA; con varias, 0 = no calculable.
      x.clientes += f.clientes;
      sh.set(k, x);
    }
    const varias = this.enAlcance(seg.filas).filter((x) => x.propertyId !== null).map((x) => x.propertyId).filter((v, i, a) => a.indexOf(v) === i).length > 1;
    const segmentoHora = [...sh.values()].map((x) => ({ ...x, clientes: varias ? 0 : x.clientes })).sort((a, b) => (a.segmento < b.segmento ? -1 : a.segmento > b.segmento ? 1 : a.dow - b.dow || a.hora - b.hora));

    const conj = cc.conjunto;
    const avisos: string[] = [];
    if (res.disponible && res.filas.length === 0) avisos.push("No hay clientes con pedido en el periodo seleccionado.");
    const pedSin = conj ? conj.pedidosSinCliente : cc.porSucursal.reduce((s, f) => s + f.pedidosSinCliente, 0);
    if (res.disponible && pedSin > 0) avisos.push("Hay pedidos sin cliente identificado: no entran a las métricas de clientes.");
    if (varias) avisos.push("Los clientes únicos no se suman entre sucursales: el total es el conjunto. En «segmento por hora» el conteo de clientes no se muestra con varias sucursales.");
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      porSucursal,
      total: conj ? columna(conj) : null,
      multiSucursal: { clientes: res.disponible ? cc.clientesVariasSucursales : null, texto: res.disponible ? cc.texto : null, sumaPorSucursal: cc.sumaClientesPorSucursal },
      definiciones: definicionesSegmentos(cfg),
      cohortes,
      altas: { porSemana: altasFilas, porMes: [...porMes.values()].sort((a, b) => (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0)) },
      segmentoHora,
      pedidosSinCliente: pedSin,
    };
  }

  // ---- /productos ---------------------------------------------------------------------------------------------------------------------

  async productosVista(q: ConsultaCfo): Promise<ProductosVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const ids = [...this.idsAlcance];
    const prod = await this.productosDe(r);
    const ventas = await this.ventas(r);
    this.usados.add("ventas");
    let canasta: Awaited<ReturnType<CfoRepository["canastaPares"]>> = { disponible: false, pares: [], totales: [], tickets: [] };
    try {
      canasta = await this.e.repo.canastaPares(this.params, r, 50);
    } catch (err) {
      if (ServicioCfo.esFatal(err)) throw err;
      this.e.onError?.("ventas", err);
    }
    if (!canasta.disponible) this.caidos.add("ventas");
    const agot = await this.agotadosConRanking();

    type Acum = { productoRef: string; nombre: string; categoria: string; unidades: number; ingreso: number; pedidos: number };
    const agrupar = (filas: readonly FilaProducto[]): Acum[] => {
      const m = new Map<string, Acum>();
      for (const f of filas) {
        const k = f.productoRef.toLowerCase();
        const a = m.get(k) ?? { productoRef: f.productoRef, nombre: f.nombreActual, categoria: f.categoria, unidades: 0, ingreso: 0, pedidos: 0 };
        a.unidades += f.unidades;
        a.ingreso += f.ingresoCentavos;
        a.pedidos += f.pedidos;
        m.set(k, a);
      }
      return [...m.values()];
    };
    const cmpTop = (x: Acum, y: Acum): number => y.unidades - x.unidades || y.ingreso - x.ingreso || (x.productoRef < y.productoRef ? -1 : x.productoRef > y.productoRef ? 1 : 0);
    const totalIngreso = prod.filas.reduce((s, f) => s + f.ingresoCentavos, 0);
    const api = (a: Acum, den: number): RankingProductoApi => ({ productoRef: a.productoRef, nombre: a.nombre, categoria: a.categoria, unidades: a.unidades, ingresoCentavos: a.ingreso, pedidos: a.pedidos, participacionIngresoPct: pct1(a.ingreso, den) });
    const todos = agrupar(prod.filas);
    const masVendidos = [...todos].sort(cmpTop).slice(0, 10);
    const menosVendidos = [...todos].filter((a) => a.unidades > 0).sort((x, y) => -cmpTop(x, y)).slice(0, 10);
    const porSucursal = ids.map((id) => {
      const fs = prod.filas.filter((f) => f.propertyId === id);
      const den = fs.reduce((s, f) => s + f.ingresoCentavos, 0);
      return { propertyId: id, nombre: this.nombre(id), masVendidos: agrupar(fs).sort(cmpTop).slice(0, 10).map((a) => api(a, den)) };
    });
    const cats = new Map<string, { categoria: string; unidades: number; ingreso: number }>();
    for (const f of prod.filas) {
      const c = cats.get(f.categoria) ?? { categoria: f.categoria, unidades: 0, ingreso: 0 };
      c.unidades += f.unidades;
      c.ingreso += f.ingresoCentavos;
      cats.set(f.categoria, c);
    }
    const mixCategoria = [...cats.values()].sort((a, b) => b.ingreso - a.ingreso || (a.categoria < b.categoria ? -1 : 1)).map((c) => ({ categoria: c.categoria, unidades: c.unidades, ingresoCentavos: c.ingreso, participacionPct: pct1(c.ingreso, totalIngreso) }));
    // Matriz popularidad × ingreso: cuadrantes por la mediana de unidades e ingreso de los productos con venta.
    const medU = medianaNum(todos.map((a) => a.unidades));
    const medI = medianaNum(todos.map((a) => a.ingreso));
    const matriz: PuntoMatriz[] = todos
      .map((a): PuntoMatriz => ({
        productoRef: a.productoRef, nombre: a.nombre, unidades: a.unidades, ingresoCentavos: a.ingreso,
        cuadrante: a.unidades >= medU ? (a.ingreso >= medI ? "estrella" : "popular") : a.ingreso >= medI ? "rentable" : "revisar",
      }))
      .sort((a, b) => b.unidades - a.unidades || (a.productoRef < b.productoRef ? -1 : 1));
    const nombrePorRef = new Map(prod.filas.map((f) => [f.productoRef.toLowerCase(), f.nombreActual]));
    const pares = topParesCanasta(this.soloSucursales(canasta.pares), this.soloSucursales(canasta.totales), 20);
    const canastaApi: ParCanastaApi[] = pares.map((p) => ({
      propertyId: p.propertyId, productoA: p.productoA, nombreA: nombrePorRef.get(p.productoA.toLowerCase()) ?? p.productoA, productoB: p.productoB,
      nombreB: nombrePorRef.get(p.productoB.toLowerCase()) ?? p.productoB, pedidosJuntos: p.pedidosJuntos, soportePct: p.soportePct, lift: p.lift,
    }));
    const tk = new Map<number, { pedidos: number; neta: number }>();
    for (const t of this.soloSucursales(canasta.tickets)) {
      const x = tk.get(t.nProductos) ?? { pedidos: 0, neta: 0 };
      x.pedidos += t.pedidos;
      x.neta += t.netaCentavos;
      tk.set(t.nProductos, x);
    }
    const ticketPorNumeroProductos = [...tk.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({ nProductos: n, pedidos: x.pedidos, netaCentavos: x.neta, ticketCentavos: x.pedidos > 0 ? divEntera(x.neta, x.pedidos) : null }));

    // Efecto de promoción: días con promoción (descuento por promoción > 0 en la sucursal) vs los mismos días de la semana sin promoción.
    const efecto: ProductosVista["efectoPromocion"] = masVendidos.slice(0, 10).map((a) => {
      let uCon = 0;
      let uSin = 0;
      let dCon = 0;
      let dSin = 0;
      for (const id of ids) {
        const diasPromo = new Set(ventas.filas.filter((f) => f.propertyId === id && f.descPromoCentavos > 0).map((f) => f.diaNegocio));
        const dows = new Set([...diasPromo].map((d) => diaSemanaIso(d)));
        const dias = expandirDias(q.desde, q.hasta).filter((d) => dows.has(diaSemanaIso(d)));
        dCon += dias.filter((d) => diasPromo.has(d)).length;
        dSin += dias.filter((d) => !diasPromo.has(d)).length;
        for (const f of prod.filas) {
          if (f.propertyId !== id || f.productoRef.toLowerCase() !== a.productoRef.toLowerCase() || !dows.has(f.dowNegocio)) continue;
          if (diasPromo.has(f.diaNegocio)) uCon += f.unidades;
          else uSin += f.unidades;
        }
      }
      return { productoRef: a.productoRef, nombre: a.nombre, efecto: efectoPromocion({ unidadesConPromo: uCon, diasConPromo: dCon, unidadesSinPromo: uSin, diasSinPromo: dSin }) };
    });

    const agotados: AgotadoApi[] = agot.map((a) => ({
      propertyId: a.propertyId, productId: a.productId, nombre: a.nombre, disponible: a.disponible, agotadoHasta: a.agotadoHasta, rankingUnidades: a.rankingUnidades, unidades28d: a.unidades28d,
      ventaEnRiesgoPorDia: ventaEnRiesgoAgotado({ unidades28d: a.unidades28d, precioListaCentavos: a.precioListaCentavos, diasAgotado: 1 }),
    }));
    const avisos: string[] = [];
    if (prod.disponible && prod.filas.length === 0) avisos.push("No hay ventas de productos en el periodo seleccionado.");
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      ranking: { masVendidos: masVendidos.map((a) => api(a, totalIngreso)), menosVendidos: menosVendidos.map((a) => api(a, totalIngreso)), porSucursal },
      mixCategoria,
      matriz,
      canasta: canastaApi,
      ticketPorNumeroProductos,
      efectoPromocion: efecto,
      agotados,
    };
  }

  // ---- /patrones ----------------------------------------------------------------------------------------------------------------------

  async patronesVista(q: ConsultaCfo): Promise<PatronesVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ventas = await this.ventas(r);
    const hora = await this.marcar("ventas", this.e.repo.ventasHora(this.params, r));
    const col = await this.marcar("clientes", this.e.repo.colonias(this.params, r, 5));
    const res = await this.clientesRes(r, cfg);
    const dias = expandirDias(q.desde, q.hasta);
    const ocurrencias = new Map<number, number>();
    for (const d of dias) ocurrencias.set(diaSemanaIso(d), (ocurrencias.get(diaSemanaIso(d)) ?? 0) + 1);
    const sem = new Map<number, { pedidos: number; neta: number }>();
    const men = new Map<string, { pedidos: number; neta: number }>();
    for (const f of ventas.filas) {
      const dow = diaSemanaIso(f.diaNegocio);
      const a = sem.get(dow) ?? { pedidos: 0, neta: 0 };
      a.pedidos += f.pedidos;
      a.neta += f.netaCentavos;
      sem.set(dow, a);
      const m = men.get(mesDe(f.diaNegocio)) ?? { pedidos: 0, neta: 0 };
      m.pedidos += f.pedidos;
      m.neta += f.netaCentavos;
      men.set(mesDe(f.diaNegocio), m);
    }
    const estacionalidadSemanal = [1, 2, 3, 4, 5, 6, 7].map((dow) => {
      const a = sem.get(dow) ?? { pedidos: 0, neta: 0 };
      const n = ocurrencias.get(dow) ?? 0;
      return { dow, etiqueta: DIAS_SEMANA[dow - 1]!, pedidos: a.pedidos, netaCentavos: a.neta, promedioDiaCentavos: n > 0 && ventas.disponible ? divEntera(a.neta, n) : null };
    });
    const diasPorMes = new Map<string, number>();
    for (const d of dias) diasPorMes.set(mesDe(d), (diasPorMes.get(mesDe(d)) ?? 0) + 1);
    const estacionalidadMensual = [...men.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([mes, x]) => ({ mes, pedidos: x.pedidos, netaCentavos: x.neta, dias: diasPorMes.get(mes) ?? 0 }));
    const canalHora = new Map<string, { source: FilaVentasDiarias["source"]; hora: number; pedidos: number; neta: number }>();
    for (const h of this.soloSucursales(hora.filas)) {
      const k = `${h.source}|${h.horaLocal}`;
      const c = canalHora.get(k) ?? { source: h.source, hora: h.horaLocal, pedidos: 0, neta: 0 };
      c.pedidos += h.pedidos;
      c.neta += h.netaCentavos;
      canalHora.set(k, c);
    }
    const colonias: ColoniaApi[] = this.soloSucursales(col.filas).map((c) => ({
      propertyId: c.propertyId, colonia: c.colonia, pedidos: c.pedidos, netaCentavos: c.netaCentavos, ticket: c.pedidos > 0 ? cifra(divEntera(c.netaCentavos, c.pedidos), "medido", "cfo_colonias") : sinDato("cfo_colonias"),
      entregaPromedioMin: cifra(promedioMin1(c.minSuma, c.entregados), "medido", "cfo_colonias"), sucursalCercanaId: c.sucursalCercanaId, distanciaKm: c.distanciaKm,
    }));
    const conj = consolidarClientes(res.filas).conjunto;
    const avisos: string[] = [];
    if (ventas.disponible && ventas.filas.length === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    if (col.disponible && col.filas.length > 0) avisos.push("Las colonias con menos de 5 pedidos o 5 clientes se agrupan en «(otras)» para proteger la privacidad.");
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      estacionalidadSemanal,
      estacionalidadMensual,
      colonias,
      canalPorHora: [...canalHora.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.hora - b.hora)).map((c) => ({ source: c.source, hora: c.hora, pedidos: c.pedidos, netaCentavos: c.neta })),
      diasEntrePedidos: cifra(conj?.diasEntrePedidosMediana ?? null, "medido", "cfo_clientes_resumen"),
    };
  }

  // ---- /operacion ---------------------------------------------------------------------------------------------------------------------

  async operacionVista(q: ConsultaCfo): Promise<OperacionVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ids = [...this.idsAlcance];
    const ventas = await this.ventas(r);
    const entregas = await this.marcar("clientes", this.e.repo.entregas(this.params, r, cfg.promesaMin));
    const percentiles = await this.percentiles(r);
    const repartidores = await this.marcar("clientes", this.e.repo.repartidores(this.params, r, cfg.promesaMin));
    const agente = await this.agente(r);
    const esc = await this.marcar("clientes", this.e.repo.escalacionesHora(this.params, r));
    const comandas = await this.comandas(r);
    const sr = await this.srResumen(r);

    const entPor = indexarPor(this.soloSucursales(entregas.filas), (f) => f.propertyId);
    const pIdx = new Map(percentiles.filas.filter((f) => f.alcance === "sucursal" && f.propertyId !== null).map((f) => [f.propertyId as string, f]));
    const entregaRenglon = (id: string | null, nombre: string, filas: readonly { entregados: number; minSuma: number; tarde: number }[], p: FilaEntregaPercentiles | undefined, conjunto: boolean): EntregasSucursalApi => {
      const entregados = filas.reduce((s, f) => s + f.entregados, 0);
      const minSuma = filas.reduce((s, f) => s + Math.round(f.minSuma * 100), 0) / 100;
      const tarde = filas.reduce((s, f) => s + f.tarde, 0);
      return {
        propertyId: id, nombre, entregados, promedioMin: entregaPromedioMin({ entregaMinSuma: minSuma, entregados }), tardePct: entregaTardePct({ entregaTarde: tarde, entregados }),
        p50Min: cifra(p?.p50Min ?? null, "medido", "cfo_entregas_percentiles"), p90Min: cifra(p?.p90Min ?? null, "medido", "cfo_entregas_percentiles"), conjunto,
      };
    };
    const entregasApi: EntregasSucursalApi[] = [
      ...ids.map((id) => entregaRenglon(id, this.nombre(id), entPor.get(id) ?? [], pIdx.get(id), false)),
      entregaRenglon(null, "Conjunto (todas las entregas del alcance)", this.soloSucursales(entregas.filas), percentiles.filas.find((f) => f.alcance === "conjunto"), true),
    ];
    const porHora = new Map<number, { entregados: number; minSuma: number; tarde: number }>();
    for (const f of this.soloSucursales(entregas.filas)) {
      const a = porHora.get(f.horaLocal) ?? { entregados: 0, minSuma: 0, tarde: 0 };
      a.entregados += f.entregados;
      a.minSuma += Math.round(f.minSuma * 100);
      a.tarde += f.tarde;
      porHora.set(f.horaLocal, a);
    }
    const entregasPorHora = [...porHora.entries()].sort((a, b) => a[0] - b[0]).map(([hora, a]) => ({ hora, entregados: a.entregados, promedioMin: promedioMin1(a.minSuma / 100, a.entregados), tardePct: pct1(a.tarde, a.entregados) }));

    const embudo = (ag: SumasAgente): EmbudoAgenteApi => ({
      whatsapp: { conversaciones: ag.waConversacionesNuevas, conPedido: ag.waConPedido, conHandoff: ag.waConHandoff, tasaCierre: tasaCierreWhatsApp(ag) },
      voz: { llamadas: ag.vozLlamadas, pedidoCreado: ag.vozPedidoCreado, escalado: ag.vozEscalado, abandonado: ag.vozAbandonado, tasaCierre: tasaCierreVoz(ag) },
      tasaCierreAgente: tasaCierreAgente(ag),
    });
    const agPor = indexarPor(agente.filas, (f) => f.propertyId);
    const ventasPor = (id: string | null): SumasVentas => (id === null ? sumarVentas(ventas.filas) : sumarVentas(ventas.filas.filter((f) => f.propertyId === id)));
    const costo = (ag: SumasAgente, incluirLlm: boolean, pedidosAgente: number): CostoAgenteApi => {
      const c = costoAgente(ag, incluirLlm);
      return { total: c.total, voz: c.voz, telefonia: c.telefonia, meta: c.meta, llmTexto: c.llmTexto, porPedido: costoPorPedidoAgente(c.total.valor, pedidosAgente), completo: c.completo };
    };
    const agTotal = sumarAgente(agente.filas);
    const incluirLlm = this.verNoAsignado;
    const noAsigFilas = agPor.get("*") ?? [];
    const costoAgenteVista = {
      porSucursal: ids.map((id) => ({ propertyId: id, nombre: this.nombre(id), ...costo(sumarAgente(agPor.get(id) ?? []), false, ventasPor(id).pedidosAgente) })),
      noAsignado: incluirLlm && noAsigFilas.length > 0 ? costo(sumarAgente(noAsigFilas), true, 0) : null,
      total: costo(agTotal, incluirLlm, ventasPor(null).pedidosAgente),
    };
    const escPor = new Map<number, { conversaciones: number; handoffs: number }>();
    for (const f of this.soloSucursales(esc.filas)) {
      const a = escPor.get(f.horaLocal) ?? { conversaciones: 0, handoffs: 0 };
      a.conversaciones += f.conversaciones;
      a.handoffs += f.handoffs;
      escPor.set(f.horaLocal, a);
    }
    const cmdPor = indexarPor(comandas.filas, (f) => f.propertyId);
    const sumasCmd = sumarComandas(comandas.filas);
    const avisos: string[] = [];
    if (ventas.disponible && ventas.filas.length === 0) avisos.push("No hay pedidos en el periodo seleccionado.");
    this.avisosFuentes(avisos, { sr: sr.filas, comandas: comandas.filas, agente: agente.filas, agenteOk: agente.disponible });
    const cab = await this.cabecera(q, avisos);
    return {
      ...cab,
      entregas: entregasApi,
      entregasPorHora,
      repartidores: this.soloSucursales(repartidores.filas),
      embudo: {
        porSucursal: ids.map((id) => ({ propertyId: id, nombre: this.nombre(id), ...embudo(sumarAgente(agPor.get(id) ?? [])) })),
        noAsignado: null,
        total: embudo(sumarAgente(agente.filas.filter((f) => f.propertyId !== null))),
      },
      costoAgente: costoAgenteVista,
      escalacionesPorHora: [...escPor.entries()].sort((a, b) => a[0] - b[0]).map(([hora, a]) => ({ hora, conversaciones: a.conversaciones, handoffs: a.handoffs, handoffPct: pct1(a.handoffs, a.conversaciones) })),
      comandas: {
        modo: sumasCmd.modo,
        sumas: sumasCmd,
        tasaCaptura: tasaCapturaSr(sumasCmd),
        minutosACaptura: minutosACapturaSr(sumasCmd),
        porSucursal: ids.map((id) => ({ propertyId: id, nombre: this.nombre(id), modo: sumarComandas(cmdPor.get(id) ?? []).modo, sumas: sumarComandas(cmdPor.get(id) ?? []) })),
      },
    };
  }

  // ---- /pedidos -----------------------------------------------------------------------------------------------------------------------

  async pedidosVista(q: ConsultaCfo, filtro: FiltroPedidosDetalle, limite: number, cursor: string | null): Promise<PedidosVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    this.usados.add("ventas");
    let l: Awaited<ReturnType<CfoRepository["pedidosDetalle"]>> = { disponible: false, filas: [], cursorSiguiente: null };
    try {
      l = await this.e.repo.pedidosDetalle(this.params, r, filtro, limite, cursor, cfg.promesaMin);
    } catch (err) {
      if (ServicioCfo.esFatal(err)) throw err;
      this.e.onError?.("ventas", err);
    }
    if (!l.disponible) this.caidos.add("ventas");
    const avisos: string[] = [];
    if (l.disponible && l.filas.length === 0) avisos.push("No hay pedidos con ese filtro en el periodo seleccionado.");
    const cab = await this.cabecera(q, avisos);
    return { ...cab, pedidos: this.soloSucursales(l.filas), cursor: l.cursorSiguiente, limite };
  }

  // ---- /config, /costos --------------------------------------------------------------------------------------------------------------

  async configVista(): Promise<ConfigVista> {
    const l = await this.cfg();
    return {
      disponible: l.disponible,
      config: l.config,
      configurada: l.configurada,
      defaults: CFO_CONFIG_POR_DEFECTO,
      rangos: RANGOS_CONFIG_CFO,
      puedeGuardar: this.e.alcance.organizacionCompleta,
    };
  }

  async costosVista(mesDesde: string, mesHasta: string): Promise<CostoVista> {
    const l = await this.marcar("captura", this.e.repo.costosLeer(this.params, mesDesde, mesHasta));
    return {
      disponible: l.disponible,
      costos: this.enAlcance(l.filas),
      conceptos: CONCEPTOS_COSTO,
      sucursales: this.e.sucursales,
      puedeCapturarOrganizacion: this.e.alcance.organizacionCompleta,
    };
  }

  async costoHistorialVista(propertyId: string | null, mes: string, concepto: ConceptoCosto): Promise<CostoHistorialVista> {
    const l = await this.marcar("captura", this.e.repo.costoHistorial(this.e.organizationId, propertyId, mes, concepto));
    return { disponible: l.disponible, historial: l.filas };
  }

  // ---- SoftRestaurant ----------------------------------------------------------------------------------------------------------------

  async lotesSr(limite: number): Promise<LotesSrVista> {
    const l = await this.marcar("captura", this.e.repo.srLotes(this.params, limite));
    const c = await this.marcar("captura", this.e.repo.srCobertura(this.params));
    return { disponible: l.disponible && c.disponible, lotes: this.soloSucursales(l.filas), cobertura: this.soloSucursales(c.filas) };
  }

  async cuadreSr(q: ConsultaCfo): Promise<CuadreSrVista> {
    const r: RangoCfo = { desde: q.desde, hasta: q.hasta };
    const cfg = await this.config();
    const ids = [...this.idsAlcance];
    const ventas = await this.ventas(r);
    const sr = await this.srResumen(r);
    const filas: FilaCuadreApi[] = [];
    for (const id of ids) {
      const srProp = sr.filas.filter((f) => f.propertyId === id);
      const diasSr = [...new Set(srProp.map((f) => f.diaNegocio))].sort();
      for (const dia of diasSr) {
        const srDom = srProp.filter((f) => f.diaNegocio === dia && f.tipoServicio === "domicilio");
        const nuestras = ventas.filas.filter((f) => f.propertyId === id && f.diaNegocio === dia && f.canal === "domicilio");
        const srCent = srDom.reduce((s, f) => s + f.netaCentavos, 0);
        const tickets = srDom.reduce((s, f) => s + f.tickets, 0);
        const nuestro = nuestras.reduce((s, f) => s + f.netaCentavos, 0);
        const pedidos = nuestras.reduce((s, f) => s + f.pedidos, 0);
        const c = cuadreSr({ nuestroCentavos: nuestro, srCentavos: srCent, pedidosNuestros: pedidos, ticketsSr: tickets }, cfg);
        filas.push({
          propertyId: id, nombre: this.nombre(id), diaNegocio: dia, nuestroDomicilioCentavos: nuestro, nuestroPedidos: pedidos, srDomicilioCentavos: srCent, srTickets: tickets,
          diferenciaCentavos: c.diferenciaCentavos, diferenciaPct: c.diferenciaPct, diferenciaPedidos: c.diferenciaPedidos, semaforo: c.semaforo,
        });
      }
    }
    const peor = (a: FilaCuadreApi["semaforo"], b: FilaCuadreApi["semaforo"]): FilaCuadreApi["semaforo"] => {
      const rank = { sin_datos: 0, verde: 1, ambar: 2, rojo: 3 } as const;
      return rank[b] > rank[a] ? b : a;
    };
    const porSucursal = ids.map((id) => {
      const fs = filas.filter((f) => f.propertyId === id);
      const c = fs.length === 0 ? null : cuadreSr({ nuestroCentavos: fs.reduce((s, f) => s + f.nuestroDomicilioCentavos, 0), srCentavos: fs.reduce((s, f) => s + (f.srDomicilioCentavos ?? 0), 0), pedidosNuestros: fs.reduce((s, f) => s + f.nuestroPedidos, 0), ticketsSr: fs.reduce((s, f) => s + (f.srTickets ?? 0), 0) }, cfg);
      return {
        propertyId: id, nombre: this.nombre(id), diasConDato: fs.length,
        semaforo: fs.reduce<FilaCuadreApi["semaforo"]>((p, f) => peor(p, f.semaforo), "sin_datos"), diferenciaCentavos: c ? c.diferenciaCentavos : null,
      };
    });
    const avisos: string[] = [];
    if (sr.disponible && sr.filas.length === 0) avisos.push("Sin datos de mostrador de SoftRestaurant: suba el reporte de ventas por tipo de servicio o el listado de cuentas.");
    avisos.push("El cuadre compara solo el domicilio del agente con el «domicilio» de SoftRestaurant en los días que el reporte trae; nunca se suman ambos.");
    const cab = await this.cabecera(q, avisos);
    return { ...cab, filas, porSucursal, umbrales: { verdePct: cfg.srCuadreVerdePct, ambarPct: cfg.srCuadreAmbarPct, verdeCentavos: cfg.srCuadreVerdeCentavos } };
  }

  /** Hora de corte (`HH:MM`) del día de negocio de una sucursal; `00:00` si la base aún no la informa. Lo usa la importación de SoftRestaurant. */
  async corteDe(propertyId: string): Promise<string> {
    const c = (await this.cobertura()).filas.find((f) => f.propertyId === propertyId);
    return corteHHMM(c?.corte) ?? "00:00";
  }

  // ---- escrituras: delegan al repositorio (la SQL valida y deja la bitácora) ------------------------------------------------------------

  /** Falla con `CfoNoDisponibleError` si la base no tiene aún la lectura de la que depende (usado por las rutas de escritura). */
  async exigirCaptura(): Promise<void> {
    const l = await this.cfg();
    if (!l.disponible) throw new CfoNoDisponibleError();
  }
}

function medianaNum(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 1 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
}

