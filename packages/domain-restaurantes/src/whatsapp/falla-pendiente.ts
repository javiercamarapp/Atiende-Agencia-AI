// PM ronda 21 (arreglo 2 del informe R20): tras un turno que murio por falla del sistema (proveedor caido, `tope_llamada`) el cliente recibe el aviso
// «problema tecnico / ya avise al equipo» como respuesta del agente. En el turno siguiente el modelo ve ese aviso como SU ultima palabra y el mensaje
// que lo provoco como algo ya atendido por una persona: vuelve a preguntar «¿que desea pedir?». Aqui el SERVIDOR reconoce ese aviso en el historial y le
// dice al modelo que el mensaje previo del cliente NO fue atendido. No crea pedidos ni toca la maquina de estados: solo es texto de sistema del turno, asi
// que la idempotencia de `crear_pedido` (huella, resumen mostrado, «si» explicito) sigue siendo la unica puerta de un pedido.
import type { ConversationMessage } from "../repository.ts";
import { PM_COPY } from "./perfil-pm.ts";

/** Lista unica de avisos de falla reconocibles (la misma que usa el PR de reglas de cierre R21). Avisos de falla que el servidor le manda al cliente cuando el turno no pudo contestar (PM y genericos). */
const AVISOS_DE_FALLA: readonly string[] = [
  PM_COPY.sinAsistenteAvisoEquipo,
  PM_COPY.problemaTecnico,
  "Ahorita tenemos un problema técnico. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
  "Ahorita tenemos un problema técnico, por favor inténtelo de nuevo en un momento.",
];
const MAX_MENSAJES_PENDIENTES = 3;

/** El texto del mensaje del asistente es un aviso de falla del sistema (no una respuesta del modelo). */
export function esAvisoDeFallaDelSistema(contenido: string): boolean {
  const c = contenido.trim();
  return AVISOS_DE_FALLA.some((a) => c === a || c.startsWith(a));
}

/**
 * Mensajes del cliente que quedaron sin atender porque el turno murio: los que van entre la ultima respuesta REAL del agente y el ultimo aviso de falla (cruzando avisos consecutivos), SOLO si ese aviso
 * es la ULTIMA respuesta del agente en el historial. Vacio si la ultima respuesta fue del modelo (nada que retomar).
 */
export function mensajesPerdidosPorFalla(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  let ultimoAsistente = -1;
  messages.forEach((m, i) => { if (m.role === "assistant") ultimoAsistente = i; });
  if (ultimoAsistente < 0 || !esAvisoDeFallaDelSistema(messages[ultimoAsistente]!.content)) return [];
  // Retrocede por los avisos de falla CONSECUTIVOS (aviso, aviso) hasta la ultima respuesta REAL del asistente: asi no se pierde el pedido original si hubo dos fallas seguidas.
  let anterior = -1;
  for (let i = ultimoAsistente - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && !esAvisoDeFallaDelSistema(m.content)) { anterior = i; break; }
  }
  return messages.slice(anterior + 1, ultimoAsistente).filter((m) => m.role === "user").slice(-MAX_MENSAJES_PENDIENTES);
}

/** Bloque de sistema del turno. Vacio si el ultimo aviso del agente no fue una falla o no hay mensaje perdido. */
export function bloquePedidoPendienteTrasFalla(messages: readonly ConversationMessage[]): string {
  const perdidos = mensajesPerdidosPorFalla(messages);
  if (perdidos.length === 0) return "";
  return [
    "REGLA DEL SERVIDOR PARA ESTE TURNO (falla previa del sistema):",
    `Su ultima respuesta en la conversacion («problema tecnico / ya avise al equipo») NO la escribio usted: fue un aviso automatico porque el sistema fallo. Los ${perdidos.length === 1 ? "mensaje" : `${perdidos.length} mensajes`} del cliente justo antes de ese aviso NO fueron atendidos por usted. Tomelos como el pedido o la duda VIGENTE, junto con el mensaje nuevo (si el nuevo solo dice «hola», «?», «gracias» o «sigue ahi», es una espera de respuesta a lo anterior).`,
    "Continue desde ahi: no le vuelva a preguntar lo que ya dijo (que desea pedir, productos, cantidades, sucursal, direccion), no repita el aviso de falla y ofrezcale una disculpa breve. Un pedido solo se crea por el camino de siempre (cotizar, resumen, «si» explicito del cliente y crear_pedido): no cree nada sin esa confirmacion y no asuma que alguien ya registro el pedido. Si el cliente ya tiene un pedido creado, no abra otro. No mencione al servidor.",
  ].join("\n");
}
