// CFO-04 · tipos del dominio puro del CFO de restaurantes.
//
// Las filas de entrada reflejan, columna por columna (snake_case SQL -> camelCase TS), lo que devuelven las funciones
// SQL de los briefs CFO-01 (081), CFO-02 (082) y CFO-03 (083). Este archivo NO toca la base: es el contrato que CFO-05
// (repositorios) debe cumplir al mapear filas.
//
// Convenciones:
//  - Montos: centavos ENTEROS (`*Centavos`). Nunca flotantes.
//  - `propertyId: null` = renglón «No asignado a sucursal» (LLM de texto de la organización, costos capturados a nivel
//    organización, eventos de costo sin sucursal). Solo existe con alcance de organización completa.
//  - Fechas de negocio: `YYYY-MM-DD` (día de negocio de la sucursal, con su corte; ver diseño §3.1).
//  - Un campo `null` significa «sin dato» (nunca 0).
//  - CONTRATO CON LA SQL (para CFO-05): node-postgres entrega los `numeric` como STRING; conviértalos con `numericoSql` (util.ts) antes de
//    construir estas filas. Los minutos (`entrega_min_suma`, `min_a_captura_suma`) son numeric con hasta 2 decimales y el dominio los opera en
//    centésimas enteras. `cfo_pedidos_detalle` devuelve `bruta`, `desc`, `neta`, `propina` (centavos) y `cursor_pagina`: se mapean a
//    `brutaCentavos`, `descCentavos`, `netaCentavos`, `propinaCentavos` y al cursor de paginación (no vive en estas filas).

/** Qué tan confiable es una cifra (diseño §3.6). */
export type Confianza = "medido" | "estimado" | "capturado" | "importado" | "sin_dato";

/** Una cifra con su procedencia. `valor: null` ⇒ la UI dice «sin datos», NUNCA 0. Montos en centavos enteros. */
export interface Cifra {
  readonly valor: number | null;
  readonly confianza: Confianza;
  /** Nombre corto de la fuente: `cfo_ventas_diarias`, `sr_resumen_dia`, `cfo_costo_captura`, `formula:...`. */
  readonly fuente: string;
}

/** Alcance de sucursales que el actor puede ver y que pidió ver (diseño §4.5). */
export interface AlcanceSucursales {
  /** Sucursales visibles y consultadas (ya resueltas contra la membresía). */
  readonly propertyIds: readonly string[];
  /** true = «Todas» (las permitidas); false = el usuario eligió un subconjunto. */
  readonly todas: boolean;
  /** true = owner/admin sin `property_ids` acotado: puede ver la fila «No asignado». Un admin acotado NUNCA la ve. */
  readonly organizacionCompleta: boolean;
}

/** Datos mínimos de una sucursal para etiquetar. */
export interface SucursalCfo {
  readonly propertyId: string;
  readonly nombre: string;
}

// ---- Canales y enumeraciones -------------------------------------------------------------------------------------------------------------

export type CanalPedido = "domicilio" | "recoger";
export type OrigenPedido = "web" | "voice" | "whatsapp" | "admin";
export type FormaPagoPedido = "efectivo" | "tarjeta";
export type TipoServicioSr = "comedor" | "para_llevar" | "domicilio" | "rapido" | "otro";
export type TipoLayoutSr = "resumen_servicio" | "cuentas";
export type ConceptoCosto =
  | "insumos"
  | "food_cost_objetivo_pct"
  | "nomina"
  | "renta"
  | "servicios"
  | "comision_terminal"
  | "marketing"
  | "mantenimiento"
  | "otros";

// ---- Filas de entrada: CFO-01 (081) ------------------------------------------------------------------------------------------------------

/** `cfo_ventas_diarias`: una fila por property × día × canal × source × forma de pago. Solo sumas y conteos aditivos. */
export interface FilaVentasDiarias {
  readonly propertyId: string;
  readonly diaNegocio: string;
  readonly canal: CanalPedido;
  readonly source: OrigenPedido;
  readonly paymentMethod: FormaPagoPedido | null;
  readonly pedidos: number;
  readonly brutaCentavos: number;
  readonly descPromoCentavos: number;
  readonly descCompCentavos: number;
  readonly netaCentavos: number;
  readonly propinaCentavos: number;
  readonly cancelados: number;
  readonly canceladosCentavos: number;
  readonly noRecogidos: number;
  readonly noRecogidosCentavos: number;
  readonly reposiciones: number;
  readonly reposicionUnidades: number;
  readonly entregados: number;
  readonly entregaMinSuma: number;
  readonly entregaTarde: number;
}

/** `cfo_cortesias`: reposiciones a $0 valuadas a precio de lista (ESTIMADO). */
export interface FilaCortesias {
  readonly propertyId: string;
  readonly diaNegocio: string;
  readonly reposiciones: number;
  readonly valorListaCentavos: number;
  readonly renglonesSinPrecio: number;
}

/** `cfo_ventas_hora`. */
export interface FilaVentasHora {
  readonly propertyId: string;
  /** 1 = lunes … 7 = domingo, del día de NEGOCIO. */
  readonly dowNegocio: number;
  readonly horaLocal: number;
  readonly source: OrigenPedido;
  readonly pedidos: number;
  readonly netaCentavos: number;
}

/** `cfo_productos`. */
export interface FilaProducto {
  readonly propertyId: string;
  readonly productoRef: string;
  readonly nombreActual: string;
  readonly categoria: string;
  readonly diaNegocio: string;
  readonly dowNegocio: number;
  readonly unidades: number;
  readonly ingresoCentavos: number;
  readonly pedidos: number;
}

/** `cfo_canasta_pares`: pares (a < b) y totales para soporte/lift. */
export interface FilaCanastaPar {
  readonly propertyId: string;
  readonly productoA: string;
  readonly productoB: string;
  readonly pedidosJuntos: number;
}

/** Distribución del ticket por número de productos distintos (1..5+, el 5 agrupa «5 o más»). */
export interface FilaCanastaTicket {
  readonly propertyId: string;
  readonly nProductos: number;
  readonly pedidos: number;
  readonly netaCentavos: number;
}

export interface FilaCanastaTotales {
  readonly propertyId: string;
  readonly pedidosTotales: number;
  /** productoRef -> pedidos que contienen el producto. */
  readonly pedidosConProducto: Readonly<Record<string, number>>;
}

/** `cfo_pedidos_detalle` (drill-down sin PII). */
export interface FilaPedidoDetalle {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly propertyId: string;
  readonly diaNegocio: string;
  readonly horaLocal: number;
  readonly canal: CanalPedido;
  readonly source: OrigenPedido;
  readonly status: string;
  readonly paymentMethod: FormaPagoPedido | null;
  readonly brutaCentavos: number;
  readonly descCentavos: number;
  readonly netaCentavos: number;
  readonly propinaCentavos: number;
  readonly entregadoMin: number | null;
  readonly esCompensacion: boolean;
  readonly esReposicion: boolean;
  /** Alias de 8 caracteres (hash de `customer_id`); null si el pedido no tiene cliente identificado. Nunca nombre, teléfono ni dirección. */
  readonly clienteAlias: string | null;
  readonly comandaEstado: string | null;
}

/** `cfo_cobertura`. */
export interface FilaCobertura {
  readonly propertyId: string;
  readonly primerDia: string | null;
  readonly ultimoDia: string | null;
  readonly zona: string;
  readonly corte: string;
}

// ---- Filas de entrada: CFO-02 (082) ------------------------------------------------------------------------------------------------------

/**
 * `cfo_clientes_resumen`: un renglón por sucursal y un renglón de CONJUNTO (`propertyId: null`, `alcance: "conjunto"`).
 * Estas métricas NO son aditivas (un cliente compra en dos sucursales): el conjunto se calcula aparte (diseño §3.5).
 */
export interface FilaClientesResumen {
  readonly propertyId: string | null;
  readonly alcance: "sucursal" | "conjunto";
  readonly clientesConPedido: number;
  readonly nuevos: number;
  readonly recurrentes: number;
  readonly activos: number;
  readonly dormidos: number;
  readonly perdidos: number;
  readonly frecuentes: number;
  /** Solo en el renglón del conjunto: Σ clientes de las sucursales − clientes únicos del conjunto (lo que `consolidarClientes` verifica). */
  readonly multiSucursal: number | null;
  /** Solo en el renglón del conjunto: clientes distintos con pedido en 2 o más sucursales (conteo exacto; `multiSucursal` cuenta k−1 por cliente). */
  readonly clientesVariasSucursales: number | null;
  readonly recuperados: number;
  readonly recuperadosPorCampana: number;
  /** Clientes cuyo último pedido ANTERIOR al rango fue hace ≤ activo_dias (base del churn). */
  readonly activosAlInicio: number;
  /** De esos, los que al cierre del rango llevan más de perdido_dias sin pedir. */
  readonly pasanAPerdidos: number;
  readonly diasEntrePedidosMediana: number | null;
  readonly netaTop10pctCentavos: number;
  readonly netaTotalCentavos: number;
  readonly pedidosPorCliente12mPromedio: number | null;
  /** Pedidos de venta con cliente identificado / sin él (los segundos no entran a ninguna métrica de clientes). */
  readonly pedidosConCliente: number;
  readonly pedidosSinCliente: number;
}

export interface FilaClientesCohorte {
  readonly propertyId: string | null;
  /** `YYYY-MM`. */
  readonly mesCohorte: string;
  readonly clientes: number;
  readonly conRecompra30: number;
  readonly conRecompra60: number;
  readonly conRecompra90: number;
  /** Clientes cuya ventana de N días ya terminó: la tasa honesta es `conRecompraN / observablesN`. */
  readonly observables30: number;
  readonly observables60: number;
  readonly observables90: number;
}

/** `cfo_clientes_segmento_hora`. */
export interface FilaClientesSegmentoHora {
  readonly propertyId: string | null;
  readonly segmento: "nuevo" | "recurrente" | "frecuente";
  readonly dowNegocio: number;
  readonly horaLocal: number;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly clientes: number;
  readonly pedidosPorCliente: number | null;
}

export interface FilaClientesAltas {
  readonly propertyId: string | null;
  /** Lunes de la semana ISO. */
  readonly semana: string;
  readonly altas: number;
}

/** `cfo_agente_diario`. `propertyId: null` = no asignable (LLM de texto de la organización, eventos sin sucursal). */
export interface FilaAgenteDiario {
  readonly propertyId: string | null;
  readonly diaNegocio: string;
  readonly waConversacionesNuevas: number;
  readonly waConPedido: number;
  readonly waConHandoff: number;
  readonly waHandoffs: number;
  readonly vozLlamadas: number;
  readonly vozPedidoCreado: number;
  readonly vozEscalado: number;
  readonly vozAbandonado: number;
  readonly costoVozMicroUsd: number;
  readonly costoTelefoniaMicroUsd: number;
  /** null = 0 eventos de Meta: «no medido», NUNCA $0. */
  readonly costoMetaMicroUsd: number | null;
  /** Solo en el renglón no asignado (LLM de texto, es de la organización). null en organizaciones demo. */
  readonly costoLlmMicroUsd: number | null;
  /** null = no hubo `core.fx_rate` para convertir. NO es 0. */
  readonly costoVozCentavos: number | null;
  readonly costoTelefoniaCentavos: number | null;
  readonly costoMetaCentavos: number | null;
  readonly costoLlmCentavos: number | null;
  /** 0 eventos ⇒ el costo de Meta es «no medido» (nunca $0). */
  readonly metaEventos: number;
  /** Tipo de cambio MXN por USD con el que se convirtió el renglón. null = no hubo `core.fx_rate`. */
  readonly mxnPorUsd: number | null;
}

export interface FilaEscalacionHora {
  readonly propertyId: string;
  readonly dowNegocio: number;
  readonly horaLocal: number;
  readonly conversaciones: number;
  readonly handoffs: number;
}

export interface FilaEntregas {
  readonly propertyId: string;
  readonly horaLocal: number;
  readonly dowNegocio: number;
  readonly entregados: number;
  readonly minSuma: number;
  readonly tarde: number;
}

/** Percentiles de entrega: NO aditivos (por sucursal y del conjunto, calculado aparte). */
export interface FilaEntregaPercentiles {
  readonly propertyId: string | null;
  /** `conjunto` = percentil sobre todas las entregas del alcance (no se obtiene de los de cada sucursal). */
  readonly alcance: "sucursal" | "conjunto";
  readonly entregados: number;
  readonly p50Min: number | null;
  readonly p90Min: number | null;
}

export interface FilaRepartidor {
  readonly propertyId: string;
  readonly repartidorId: string;
  readonly nombre: string;
  readonly entregas: number;
  readonly minSuma: number;
  readonly tarde: number;
  readonly incidencias: number;
}

export interface FilaColonia {
  readonly propertyId: string;
  readonly colonia: string;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly entregados: number;
  readonly minSuma: number;
  readonly clientes: number;
  readonly sucursalCercanaId: string | null;
  readonly distanciaKm: number | null;
}

/** `cfo_comandas_pos`. */
export interface FilaComandasPos {
  readonly propertyId: string;
  readonly diaNegocio: string;
  /** Modo vigente de `softrestaurant_config` (`apagado` por omisión). */
  readonly modo: string;
  readonly encoladas: number;
  readonly confirmadas: number;
  readonly capturadasManual: number;
  readonly capturaManualPendientes: number;
  readonly fallidas: number;
  readonly pendientesEnviadas: number;
  readonly minACapturaSuma: number;
  readonly capturadasConTiempo: number;
  readonly vencidasUmbral: number;
  readonly conFolioPos: number;
  readonly conFolioDeclarado: number;
}

/** `cfo_agotados` (enriquecida por el repositorio con nombre y precio de lista vigente). */
export interface FilaAgotado {
  readonly propertyId: string;
  readonly productId: string;
  readonly nombre: string;
  /**
   * false = agotado. Con `agotadoHasta: null` y `disponible: false` el producto está agotado INDEFINIDAMENTE (la SQL solo lista
   * agotados vigentes). `disponible: true` con `agotadoHasta` es un agotado programado.
   */
  readonly disponible: boolean;
  /** `YYYY-MM-DD` (de la SQL) o ISO 8601; null = sin fecha de regreso. */
  readonly agotadoHasta: string | null;
  readonly unidades28d: number;
  readonly diasConVenta28d: number;
  readonly precioListaCentavos: number | null;
  /** Posición por unidades en el periodo (1 = el más vendido). null = no está en el ranking. */
  readonly rankingUnidades: number | null;
}

// ---- Filas de entrada: CFO-03 (083) ------------------------------------------------------------------------------------------------------

/** `cfo_costo_captura` (solo versiones vigentes). `propertyId: null` = organización («No asignado»). */
export interface FilaCostoCaptura {
  readonly propertyId: string | null;
  /** Día 1 del mes: `YYYY-MM-01`. */
  readonly mes: string;
  readonly concepto: ConceptoCosto;
  readonly montoCentavos: number | null;
  /** Solo para `food_cost_objetivo_pct`. Porcentaje (p. ej. 32 = 32 %). */
  readonly pct: number | null;
}

/** `sr_resumen_dia`: suma de lo vigente por sucursal × día × tipo de servicio × forma de pago. */
export interface FilaSrResumen {
  readonly propertyId: string;
  readonly diaNegocio: string;
  readonly tipoServicio: TipoServicioSr;
  readonly formaPago: string | null;
  readonly tickets: number;
  readonly brutaCentavos: number;
  readonly descuentoCentavos: number;
  readonly canceladoCentavos: number;
  readonly propinaCentavos: number;
  /** null si el archivo no trae IVA. */
  readonly ivaCentavos: number | null;
  readonly netaCentavos: number;
}

/** `sr_ticket` (layout de cuentas). Sin datos de cliente. */
export interface FilaSrTicket {
  readonly propertyId: string;
  readonly folio: string;
  readonly diaNegocio: string;
  readonly horaLocal: string | null;
  readonly tipoServicio: TipoServicioSr;
  readonly totalCentavos: number;
  readonly descuentoCentavos: number;
  readonly propinaCentavos: number;
  readonly formaPago: string | null;
  readonly cancelado: boolean;
}

/** `cfo_config` (una fila por organización; la base devuelve estos defaults si no hay fila). */
export interface CfoConfig {
  readonly frecuenteN: number;
  readonly frecuenteDias: number;
  readonly activoDias: number;
  readonly perdidoDias: number;
  readonly promesaMin: number;
  readonly ivaPct: number;
  // umbrales de hallazgos
  readonly caidaPct: number;
  readonly ticketBajaPct: number;
  readonly cancelacionXMediana: number;
  readonly descuentoMaxPct: number;
  readonly costoAgenteAlzaPct: number;
  readonly cierreBajaPp: number;
  readonly entregaP90MaxMin: number;
  readonly srCuadreVerdePct: number;
  readonly srCuadreAmbarPct: number;
  readonly srCuadreVerdeCentavos: number;
  /** null = captura pendiente. */
  readonly comisionTerminalPct: number | null;
}

/** Defaults de la base (083). */
export const CFO_CONFIG_POR_DEFECTO: CfoConfig = {
  frecuenteN: 3,
  frecuenteDias: 90,
  activoDias: 60,
  perdidoDias: 120,
  promesaMin: 50,
  ivaPct: 16,
  caidaPct: 15,
  ticketBajaPct: 10,
  cancelacionXMediana: 2,
  descuentoMaxPct: 8,
  costoAgenteAlzaPct: 30,
  cierreBajaPp: 10,
  entregaP90MaxMin: 60,
  srCuadreVerdePct: 1,
  srCuadreAmbarPct: 3,
  srCuadreVerdeCentavos: 5000,
  comisionTerminalPct: null,
};

// ---- Fuentes de datos (punto de enlace F2-F5) --------------------------------------------------------------------------------------------

/**
 * Cada fuente de datos del CFO declara qué es, qué tan confiable y qué cubre. Es el punto de enlace de las fases 2–5
 * (bancos, CFDI, balanza, API del distribuidor…): una fuente nueva solo agrega un renglón aquí.
 */
export interface FuenteDatosCfo {
  readonly id: string;
  readonly nombre: string;
  readonly confianza: Confianza;
  readonly cobertura: { readonly desde: string | null; readonly hasta: string | null };
  readonly disponible: boolean;
}

/** Cómo se compara un periodo (diseño §4.1). */
export type TipoBaseComparacion = "periodo_anterior" | "mismo_periodo_anio_pasado" | "promedio_mismo_dia_4_semanas";
