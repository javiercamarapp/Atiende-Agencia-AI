// CFO-05 · adaptador Postgres del CFO: UNA llamada por función SQL de 081/082/083/084, cada una dentro de `runWithSavepointFallback`.
//
// REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el código y la migración no se aplica sola. Toda operación corre en la
// transacción ÚNICA del request, donde un error de Postgres la deja abortada (25P02): por eso cada llamada abre su SAVEPOINT. Una LECTURA con
// 42883 (función inexistente), 42P01 (tabla) o 42703 (columna) devuelve `disponible: false` con listas vacías; una ESCRITURA lanza
// `CfoNoDisponibleError` (503 honesto). 22023 -> `CfoParametroInvalidoError`; 42501 -> `CfoSinAccesoError`.
//
// node-postgres entrega bigint y numeric como STRING: TODO número pasa por `numericoSql` (nunca `Number(x)` suelto ni `parseInt`).
// Las fechas se piden con `to_char(..., 'YYYY-MM-DD')`. Las llamadas son SECUENCIALES (una sesión, SAVEPOINT por llamada).
//
// Este archivo importa `@atiende/db` (Node): por eso NO se reexporta desde `./index.ts` (la web importa ese subpath); vive en
// `@atiende/domain-restaurantes/cfo/postgres`.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
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
  type ParamsFrecuentesDormidos,
  type RangoCfo,
  type RegistrarExportacionEntrada,
  type ResultadoImportacionSr,
  type UmbralesClientes,
} from "./repositorio.ts";
import {
  CFO_CONFIG_POR_DEFECTO,
  type CanalPedido,
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
  type FilaDescuentoP90,
  type FilaEntregaPercentiles,
  type FilaEntregas,
  type FilaEscalacionHora,
  type FilaFrecuentesDormidos,
  type FilaPedidoDetalle,
  type FilaProducto,
  type FilaRepartidor,
  type FilaSrResumen,
  type FilaVentasDiarias,
  type FilaVentasHora,
  type FormaPagoPedido,
  type OrigenPedido,
  type TipoServicioSr,
} from "./tipos.ts";
import { numericoSql } from "./util.ts";

// ---- Errores de Postgres -----------------------------------------------------------------------------------------------------------------

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Función, tabla o columna inexistente: la base aún no tiene la migración. */
export function esBaseSinMigrar(err: unknown): boolean {
  const c = codigo(err);
  return c === "42883" || c === "42P01" || c === "42703";
}

/**
 * Traduce los SQLSTATE conocidos a errores tipados; cualquier otro error se repropaga tal cual.
 * El mensaje del 22023 se pasa TAL CUAL: son textos propios de las funciones SQL de 081/082/083 (sin datos del negocio ni PII), pensados para mostrarse.
 */
export function traducirErrorPg(err: unknown): never {
  const c = codigo(err);
  const mensaje = err instanceof Error ? err.message : "Solicitud inválida.";
  if (c === "22023") throw new CfoParametroInvalidoError(mensaje);
  if (c === "42501") throw new CfoSinAccesoError();
  throw err;
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresCfoRepository: las funciones del CFO todavia no existen en esta base (SQLSTATE 42883/42P01/42703) -- aplica las migraciones " +
      "081_cfo_ventas_productos, 082_cfo_clientes_agente_operacion, 083_cfo_captura_y_softrestaurant_import y 084_cfo_huecos_frecuentes_p90_es_venta_forma_pago (supabase/migrations/). El CFO responde 'disponible: false'.",
    err,
  );
}

// ---- Conversión de tipos (node-postgres entrega bigint y numeric como string) -------------------------------------------------------------

/** Contador/monto NOT NULL (bigint llega como string). */
export function entero(v: unknown): number {
  return numericoSql(v as string | number | null | undefined) ?? 0;
}
/** Número con NULL significativo (nunca 0). */
export function anulable(v: unknown): number | null {
  return numericoSql(v as string | number | null | undefined);
}
function texto(v: unknown): string {
  return String(v);
}
function textoNulo(v: unknown): string | null {
  return v == null ? null : String(v);
}
/** `YYYY-MM-DD`; tolera un `Date` (si algún día se omite el to_char) usando los componentes locales, que es como pg interpreta un `date`. */
export function fecha(v: unknown): string {
  if (v instanceof Date) return `${v.getFullYear().toString().padStart(4, "0")}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}
function fechaNula(v: unknown): string | null {
  return v == null ? null : fecha(v);
}
function instante(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

type Fila = Record<string, unknown>;

// ---- Mapeadores (exportados para pruebas con filas tal como las entrega node-postgres) -----------------------------------------------------

export function mapVentasDiarias(r: Fila): FilaVentasDiarias {
  return {
    propertyId: texto(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    canal: texto(r["canal"]) as CanalPedido,
    source: texto(r["source"]) as OrigenPedido,
    paymentMethod: textoNulo(r["payment_method"]) as FormaPagoPedido | null,
    pedidos: entero(r["pedidos"]),
    brutaCentavos: entero(r["bruta_centavos"]),
    descPromoCentavos: entero(r["desc_promo_centavos"]),
    descCompCentavos: entero(r["desc_comp_centavos"]),
    netaCentavos: entero(r["neta_centavos"]),
    propinaCentavos: entero(r["propina_centavos"]),
    cancelados: entero(r["cancelados"]),
    canceladosCentavos: entero(r["cancelados_centavos"]),
    noRecogidos: entero(r["no_recogidos"]),
    noRecogidosCentavos: entero(r["no_recogidos_centavos"]),
    reposiciones: entero(r["reposiciones"]),
    reposicionUnidades: entero(r["reposicion_unidades"]),
    entregados: entero(r["entregados"]),
    // Minutos: numeric con 2 decimales (el dominio los opera en centésimas enteras).
    entregaMinSuma: anulable(r["entrega_min_suma"]) ?? 0,
    entregaTarde: entero(r["entrega_tarde"]),
  };
}

export function mapCortesias(r: Fila): FilaCortesias {
  return {
    propertyId: texto(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    reposiciones: entero(r["reposiciones"]),
    valorListaCentavos: entero(r["valor_lista_centavos"]),
    renglonesSinPrecio: entero(r["renglones_sin_precio"]),
  };
}

export function mapVentasHora(r: Fila): FilaVentasHora {
  return {
    propertyId: texto(r["property_id"]),
    dowNegocio: entero(r["dow_negocio"]),
    horaLocal: entero(r["hora_local"]),
    source: texto(r["source"]) as OrigenPedido,
    pedidos: entero(r["pedidos"]),
    netaCentavos: entero(r["neta_centavos"]),
  };
}

export function mapProducto(r: Fila): FilaProducto {
  return {
    propertyId: texto(r["property_id"]),
    productoRef: texto(r["producto_ref"]),
    nombreActual: texto(r["nombre_actual"]),
    categoria: texto(r["categoria"]),
    diaNegocio: fecha(r["dia_negocio"]),
    dowNegocio: entero(r["dow_negocio"]),
    unidades: entero(r["unidades"]),
    ingresoCentavos: entero(r["ingreso_centavos"]),
    pedidos: entero(r["pedidos"]),
  };
}

export function mapPedidoDetalle(r: Fila): FilaPedidoDetalle {
  return {
    orderId: texto(r["order_id"]),
    orderNumber: texto(r["order_number"]),
    propertyId: texto(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    horaLocal: entero(r["hora_local"]),
    canal: texto(r["canal"]) as CanalPedido,
    source: texto(r["source"]) as OrigenPedido,
    status: texto(r["status"]),
    paymentMethod: textoNulo(r["payment_method"]) as FormaPagoPedido | null,
    brutaCentavos: entero(r["bruta"]),
    descCentavos: entero(r["desc_centavos"] ?? r["desc"]),
    netaCentavos: entero(r["neta"]),
    propinaCentavos: entero(r["propina"]),
    entregadoMin: anulable(r["entregado_min"]),
    esCompensacion: r["es_compensacion"] === true,
    esReposicion: r["es_reposicion"] === true,
    clienteAlias: textoNulo(r["cliente_alias"]),
    comandaEstado: textoNulo(r["comanda_estado"]),
    // 084: ausente (null) en una base sin la migración -> no se afirma nada.
    ...(typeof r["es_venta"] === "boolean" ? { esVenta: r["es_venta"] } : {}),
  };
}

export function mapCobertura(r: Fila): FilaCobertura {
  return {
    propertyId: texto(r["property_id"]),
    primerDia: fechaNula(r["primer_dia"]),
    ultimoDia: fechaNula(r["ultimo_dia"]),
    zona: texto(r["zona"]),
    corte: texto(r["corte"]),
  };
}

export function mapClientesResumen(r: Fila): FilaClientesResumen {
  return {
    propertyId: textoNulo(r["property_id"]),
    alcance: texto(r["alcance"]) === "conjunto" ? "conjunto" : "sucursal",
    clientesConPedido: entero(r["clientes_con_pedido"]),
    nuevos: entero(r["nuevos"]),
    recurrentes: entero(r["recurrentes"]),
    activos: entero(r["activos"]),
    dormidos: entero(r["dormidos"]),
    perdidos: entero(r["perdidos"]),
    frecuentes: entero(r["frecuentes"]),
    multiSucursal: anulable(r["multi_sucursal"]),
    clientesVariasSucursales: anulable(r["clientes_varias_sucursales"]),
    recuperados: entero(r["recuperados"]),
    recuperadosPorCampana: entero(r["recuperados_por_campana"]),
    activosAlInicio: entero(r["activos_al_inicio"]),
    pasanAPerdidos: entero(r["pasan_a_perdidos"]),
    diasEntrePedidosMediana: anulable(r["dias_entre_pedidos_mediana"]),
    netaTop10pctCentavos: entero(r["neta_top10pct_centavos"]),
    netaTotalCentavos: entero(r["neta_total_centavos"]),
    pedidosPorCliente12mPromedio: anulable(r["pedidos_por_cliente_12m_promedio"]),
    pedidosConCliente: entero(r["pedidos_con_cliente"]),
    pedidosSinCliente: entero(r["pedidos_sin_cliente"]),
  };
}

export function mapCohorte(r: Fila): FilaClientesCohorte {
  return {
    propertyId: textoNulo(r["property_id"]),
    mesCohorte: texto(r["mes_cohorte"]),
    clientes: entero(r["clientes"]),
    conRecompra30: entero(r["con_recompra_30"]),
    conRecompra60: entero(r["con_recompra_60"]),
    conRecompra90: entero(r["con_recompra_90"]),
    observables30: entero(r["observables_30"]),
    observables60: entero(r["observables_60"]),
    observables90: entero(r["observables_90"]),
  };
}

export function mapAltas(r: Fila): FilaClientesAltas {
  return { propertyId: textoNulo(r["property_id"]), semana: fecha(r["semana"]), altas: entero(r["altas"]) };
}

export function mapSegmentoHora(r: Fila): FilaClientesSegmentoHora {
  return {
    propertyId: textoNulo(r["property_id"]),
    segmento: texto(r["segmento"]) as FilaClientesSegmentoHora["segmento"],
    dowNegocio: entero(r["dow_negocio"]),
    horaLocal: entero(r["hora_local"]),
    pedidos: entero(r["pedidos"]),
    netaCentavos: entero(r["neta_centavos"]),
    clientes: entero(r["clientes"]),
    pedidosPorCliente: anulable(r["pedidos_por_cliente"]),
  };
}

export function mapAgenteDiario(r: Fila): FilaAgenteDiario {
  return {
    propertyId: textoNulo(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    waConversacionesNuevas: entero(r["wa_conversaciones_nuevas"]),
    waConPedido: entero(r["wa_con_pedido"]),
    waConHandoff: entero(r["wa_con_handoff"]),
    waHandoffs: entero(r["wa_handoffs"]),
    vozLlamadas: entero(r["voz_llamadas"]),
    vozPedidoCreado: entero(r["voz_pedido_creado"]),
    vozEscalado: entero(r["voz_escalado"]),
    vozAbandonado: entero(r["voz_abandonado"]),
    costoVozMicroUsd: entero(r["costo_voz_micro_usd"]),
    costoTelefoniaMicroUsd: entero(r["costo_telefonia_micro_usd"]),
    // NULL ≠ 0: sin eventos de Meta el costo es «no medido»; en demos el LLM de texto es NULL.
    costoMetaMicroUsd: anulable(r["costo_meta_micro_usd"]),
    costoLlmMicroUsd: anulable(r["costo_llm_micro_usd"]),
    costoVozCentavos: anulable(r["costo_voz_centavos"]),
    costoTelefoniaCentavos: anulable(r["costo_telefonia_centavos"]),
    costoMetaCentavos: anulable(r["costo_meta_centavos"]),
    costoLlmCentavos: anulable(r["costo_llm_centavos"]),
    metaEventos: entero(r["meta_eventos"]),
    mxnPorUsd: anulable(r["mxn_por_usd"]),
  };
}

export function mapEscalacion(r: Fila): FilaEscalacionHora {
  return {
    propertyId: texto(r["property_id"]),
    dowNegocio: entero(r["dow_negocio"]),
    horaLocal: entero(r["hora_local"]),
    conversaciones: entero(r["conversaciones"]),
    handoffs: entero(r["handoffs"]),
  };
}

export function mapEntregas(r: Fila): FilaEntregas {
  return {
    propertyId: texto(r["property_id"]),
    horaLocal: entero(r["hora_local"]),
    dowNegocio: entero(r["dow_negocio"]),
    entregados: entero(r["entregados"]),
    minSuma: anulable(r["min_suma"]) ?? 0,
    tarde: entero(r["tarde"]),
  };
}

export function mapPercentiles(r: Fila): FilaEntregaPercentiles {
  return {
    propertyId: textoNulo(r["property_id"]),
    alcance: texto(r["alcance"]) === "conjunto" ? "conjunto" : "sucursal",
    entregados: entero(r["entregados"]),
    p50Min: anulable(r["p50_min"]),
    p90Min: anulable(r["p90_min"]),
  };
}

export function mapRepartidor(r: Fila): FilaRepartidor {
  return {
    propertyId: texto(r["property_id"]),
    repartidorId: texto(r["repartidor_id"]),
    nombre: texto(r["nombre"]),
    entregas: entero(r["entregas"]),
    minSuma: anulable(r["min_suma"]) ?? 0,
    tarde: entero(r["tarde"]),
    incidencias: entero(r["incidencias"]),
  };
}

export function mapColonia(r: Fila): FilaColonia {
  return {
    propertyId: texto(r["property_id"]),
    colonia: texto(r["colonia"]),
    pedidos: entero(r["pedidos"]),
    netaCentavos: entero(r["neta_centavos"]),
    entregados: entero(r["entregados"]),
    minSuma: anulable(r["min_suma"]) ?? 0,
    clientes: entero(r["clientes"]),
    sucursalCercanaId: textoNulo(r["sucursal_cercana_id"]),
    distanciaKm: anulable(r["distancia_km"]),
  };
}

export function mapComandas(r: Fila): FilaComandasPos {
  return {
    propertyId: texto(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    modo: texto(r["modo"]),
    encoladas: entero(r["encoladas"]),
    confirmadas: entero(r["confirmadas"]),
    capturadasManual: entero(r["capturadas_manual"]),
    capturaManualPendientes: entero(r["captura_manual_pendientes"]),
    fallidas: entero(r["fallidas"]),
    pendientesEnviadas: entero(r["pendientes_enviadas"]),
    minACapturaSuma: anulable(r["min_a_captura_suma"]) ?? 0,
    capturadasConTiempo: entero(r["capturadas_con_tiempo"]),
    vencidasUmbral: entero(r["vencidas_umbral"]),
    conFolioPos: entero(r["con_folio_pos"]),
    conFolioDeclarado: entero(r["con_folio_declarado"]),
  };
}

export function mapAgotado(r: Fila): FilaAgotado {
  return {
    propertyId: texto(r["property_id"]),
    productId: texto(r["product_id"]),
    nombre: texto(r["nombre"]),
    // disponible=false con agotado_hasta NULL = agotado INDEFINIDO (no «disponible»).
    disponible: r["disponible"] === true,
    agotadoHasta: fechaNula(r["agotado_hasta"]),
    unidades28d: entero(r["unidades_28d"]),
    diasConVenta28d: entero(r["dias_con_venta_28d"]),
    precioListaCentavos: anulable(r["precio_centavos"]),
    rankingUnidades: null,
  };
}

/** `cfo_config_leer` -> `CfoConfig` (numeric(5,2) llega como string). Un campo ausente cae al default de la base. */
export function mapConfig(r: Fila): CfoConfig {
  const d = CFO_CONFIG_POR_DEFECTO;
  const num = (k: string, por: number): number => anulable(r[k]) ?? por;
  return {
    frecuenteN: num("frecuente_n", d.frecuenteN),
    frecuenteDias: num("frecuente_dias", d.frecuenteDias),
    activoDias: num("activo_dias", d.activoDias),
    perdidoDias: num("perdido_dias", d.perdidoDias),
    promesaMin: num("promesa_min", d.promesaMin),
    ivaPct: num("iva_pct", d.ivaPct),
    caidaPct: num("caida_pct", d.caidaPct),
    ticketBajaPct: num("ticket_baja_pct", d.ticketBajaPct),
    cancelacionXMediana: num("cancelacion_x_mediana", d.cancelacionXMediana),
    descuentoMaxPct: num("descuento_max_pct", d.descuentoMaxPct),
    costoAgenteAlzaPct: num("costo_agente_alza_pct", d.costoAgenteAlzaPct),
    cierreBajaPp: num("cierre_baja_pp", d.cierreBajaPp),
    entregaP90MaxMin: num("entrega_p90_max_min", d.entregaP90MaxMin),
    srCuadreVerdePct: num("sr_cuadre_verde_pct", d.srCuadreVerdePct),
    srCuadreAmbarPct: num("sr_cuadre_ambar_pct", d.srCuadreAmbarPct),
    srCuadreVerdeCentavos: num("sr_cuadre_verde_centavos", d.srCuadreVerdeCentavos),
    // NULL = captura pendiente (nunca 0 %).
    comisionTerminalPct: anulable(r["comision_terminal_pct"]),
  };
}

export function mapCosto(r: Fila): CostoCapturadoDetalle {
  return {
    id: texto(r["id"]),
    propertyId: textoNulo(r["property_id"]),
    mes: fecha(r["mes"]),
    concepto: texto(r["concepto"]) as ConceptoCosto,
    montoCentavos: anulable(r["monto_centavos"]),
    pct: anulable(r["pct"]),
    nota: textoNulo(r["nota"]),
    creadoEn: instante(r["created_at"]),
  };
}

export function mapCostoHistorial(r: Fila): CostoHistorialItem {
  return {
    id: texto(r["id"]),
    version: entero(r["version"]),
    montoCentavos: anulable(r["monto_centavos"]),
    pct: anulable(r["pct"]),
    nota: textoNulo(r["nota"]),
    creadoPor: textoNulo(r["created_by"]),
    creadoEn: instante(r["created_at"]),
    vigente: r["vigente"] === true,
  };
}

export function mapSrResumen(r: Fila): FilaSrResumen {
  return {
    propertyId: texto(r["property_id"]),
    diaNegocio: fecha(r["dia_negocio"]),
    tipoServicio: texto(r["tipo_servicio"]) as TipoServicioSr,
    // 084: el renglón viene partido por forma de pago (minúsculas); null = el archivo no la traía o la base aún no tiene la 084 (sr_resumen_leer
    // sumaba todas las formas de pago de ese día y servicio).
    formaPago: textoNulo(r["forma_pago"]),
    tickets: entero(r["tickets"]),
    brutaCentavos: entero(r["bruta_centavos"]),
    descuentoCentavos: entero(r["descuento_centavos"]),
    canceladoCentavos: entero(r["cancelado_centavos"]),
    propinaCentavos: entero(r["propina_centavos"]),
    ivaCentavos: anulable(r["iva_centavos"]),
    netaCentavos: entero(r["neta_centavos"]),
  };
}

export function mapFrecuentesDormidos(r: Fila): FilaFrecuentesDormidos {
  const crudo = typeof r["muestra"] === "string" ? safeJson(r["muestra"]) : r["muestra"];
  const muestra = Array.isArray(crudo)
    ? crudo.flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const o = m as Record<string, unknown>;
        return [{ alias: texto(o["alias"]), pedidos: entero(o["pedidos"]), diasSinPedir: entero(o["dias_sin_pedir"]), netaCentavos: entero(o["neta_centavos"]) }];
      })
    : [];
  return {
    propertyId: textoNulo(r["property_id"]),
    alcance: texto(r["alcance"]) === "conjunto" ? "conjunto" : "sucursal",
    frecuenteN: entero(r["frecuente_n"]),
    frecuenteDias: entero(r["frecuente_dias"]),
    dormidoDias: entero(r["dormido_dias"]),
    frecuentes: entero(r["frecuentes"]),
    frecuentesDormidos: entero(r["frecuentes_dormidos"]),
    pedidosVentana: entero(r["pedidos_ventana"]),
    netaVentanaCentavos: entero(r["neta_ventana_centavos"]),
    muestra,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function mapDescuentoP90(r: Fila): FilaDescuentoP90 {
  return {
    propertyId: textoNulo(r["property_id"]),
    alcance: texto(r["alcance"]) === "conjunto" ? "conjunto" : "sucursal",
    dias: entero(r["dias"]),
    desde: fecha(r["desde"]),
    hasta: fecha(r["hasta"]),
    diasConVenta: entero(r["dias_con_venta"]),
    // NULL = sin historia suficiente: nunca 0.
    p90Pct: anulable(r["p90_pct"]),
  };
}

export function mapLote(r: Fila): LoteSr {
  return {
    id: texto(r["id"]),
    propertyId: texto(r["property_id"]),
    tipo: texto(r["tipo"]) as LoteSr["tipo"],
    nombreArchivo: texto(r["nombre_archivo"]),
    fechaMin: fechaNula(r["fecha_min"]),
    fechaMax: fechaNula(r["fecha_max"]),
    renglones: entero(r["renglones"]),
    aceptados: entero(r["aceptados"]),
    rechazados: entero(r["rechazados"]),
    estado: texto(r["estado"]) === "reemplazado" ? "reemplazado" : "aplicado",
    origen: texto(r["origen"]) === "api" ? "api" : "archivo",
    creadoEn: instante(r["created_at"]),
  };
}

export function mapCoberturaSr(r: Fila): CoberturaSr {
  const dias = r["dias"];
  return {
    propertyId: texto(r["property_id"]),
    diasConDato: entero(r["dias_con_dato"]),
    diaMin: fechaNula(r["dia_min"]),
    diaMax: fechaNula(r["dia_max"]),
    dias: Array.isArray(dias) ? dias.map(fecha) : [],
  };
}

/** Salida jsonb de `cfo_canasta_pares` (los números dentro del jsonb ya son números JSON). */
export function mapCanasta(j: unknown): Pick<LecturaCanasta, "pares" | "totales" | "tickets"> {
  const crudo = typeof j === "string" ? (JSON.parse(j) as unknown) : j;
  const o = (crudo && typeof crudo === "object" ? crudo : {}) as Record<string, unknown>;
  const lista = (k: string): Fila[] => (Array.isArray(o[k]) ? (o[k] as Fila[]) : []);
  const pares: FilaCanastaPar[] = lista("pares").map((p) => ({
    propertyId: texto(p["property_id"]),
    productoA: texto(p["producto_a"]),
    productoB: texto(p["producto_b"]),
    pedidosJuntos: entero(p["pedidos_juntos"]),
  }));
  const conProducto = new Map<string, Record<string, number>>();
  for (const p of lista("productos")) {
    const id = texto(p["property_id"]);
    const m = conProducto.get(id) ?? {};
    m[texto(p["producto_ref"])] = entero(p["pedidos_con_producto"]);
    conProducto.set(id, m);
  }
  const totales: FilaCanastaTotales[] = lista("totales").map((t) => ({
    propertyId: texto(t["property_id"]),
    pedidosTotales: entero(t["pedidos_totales"]),
    pedidosConProducto: conProducto.get(texto(t["property_id"])) ?? {},
  }));
  const tickets: FilaCanastaTicket[] = lista("tickets").map((t) => ({
    propertyId: texto(t["property_id"]),
    nProductos: entero(t["n_productos"]),
    pedidos: entero(t["pedidos"]),
    netaCentavos: entero(t["neta_centavos"]),
  }));
  return { pares, totales, tickets };
}

// ---- Adaptador -----------------------------------------------------------------------------------------------------------------------------

const D = (col: string): string => `to_char(${col}, 'YYYY-MM-DD') as ${col}`;
const PROPS = (p: ParamsCfo): readonly string[] | null => (p.propertyIds === null ? null : [...p.propertyIds]);

export class PostgresCfoRepository implements CfoRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Lectura con SAVEPOINT: base sin migrar -> `disponible: false`; 22023 / 42501 -> errores tipados. */
  private async leer<T>(nombre: string, sql: string, params: unknown[], mapear: (r: Fila) => T): Promise<LecturaCfo<T>> {
    try {
      return await runWithSavepointFallback<LecturaCfo<T>>({
        session: this.db,
        savepointName: `sp_cfo_${nombre}`,
        primary: async () => {
          const { rows } = await this.db.query<Fila>(sql, params);
          return { disponible: true, filas: rows.map(mapear) };
        },
        isRecoverable: esBaseSinMigrar,
        fallback: async (err) => {
          advertirNoDisponible(err);
          return { disponible: false, filas: [] };
        },
      });
    } catch (err) {
      return traducirErrorPg(err);
    }
  }

  /** Escritura con SAVEPOINT: base sin migrar -> `CfoNoDisponibleError`. */
  private async escribir<T>(nombre: string, sql: string, params: unknown[], mapear: (rows: Fila[]) => T): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName: `sp_cfo_${nombre}`,
        primary: async () => mapear((await this.db.query<Fila>(sql, params)).rows),
        isRecoverable: esBaseSinMigrar,
        fallback: async (err) => {
          advertirNoDisponible(err);
          throw new CfoNoDisponibleError();
        },
      });
    } catch (err) {
      if (err instanceof CfoNoDisponibleError) throw err;
      return traducirErrorPg(err);
    }
  }

  // ---- 081 ----

  ventasDiarias(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaVentasDiarias>> {
    return this.leer(
      "ventas_diarias",
      `select property_id, ${D("dia_negocio")}, canal, source, payment_method, pedidos, bruta_centavos, desc_promo_centavos, desc_comp_centavos,
              neta_centavos, propina_centavos, cancelados, cancelados_centavos, no_recogidos, no_recogidos_centavos, reposiciones,
              reposicion_unidades, entregados, entrega_min_suma, entrega_tarde
         from restaurantes.cfo_ventas_diarias($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, promesaMin],
      mapVentasDiarias,
    );
  }

  cortesias(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaCortesias>> {
    return this.leer(
      "cortesias",
      `select property_id, ${D("dia_negocio")}, reposiciones, valor_lista_centavos, renglones_sin_precio
         from restaurantes.cfo_cortesias($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapCortesias,
    );
  }

  ventasHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaVentasHora>> {
    return this.leer(
      "ventas_hora",
      `select property_id, dow_negocio, hora_local, source, pedidos, neta_centavos
         from restaurantes.cfo_ventas_hora($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapVentasHora,
    );
  }

  productos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaProducto>> {
    return this.leer(
      "productos",
      `select property_id, producto_ref, nombre_actual, categoria, ${D("dia_negocio")}, dow_negocio, unidades, ingreso_centavos, pedidos
         from restaurantes.cfo_productos($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapProducto,
    );
  }

  async canastaPares(p: ParamsCfo, r: RangoCfo, limite: number): Promise<LecturaCanasta> {
    const vacia: LecturaCanasta = { disponible: false, pares: [], totales: [], tickets: [] };
    try {
      return await runWithSavepointFallback<LecturaCanasta>({
        session: this.db,
        savepointName: "sp_cfo_canasta",
        primary: async () => {
          const { rows } = await this.db.query<Fila>(
            "select restaurantes.cfo_canasta_pares($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer) as canasta;",
            [p.organizationId, PROPS(p), r.desde, r.hasta, limite],
          );
          return { disponible: true, ...mapCanasta(rows[0]?.["canasta"]) };
        },
        isRecoverable: esBaseSinMigrar,
        fallback: async (err) => {
          advertirNoDisponible(err);
          return vacia;
        },
      });
    } catch (err) {
      return traducirErrorPg(err);
    }
  }

  async pedidosDetalle(p: ParamsCfo, r: RangoCfo, filtro: FiltroPedidosDetalle, limite: number, cursor: string | null, promesaMin: number): Promise<LecturaPedidosDetalle> {
    // Se piden limite + 1 filas para saber si hay otra página sin un segundo viaje (la SQL topa en 200).
    const lectura = await this.leer(
      "pedidos_detalle",
      // es_venta (084) se lee de to_jsonb(t): una base con solo la 081 no tiene la columna y un `select es_venta` fallaría con 42703 (perdiendo todo el detalle).
      `select t.order_id, t.order_number, t.property_id, to_char(t.dia_negocio, 'YYYY-MM-DD') as dia_negocio, t.hora_local, t.canal, t.source, t.status, t.payment_method, t.bruta, t."desc" as desc_centavos,
              t.neta, t.propina, t.entregado_min, t.es_compensacion, t.es_reposicion, t.cliente_alias, t.comanda_estado, t.cursor_pagina,
              (to_jsonb(t) ->> 'es_venta')::boolean as es_venta
         from restaurantes.cfo_pedidos_detalle($1::uuid, $2::uuid[], $3::date, $4::date, $5::jsonb, $6::integer, $7::text, $8::integer) t;`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, JSON.stringify(filtro), limite + 1, cursor, promesaMin],
      (fila) => ({ detalle: mapPedidoDetalle(fila), cursor: texto(fila["cursor_pagina"]) }),
    );
    const hayMas = lectura.filas.length > limite;
    const pagina = lectura.filas.slice(0, limite);
    return {
      disponible: lectura.disponible,
      filas: pagina.map((x) => x.detalle),
      cursorSiguiente: hayMas && pagina.length > 0 ? pagina[pagina.length - 1]!.cursor : null,
    };
  }

  cobertura(p: ParamsCfo): Promise<LecturaCfo<FilaCobertura>> {
    return this.leer(
      "cobertura",
      `select property_id, ${D("primer_dia")}, ${D("ultimo_dia")}, zona, corte from restaurantes.cfo_cobertura($1::uuid, $2::uuid[]);`,
      [p.organizationId, PROPS(p)],
      mapCobertura,
    );
  }

  // ---- 082 ----

  clientesResumen(p: ParamsCfo, r: RangoCfo, u: UmbralesClientes): Promise<LecturaCfo<FilaClientesResumen>> {
    return this.leer(
      "clientes_resumen",
      `select property_id, alcance, clientes_con_pedido, nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, multi_sucursal,
              clientes_varias_sucursales, recuperados, recuperados_por_campana, activos_al_inicio, pasan_a_perdidos, dias_entre_pedidos_mediana,
              neta_top10pct_centavos, neta_total_centavos, pedidos_por_cliente_12m_promedio, pedidos_con_cliente, pedidos_sin_cliente
         from restaurantes.cfo_clientes_resumen($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer, $6::integer, $7::integer, $8::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, u.frecuenteN, u.frecuenteDias, u.activoDias, u.perdidoDias],
      mapClientesResumen,
    );
  }

  clientesCohortes(p: ParamsCfo, meses: number): Promise<LecturaCfo<FilaClientesCohorte>> {
    return this.leer(
      "clientes_cohortes",
      `select property_id, mes_cohorte, clientes, con_recompra_30, con_recompra_60, con_recompra_90, observables_30, observables_60, observables_90
         from restaurantes.cfo_clientes_cohortes($1::uuid, $2::uuid[], $3::integer);`,
      [p.organizationId, PROPS(p), meses],
      mapCohorte,
    );
  }

  clientesAltas(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaClientesAltas>> {
    return this.leer(
      "clientes_altas",
      `select property_id, ${D("semana")}, altas from restaurantes.cfo_clientes_altas($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapAltas,
    );
  }

  clientesSegmentoHora(p: ParamsCfo, r: RangoCfo, u: Pick<UmbralesClientes, "frecuenteN" | "frecuenteDias">): Promise<LecturaCfo<FilaClientesSegmentoHora>> {
    return this.leer(
      "clientes_segmento_hora",
      `select property_id, segmento, dow_negocio, hora_local, pedidos, neta_centavos, clientes, pedidos_por_cliente
         from restaurantes.cfo_clientes_segmento_hora($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer, $6::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, u.frecuenteN, u.frecuenteDias],
      mapSegmentoHora,
    );
  }

  agenteDiario(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaAgenteDiario>> {
    return this.leer(
      "agente_diario",
      `select property_id, ${D("dia_negocio")}, wa_conversaciones_nuevas, wa_con_pedido, wa_con_handoff, wa_handoffs, voz_llamadas, voz_pedido_creado,
              voz_escalado, voz_abandonado, costo_voz_micro_usd, costo_telefonia_micro_usd, costo_meta_micro_usd, costo_llm_micro_usd,
              costo_voz_centavos, costo_telefonia_centavos, costo_meta_centavos, costo_llm_centavos, meta_eventos, mxn_por_usd
         from restaurantes.cfo_agente_diario($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapAgenteDiario,
    );
  }

  escalacionesHora(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEscalacionHora>> {
    return this.leer(
      "escalaciones_hora",
      `select property_id, dow_negocio, hora_local, conversaciones, handoffs from restaurantes.cfo_escalaciones_hora($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapEscalacion,
    );
  }

  entregas(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaEntregas>> {
    return this.leer(
      "entregas",
      `select property_id, hora_local, dow_negocio, entregados, min_suma, tarde from restaurantes.cfo_entregas($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, promesaMin],
      mapEntregas,
    );
  }

  entregasPercentiles(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaEntregaPercentiles>> {
    return this.leer(
      "entregas_percentiles",
      `select property_id, alcance, entregados, p50_min, p90_min from restaurantes.cfo_entregas_percentiles($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapPercentiles,
    );
  }

  repartidores(p: ParamsCfo, r: RangoCfo, promesaMin: number): Promise<LecturaCfo<FilaRepartidor>> {
    return this.leer(
      "repartidores",
      `select property_id, repartidor_id, nombre, entregas, min_suma, tarde, incidencias
         from restaurantes.cfo_repartidores($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, promesaMin],
      mapRepartidor,
    );
  }

  colonias(p: ParamsCfo, r: RangoCfo, k: number): Promise<LecturaCfo<FilaColonia>> {
    return this.leer(
      "colonias",
      `select property_id, colonia, pedidos, neta_centavos, entregados, min_suma, clientes, sucursal_cercana_id, distancia_km
         from restaurantes.cfo_colonias($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta, k],
      mapColonia,
    );
  }

  comandasPos(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaComandasPos>> {
    return this.leer(
      "comandas_pos",
      `select property_id, ${D("dia_negocio")}, modo, encoladas, confirmadas, capturadas_manual, captura_manual_pendientes, fallidas, pendientes_enviadas,
              min_a_captura_suma, capturadas_con_tiempo, vencidas_umbral, con_folio_pos, con_folio_declarado
         from restaurantes.cfo_comandas_pos($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapComandas,
    );
  }

  agotados(p: ParamsCfo): Promise<LecturaCfo<FilaAgotado>> {
    return this.leer(
      "agotados",
      `select property_id, product_id, nombre, ${D("agotado_hasta")}, disponible, precio_centavos, unidades_28d, dias_con_venta_28d
         from restaurantes.cfo_agotados($1::uuid, $2::uuid[]);`,
      [p.organizationId, PROPS(p)],
      mapAgotado,
    );
  }

  // ---- 083 ----

  async configLeer(organizationId: string): Promise<LecturaConfig> {
    const l = await this.leer(
      "config_leer",
      `select frecuente_n, frecuente_dias, activo_dias, perdido_dias, promesa_min, iva_pct, caida_pct, ticket_baja_pct, cancelacion_x_mediana,
              descuento_max_pct, costo_agente_alza_pct, cierre_baja_pp, entrega_p90_max_min, sr_cuadre_verde_pct, sr_cuadre_ambar_pct,
              sr_cuadre_verde_centavos, comision_terminal_pct, updated_at
         from restaurantes.cfo_config_leer($1::uuid);`,
      [organizationId],
      (r) => ({ config: mapConfig(r), configurada: r["updated_at"] != null }),
    );
    const f = l.filas[0];
    return { disponible: l.disponible && f !== undefined, config: f?.config ?? CFO_CONFIG_POR_DEFECTO, configurada: f?.configurada ?? false };
  }

  configGuardar(organizationId: string, cambios: Readonly<Record<string, number | null>>): Promise<void> {
    return this.escribir("config_guardar", "select restaurantes.cfo_config_guardar($1::uuid, $2::jsonb);", [organizationId, JSON.stringify(cambios)], () => undefined);
  }

  costosLeer(p: ParamsCfo, mesDesde: string, mesHasta: string): Promise<LecturaCfo<CostoCapturadoDetalle>> {
    return this.leer(
      "costos_leer",
      `select id, property_id, ${D("mes")}, concepto, monto_centavos, pct, nota, created_at
         from restaurantes.cfo_costos_leer($1::uuid, $2::uuid[], $3::date, $4::date);`,
      [p.organizationId, PROPS(p), mesDesde, mesHasta],
      mapCosto,
    );
  }

  costoGuardar(e: GuardarCostoEntrada): Promise<string> {
    return this.escribir(
      "costo_guardar",
      "select restaurantes.cfo_costo_guardar($1::uuid, $2::uuid, $3::date, $4::text, $5::bigint, $6::numeric, $7::text) as id;",
      [e.organizationId, e.propertyId, e.mes, e.concepto, e.montoCentavos, e.pct, e.nota],
      (rows) => texto(rows[0]?.["id"]),
    );
  }

  costoHistorial(organizationId: string, propertyId: string | null, mes: string, concepto: ConceptoCosto): Promise<LecturaCfo<CostoHistorialItem>> {
    return this.leer(
      "costo_historial",
      `select id, version, monto_centavos, pct, nota, created_by, created_at, vigente
         from restaurantes.cfo_costo_historial($1::uuid, $2::uuid, $3::date, $4::text);`,
      [organizationId, propertyId, mes, concepto],
      mapCostoHistorial,
    );
  }

  // ---- 084 ----

  clientesFrecuentesDormidos(p: ParamsCfo, hasta: string, params: ParamsFrecuentesDormidos): Promise<LecturaCfo<FilaFrecuentesDormidos>> {
    return this.leer(
      "clientes_frecuentes_dormidos",
      `select property_id, alcance, frecuente_n, frecuente_dias, dormido_dias, frecuentes, frecuentes_dormidos, pedidos_ventana, neta_ventana_centavos, muestra
         from restaurantes.cfo_clientes_frecuentes_dormidos($1::uuid, $2::uuid[], $3::date, $4::integer, $5::integer, $6::integer, $7::integer);`,
      [p.organizationId, PROPS(p), hasta, params.frecuenteN ?? null, params.frecuenteDias ?? null, params.dormidoDias, params.muestra ?? 0],
      mapFrecuentesDormidos,
    );
  }

  descuentoP90(p: ParamsCfo, hasta: string, dias: number): Promise<LecturaCfo<FilaDescuentoP90>> {
    return this.leer(
      "descuento_p90",
      `select property_id, alcance, dias, ${D("desde")}, ${D("hasta")}, dias_con_venta, p90_pct
         from restaurantes.cfo_descuento_p90($1::uuid, $2::uuid[], $3::date, $4::integer);`,
      [p.organizationId, PROPS(p), hasta, dias],
      mapDescuentoP90,
    );
  }

  srResumenLeer(p: ParamsCfo, r: RangoCfo): Promise<LecturaCfo<FilaSrResumen>> {
    return this.leer(
      "sr_resumen_leer",
      // forma_pago (084) se lee de to_jsonb(t): una base con solo la 083 no tiene la columna y un `select forma_pago` fallaría con 42703 (perdiendo todo el resumen).
      `select t.property_id, to_char(t.dia_negocio, 'YYYY-MM-DD') as dia_negocio, t.tipo_servicio, t.tickets, t.bruta_centavos, t.descuento_centavos, t.cancelado_centavos, t.propina_centavos,
              t.iva_centavos, t.neta_centavos, to_jsonb(t) ->> 'forma_pago' as forma_pago
         from restaurantes.sr_resumen_leer($1::uuid, $2::uuid[], $3::date, $4::date) t;`,
      [p.organizationId, PROPS(p), r.desde, r.hasta],
      mapSrResumen,
    );
  }

  srLotes(p: ParamsCfo, limite: number): Promise<LecturaCfo<LoteSr>> {
    return this.leer(
      "sr_lotes",
      `select id, property_id, tipo, nombre_archivo, ${D("fecha_min")}, ${D("fecha_max")}, renglones, aceptados, rechazados, estado, origen, created_at
         from restaurantes.sr_lotes_listar($1::uuid, $2::uuid[], $3::integer);`,
      [p.organizationId, PROPS(p), limite],
      mapLote,
    );
  }

  srCobertura(p: ParamsCfo): Promise<LecturaCfo<CoberturaSr>> {
    return this.leer(
      "sr_cobertura",
      `select property_id, dias_con_dato, ${D("dia_min")}, ${D("dia_max")}, dias::text[] as dias from restaurantes.sr_cobertura($1::uuid, $2::uuid[]);`,
      [p.organizationId, PROPS(p)],
      mapCoberturaSr,
    );
  }

  srImportar(e: ImportarSrEntrada): Promise<ResultadoImportacionSr> {
    return this.escribir(
      "sr_importar",
      "select lote_id, creado, aceptados, rechazados, errores from restaurantes.sr_importar($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb);",
      [e.organizationId, e.propertyId, e.huella, e.tipo, e.nombreArchivo, JSON.stringify(e.renglones)],
      (rows) => {
        const f = rows[0];
        if (!f) throw new CfoNoDisponibleError("La importación no devolvió resultado.");
        const errores = (typeof f["errores"] === "string" ? JSON.parse(f["errores"]) : f["errores"]) as Array<Record<string, unknown>> | null;
        return {
          loteId: textoNulo(f["lote_id"]),
          creado: f["creado"] === true,
          aceptados: entero(f["aceptados"]),
          rechazados: entero(f["rechazados"]),
          errores: (errores ?? []).map((x): ErrorImportacionSr => ({ renglon: entero(x["renglon"]), campo: texto(x["campo"]), motivo: texto(x["motivo"]) })),
        };
      },
    );
  }

  registrarExportacion(e: RegistrarExportacionEntrada): Promise<string> {
    return this.escribir(
      "registrar_exportacion",
      "select restaurantes.cfo_registrar_exportacion($1::uuid, $2::uuid[], $3::text, $4::text, $5::date, $6::date) as id;",
      [e.organizationId, e.propertyIds === null ? null : [...e.propertyIds], e.vista, e.formato, e.desde, e.hasta],
      (rows) => texto(rows[0]?.["id"]),
    );
  }
}
