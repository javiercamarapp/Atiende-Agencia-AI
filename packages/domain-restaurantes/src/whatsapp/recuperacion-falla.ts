// R21 (G1 / NU-2 / T7-012, R20-FALLOS.md): tras un aviso de «falla del sistema» (el turno murio por proveedor o tope de tiempo) el mensaje del cliente con su pedido quedaba "respondido" por el aviso
// y el turno siguiente volvia a preguntar «¿Qué le gustaría pedir?» aunque el cliente ya habia dado la orden completa. El servidor detecta el aviso de falla como ultima respuesta del asistente y le fija
// al modelo, SOLO para ese turno, los mensajes que quedaron sin atender para que retome el pedido en vez de reiniciarlo.
import { PM_COPY } from "./perfil-pm.ts";

type Mensaje = { readonly role: string; readonly content: string };

const COPIES_DE_FALLA: readonly string[] = [PM_COPY.sinAsistenteAvisoEquipo, PM_COPY.problemaTecnico];
const MAX_MENSAJES = 6;
const MAX_LARGO = 300;

/** ¿Este mensaje del asistente es un aviso de falla del sistema (y no una respuesta real)? */
export function esAvisoDeFalla(contenido: string): boolean {
  return COPIES_DE_FALLA.some((c) => contenido.includes(c));
}

/**
 * Mensajes del cliente que quedaron SIN atender por la falla: los que van despues de la ultima respuesta REAL del asistente y antes (o hasta) el aviso de falla, mas los nuevos.
 * Vacio si la ultima respuesta del asistente no fue un aviso de falla.
 */
export function mensajesPerdidosPorFalla(historial: readonly Mensaje[]): string[] {
  let ultimoAsistente = -1;
  historial.forEach((m, i) => {
    if (m.role === "assistant") ultimoAsistente = i;
  });
  if (ultimoAsistente < 0 || !esAvisoDeFalla(historial[ultimoAsistente]!.content)) return [];
  // Retrocede por los avisos de falla consecutivos hasta la ultima respuesta real.
  let inicio = ultimoAsistente;
  for (let i = ultimoAsistente; i >= 0; i--) {
    const m = historial[i]!;
    if (m.role === "assistant" && !esAvisoDeFalla(m.content)) break;
    inicio = i;
  }
  return historial
    .slice(inicio)
    .filter((m) => m.role === "user" && m.content.trim() !== "")
    .map((m) => m.content.replace(/\s+/g, " ").trim().slice(0, MAX_LARGO))
    .slice(-MAX_MENSAJES);
}

/** Bloque de sistema del turno. Vacio si no hubo falla o el cliente aun no habia dicho nada que perder. */
export function bloqueRecuperacionTrasFalla(historial: readonly Mensaje[]): string {
  // Solo si el turno actual tiene mensajes del cliente sin responder DESPUES del aviso (si no, no hay turno que recuperar).
  const perdidos = mensajesPerdidosPorFalla(historial);
  if (perdidos.length === 0) return "";
  return [
    "REGLA DEL SERVIDOR PARA ESTE TURNO (recuperación tras una falla del sistema):",
    "El turno anterior se cortó y el cliente recibió un aviso de falla; estos mensajes suyos NO se atendieron y siguen vigentes:",
    ...perdidos.map((m) => `- «${m}»`),
    "NO le vuelva a preguntar qué desea pedir ni le pida de nuevo lo que ya dijo. Retome ese pedido desde esos mensajes (busque los productos, cotice y muestre el resumen para su sí) y, si hay un dato que de verdad falta, pida solo ese dato. Si el cliente ya tiene un pedido creado, no abra otro. No vuelva a mencionar la falla.",
  ].join("\n");
}
