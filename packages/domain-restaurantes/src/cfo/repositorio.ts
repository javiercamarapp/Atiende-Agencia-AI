// CFO-05 · puerto de lectura/escritura del CFO de restaurantes (una llamada por función SQL de 081/082/083; CFO-02b suma las de la 084).
//
// Contrato (lecciones de la revisión de CFO-01..04):
//  - Las llamadas son SECUENCIALES: comparten UNA sesión (la transacción única del request) y cada una abre su SAVEPOINT. Nunca `Promise.all`.
//  - Base sin migrar: una LECTURA responde `{ disponible: false, filas: [] }` (nunca 500); una ESCRITURA lanza `CfoNoDisponibleError` (503 honesto).
//  - `22023` -> `CfoParametroInvalidoError` (400) y `42501` -> `CfoSinAccesoError` (403); cualquier otro error se repropaga.
//  - node-postgres entrega bigint y numeric como STRING: el adaptador Postgres los convierte con `numericoSql`; este puerto ya habla en números.
//  - NULL ≠ 0: los campos que la SQL deja NULL (costo de Meta con 0 eventos, LLM en demos, centavos sin tipo de cambio) llegan como `null`.
//  - Sin PII: ninguna fila lleva nombre, teléfono ni dirección de cliente (el detalle de pedidos identifica con un alias de 8 caracteres).
import type {
  CfoConfig,
  ConceptoCosto,
  FilaAgenteDiario,
  FilaAgotado,
  FilaCanastaPar,
  FilaCanastaTicket,
  FilaCanastaTotales,
  FilaClientesAltas,
  FilaClientesCohorte,
  FilaClientesResumen,
  FilaClientesSegmentoHora,
  FilaCobertura,
  FilaColonia,
  FilaComandasPos,
  FilaCortesias,
  FilaCostoCaptura,
  FilaDescuentoP90,
  FilaEntregaPercentiles,
  FilaEntregas,
  FilaEscalacionHora,
  FilaFrecuentesDormidos,
  FilaPedidoDetalle,
  FilaProducto,
  FilaRepartidor,
  FilaSrResumen,
  FilaVentasDiarias,
  FilaVentasHora,
  TipoLayoutSr,
} from "./tipos.ts";

/** Alcance de una consulta: organización y sucursales. `propertyIds: null` = todas las permitidas del actor (la SQL resuelve el alcance). */
export interface ParamsCfo {
  readonly organizationId: string;
  readonly propertyIds: readonly string[] | null;
}

/** Rango de días de negocio `YYYY-MM-DD`, ambos extremos incluidos (la SQL rechaza más de 400 días con 22023). */
export interface RangoCfo {
  readonly desde: string;
  readonly hasta: string;
}

/** Resultado de una lectura. `disponible: false` = la base aún no tiene la migración de esa función (081, 082 o 083). */
export interface LecturaCfo<T> {
  readonly disponible: boolean;
  readonly filas: readonly T[];
}

export interface LecturaCanasta {
  readonly disponible: boolean;
  readonly pares: readonly FilaCanastaPar[];
  readonly totales: readonly FilaCanastaTotales[];
  readonly tickets: readonly FilaCanastaTicket[];
}

export interface LecturaPedidosDetalle {
  readonly disponible: boolean;
  readonly filas: readonly FilaPedidoDetalle[];
  /** Cursor de la página siguiente; null = no hay más. */
  readonly cursorSiguiente: string | null;
}

export interface FiltroPedidosDetalle {
  readonly canal?: string;
  readonly source?: string;
  readonly status?: string;
  readonly payment_method?: string;
  readonly producto_ref?: string;
  readonly es_venta?: boolean;
  readonly es_compensacion?: boolean;
  readonly con_descuento?: boolean;
  readonly entrega_tarde?: boolean;
  readonly hora_local?: number;
  readonly dow_negocio?: number;
}

export interface UmbralesClientes {
  readonly frecuenteN: number;
  readonly frecuenteDias: number;
  readonly activoDias: number;
  readonly perdidoDias: number;
}

/** Parámetros de `cfo_clientes_frecuentes_dormidos`: N y X salen de `cfo_config` si se omiten; M (días sin pedir) es obligatorio. */
export interface ParamsFrecuentesDormidos {
  readonly frecuenteN?: number;
  readonly frecuenteDias?: number;
  /** Días sin pedir para considerar dormido (7..365). */
  readonly dormidoDias: number;
  /** Cuántos clientes (alias hash) devolver en la muestra de cada renglón, 0..50. */
  readonly muestra?: number;
}

export interface LecturaConfig {
  readonly disponible: boolean;
  readonly config: CfoConfig;
  /** false = la organización nunca guardó configuración (rigen los defaults de la base). */
  readonly configurada: boolean;
}

export interface CostoCapturadoDetalle extends FilaCostoCaptura {
  readonly id: string;
  readonly nota: string | null;
  readonly creadoEn: string;
}

export interface CostoHistorialItem {
  readonly id: string;
  readonly version: number;
  readonly montoCentavos: number | null;
  readonly pct: number | null;
  readonly nota: string | null;
  readonly creadoPor: string | null;
  readonly creadoEn: string;
  readonly vigente: boolean;
}

export interface GuardarCostoEntrada {
  readonly organizationId: string;
  /** null = costo de la organización («No asignado»): exige alcance de organización completa. */
  readonly propertyId: string | null;
  /** Día 1 del mes: `YYYY-MM-01`. */
  readonly mes: string;
  readonly concepto: ConceptoCosto;
  readonly montoCentavos: number | null;
  readonly pct: number | null;
  readonly nota: string | null;
}

export interface LoteSr {
  readonly id: string;
  readonly propertyId: string;
  readonly tipo: TipoLayoutSr;
  readonly nombreArchivo: string;
  readonly fechaMin: string | null;
  readonly fechaMax: string | null;
  readonly renglones: number;
  readonly aceptados: number;
  readonly rechazados: number;
  readonly estado: "aplicado" | "reemplazado";
  readonly origen: "archivo" | "api";
  readonly creadoEn: string;
}

export interface CoberturaSr {
  readonly propertyId: string;
  readonly diasConDato: number;
  readonly diaMin: string | null;
  readonly diaMax: string | null;
  readonly dias: readonly string[];
}

export interface ErrorImportacionSr {
  readonly renglon: number;
  readonly campo: string;
  readonly motivo: string;
}

export interface ImportarSrEntrada {
  readonly organizationId: string;
  readonly propertyId: string;
  /** sha-256 hexadecimal en minúsculas, calculado por el llamador sobre archivo + mapeo. */
  readonly huella: string;
  readonly tipo: TipoLayoutSr;
  readonly nombreArchivo: string;
  readonly renglones: readonly Readonly<Record<string, unknown>>[];
}

export interface ResultadoImportacionSr {
  /** null si ningún renglón fue válido (no se crea lote). */
  readonly loteId: string | null;
  /** false = la misma huella ya estaba importada (idempotente) o no se aceptó ningún renglón. */
  readonly creado: boolean;
  readonly aceptados: number;
  readonly rechazados: number;
  readonly errores: readonly ErrorImportacionSr[];
}

export type VistaExportacionCfo = "resumen" | "ventas" | "sucursales" | "estado_resultados" | "clientes" | "platillos" | "patrones" | "operacion" | "softrestaurant";

export interface RegistrarExportacionEntrada {
  readonly organizationId: string;
  readonly propertyIds: readonly string[] | null;
  readonly vista: VistaExportacionCfo;
  readonly formato: "xlsx" | "pdf";
  readonly desde: string;
  readonly hasta: string;
}

/** Parámetros SQL inválidos (22023): el mensaje de la base es seguro de mostrar (no lleva datos del negocio). */
export class CfoParametroInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfoParametroInvalidoError";
  }
}

/** Sucursal u organización sin acceso (42501): el mismo error para una sucursal ajena que para una inexistente. */
export class CfoSinAccesoError extends Error {
  constructor(message = "No tienes acceso a esta sucursal.") {
    super(message);
    this.name = "CfoSinAccesoError";
  }
}

/** Escritura contra una base sin la migración correspondiente (503 honesto). */
export class CfoNoDisponibleError extends Error {
  constructor(message = "Esta función del CFO todavía no está disponible en esta base de datos.") {
    super(message);
    this.name = "CfoNoDisponibleError";
  }
}

export interface CfoRepository {
  // ---- 081: ventas y productos ----
  ventasDiarias(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaVentasDiarias>>;
  cortesias(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaCortesias>>;
  ventasHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaVentasHora>>;
  productos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaProducto>>;
  canastaPares(p: ParamsCfo, r: RangoCfo, limite: number): Promise<LecturaCanasta>;
  pedidosDetalle(p: ParamsCfo, r: RangoCfo, filtro: FiltroPedidosDetalle, limite: number, cursor: string | null, promesaMin: number): Promise<LecturaPedidosDetalle>;
  cobertura(p: ParamsCfo): Promise<LecturaCfo<FilaCobertura>>;

  // ---- 082: clientes, agente, operación ----
  clientesResumen(p: ParamsCfo, r: RangoCfo, umbrales: UmbralesClientes): Promise<LecturaCfo<FilaClientesResumen>>;
  clientesCohortes(p: ParamsCfo, meses: number): Promise<LecturaCfo<FilaClientesCohorte>>;
  clientesAltas(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaClientesAltas>>;
  clientesSegmentoHora(p: ParamsCfo, r: RangoCfo, umbrales: Pick<UmbralesClientes, "frecuenteN" | "frecuenteDias">): Promise<LecturaCfo<FilaClientesSegmentoHora>>;
  agenteDiario(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaAgenteDiario>>;
  escalacionesHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEscalacionHora>>;
  entregas(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaEntregas>>;
  entregasPercentiles(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEntregaPercentiles>>;
  repartidores(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaRepartidor>>;
  colonias(p: ParamsCfo, r: RangoCfo, k: number): Promise<LecturaCfo<FilaColonia>>;
  comandasPos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaComandasPos>>;
  /** Solo agotados vigentes; `rankingUnidades` queda en null (lo calcula el servicio con `productos`). */
  agotados(p: ParamsCfo): Promise<LecturaCfo<FilaAgotado>>;

  // ---- 084: huecos del CFO (CFO-02b) ----
  /** Frecuentes dormidos al cierre `hasta` (día de negocio). Base sin la 084: `disponible: false`. */
  clientesFrecuentesDormidos(p: ParamsCfo, hasta: string, params: ParamsFrecuentesDormidos): Promise<LecturaCfo<FilaFrecuentesDormidos>>;
  /** p90 del descuento % diario de los `dias` días que terminan en `hasta` (14..365). Base sin la 084: `disponible: false`. */
  descuentoP90(p: ParamsCfo, hasta: string, dias: number): Promise<LecturaCfo<FilaDescuentoP90>>;

  // ---- 083: configuración, costos capturados, SoftRestaurant, bitácora ----
  configLeer(organizationId: string): Promise<LecturaConfig>;
  /** `cambios` usa las llaves SQL de `cfo_config_guardar` (snake_case). */
  configGuardar(organizationId: string, cambios: Readonly<Record<string, number | null>>): Promise<void>;
  costosLeer(p: ParamsCfo, mesDesde: string, mesHasta: string): Promise<LecturaCfo<CostoCapturadoDetalle>>;
  costoGuardar(e: GuardarCostoEntrada): Promise<string>;
  costoHistorial(organizationId: string, propertyId: string | null, mes: string, concepto: ConceptoCosto): Promise<LecturaCfo<CostoHistorialItem>>;
  srResumenLeer(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaSrResumen>>;
  srLotes(p: ParamsCfo, limite: number): Promise<LecturaCfo<LoteSr>>;
  srCobertura(p: ParamsCfo): Promise<LecturaCfo<CoberturaSr>>;
  srImportar(e: ImportarSrEntrada): Promise<ResultadoImportacionSr>;
  registrarExportacion(e: RegistrarExportacionEntrada): Promise<string>;
}

/** Bloques de datos del CFO según la migración que los respalda. */
export const BLOQUES_CFO = ["ventas", "clientes", "captura"] as const;
export type BloqueCfo = (typeof BLOQUES_CFO)[number];
