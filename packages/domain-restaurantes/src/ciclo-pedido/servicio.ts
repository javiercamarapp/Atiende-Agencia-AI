// Servicio del ciclo operativo del pedido (F4b): aceptar/rechazar con tiempo prometido y motivo, salida y entrega con hora real, encuesta
// post-entrega por WhatsApp y recordatorios de pedidos sin aceptar. Toda la logica de negocio vive aqui (puertos inyectados: repositorio del dominio,
// repositorio del ciclo, sesion de BD para el productor de notificaciones) para que las rutas HTTP solo autoricen y traduzcan errores.
//
// Reutiliza lo que YA existe y no lo duplica:
//   * Aviso al cliente: el MISMO outbox de WhatsApp (`enqueueMessagingOutbox`) y las MISMAS claves de evento/dedupe que `order-notifications.ts`
//     (`order.status.preparando|cancelado` con `order-status:<id>:<estado>`): si el pedido se mueve despues por el PATCH de estado, el cliente no recibe un aviso doble.
//   * Aviso a la sucursal: el productor compartido `emitirNotificacion` (campana del panel), como el aviso «sin aceptar» de 15 min de `avisos-operativos.ts`.
//   * Encuesta: criterios (2 a 3 h, silencio nocturno, una por pedido, una cada 14 dias, 1 a 5, sin incentivo) de `encuesta-reglas.ts`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import { registerCallbackRequest } from "../callback-requests.ts";
import { ENCUESTA_CALLBACK_MOTIVO_BAJA } from "../encuesta-reglas.ts";
import { descripcionSeguraDeError } from "../log-seguro.ts";
import { changeOrderStatus } from "../order-lifecycle.ts";
import { tryNotifyCustomerOnOrderStatusChange } from "../order-notifications.ts";
import { normalizePhone, toWhatsAppRecipient } from "../phone.ts";
import { actorHash } from "../rate-limit.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { Order } from "../types.ts";
import {
  PLANTILLA_ENCUESTA_ENTREGA,
  PLANTILLA_PEDIDO_ACEPTADO,
  PLANTILLA_PEDIDO_RECHAZADO,
  TEXTO_BAJA_ENCUESTA,
  TEXTO_GRACIAS_COMENTARIO,
  TIEMPO_PROMETIDO_POR_OMISION,
  calcularRatiosOperacion,
  decidirEncuesta,
  esTiempoPrometidoValido,
  interpretarRespuestaEncuesta,
  parametrosEncuesta,
  parametrosPedidoAceptado,
  parametrosPedidoRechazado,
  textoEncuesta,
  textoEncuestaSeguro,
  textoPedidoAceptado,
  textoPedidoRechazado,
  textosTrasCalificar,
} from "./reglas.ts";
import type { MotivoOmision, MotivoRechazo, RatiosOperacion } from "./reglas.ts";
import { CicloNoDisponibleError, CicloNoEncontradoError, CicloValidacionError } from "./tipos.ts";
import type { CicloPedidoRepository, ResultadoDespachar, ResultadoEntregarStaff } from "./tipos.ts";

export interface CicloServicioDeps {
  readonly repo: RestaurantesRepository;
  readonly ciclo: CicloPedidoRepository;
  /** Sesion de BD (para `emitirNotificacion` y el SAVEPOINT de los avisos). Ausente en pruebas que no emiten campana. */
  readonly db?: TenantDbSession;
  /** Plantillas declaradas APROBADAS por el operador (`WHATSAPP_APPROVED_TEMPLATES`). Sin `encuesta_entrega` aqui no se escribe fuera de la ventana de 24 h. */
  readonly plantillasAprobadas?: readonly string[];
}

export interface ResultadoAviso {
  readonly encolado: boolean;
  readonly motivo?: "sin_telefono" | "sin_canal_whatsapp" | "error";
}

async function pedidoOFalla(repo: RestaurantesRepository, organizationId: string, orderId: string): Promise<Order> {
  const order = await repo.findOrderById(organizationId, orderId);
  if (!order) throw new CicloNoEncontradoError("Pedido no encontrado.");
  return order;
}

async function canalDelPedido(repo: RestaurantesRepository, order: Order): Promise<"domicilio" | "recoger"> {
  const [info] = await repo.listOrderPickupInfo(order.organizationId, [order.id]);
  return info?.canal === "recoger" ? "recoger" : "domicilio";
}

/** Encola el aviso al cliente por el canal de notificaciones de pedido. Best-effort: nunca lanza ni revierte la decision de la sucursal. */
async function avisarCliente(
  repo: RestaurantesRepository,
  order: Order,
  evento: string,
  dedupe: string,
  cuerpo: string,
  plantilla: { readonly name: string; readonly language: string; readonly params: readonly string[] },
): Promise<ResultadoAviso> {
  try {
    return await repo.runWithRowSavepoint(async (): Promise<ResultadoAviso> => {
      if (!order.customerPhone) return { encolado: false, motivo: "sin_telefono" };
      const recipient = toWhatsAppRecipient(order.customerPhone);
      if (!recipient) return { encolado: false, motivo: "sin_telefono" };
      const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(order.organizationId, order.propertyId);
      if (!phoneNumberId) return { encolado: false, motivo: "sin_canal_whatsapp" };
      await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", evento, dedupe, {
        to: recipient,
        phone_number_id: phoneNumberId,
        body: cuerpo,
        transaccional: true, // estado de SU pedido: la lista de supresion no lo bloquea (SA-L-46).
        template: plantilla,
      });
      return { encolado: true };
    });
  } catch (err) {
    console.error("ciclo-pedido: el aviso al cliente fallo (la decision ya quedo registrada):", descripcionSeguraDeError(err));
    return { encolado: false, motivo: "error" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. Aceptar / rechazar
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface AceptarEntrada {
  readonly organizationId: string;
  readonly orderId: string;
  /** Tiempo prometido en minutos (editable por la sucursal). Ausente = el valor por omision del canal. */
  readonly tiempoPrometidoMin?: number;
}
export interface ResultadoAceptarPedido {
  readonly resultado: "aceptado" | "ya_aplicado";
  readonly aceptadoAt: string;
  readonly tiempoPrometidoMin: number;
  readonly aviso: ResultadoAviso;
}

export async function aceptarPedido(deps: CicloServicioDeps, entrada: AceptarEntrada): Promise<ResultadoAceptarPedido> {
  const order = await pedidoOFalla(deps.repo, entrada.organizationId, entrada.orderId);
  const canal = await canalDelPedido(deps.repo, order);
  const minutos = entrada.tiempoPrometidoMin ?? TIEMPO_PROMETIDO_POR_OMISION[canal];
  if (!esTiempoPrometidoValido(minutos)) throw new CicloValidacionError("tiempoPrometidoMin debe ser un entero entre 5 y 240.");
  const r = await deps.ciclo.aceptar(entrada.organizationId, entrada.orderId, minutos);
  // Un reintento (`ya_aplicado`) no duplica el aviso: la clave de dedupe del outbox lo cubre.
  const aviso = await avisarCliente(
    deps.repo,
    order,
    "order.status.preparando",
    `order-status:${order.id}:preparando`,
    textoPedidoAceptado(order, r.tiempoPrometidoMin, canal),
    { ...PLANTILLA_PEDIDO_ACEPTADO, params: parametrosPedidoAceptado(order, r.tiempoPrometidoMin) },
  );
  return { resultado: r.resultado, aceptadoAt: r.aceptadoAt, tiempoPrometidoMin: r.tiempoPrometidoMin, aviso };
}

export interface RechazarEntrada {
  readonly organizationId: string;
  readonly orderId: string;
  readonly motivo: MotivoRechazo;
  readonly nota?: string | null;
}
export interface ResultadoRechazarPedido {
  readonly resultado: "rechazado" | "ya_aplicado";
  readonly rechazadoAt: string;
  readonly motivo: MotivoRechazo;
  readonly aviso: ResultadoAviso;
}

export async function rechazarPedido(deps: CicloServicioDeps, entrada: RechazarEntrada): Promise<ResultadoRechazarPedido> {
  const order = await pedidoOFalla(deps.repo, entrada.organizationId, entrada.orderId);
  const nota = typeof entrada.nota === "string" && entrada.nota.trim().length > 0 ? entrada.nota.trim() : null;
  if (nota !== null && nota.length > 240) throw new CicloValidacionError("La nota no puede pasar de 240 caracteres.");
  const r = await deps.ciclo.rechazar(entrada.organizationId, entrada.orderId, entrada.motivo, nota);
  // La nota interna NUNCA va al cliente: solo la frase de la lista cerrada de motivos.
  const aviso = await avisarCliente(deps.repo, order, "order.status.cancelado", `order-status:${order.id}:cancelado`, textoPedidoRechazado(order, r.motivo), {
    ...PLANTILLA_PEDIDO_RECHAZADO,
    params: parametrosPedidoRechazado(order, r.motivo),
  });
  return { resultado: r.resultado, rechazadoAt: r.rechazadoAt, motivo: r.motivo, aviso };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. Salida (asignar repartidor) y entrega con hora real
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface SalidaEntrada {
  readonly organizationId: string;
  readonly orderId: string;
  readonly repartidorId: string;
  /** Minutos estimados hasta la entrega (5 a 240). Ausente = 45. */
  readonly etaMin?: number;
}
export interface ResultadoSalida {
  readonly resultado: ResultadoDespachar["resultado"];
  readonly salioAt: string | null;
  readonly repartidorId: string;
  /** `false` = la base aun no tiene la 092 y se uso el camino anterior (asignar + cambiar estado): no se registra la hora real de salida. */
  readonly horaRealRegistrada: boolean;
}

export async function registrarSalida(deps: CicloServicioDeps, entrada: SalidaEntrada): Promise<ResultadoSalida> {
  const order = await pedidoOFalla(deps.repo, entrada.organizationId, entrada.orderId);
  const eta = entrada.etaMin ?? TIEMPO_PROMETIDO_POR_OMISION.domicilio;
  if (!Number.isInteger(eta) || eta < 5 || eta > 240) throw new CicloValidacionError("etaMin debe ser un entero entre 5 y 240.");
  let r: ResultadoDespachar;
  let horaRealRegistrada = true;
  try {
    r = await deps.ciclo.despachar(entrada.organizationId, entrada.orderId, entrada.repartidorId, eta);
  } catch (err) {
    if (!(err instanceof CicloNoDisponibleError)) throw err;
    // Base sin la 092: camino anterior (asignar y luego cambiar el estado). Sin hora real de salida.
    horaRealRegistrada = false;
    const estimada = new Date(Date.now() + eta * 60_000).toISOString();
    const asignado = await deps.repo.assignRepartidorToOrder(entrada.organizationId, entrada.orderId, entrada.repartidorId, estimada);
    if (!asignado) throw new CicloNoEncontradoError("Pedido no encontrado.");
    if (asignado.status !== "en_camino") await changeOrderStatus(deps.repo, entrada.organizationId, asignado, "en_camino", deps.db, { avisarCliente: false });
    r = { resultado: "despachado", salioAt: null, repartidorId: entrada.repartidorId };
  }
  if (r.resultado === "despachado") {
    const actualizado = (await deps.repo.findOrderById(entrada.organizationId, entrada.orderId)) ?? order;
    await tryNotifyCustomerOnOrderStatusChange(deps.repo, actualizado, deps.db);
  }
  return { resultado: r.resultado, salioAt: r.salioAt, repartidorId: r.repartidorId, horaRealRegistrada };
}

export interface EntregaEntrada {
  readonly organizationId: string;
  readonly orderId: string;
  /** Hora real en que ocurrio la entrega (pasada o ahora). Ausente = ahora. */
  readonly ocurrioEn?: Date | null;
  readonly cobradoMonto?: number | null;
}

export async function registrarEntrega(deps: CicloServicioDeps, entrada: EntregaEntrada): Promise<ResultadoEntregarStaff> {
  const r = await deps.ciclo.entregarStaff(entrada.organizationId, entrada.orderId, entrada.ocurrioEn ?? null, entrada.cobradoMonto ?? null);
  if (r.resultado === "entregado") {
    const actualizado = await deps.repo.findOrderById(entrada.organizationId, entrada.orderId);
    if (actualizado) await tryNotifyCustomerOnOrderStatusChange(deps.repo, actualizado, deps.db);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. Encuesta post-entrega
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface ResumenBarridoEncuestas {
  readonly disponible: boolean;
  readonly candidatas: number;
  readonly enviadas: number;
  readonly enviadasPlantilla: number;
  readonly omitidas: number;
  readonly esperando: number;
  readonly errores: number;
}

/** Recorre los pedidos entregados sin encuesta y envia (o registra la omision de) cada una. Una vez por pedido: el renglon se reserva ANTES de encolar. */
export async function barrerEncuestas(deps: CicloServicioDeps, ahora: Date, limite = 50): Promise<ResumenBarridoEncuestas> {
  const lectura = await deps.ciclo.candidatasEncuesta(ahora, limite);
  if (!lectura.disponible) return { disponible: false, candidatas: 0, enviadas: 0, enviadasPlantilla: 0, omitidas: 0, esperando: 0, errores: 0 };
  const aprobada = (deps.plantillasAprobadas ?? []).includes(PLANTILLA_ENCUESTA_ENTREGA.name);
  let enviadas = 0;
  let enviadasPlantilla = 0;
  let omitidas = 0;
  let esperando = 0;
  let errores = 0;
  for (const c of lectura.valor) {
    try {
      await deps.repo.runWithRowSavepoint(async () => {
        const recipient = toWhatsAppRecipient(c.customerPhone);
        const phoneNumberId = recipient ? await deps.repo.resolveActiveWhatsAppPhoneNumberId(c.organizationId, c.propertyId) : null;
        const decision = decidirEncuesta({
          ahora,
          deliveredAt: new Date(c.deliveredAt),
          zonaHoraria: c.zonaHoraria,
          telefonoValido: recipient !== null,
          optOut: c.optOut,
          ultimaEncuestaCliente: c.ultimaEncuestaAt ? new Date(c.ultimaEncuestaAt) : null,
          ultimoEntrante: c.ultimoEntranteAt ? new Date(c.ultimoEntranteAt) : null,
          plantillaAprobada: aprobada,
          consentimiento: c.consentimiento,
          hayCanal: phoneNumberId !== null,
        });
        if (decision.accion === "esperar") {
          esperando += 1;
          return;
        }
        if (decision.accion === "omitir") {
          if (await deps.ciclo.reservarEncuesta(c.organizationId, c.orderId, c.phoneHash, "omitida", decision.motivo as MotivoOmision, null)) omitidas += 1;
          return;
        }
        const order = await deps.repo.findOrderById(c.organizationId, c.orderId);
        const sucursal = order?.branch ?? null;
        const cuerpo = textoEncuesta(sucursal);
        if (!textoEncuestaSeguro(cuerpo)) throw new Error("texto de encuesta con incentivo de resena");
        // Reservar primero: si otro barrido gano la carrera, este NO envia.
        if (!(await deps.ciclo.reservarEncuesta(c.organizationId, c.orderId, c.phoneHash, "enviada", null, decision.canal))) return;
        await deps.repo.enqueueMessagingOutbox(c.organizationId, "whatsapp", "encuesta.entrega", `encuesta:${c.orderId}`, {
          to: recipient,
          phone_number_id: phoneNumberId,
          body: cuerpo,
          // NO transaccional: es una encuesta, la lista de supresion SI la bloquea.
          ...(decision.canal === "plantilla" ? { template: { ...PLANTILLA_ENCUESTA_ENTREGA, params: parametrosEncuesta(order?.customerName ?? null, sucursal) } } : {}),
        });
        enviadas += 1;
        if (decision.canal === "plantilla") enviadasPlantilla += 1;
      });
    } catch (err) {
      errores += 1;
      console.error("ciclo-pedido: una encuesta fallo (el barrido sigue):", descripcionSeguraDeError(err));
    }
  }
  return { disponible: true, candidatas: lectura.valor.length, enviadas, enviadasPlantilla, omitidas, esperando, errores };
}

export interface RespuestaEntrante {
  /** Texto fijo para devolver al cliente (el llamador lo encola y NO corre al agente). */
  readonly reply: string;
  readonly tipo: "calificacion" | "comentario" | "baja";
}

/** Parece que el cliente empieza un pedido nuevo: no se toma como comentario de la encuesta. */
function parecePedidoNuevo(texto: string): boolean {
  return /\b(quiero|quisiera|me (da|das|pone|ponen|manda)|mand(a|e|en)me|pedir|pedido nuevo|menu|menú|hola|buenas|cancel)/i.test(texto);
}

/**
 * Interpreta un mensaje ENTRANTE si el telefono tiene una encuesta abierta. `null` = no es una respuesta de encuesta: el mensaje sigue su camino normal (agente).
 * Calificacion 1 a 5 => registra; <= 3 abre recuperacion privada (callback `encuesta_baja` + aviso en la campana) y nunca invita a Google; BAJA => opt-out.
 * Tras calificar, el SIGUIENTE mensaje (hasta 30 min) se guarda como comentario opcional, salvo que parezca un pedido nuevo.
 */
export async function procesarMensajeDeEncuesta(deps: CicloServicioDeps, args: { readonly organizationId: string; readonly phone: string; readonly body: string; readonly ahora?: Date }): Promise<RespuestaEntrante | null> {
  const ahora = args.ahora ?? new Date();
  const hash = actorHash(normalizePhone(args.phone));
  const estado = await deps.ciclo.estadoEsperadoEncuesta(args.organizationId, hash, ahora);
  if (!estado.disponible || estado.valor === "ninguna") return null;
  const interpretado = interpretarRespuestaEncuesta(args.body);
  if (interpretado.tipo === "baja") {
    await deps.ciclo.registrarBajaEncuesta(args.organizationId, hash);
    return { reply: TEXTO_BAJA_ENCUESTA, tipo: "baja" };
  }
  if (estado.valor === "calificacion") {
    if (interpretado.tipo !== "calificacion") return null;
    const r = await deps.ciclo.responderEncuesta(args.organizationId, hash, interpretado.valor, ahora);
    if (r.resultado !== "respondida" || !r.orderId || !r.propertyId) return null;
    const order = await deps.repo.findOrderById(args.organizationId, r.orderId);
    const sucursal = order?.branch ?? "la sucursal";
    const textos = textosTrasCalificar(interpretado.valor, sucursal, r.linkResena ?? null);
    if (textos.esBaja) await abrirRecuperacionPrivada(deps, order, interpretado.valor, r.propertyId, r.orderNumber ?? null);
    return { reply: textos.cliente, tipo: "calificacion" };
  }
  // estado "comentario"
  if (interpretado.tipo === "calificacion" || parecePedidoNuevo(args.body)) return null;
  const c = await deps.ciclo.comentarEncuesta(args.organizationId, hash, args.body, ahora);
  if (c.resultado !== "comentada") return null;
  return { reply: TEXTO_GRACIAS_COMENTARIO, tipo: "comentario" };
}

async function abrirRecuperacionPrivada(deps: CicloServicioDeps, order: Order | null, calificacion: number, propertyId: string, orderNumber: number | null): Promise<void> {
  if (!order) return;
  try {
    await deps.repo.runWithRowSavepoint(async () => {
      await registerCallbackRequest(deps.repo, {
        organizationId: order.organizationId,
        propertyId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        reason: ENCUESTA_CALLBACK_MOTIVO_BAJA,
        message: `Encuesta post-entrega: el cliente calificó ${calificacion} de 5${orderNumber !== null ? ` el pedido #${orderNumber}` : ""}. Llamarle para atenderle; no se envía a Google.`,
        source: "admin",
        sourceEventId: `encuesta:${order.id}`,
      });
    });
  } catch (err) {
    console.error("ciclo-pedido: no se pudo abrir la recuperacion privada:", descripcionSeguraDeError(err));
  }
  if (deps.db) {
    await emitirNotificacion(deps.db, {
      evento: "restaurantes.encuesta.calificacion_baja",
      organizationId: order.organizationId,
      propertyId,
      clave: order.id,
      parametros: { calificacion },
      entidadTipo: "order",
      entidadId: order.id,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 4. Recordatorios de pedidos sin aceptar
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface ResumenBarridoRecordatorios {
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly emitidas: number;
  readonly sinNuevas: number;
  readonly escaladas: number;
  readonly errores: number;
}

/**
 * Un recordatorio por pedido sin aceptar y por numero (clave `<pedido>:<n>`), al gerente de pedidos (staff de la sucursal) por la campana del panel. El ULTIMO
 * recordatorio se escala tambien a owner/admin (`escalado_sin_aceptar`). No reemplaza el aviso unico de 15 min de `avisos-operativos.ts`; es apagable por sucursal.
 */
export async function barrerRecordatorios(deps: CicloServicioDeps & { readonly db: TenantDbSession }, ahora: Date): Promise<ResumenBarridoRecordatorios> {
  const lectura = await deps.ciclo.candidatosRecordatorio(ahora);
  if (!lectura.disponible) return { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, escaladas: 0, errores: 0 };
  let emitidas = 0;
  let sinNuevas = 0;
  let escaladas = 0;
  let errores = 0;
  for (const c of lectura.valor) {
    const base = { organizationId: c.organizationId, propertyId: c.propertyId, entidadTipo: "order", entidadId: c.orderId } as const;
    const r = await emitirNotificacion(deps.db, { evento: "restaurantes.pedido.recordatorio_sin_aceptar", ...base, clave: `${c.orderId}:${c.numeroRecordatorio}`, parametros: { numero: c.orderNumber, minutos: c.minutos } });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
    if (c.numeroRecordatorio >= c.maximo) {
      const e = await emitirNotificacion(deps.db, { evento: "restaurantes.pedido.escalado_sin_aceptar", ...base, clave: c.orderId, parametros: { numero: c.orderNumber, minutos: c.minutos } });
      if (e.estado === "emitida") escaladas += 1;
      else if (e.estado !== "sin_nuevas") errores += 1;
    }
  }
  return { disponible: true, candidatos: lectura.valor.length, emitidas, sinNuevas, escaladas, errores };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 5. Ratios
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface ResultadoRatios {
  readonly disponible: boolean;
  readonly desde: string;
  readonly hasta: string;
  readonly ratios: RatiosOperacion | null;
  readonly detalle: { readonly tiempos: boolean; readonly encuesta: boolean };
}

export async function obtenerRatiosOperacion(deps: Pick<CicloServicioDeps, "ciclo">, organizationId: string, propertyId: string, desde: Date, hasta: Date): Promise<ResultadoRatios> {
  const [t, e] = await Promise.all([deps.ciclo.tiempos(organizationId, propertyId, desde, hasta), deps.ciclo.metricasEncuesta(organizationId, propertyId, desde, hasta)]);
  const tiempos = t.disponible && t.valor !== null;
  const encuesta = e.disponible && e.valor !== null;
  const vacioT = { pedidos: 0, aceptados: 0, rechazados: 0, entregadosConPromesa: 0, aTiempo: 0, realMinProm: null, prometidoMinProm: null, aceptacionSegProm: null, salidaMinProm: null, rechazosPorMotivo: {} };
  const vacioE = { enviadas: 0, respondidas: 0, omitidas: 0, conComentario: 0, sumaCalificacion: 0, bajas: 0, distribucion: {}, omitidasPorMotivo: {}, optouts: 0 };
  return {
    disponible: tiempos || encuesta,
    desde: desde.toISOString(),
    hasta: hasta.toISOString(),
    ratios: tiempos || encuesta ? calcularRatiosOperacion(t.valor ?? vacioT, e.valor ?? vacioE) : null,
    detalle: { tiempos, encuesta },
  };
}
