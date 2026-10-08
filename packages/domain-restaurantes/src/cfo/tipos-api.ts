// CFO-05 · contrato tipado de la API `/v1/restaurantes/:propertyId/admin/cfo/*`. CFO-07 y CFO-08 (web) importan estos tipos desde
// `@atiende/domain-restaurantes/cfo`; no se duplican en la web.
//
// Reglas del contrato (diseño §3):
//  - Montos en CENTAVOS enteros (`*Centavos`). Razones en % con 1 decimal calculadas desde sumas. Minutos con 1 decimal.
//  - `Cifra { valor, confianza, fuente }`: `valor: null` = «sin dato» (la pantalla dice «—» o «captura pendiente»), NUNCA 0.
//  - Consolidado = Σ sucursales + «No asignado»: `noAsignado` solo viene con alcance de organización completa (nunca para un admin acotado).
//  - Clientes únicos NO se suman entre sucursales: `clientes.conjunto` se calcula aparte y `multiSucursal` dice cuántos compraron en 2+.
//  - Sin PII: ningún campo lleva nombre, teléfono ni dirección de cliente (el detalle de pedidos usa un alias de 8 caracteres). Los
//    repartidores aparecen por nombre de staff solo para owner/admin.
//  - `bloques`: qué migración respalda cada bloque de datos. `false` = la base aún no la tiene; la vista responde 200 con ese bloque vacío y un aviso.
import type { CriterioOrden, Hallazgo } from "./hallazgos.ts";
import type { ResumenNarrado } from "./narrativa.ts";
import type { EstadoResultados, Granularidad } from "./estado-resultados.ts";
import type { SemaforoCuadre, SumasAgente, SumasComandas, SumasVentas } from "./formulas.ts";
import type { CoberturaSr, CostoCapturadoDetalle, CostoHistorialItem, ErrorImportacionSr, LoteSr, ResultadoImportacionSr } from "./repositorio.ts";
import type {
  AlcanceSucursales,
  CanalPedido,
  CfoConfig,
  Cifra,
  ConceptoCosto,
  FilaClientesAltas,
  FilaClientesResumen,
  FilaColonia,
  FilaEscalacionHora,
  FilaPedidoDetalle,
  FilaRepartidor,
  FuenteDatosCfo,
  OrigenPedido,
  TipoBaseComparacion,
  TipoLayoutSr,
  TipoServicioSr,
} from "./tipos.ts";

export type { CriterioOrden, Granularidad };

/** `comparar` del query. */
export type CompararCfo = "periodo_anterior" | "anio_anterior" | "mismo_dia_semana_4";
export const COMPARAR_CFO: readonly CompararCfo[] = ["periodo_anterior", "anio_anterior", "mismo_dia_semana_4"];
export const GRANULARIDADES_CFO: readonly Granularidad[] = ["dia", "semana", "mes"];

export const COMPARAR_A_BASE: Readonly<Record<CompararCfo, TipoBaseComparacion>> = {
  periodo_anterior: "periodo_anterior",
  anio_anterior: "mismo_periodo_anio_pasado",
  mismo_dia_semana_4: "promedio_mismo_dia_4_semanas",
};

/** Qué datos respalda cada migración: ventas = 081, clientes = 082 (clientes, agente, operación), captura = 083 (config, costos, SoftRestaurant). */
export interface BloquesCfo {
  readonly ventas: boolean;
  readonly clientes: boolean;
  readonly captura: boolean;
}

export interface SucursalApi {
  readonly propertyId: string;
  readonly nombre: string;
  readonly slug: string;
  /** false = sucursal inactiva con historia: sigue contando en los totales de la organización completa. Ausente = se asume activa. */
  readonly activa?: boolean;
}

export interface AlcanceApi extends AlcanceSucursales {
  /** «Todas tus sucursales» / «Tus 2 sucursales» (admin acotado) / nombres elegidos. */
  readonly etiqueta: string;
}

export interface PeriodoApi {
  readonly desde: string;
  readonly hasta: string;
  readonly dias: number;
  readonly comparar: CompararCfo;
  readonly granularidad: Granularidad;
  /** Rango contra el que se compara (null con «mismo día de la semana»: son 4 ventanas). */
  readonly comparadoDesde: string | null;
  readonly comparadoHasta: string | null;
}

/** Todas las vistas llevan esta cabecera. */
export interface VistaCfoBase {
  readonly alcance: AlcanceApi;
  readonly sucursales: readonly SucursalApi[];
  readonly periodo: PeriodoApi;
  /** true solo si TODOS los bloques que usa la vista están disponibles. */
  readonly disponible: boolean;
  readonly bloques: BloquesCfo;
  readonly fuentes: readonly FuenteDatosCfo[];
  readonly avisos: readonly string[];
  readonly avisoLegal: string;
}

/** Un renglón por sucursal + «No asignado» (solo organización completa) + total. */
export interface PorSucursalApi<T> {
  readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string } & T>;
  readonly noAsignado: T | null;
  readonly total: T;
}

// ---- /alcance ----------------------------------------------------------------------------------------------------------------------------

export interface SucursalAlcanceApi extends SucursalApi {
  readonly zona: string | null;
  /** Corte del día de negocio, `HH:MM` (p. ej. «01:00»). */
  readonly corte: string | null;
}

export interface CoberturaFuenteApi {
  readonly propertyId: string;
  readonly primerDia: string | null;
  readonly ultimoDia: string | null;
}

export interface CoberturaSrApi {
  readonly propertyId: string;
  readonly diasConDato: number;
  readonly diaMin: string | null;
  readonly diaMax: string | null;
}

export interface AlcanceVista {
  readonly alcance: AlcanceApi;
  readonly sucursales: readonly SucursalAlcanceApi[];
  /** true solo si ventas (081), clientes (082) y captura (083) están disponibles. */
  readonly disponible: boolean;
  readonly bloques: BloquesCfo;
  readonly cobertura: {
    readonly pedidos: readonly CoberturaFuenteApi[];
    readonly softrestaurant: readonly CoberturaSrApi[];
    /** Meses (`YYYY-MM-01`) con al menos un costo capturado en los últimos 12 meses. */
    readonly costosMeses: readonly string[];
  };
  /** Modo de envío de comandas a SoftRestaurant: `apagado`, `sombra` o `activo`. null = sin dato. */
  readonly modoSr: string | null;
  readonly organizacionCompleta: boolean;
  /** true = la organización ya guardó su configuración del CFO (si no, rigen los defaults). */
  readonly configurada: boolean;
  readonly fuentes: readonly FuenteDatosCfo[];
  readonly avisos: readonly string[];
  readonly avisoLegal: string;
}

// ---- /resumen ----------------------------------------------------------------------------------------------------------------------------

export type Semaforo = "verde" | "ambar" | "rojo" | "sin_dato";
export type TipoValorKpi = "centavos" | "pct" | "entero" | "minutos";

export interface VariacionKpi {
  /** `pct` = variación porcentual (monto/conteo); `pp` = diferencia en puntos porcentuales (razones); `minutos` = diferencia en minutos. */
  readonly tipo: "pct" | "pp" | "minutos";
  readonly valor: number | null;
}

export interface KpiTarjeta {
  readonly id: string;
  readonly etiqueta: string;
  readonly tipo: TipoValorKpi;
  readonly valor: Cifra;
  /** Valor del comparativo calculado con la misma fórmula (null = sin base). */
  readonly base: number | null;
  readonly variacion: VariacionKpi;
  readonly semaforo: Semaforo;
  /** Qué dirección es «mejor» (para pintar la variación). */
  readonly mejorSi: "mayor" | "menor" | "neutral";
}

export interface ResumenColumna {
  readonly kpis: readonly KpiTarjeta[];
  /** Sumas aditivas del periodo (Σ sucursales = total). */
  readonly sumas: SumasVentas;
}

export interface TitularApi {
  readonly etiqueta: string;
  readonly origen: "agente" | "softrestaurant";
  readonly cifra: Cifra;
}

export interface ResumenVista extends VistaCfoBase {
  readonly titular: TitularApi;
  readonly kpis: {
    readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string } & ResumenColumna>;
    /** «No asignado a sucursal» (LLM de texto de la organización): solo con alcance de organización completa. */
    readonly noAsignado: { readonly costoAgenteCentavos: Cifra; readonly llmTexto: Cifra } | null;
    readonly total: ResumenColumna;
  };
  readonly hallazgos: readonly Hallazgo[];
  readonly orden: CriterioOrden;
  readonly narrativa: ResumenNarrado;
  /** Clientes que compraron en 2+ sucursales (no aditivo). null = sin dato de clientes. */
  readonly multiSucursal: { readonly clientes: number | null; readonly texto: string | null };
}

// ---- /ventas -----------------------------------------------------------------------------------------------------------------------------

export interface PuntoSerie {
  /** Clave del periodo: `YYYY-MM-DD` (día), lunes de la semana o `YYYY-MM`. */
  readonly clave: string;
  readonly desde: string;
  readonly hasta: string;
  readonly pedidos: number;
  readonly brutaCentavos: number;
  readonly netaCentavos: number;
  readonly ticketCentavos: number | null;
}

export interface FilaCanalApi {
  readonly canal: CanalPedido;
  readonly source: OrigenPedido;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly mixPedidosPct: number | null;
  readonly mixVentasPct: number | null;
}

export interface CeldaHeatmap {
  /** 1 = lunes … 7 = domingo, del día de NEGOCIO. */
  readonly dow: number;
  readonly hora: number;
  readonly pedidos: number;
  readonly netaCentavos: number;
}

export interface CascadaVentas {
  readonly brutaCentavos: Cifra;
  readonly descuentoPromocionCentavos: Cifra;
  readonly compensacionesCentavos: Cifra;
  readonly netaCentavos: Cifra;
  readonly ivaEstimadoCentavos: Cifra;
  readonly netaSinIvaCentavos: Cifra;
  /** bruta − descuentos − neta. Debe ser 0: si no, hay un descuadre. */
  readonly descuadreCentavos: number;
}

export interface VentasColumna {
  readonly sumas: SumasVentas;
  readonly serie: readonly PuntoSerie[];
  readonly cascada: CascadaVentas;
  readonly cancelacionPct: Cifra;
  readonly cortesias: Cifra;
}

export interface VentasVista extends VistaCfoBase {
  readonly titular: TitularApi;
  readonly ventas: PorSucursalApi<VentasColumna>;
  /** Serie del comparativo, alineada por posición con `total.serie` (null con «mismo día de la semana»). */
  readonly serieComparativo: readonly PuntoSerie[] | null;
  readonly porCanal: readonly FilaCanalApi[];
  readonly heatmap: readonly CeldaHeatmap[];
  readonly formaPago: ReadonlyArray<{ readonly formaPago: "efectivo" | "tarjeta" | "sin_dato"; readonly pedidos: number; readonly netaCentavos: number }>;
  readonly propinas: { readonly tarjetaCentavos: Cifra; readonly nota: string };
  readonly cancelaciones: {
    readonly cancelados: number;
    readonly canceladosCentavos: number;
    readonly noRecogidos: number;
    readonly noRecogidosCentavos: number;
    readonly cancelacionPct: Cifra;
  };
}

// ---- /sucursales -------------------------------------------------------------------------------------------------------------------------

export interface FilaSucursalApi {
  readonly propertyId: string;
  readonly nombre: string;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly participacionPct: Cifra;
  readonly ticket: Cifra;
  readonly descuentoPct: Cifra;
  readonly cancelacionPct: Cifra;
  readonly entregaPromedioMin: Cifra;
  readonly entregaP90Min: Cifra;
  readonly costoPorPedidoAgente: Cifra;
  readonly miniTendencia: readonly number[];
}

export interface OutlierApi {
  readonly propertyId: string;
  readonly nombre: string;
  readonly metrica: "netaCentavos" | "ticket" | "cancelacionPct" | "descuentoPct";
  readonly valor: number;
  readonly mediana: number;
  /** z-score entre sucursales (null con menos de 3). */
  readonly z: number | null;
  readonly motivo: "z>=2" | ">=2xMediana";
}

export interface SucursalesVista extends VistaCfoBase {
  readonly tabla: readonly FilaSucursalApi[];
  readonly total: { readonly pedidos: number; readonly netaCentavos: number; readonly ticket: Cifra; readonly descuentoPct: Cifra; readonly cancelacionPct: Cifra };
  readonly noAsignado: { readonly costoAgenteCentavos: Cifra } | null;
  readonly ranking: ReadonlyArray<{ readonly posicion: number; readonly propertyId: string; readonly nombre: string; readonly netaCentavos: number }>;
  readonly outliers: readonly OutlierApi[];
}

// ---- /estado-resultados ------------------------------------------------------------------------------------------------------------------

export interface EstadoResultadosVista extends VistaCfoBase {
  readonly estadoResultados: EstadoResultados;
}

// ---- /clientes ---------------------------------------------------------------------------------------------------------------------------

export interface SegmentoClientesApi {
  readonly activos: number;
  readonly dormidos: number;
  readonly perdidos: number;
  readonly frecuentes: number;
  readonly frecuentesPct: Cifra;
}

export interface CohorteApi {
  readonly propertyId: string | null;
  readonly mesCohorte: string;
  readonly clientes: number;
  /** Tasas honestas: con_recompra_N / observables_N (null si ninguno es observable todavía). */
  readonly recompra30: { readonly con: number; readonly observables: number; readonly pct: Cifra };
  readonly recompra60: { readonly con: number; readonly observables: number; readonly pct: Cifra };
  readonly recompra90: { readonly con: number; readonly observables: number; readonly pct: Cifra };
}

export interface ClientesColumna {
  readonly resumen: FilaClientesResumen;
  readonly segmentos: SegmentoClientesApi;
  readonly churn: Cifra;
  readonly concentracion: Cifra;
  readonly valorDeVida: Cifra;
  readonly diasEntrePedidosMediana: Cifra;
  readonly winBack: { readonly recuperados: number; readonly recuperadosPorCampana: number };
}

export interface ClientesVista extends VistaCfoBase {
  /** Clientes únicos: `total` es el CONJUNTO (no la suma de sucursales); null si la base no devolvió el renglón del conjunto. */
  readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string } & ClientesColumna>;
  readonly total: ClientesColumna | null;
  readonly multiSucursal: { readonly clientes: number | null; readonly texto: string | null; readonly sumaPorSucursal: number };
  readonly definiciones: Readonly<Record<string, string>>;
  readonly cohortes: readonly CohorteApi[];
  readonly altas: { readonly porSemana: readonly FilaClientesAltas[]; readonly porMes: ReadonlyArray<{ readonly propertyId: string | null; readonly mes: string; readonly altas: number }> };
  readonly segmentoHora: ReadonlyArray<{ readonly segmento: string; readonly dow: number; readonly hora: number; readonly pedidos: number; readonly netaCentavos: number; readonly clientes: number }>;
  readonly pedidosSinCliente: number;
}

// ---- /productos --------------------------------------------------------------------------------------------------------------------------

export interface RankingProductoApi {
  readonly productoRef: string;
  readonly nombre: string;
  readonly categoria: string;
  readonly unidades: number;
  readonly ingresoCentavos: number;
  readonly pedidos: number;
  readonly participacionIngresoPct: number | null;
}

export type CuadranteProducto = "estrella" | "popular" | "rentable" | "revisar";

export interface PuntoMatriz {
  readonly productoRef: string;
  readonly nombre: string;
  readonly unidades: number;
  readonly ingresoCentavos: number;
  readonly cuadrante: CuadranteProducto;
}

export interface ParCanastaApi {
  readonly propertyId: string;
  readonly productoA: string;
  readonly nombreA: string;
  readonly productoB: string;
  readonly nombreB: string;
  readonly pedidosJuntos: number;
  readonly soportePct: number;
  readonly lift: number | null;
}

export interface AgotadoApi {
  readonly propertyId: string;
  readonly productId: string;
  readonly nombre: string;
  /** false = agotado. Con `agotadoHasta: null` es agotado INDEFINIDO. */
  readonly disponible: boolean;
  readonly agotadoHasta: string | null;
  readonly rankingUnidades: number | null;
  readonly unidades28d: number;
  readonly ventaEnRiesgoPorDia: Cifra;
}

export interface ProductosVista extends VistaCfoBase {
  readonly ranking: { readonly masVendidos: readonly RankingProductoApi[]; readonly menosVendidos: readonly RankingProductoApi[]; readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string; readonly masVendidos: readonly RankingProductoApi[] }> };
  readonly mixCategoria: ReadonlyArray<{ readonly categoria: string; readonly unidades: number; readonly ingresoCentavos: number; readonly participacionPct: number | null }>;
  readonly matriz: readonly PuntoMatriz[];
  readonly canasta: readonly ParCanastaApi[];
  readonly ticketPorNumeroProductos: ReadonlyArray<{ readonly nProductos: number; readonly pedidos: number; readonly netaCentavos: number; readonly ticketCentavos: number | null }>;
  readonly efectoPromocion: ReadonlyArray<{ readonly productoRef: string; readonly nombre: string; readonly efecto: Cifra }>;
  readonly agotados: readonly AgotadoApi[];
}

// ---- /patrones ---------------------------------------------------------------------------------------------------------------------------

export interface ColoniaApi {
  readonly propertyId: string;
  readonly colonia: string;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly ticket: Cifra;
  readonly entregaPromedioMin: Cifra;
  readonly sucursalCercanaId: string | null;
  readonly distanciaKm: number | null;
}

export interface PatronesVista extends VistaCfoBase {
  readonly estacionalidadSemanal: ReadonlyArray<{ readonly dow: number; readonly etiqueta: string; readonly pedidos: number; readonly netaCentavos: number; readonly promedioDiaCentavos: number | null }>;
  readonly estacionalidadMensual: ReadonlyArray<{ readonly mes: string; readonly pedidos: number; readonly netaCentavos: number; readonly dias: number }>;
  readonly colonias: readonly ColoniaApi[];
  readonly canalPorHora: ReadonlyArray<{ readonly source: OrigenPedido; readonly hora: number; readonly pedidos: number; readonly netaCentavos: number }>;
  readonly diasEntrePedidos: Cifra;
}

// ---- /operacion --------------------------------------------------------------------------------------------------------------------------

export interface EntregasSucursalApi {
  readonly propertyId: string | null;
  readonly nombre: string;
  readonly entregados: number;
  readonly promedioMin: Cifra;
  readonly p50Min: Cifra;
  readonly p90Min: Cifra;
  readonly tardePct: Cifra;
  /** true en el renglón del conjunto (el percentil no es la suma ni el promedio de los de cada sucursal). */
  readonly conjunto: boolean;
}

export interface EmbudoAgenteApi {
  readonly whatsapp: { readonly conversaciones: number; readonly conPedido: number; readonly conHandoff: number; readonly tasaCierre: Cifra };
  readonly voz: { readonly llamadas: number; readonly pedidoCreado: number; readonly escalado: number; readonly abandonado: number; readonly tasaCierre: Cifra };
  readonly tasaCierreAgente: Cifra;
}

export interface CostoAgenteApi {
  readonly total: Cifra;
  readonly voz: Cifra;
  readonly telefonia: Cifra;
  /** `valor: null` y fuente «Meta: no medido» cuando no hubo eventos: nunca $0. */
  readonly meta: Cifra;
  readonly llmTexto: Cifra;
  readonly porPedido: Cifra;
  readonly completo: boolean;
}

export interface OperacionVista extends VistaCfoBase {
  readonly entregas: readonly EntregasSucursalApi[];
  readonly entregasPorHora: ReadonlyArray<{ readonly hora: number; readonly entregados: number; readonly promedioMin: number | null; readonly tardePct: number | null }>;
  readonly repartidores: readonly FilaRepartidor[];
  readonly embudo: PorSucursalApi<EmbudoAgenteApi>;
  readonly costoAgente: PorSucursalApi<CostoAgenteApi>;
  readonly escalacionesPorHora: ReadonlyArray<{ readonly hora: number; readonly conversaciones: number; readonly handoffs: number; readonly handoffPct: number | null }>;
  readonly comandas: {
    readonly modo: string;
    readonly sumas: SumasComandas;
    readonly tasaCaptura: Cifra;
    readonly minutosACaptura: Cifra;
    readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string; readonly modo: string; readonly sumas: SumasComandas }>;
  };
}

// ---- /pedidos ----------------------------------------------------------------------------------------------------------------------------

export interface PedidosVista extends VistaCfoBase {
  readonly pedidos: readonly FilaPedidoDetalle[];
  /** Cursor de la página siguiente (null = no hay más). Se manda en `?cursor=`. */
  readonly cursor: string | null;
  readonly limite: number;
}

// ---- /config y /costos -------------------------------------------------------------------------------------------------------------------

export interface ConfigVista {
  readonly disponible: boolean;
  readonly config: CfoConfig;
  readonly configurada: boolean;
  readonly defaults: CfoConfig;
  /** Rangos válidos (los mismos que valida la base). */
  readonly rangos: Readonly<Record<string, readonly [number, number]>>;
  /** Solo owner/admin de organización completa guardan; un admin acotado la lee. */
  readonly puedeGuardar: boolean;
}

export interface CostoVista {
  readonly disponible: boolean;
  readonly costos: readonly CostoCapturadoDetalle[];
  readonly conceptos: readonly ConceptoCosto[];
  /** Sucursales a las que este actor puede capturar y si puede capturar a nivel organización («No asignado»). */
  readonly sucursales: readonly SucursalApi[];
  readonly puedeCapturarOrganizacion: boolean;
}

export interface CostoHistorialVista {
  readonly disponible: boolean;
  readonly historial: readonly CostoHistorialItem[];
}

// ---- SoftRestaurant ----------------------------------------------------------------------------------------------------------------------

export interface VistaPreviaSr {
  readonly ok: true;
  readonly tipo: TipoLayoutSr;
  /** Alias de columnas INFERIDOS hasta tener un export real de SoftRestaurant: el dueño confirma el mapeo. */
  readonly inferido: true;
  readonly avisoAlias: string;
  readonly mapeo: Readonly<Record<string, string>>;
  readonly ignoradas: readonly string[];
  readonly advertencias: readonly string[];
  readonly aceptados: number;
  readonly rechazados: number;
  readonly omitidos: number;
  readonly errores: readonly ErrorImportacionSr[];
  readonly fechaMin: string | null;
  readonly fechaMax: string | null;
  /** Primeros renglones normalizados (sin datos personales). */
  readonly muestra: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>>;
  /** Huella determinista del contenido normalizado (la misma que usará la importación). */
  readonly huella: string;
  /** No se escribió nada. */
  readonly escribio: false;
}

export interface ImportacionSrVista extends ResultadoImportacionSr {
  readonly tipo: TipoLayoutSr;
  readonly huella: string;
  readonly inferido: true;
}

export interface LotesSrVista {
  readonly disponible: boolean;
  readonly lotes: readonly LoteSr[];
  readonly cobertura: readonly CoberturaSr[];
}

export interface FilaCuadreApi {
  readonly propertyId: string;
  readonly nombre: string;
  readonly diaNegocio: string;
  readonly nuestroDomicilioCentavos: number;
  readonly nuestroPedidos: number;
  readonly srDomicilioCentavos: number | null;
  readonly srTickets: number | null;
  readonly diferenciaCentavos: number | null;
  readonly diferenciaPct: number | null;
  readonly diferenciaPedidos: number | null;
  readonly semaforo: SemaforoCuadre;
}

export interface CuadreSrVista extends VistaCfoBase {
  readonly filas: readonly FilaCuadreApi[];
  readonly porSucursal: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string; readonly diasConDato: number; readonly semaforo: SemaforoCuadre; readonly diferenciaCentavos: number | null }>;
  /** El semáforo de la fila se calcula con los umbrales de `cfo_config`. */
  readonly umbrales: { readonly verdePct: number; readonly ambarPct: number; readonly verdeCentavos: number };
}

export type { SumasAgente, FilaColonia, FilaEscalacionHora, TipoServicioSr };
