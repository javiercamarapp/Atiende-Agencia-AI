// Composicion (validacion + resumen legible) de un intent del catalogo CERRADO de acciones del back office. La comparten
// `POST /superadmin/acciones/intents` y la herramienta `proponer_accion` del Copiloto (superadmin-copiloto/acciones.ts): una sola
// fuente de verdad, de modo que el Copiloto propone EXACTAMENTE lo que la pantalla de Acciones aceptaria, con las mismas reglas.
import type { OutboxQueueName } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { construirResumenCerrarProspecto, construirResumenEjecutarMantenimientoAhora, construirResumenReencolarMensajeMuerto } from "./resumen.ts";

export const QUEUES_VALIDAS = new Set<OutboxQueueName>(["citas", "hoteles", "restaurantes", "despachos", "rentas", "licitaciones"]);
export const ESTADOS_CIERRE_VALIDOS = new Set(["perdido", "descartado"]);

export async function componerResumenYPayload(deps: AppDeps, callerId: string, tipo: string, payload: Record<string, unknown>): Promise<{ readonly resumen: string; readonly payloadValidado: Record<string, unknown> }> {
  if (tipo === "reencolar_mensaje_muerto") {
    const queue = typeof payload.queue === "string" ? payload.queue : "";
    const mensajeId = typeof payload.mensajeId === "string" ? payload.mensajeId : "";
    if (!QUEUES_VALIDAS.has(queue as OutboxQueueName) || mensajeId.length === 0) throw Errors.validation("payload inválido para reencolar_mensaje_muerto: requiere queue (una de las 6 verticales) y mensajeId.");
    const detalle = await deps.accionesRepo.getOutboxDeadMessageForSuperadmin(callerId, queue as OutboxQueueName, mensajeId);
    if (!detalle) throw Errors.notFound("No hay un mensaje en estado dead con ese id en esa cola (ya lo movieron, ya se reencoló, o nunca existió).");
    return { resumen: construirResumenReencolarMensajeMuerto(detalle), payloadValidado: { queue, mensajeId } };
  }

  if (tipo === "cerrar_prospecto") {
    const prospectoId = typeof payload.prospectoId === "string" ? payload.prospectoId : "";
    const estadoDestino = typeof payload.estado === "string" ? payload.estado : "";
    if (prospectoId.length === 0 || !ESTADOS_CIERRE_VALIDOS.has(estadoDestino)) throw Errors.validation("payload inválido para cerrar_prospecto: requiere prospectoId y estado en (perdido, descartado).");
    const prospectos = await deps.coreRepo.listProspectosForSuperadmin(callerId);
    const prospecto = prospectos.find((p) => p.id === prospectoId);
    if (!prospecto) throw Errors.notFound("No se encontró ese prospecto.");
    return { resumen: construirResumenCerrarProspecto(prospecto.empresa, prospecto.estado, estadoDestino as "perdido" | "descartado"), payloadValidado: { prospectoId, estado: estadoDestino } };
  }

  if (tipo === "ejecutar_mantenimiento_ahora") {
    return { resumen: construirResumenEjecutarMantenimientoAhora(), payloadValidado: {} };
  }

  throw Errors.validation(`Tipo de acción desconocido o no disponible: ${tipo}. Ver el catálogo en GET /superadmin/acciones/catalogo.`);
}
