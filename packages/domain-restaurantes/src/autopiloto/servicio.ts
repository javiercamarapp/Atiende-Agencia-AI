// Servicio del autopiloto de restaurantes: orquesta el repositorio del autopiloto, los avisos al cliente (outbox de WhatsApp, plantillas utility
// R-27) y las notificaciones in-app (campana) alrededor de las decisiones del ciclo del pedido. Reglas de producto (Javier, 3-oct):
//   * Lo que mueve dinero, cancela algo ya en cocina o es un pedido grande NO se automatiza sin humano: el sistema prepara todo y pide UNA
//     aprobacion con un clic; al aprobar, sigue solo (avisa al cliente, manda a cocina). NUNCA se autoaprueba.
//   * Todo efecto es idempotente (clave de dedupe por pedido/solicitud): un doble clic o un reintento del tick no duplica avisos ni comandas.
//   * El dinero (devolucion en efectivo o tarjeta) solo se registra; nunca se ejecuta (no hay pago en linea).
//   * Toda notificacion in-app sale por `emitirNotificacion` (catalogo `restaurantes.aprobacion.*`, `restaurantes.pedido.*`), sin PII.
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { notifyCustomerOnOrderStatusChangeCore } from "../order-notifications.ts";
import { toWhatsAppRecipient } from "../phone.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { SoftRestaurantPort, SucursalPos } from "../softrestaurant/types.ts";
import type { CanalPedido, Order, OrderStatus } from "../types.ts";
import { esMotivoCancelacion } from "./taxonomia.ts";
import type { MotivoCancelacion } from "./taxonomia.ts";
import { estimarTiempo } from "./tiempo-prometido.ts";
import type { TiempoEstimado } from "./tiempo-prometido.ts";
import { AUTOPILOTO_CONFIG_POR_OMISION } from "./tipos.ts";
import type { AutopilotoRepository, ComandaParaAvance, OpcionesResolver, PedidoGrandeHook, ResultadoResolver, SolicitudDecision } from "./tipos.ts";

export interface AutopilotoServicioDeps {
  readonly auto: AutopilotoRepository;
  readonly repo: RestaurantesRepository;
  readonly db: TenantDbSession;
  /** Encola la comanda al POS de pedidos que acaban de pasar a `pending` (best-effort; sin POS cableado no hace nada). */
  readonly encolarComandas?: (orders: readonly Order[]) => Promise<unknown>;
  /** Corta la comanda al POS (pendiente/fallida/captura manual) de un pedido que esta decision acaba de CANCELAR, para que un POS que vuelve despues no la cocine
   * (mismo corte que el cambio de estado a `cancelado`, R-34). Best-effort; sin POS cableado no hace nada. */
  readonly cortarComandaCancelado?: (order: Order) => Promise<unknown>;
}

/** Plantillas HSM (Meta) que hay que crear y aprobar para los avisos fuera de la ventana de 24 h (R-25). Todas llevan 3 variables:
 * {{1}} nombre del cliente, {{2}} sucursal, {{3}} detalle (total, folio o codigo). Sin plantilla aprobada el gateway manda el texto libre
 * (valido dentro de la ventana de 24 h) y, fuera de ella, el dispatcher lo marca `dead` (nunca `sent` fingido). */
export const PLANTILLAS_AUTOPILOTO = {
  aprobado: { name: "pedido_aprobado", language: "es_MX" },
  rechazado: { name: "pedido_no_confirmado", language: "es_MX" },
  cancelacionMantenida: { name: "cancelacion_no_posible", language: "es_MX" },
  compensacionSin: { name: "compensacion_sin_costo_extra", language: "es_MX" },
  compensacionReposicion: { name: "compensacion_reposicion", language: "es_MX" },
  compensacionDescuento: { name: "compensacion_descuento", language: "es_MX" },
  recibido: { name: "pedido_recibido", language: "es_MX" },
} as const;

function varPlantilla(valor: string | null | undefined, respaldo: string): string {
  const limpio = (valor ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  return limpio.length > 0 ? limpio : respaldo;
}

function saludo(order: Order): string {
  return order.customerName ? `Hola ${order.customerName}, ` : "Hola, ";
}

function sucursalDe(order: Order): string {
  return order.branch ? ` de ${order.branch}` : "";
}

export interface AvisoCliente {
  readonly tipoOutbox: string;
  readonly dedupeKey: string;
  readonly cuerpo: string;
  readonly plantilla: { readonly name: string; readonly language: string };
  readonly detalle: string;
}

/** Encola el WhatsApp al cliente del pedido (mismo outbox y mismo dispatcher que el aviso de estado). Idempotente por `dedupeKey`. */
export async function encolarAvisoCliente(repo: RestaurantesRepository, order: Order, aviso: AvisoCliente): Promise<{ readonly enqueued: boolean; readonly reason?: "no_customer_phone" | "no_whatsapp_channel" }> {
  const recipient = order.customerPhone ? toWhatsAppRecipient(order.customerPhone) : null;
  if (!recipient) return { enqueued: false, reason: "no_customer_phone" };
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(order.organizationId, order.propertyId);
  if (!phoneNumberId) return { enqueued: false, reason: "no_whatsapp_channel" };
  await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", aviso.tipoOutbox, aviso.dedupeKey, {
    to: recipient,
    phone_number_id: phoneNumberId,
    body: aviso.cuerpo,
    transaccional: true,
    template: { ...aviso.plantilla, params: [varPlantilla(order.customerName, "cliente"), varPlantilla(order.branch, "la sucursal"), varPlantilla(aviso.detalle, "-")] },
  });
  return { enqueued: true };
}

function formatoMxn(total: number): string {
  return `$${total.toFixed(2)} MXN`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. Pedido grande: retener, avisar y resolver con un clic
// ---------------------------------------------------------------------------------------------------------------------------------------

export type ResultadoRetencion =
  | { readonly estado: "por_aprobar"; readonly solicitudId: string; readonly creada: boolean }
  | { readonly estado: "no_disponible" };

/** Convierte un pedido grande RECIEN creado en `por_aprobar` (sin comanda ni cocina) y avisa a la sucursal en la campana. Idempotente. */
export async function retenerPedidoGrande(deps: AutopilotoServicioDeps, input: { readonly organizationId: string; readonly orderId: string; readonly detalle: Readonly<Record<string, unknown>> }): Promise<ResultadoRetencion> {
  const r = await deps.auto.retenerPedidoGrande(input.organizationId, input.orderId, input.detalle);
  if (r.estado === "no_disponible" || !r.solicitudId) return { estado: "no_disponible" };
  if (r.estado === "creada") {
    await emitirNotificacion(deps.db, {
      evento: "restaurantes.aprobacion.pedido_grande",
      organizationId: input.organizationId,
      propertyId: r.propertyId,
      clave: r.solicitudId,
      entidadTipo: "solicitud_aprobacion",
      entidadId: r.solicitudId,
    });
  }
  return { estado: "por_aprobar", solicitudId: r.solicitudId, creada: r.estado === "creada" };
}

/** Hook de `crear_pedido` sobre UNA sesion: `disponible` es una lectura barata de la config (degrada con SAVEPOINT a `false` contra la base sin migrar). */
export function crearHookPedidoGrande(deps: Pick<AutopilotoServicioDeps, "auto" | "repo" | "db">): PedidoGrandeHook {
  return {
    async disponible(organizationId, propertyId) {
      return (await deps.auto.leerConfig(organizationId, propertyId)).disponible;
    },
    async retener(input) {
      const r = await retenerPedidoGrande(deps, input);
      return r.estado === "por_aprobar" ? { estado: "por_aprobar", solicitudId: r.solicitudId } : { estado: "no_disponible" };
    },
  };
}

export interface ResultadoResolucion {
  readonly resultado: ResultadoResolver;
  /** Efectos disparados en ESTA llamada (vacio en un doble clic). */
  readonly efectos: readonly string[];
}

/**
 * Resuelve una solicitud (aprobar/rechazar, cancelar/mantener, compensacion) y dispara los efectos UNA sola vez: si la base responde
 * `aplicado = false` (doble clic o carrera) no se repite ningun efecto. Los errores de regla (motivo fuera de la lista, descuento sobre el
 * tope, sin acceso) llegan como `AutopilotoValidacionError` / `AutopilotoAccesoError`.
 */
export async function resolverSolicitudAprobacion(
  deps: AutopilotoServicioDeps,
  input: { readonly organizationId: string; readonly solicitudId: string; readonly decision: SolicitudDecision } & OpcionesResolver,
): Promise<ResultadoResolucion | null> {
  const resultado = await deps.auto.resolverSolicitud(input.organizationId, input.solicitudId, input.decision, { motivo: input.motivo, valor: input.valor, indices: input.indices });
  if (!resultado) return null;
  if (!resultado.aplicado) return { resultado, efectos: [] };
  const efectos: string[] = [];
  const marca = async (nombre: string, fn: () => Promise<unknown>) => {
    try {
      await deps.repo.runWithRowSavepoint(fn);
      efectos.push(nombre);
    } catch (err) {
      // Un efecto secundario fallido (aviso, comanda) nunca revierte la decision ya tomada: se registra y el tick/panel muestran el estado real.
      console.error(`autopiloto: efecto "${nombre}" fallo tras resolver ${input.solicitudId} (la decision ya quedo guardada):`, err instanceof Error ? err.message : err);
    }
  };
  const order = resultado.orderId ? await deps.repo.findOrderById(input.organizationId, resultado.orderId) : null;

  // Un pedido que esta decision acaba de cancelar (rechazar un pedido grande, cancelar a peticion del cliente) no debe llegar a cocina despues: si su comanda
  // quedo pendiente/fallida en el POS, se corta igual que al cancelar por cambio de estado.
  if (order && resultado.estadoPedido === "cancelado" && (input.decision === "cancelar" || input.decision === "rechazar")) {
    await marca("comanda_cortada", async () => deps.cortarComandaCancelado?.(order));
  }

  if (resultado.tipo === "pedido_grande" && order) {
    if (input.decision === "aprobar" && (resultado.estadoPedido === "pending" || resultado.estadoPedido === "programado")) {
      if (resultado.estadoPedido === "pending") await marca("comanda_pos", async () => deps.encolarComandas?.([order]));
      await marca("aviso_cliente_aprobado", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.aprobado",
          dedupeKey: `order-aprobado:${order.id}`,
          cuerpo:
            resultado.estadoPedido === "programado"
              ? `${saludo(order)}su pedido${sucursalDe(order)} (${formatoMxn(order.total)}) quedó confirmado por la sucursal para la hora indicada.`
              : `${saludo(order)}su pedido${sucursalDe(order)} (${formatoMxn(order.total)}) fue confirmado por la sucursal y ya está en preparación.`,
          plantilla: PLANTILLAS_AUTOPILOTO.aprobado,
          detalle: formatoMxn(order.total),
        }),
      );
    } else if (input.decision === "rechazar" && resultado.estadoPedido === "cancelado") {
      await marca("aviso_cliente_rechazado", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.no_confirmado",
          dedupeKey: `order-no-confirmado:${order.id}`,
          cuerpo: `${saludo(order)}lamentamos avisarle que la sucursal no pudo confirmar su pedido${sucursalDe(order)}. Una persona le contactará por este medio para ayudarle.`,
          plantilla: PLANTILLAS_AUTOPILOTO.rechazado,
          detalle: "sin confirmar",
        }),
      );
      await marca("callback", () =>
        deps.repo.createCallbackRequest({
          organizationId: input.organizationId,
          propertyId: order.propertyId,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          reason: "pedido_grande_rechazado",
          message: `Pedido grande no confirmado (${input.motivo ?? "otro"}): contactar al cliente.`,
          source: "admin",
        }),
      );
    }
  } else if (resultado.tipo === "cancelacion" && order) {
    if (input.decision === "cancelar" && resultado.estadoPedido === "cancelado") {
      // El aviso "cancelado" reutiliza el productor de estados: su dedupe `order-status:<id>:cancelado` evita un segundo mensaje.
      await marca("aviso_cliente_cancelado", async () => notifyCustomerOnOrderStatusChangeCore(deps.repo, { ...order, status: "cancelado" }));
    } else {
      await marca("aviso_cliente_cancelacion_no_posible", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.cancelacion_no_posible",
          dedupeKey: `order-cancelacion-no:${input.solicitudId}`,
          cuerpo: `${saludo(order)}la sucursal no pudo cancelar su pedido${sucursalDe(order)} porque ya está en proceso. Si necesita algo más, escríbanos por aquí.`,
          plantilla: PLANTILLAS_AUTOPILOTO.cancelacionMantenida,
          detalle: "sigue en proceso",
        }),
      );
    }
  } else if (resultado.tipo === "compensacion" && order) {
    if (input.decision === "sin_compensacion") {
      await marca("aviso_cliente_compensacion", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.compensacion",
          dedupeKey: `order-compensacion:${input.solicitudId}`,
          cuerpo: `${saludo(order)}lamentamos el inconveniente con su pedido${sucursalDe(order)}. Gracias por avisarnos: lo tomamos en cuenta para mejorar.`,
          plantilla: PLANTILLAS_AUTOPILOTO.compensacionSin,
          detalle: "gracias por avisarnos",
        }),
      );
    } else if (input.decision === "reponer_producto" && resultado.reposicionOrderId) {
      const repo = await deps.repo.findOrderById(input.organizationId, resultado.reposicionOrderId);
      if (repo?.status === "pending") await marca("comanda_pos", async () => deps.encolarComandas?.([repo]));
      await marca("aviso_cliente_compensacion", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.compensacion",
          dedupeKey: `order-compensacion:${input.solicitudId}`,
          cuerpo: `${saludo(order)}lamentamos el inconveniente con su pedido${sucursalDe(order)}. La sucursal le enviará la reposición sin costo.`,
          plantilla: PLANTILLAS_AUTOPILOTO.compensacionReposicion,
          detalle: "reposición sin costo",
        }),
      );
    } else if (input.decision === "descuento_proximo" && resultado.codigoDescuento) {
      const codigo = resultado.codigoDescuento;
      await marca("aviso_cliente_compensacion", () =>
        encolarAvisoCliente(deps.repo, order, {
          tipoOutbox: "order.compensacion",
          dedupeKey: `order-compensacion:${input.solicitudId}`,
          cuerpo: `${saludo(order)}lamentamos el inconveniente con su pedido${sucursalDe(order)}. Use el código ${codigo} en su próximo pedido para un ${input.valor ?? ""}% de descuento (un solo uso, vigente 30 días).`,
          plantilla: PLANTILLAS_AUTOPILOTO.compensacionDescuento,
          detalle: codigo,
        }),
      );
    }
  }
  return { resultado, efectos };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. Cancelacion pedida por el cliente (herramienta `solicitar_cancelacion`)
// ---------------------------------------------------------------------------------------------------------------------------------------

export type ResultadoSolicitarCancelacion =
  | { readonly resultado: "cancelado"; readonly mensaje: string }
  | { readonly resultado: "solicitud_creada"; readonly solicitudId: string | null; readonly mensaje: string }
  | { readonly resultado: "sin_pedido_activo"; readonly mensaje: string }
  | { readonly resultado: "no_disponible"; readonly mensaje: string };

const ESTADOS_ACTIVOS: readonly OrderStatus[] = ["por_aprobar", "pending", "programado", "preparando", "listo_para_recoger", "en_camino", "problema", "no_recogido"];

/**
 * El pedido sale del TELEFONO del contexto y del ultimo pedido activo, NUNCA de un id que mande el modelo. Pedido `pending`/`programado` sin
 * comanda y politica de la sucursal encendida (por omision apagada: la decide PM) => cancelacion automatica con aviso; en cualquier otro caso
 * (en cocina, politica apagada, en camino) => solicitud de aprobacion (cancelar o mantener) y el staff decide con un clic.
 */
export async function solicitarCancelacion(
  deps: AutopilotoServicioDeps,
  input: {
    readonly organizationId: string;
    readonly customerPhone: string;
    readonly desdeIso: string;
    readonly motivo?: MotivoCancelacion;
    /** `false` cuando quien llama ya confirma por su cuenta (p. ej. la respuesta del agente en el chat): evita un segundo mensaje de "cancelado". Por omision `true`. */
    readonly avisarCliente?: boolean;
  },
): Promise<ResultadoSolicitarCancelacion> {
  const order = await deps.repo.findLatestOrderByPhone(input.organizationId, input.customerPhone, input.desdeIso);
  if (!order || !ESTADOS_ACTIVOS.includes(order.status)) return { resultado: "sin_pedido_activo", mensaje: "No encuentro un pedido activo de este número. Si desea, pásele el caso a una persona." };
  const motivo = input.motivo && esMotivoCancelacion(input.motivo) ? input.motivo : "cliente_desistio";
  const cfg = (await deps.auto.leerConfig(input.organizationId, order.propertyId)).valor;
  if (order.status === "por_aprobar") {
    // Ya hay una solicitud de aprobacion abierta para este pedido: no se crea otra ni se promete nada. `no_disponible` hace que el turno SIGA por el
    // camino de siempre (aviso a una persona de la sucursal), para que el staff no apruebe y mande a cocina un pedido que el cliente ya cancelo.
    return { resultado: "no_disponible", mensaje: "Su pedido aún lo está confirmando la sucursal; le paso el caso a una persona para que lo vea." };
  }
  if ((order.status === "pending" || order.status === "programado") && cfg.cancelacionAuto) {
    const r = await deps.auto.cancelarPorCliente(input.organizationId, order.id, motivo);
    if (r?.aplicado) {
      if (input.avisarCliente !== false) await deps.repo.runWithRowSavepoint(async () => notifyCustomerOnOrderStatusChangeCore(deps.repo, { ...order, status: "cancelado" }));
      await emitirNotificacion(deps.db, { evento: "restaurantes.pedido.cancelado_por_cliente", organizationId: input.organizationId, propertyId: order.propertyId, clave: order.id, entidadTipo: "order", entidadId: order.id });
      return { resultado: "cancelado", mensaje: "Listo, su pedido quedó cancelado." };
    }
    // Carrera o comanda ya enviada: cae a la solicitud (abajo).
  }
  const s = await deps.auto.crearSolicitud(input.organizationId, order.propertyId, "cancelacion", order.id, { origen: "cliente", estado: order.status, motivo });
  if (s.estado === "no_disponible") return { resultado: "no_disponible", mensaje: "No puedo gestionar la cancelación desde aquí; le paso el caso a una persona de la sucursal." };
  if (s.estado === "creada" && s.solicitudId) {
    await emitirNotificacion(deps.db, { evento: "restaurantes.aprobacion.cancelacion", organizationId: input.organizationId, propertyId: order.propertyId, clave: s.solicitudId, entidadTipo: "solicitud_aprobacion", entidadId: s.solicitudId });
  }
  return { resultado: "solicitud_creada", solicitudId: s.solicitudId, mensaje: "Ya avisé a la sucursal que desea cancelar; ellos confirman por aquí si todavía se puede, sin prometerlo." };
}

/** Queja ligada al pedido: crea (una vez) la solicitud de compensacion del ultimo pedido ENTREGADO del telefono y avisa en la campana. */
export async function registrarQuejaConPedido(
  deps: AutopilotoServicioDeps,
  input: { readonly organizationId: string; readonly customerPhone: string; readonly desdeIso: string; readonly subtipo: "faltante" | "equivocado" | "frio" | "tarde" | "trato" | "otro" },
): Promise<{ readonly estado: "creada" | "existente" | "sin_pedido" | "no_disponible"; readonly solicitudId: string | null }> {
  const order = await deps.repo.findLatestOrderByPhone(input.organizationId, input.customerPhone, input.desdeIso);
  if (!order || !(["entregado", "completado", "en_camino", "listo_para_recoger"] as readonly OrderStatus[]).includes(order.status)) return { estado: "sin_pedido", solicitudId: null };
  const s = await deps.auto.crearSolicitud(input.organizationId, order.propertyId, "compensacion", order.id, { subtipo: input.subtipo });
  if (s.estado === "no_disponible") return { estado: "no_disponible", solicitudId: null };
  if (s.estado === "creada" && s.solicitudId) {
    await emitirNotificacion(deps.db, { evento: "restaurantes.aprobacion.compensacion", organizationId: input.organizationId, propertyId: order.propertyId, clave: s.solicitudId, entidadTipo: "solicitud_aprobacion", entidadId: s.solicitudId });
  }
  return { estado: s.estado, solicitudId: s.solicitudId };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. Tick (cada unidad corre en su propia transaccion; ver apps/api .../autopiloto-tick.ts)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface ResumenEscalado {
  readonly disponible: boolean;
  readonly escaladas: number;
}

/** SQLSTATE transitorios (bloqueo no disponible, serializacion, deadlock, cancelacion por tiempo, falta de recursos, conexion): vale la pena reintentar la alerta. */
function esFalloTransitorioDeEmision(codigo: string | undefined): boolean {
  return codigo !== undefined && /^(55P03|40001|40P01|57014|53\d{3}|08\w{3}|57P0\d)$/.test(codigo);
}

/** Avisa al owner (campana, severidad critica) de las aprobaciones que llevan N minutos sin respuesta. NUNCA las aprueba. Una sola vez por solicitud. */
export async function escalarSolicitudesVencidas(deps: AutopilotoServicioDeps, ahora: Date): Promise<ResumenEscalado> {
  const r = await deps.auto.solicitudesPorEscalar(ahora, 100);
  if (!r.disponible) return { disponible: false, escaladas: 0 };
  let falloTransitorio: string | null = null;
  for (const s of r.valor) {
    const emision = await emitirNotificacion(deps.db, {
      evento: "restaurantes.aprobacion.vencida",
      organizationId: s.organizationId,
      propertyId: s.propertyId,
      clave: s.id,
      parametros: { minutos: s.minutos },
      entidadTipo: "solicitud_aprobacion",
      entidadId: s.id,
    });
    // `solicitudes_por_escalar` marca `escalada_at` en la misma consulta que las devuelve: si la alerta falla por un error transitorio (bloqueo, red) y aqui se
    // siguiera, la marca se confirmaria y la aprobacion vencida NUNCA se volveria a avisar. Se lanza al terminar el lote para que la transaccion de la unidad
    // revierta las marcas y el siguiente tick reintente (las alertas ya emitidas son idempotentes por su clave de dedupe). `invalida` es deterministico: no se reintenta.
    if (emision.estado === "error" && esFalloTransitorioDeEmision(emision.codigo)) falloTransitorio = emision.codigo ?? "sin codigo";
  }
  if (falloTransitorio !== null) throw new Error(`autopiloto: la alerta de aprobacion vencida fallo (SQLSTATE ${falloTransitorio}); se revierte el marcado para reintentar en el siguiente tick`);
  return { disponible: true, escaladas: r.valor.length };
}

export interface ResumenEstados {
  readonly disponible: boolean;
  readonly aplicados: number;
  readonly omitidos: number;
}

/** Limpieza por tiempo y aceptacion automatica: entregado->completado, listo_para_recoger->no_recogido (aviso al staff, sin mensaje al cliente), pending->preparando. */
export async function aplicarEstadosSinClic(deps: AutopilotoServicioDeps, ahora: Date, limite = 200): Promise<ResumenEstados> {
  const c = await deps.auto.candidatosEstados(ahora, limite);
  if (!c.disponible) return { disponible: false, aplicados: 0, omitidos: 0 };
  let aplicados = 0;
  let omitidos = 0;
  for (const cand of c.valor) {
    try {
      const ok = await deps.repo.runWithRowSavepoint(() => deps.auto.aplicarTransicion(cand.organizationId, cand.orderId, cand.desde, cand.hacia, "sistema", cand.motivo));
      if (!ok) {
        omitidos++;
        continue;
      }
      aplicados++;
      if (cand.hacia === "no_recogido") {
        await emitirNotificacion(deps.db, { evento: "restaurantes.pedido.no_recogido", organizationId: cand.organizationId, propertyId: cand.propertyId, clave: cand.orderId, entidadTipo: "order", entidadId: cand.orderId });
      } else if (cand.hacia === "preparando") {
        const order = await deps.repo.findOrderById(cand.organizationId, cand.orderId);
        if (order) await deps.repo.runWithRowSavepoint(async () => notifyCustomerOnOrderStatusChangeCore(deps.repo, { ...order, status: cand.hacia }));
      }
    } catch (err) {
      omitidos++;
      console.error(`autopiloto: transicion ${cand.desde}->${cand.hacia} del pedido fallo (se reintenta en el siguiente tick):`, err instanceof Error ? err.message : err);
    }
  }
  return { disponible: true, aplicados, omitidos };
}

/** Mapea el estado de la comanda en el POS al estado del pedido (la ruta de un solo sentido: nunca retrocede ni cancela). */
export function destinoDesdeEstadoPos(estadoPos: string, canal: CanalPedido | null): OrderStatus | null {
  if (estadoPos === "en_preparacion") return "preparando";
  if (estadoPos === "lista") return canal === "recoger" ? "listo_para_recoger" : "en_camino";
  return null;
}

export interface ResumenAvancePos {
  readonly disponible: boolean;
  readonly consultadas: number;
  readonly avanzadas: number;
  readonly sinAdaptadorReal: boolean;
}

/** Tope por consulta al POS y presupuesto total del paso (la funcion de Vercel muere a los 30 s: el paso debe rendirse antes y seguir). */
export const TIMEOUT_CONSULTA_POS_MS = 3_000;
export const PRESUPUESTO_PASO_POS_MS = 12_000;
const CONCURRENCIA_CONSULTA_POS = 5;

export interface OpcionesAvancePos {
  readonly timeoutConsultaMs?: number;
  readonly presupuestoMs?: number;
  readonly ahoraMs?: () => number;
}

export interface EstadoPosConsultado {
  readonly comanda: ComandaParaAvance;
  readonly estadoPos: string;
}

function conTimeoutPos<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`el POS no respondio en ${ms} ms`)), ms);
  });
  return Promise.race([p, limite]).finally(() => clearTimeout(timer));
}

/**
 * Fase 1 del avance (SIN base de datos): pregunta al POS el estado de cada comanda con un tope por consulta y un presupuesto total del paso
 * (QA R2 automatizacion-07). Hasta 5 consultas en paralelo; al agotarse el presupuesto ya no se lanzan mas y las comandas restantes quedan
 * para el siguiente tick. Una consulta lenta o fallida se salta (se reintenta en el siguiente tick), nunca cuelga al resto del tick. El tick
 * la corre FUERA de cualquier transaccion: una llamada de red no debe tener abierta una transaccion de base de datos.
 */
export async function consultarEstadosPos(
  comandas: readonly ComandaParaAvance[],
  port: SoftRestaurantPort,
  sucursalPos: (propertyId: string) => SucursalPos | null,
  opciones: OpcionesAvancePos = {},
): Promise<{ readonly consultadas: number; readonly estados: readonly EstadoPosConsultado[] }> {
  const timeoutMs = opciones.timeoutConsultaMs ?? TIMEOUT_CONSULTA_POS_MS;
  const presupuestoMs = opciones.presupuestoMs ?? PRESUPUESTO_PASO_POS_MS;
  const ahora = opciones.ahoraMs ?? Date.now;
  const inicio = ahora();
  const estados: EstadoPosConsultado[] = [];
  let consultadas = 0;
  let siguiente = 0;
  async function trabajador(): Promise<void> {
    while (siguiente < comandas.length && ahora() - inicio < presupuestoMs) {
      const cm = comandas[siguiente++]!;
      const sucursal = sucursalPos(cm.propertyId);
      if (!sucursal) continue;
      consultadas++;
      try {
        const e = await conTimeoutPos(port.obtenerEstadoComanda({ sucursal, folio: cm.folio }), timeoutMs);
        if (e.encontrada) estados.push({ comanda: cm, estadoPos: e.estado });
      } catch (err) {
        console.error("autopiloto: consulta al POS fallo (se reintenta en el siguiente tick):", err instanceof Error ? err.message : err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA_CONSULTA_POS, comandas.length) }, () => trabajador()));
  return { consultadas, estados };
}

/** Fase 2 del avance (con base de datos): mueve cada pedido segun el estado del POS (compare-and-set, aviso al cliente por el productor de estados). */
export async function aplicarAvancesPos(deps: AutopilotoServicioDeps, estados: readonly EstadoPosConsultado[]): Promise<number> {
  let avanzadas = 0;
  for (const { comanda: cm, estadoPos } of estados) {
    try {
      const destino = destinoDesdeEstadoPos(estadoPos, cm.canal);
      if (!destino) continue;
      const pasos: OrderStatus[] = cm.status === "pending" ? ["preparando", ...(destino === "preparando" ? [] : [destino])] : destino === "preparando" ? [] : [destino];
      let actual: OrderStatus = cm.status;
      for (const paso of pasos) {
        const ok = await deps.repo.runWithRowSavepoint(() => deps.auto.aplicarTransicion(cm.organizationId, cm.orderId, actual, paso, "pos", `pos:${estadoPos}`));
        if (!ok) break;
        actual = paso;
        avanzadas++;
        const order = await deps.repo.findOrderById(cm.organizationId, cm.orderId);
        if (order) await deps.repo.runWithRowSavepoint(async () => notifyCustomerOnOrderStatusChangeCore(deps.repo, { ...order, status: paso }));
      }
    } catch (err) {
      console.error("autopiloto: avance desde el POS fallo (se reintenta en el siguiente tick):", err instanceof Error ? err.message : err);
    }
  }
  return avanzadas;
}

/**
 * Avance desde el POS: consulta `obtenerEstadoComanda` de las comandas confirmadas y mueve el pedido (con aviso al cliente por el productor de
 * estados). Sin adaptador REAL (`port.esReal = false`) no consulta nada: estado honesto "requiere API de SoftRestaurant". Version de una sola
 * sesion (pruebas); el tick usa `consultarEstadosPos` fuera de la transaccion y `aplicarAvancesPos` en otra.
 */
export async function avanzarDesdePos(
  deps: AutopilotoServicioDeps,
  port: SoftRestaurantPort,
  sucursalPos: (propertyId: string) => SucursalPos | null,
  limite = 50,
  opciones: OpcionesAvancePos = {},
): Promise<ResumenAvancePos> {
  if (!port.esReal) return { disponible: true, consultadas: 0, avanzadas: 0, sinAdaptadorReal: true };
  const c = await deps.auto.comandasParaAvance(limite);
  if (!c.disponible) return { disponible: false, consultadas: 0, avanzadas: 0, sinAdaptadorReal: false };
  const { consultadas, estados } = await consultarEstadosPos(c.valor, port, sucursalPos, opciones);
  const avanzadas = await aplicarAvancesPos(deps, estados);
  return { disponible: true, consultadas, avanzadas, sinAdaptadorReal: false };
}

export interface ResumenHandoffs {
  readonly disponible: boolean;
  readonly devueltos: number;
}

/** Devuelve al agente los handoffs tomados sin respuesta humana en N minutos (nota + frase fija dentro de 24 h) y avisa en la campana. */
export async function devolverHandoffsVencidos(deps: AutopilotoServicioDeps, ahora: Date): Promise<ResumenHandoffs> {
  const r = await deps.auto.devolverHandoffsVencidos(ahora, 50);
  if (!r.disponible) return { disponible: false, devueltos: 0 };
  for (const h of r.valor) {
    await emitirNotificacion(deps.db, {
      evento: "restaurantes.handoff.devuelto_automatico",
      organizationId: h.organizationId,
      propertyId: h.propertyId,
      clave: h.handoffId,
      parametros: { minutos: h.minutos },
      entidadTipo: "conversation_handoff",
      entidadId: h.handoffId,
    });
  }
  return { disponible: true, devueltos: r.valor.length };
}

export interface ResumenAgotados {
  readonly disponible: boolean;
  readonly repuestos: number;
}

/** Restablece los "agotado solo por hoy" al cambiar el dia de negocio de cada sucursal (zona horaria de la sucursal, no UTC). */
export async function reponerAgotadosDelDia(deps: AutopilotoServicioDeps, ahora: Date): Promise<ResumenAgotados> {
  const r = await deps.auto.reponerAgotados(ahora);
  if (!r.disponible) return { disponible: false, repuestos: 0 };
  return { disponible: true, repuestos: r.valor.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 4. Tiempo prometido aprendido y confirmacion inmediata de voz y web
// ---------------------------------------------------------------------------------------------------------------------------------------

export async function estimarTiempoSucursal(deps: { readonly auto: Pick<AutopilotoRepository, "leerConfig" | "muestrasTiempo"> | null; readonly repo: Pick<RestaurantesRepository, "findWhatsAppAgentConfig"> }, input: { readonly organizationId: string; readonly propertyId: string; readonly canal: CanalPedido; readonly ahora: Date }): Promise<TiempoEstimado> {
  // Sin repositorio del autopiloto (despliegue sin cablear) o con la base sin migrar: sin muestras ni umbrales => texto fijo del dueno.
  // SECUENCIAL a proposito: las tres lecturas comparten UNA sesion (un solo cliente pg en orden FIFO); con Promise.all el SAVEPOINT de una lectura
  // fallida (42883 con la base sin migrar) dejaba encolada la siguiente en transaccion abortada (25P02) y destruia el savepoint de la otra (3B001).
  const config = deps.auto ? await deps.auto.leerConfig(input.organizationId, input.propertyId) : { disponible: false, valor: AUTOPILOTO_CONFIG_POR_OMISION };
  const muestras = deps.auto ? await deps.auto.muestrasTiempo(input.organizationId, input.propertyId, input.canal, input.ahora) : { disponible: false, valor: { muestras: [], abiertos: 0 } };
  const agente = await deps.repo.findWhatsAppAgentConfig(input.organizationId, input.propertyId);
  const cfg = config.valor ?? AUTOPILOTO_CONFIG_POR_OMISION;
  return estimarTiempo({
    textoFijo: agente?.deliveryTimeText ?? null,
    canal: input.canal,
    muestras: muestras.valor.muestras,
    abiertos: muestras.valor.abiertos,
    saturacion: { umbral1: cfg.saturacionUmbral1, umbral2: cfg.saturacionUmbral2, extraMinutos: cfg.saturacionExtraMinutos },
  });
}

export type ResultadoConfirmacionRecibido = { readonly enviado: boolean; readonly motivo?: "canal_no_aplica" | "sin_telefono" | "sin_canal_whatsapp" };

/**
 * "Recibimos su pedido #folio, tiempo estimado X": solo para los canales VOZ y WEB (WhatsApp ya confirma en el chat). Idempotente por pedido
 * (dedupe `order-recibido:<id>`); fuera de la ventana de 24 h solo sale con plantilla aprobada (R-25), si no el dispatcher lo marca `dead`.
 */
export async function confirmarPedidoRecibido(repo: RestaurantesRepository, order: Order, tiempoTexto: string, folio: string | number | null): Promise<ResultadoConfirmacionRecibido> {
  if (order.source !== "voice" && order.source !== "web") return { enviado: false, motivo: "canal_no_aplica" };
  const etiqueta = folio === null ? "" : ` #${folio}`;
  const r = await encolarAvisoCliente(repo, order, {
    tipoOutbox: "order.recibido",
    dedupeKey: `order-recibido:${order.id}`,
    cuerpo: `${saludo(order)}recibimos su pedido${etiqueta}${sucursalDe(order)}. Tiempo estimado: ${tiempoTexto}.`,
    plantilla: PLANTILLAS_AUTOPILOTO.recibido,
    detalle: folio === null ? tiempoTexto : `${folio} - ${tiempoTexto}`,
  });
  if (r.enqueued) return { enviado: true };
  return { enviado: false, motivo: r.reason === "no_customer_phone" ? "sin_telefono" : "sin_canal_whatsapp" };
}

