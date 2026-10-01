// Transporte de "Chatea con tus datos". Sin `Accept: application/x-ndjson` la respuesta es el JSON de siempre
// (`DataChatAnswer`, identico byte a byte). Con el header la respuesta es un flujo NDJSON (una linea JSON por evento):
//
//   {"t":"paso","fase":"inicio"|"fin","herramienta":"<nombre del catalogo>"}   cero o mas, en vivo
//   {"t":"fin","respuesta":<DataChatAnswer>}                                   exactamente uno si el turno termino
//   {"t":"error","status":"error","mensaje":"..."}                            si el turno fallo despues de empezar
//
// Los errores de ANTES de empezar (401/403/400 de validacion) siguen siendo JSON HTTP normal con su status.
// Cancelacion: si el cliente corta la conexion (Detener) se aborta el turno y el flujo se cierra sin mas eventos.
//
// IMPORTANTE (transacciones): `dbSession` confirma y cierra la sesion RLS del request en cuanto el handler devuelve su
// `Response`. Un flujo que siguiera consultando con esa sesion la usaria ya cerrada. Por eso en modo NDJSON el turno
// abre su PROPIA sesion RLS del mismo usuario (`engine.withAppSession`) dentro del flujo; el alcance (organizacion,
// membership, zona horaria, rol) ya lo verifico el handler con la sesion del request ANTES de abrirlo, y las
// consultas siguen corriendo bajo RLS del usuario, nunca con una sesion de sistema.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { isDataChatAbortedError, type DataChatAnswer, type DataChatPasoEvento } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../deps.ts";
import type { PersistedDataChatAnswer } from "./conversaciones.ts";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export type DataChatStreamEvent =
  | DataChatPasoEvento
  | { readonly t: "fin"; readonly respuesta: DataChatAnswer; readonly conversacionId?: string; readonly seq?: number }
  | { readonly t: "error"; readonly status: "error"; readonly mensaje: string };

/** Mensaje fijo del evento `error`: jamas el texto de la excepcion (puede traer detalles internos). */
export const NDJSON_ERROR_MENSAJE = "No pude completar la consulta en este momento. Inténtalo de nuevo en un momento.";

/** Corre un turno con la sesion RLS que se le da y reporta pasos. */
export type DataChatTurnRunner = (db: TenantDbSession, onEvento: (e: DataChatPasoEvento) => void, signal: AbortSignal) => Promise<PersistedDataChatAnswer>;

/** Respuesta fija cuando el asistente no esta activado para la cuenta (sin proveedor de IA o sin lector de la vertical). */
export const DATA_CHAT_NOT_ACTIVATED: DataChatAnswer = {
  status: "unavailable",
  text: "El asistente de datos todavía no está activado para tu cuenta. Tus tableros siguen disponibles.",
  blocks: [],
  sources: [],
  toolsUsed: [],
};

export function wantsNdjson(c: Context<CoreAuthHonoEnv>): boolean {
  return /(^|[\s,;])application\/x-ndjson(?=$|[\s,;])/i.test(c.req.header("accept") ?? "");
}

/**
 * Responde un turno del chat en el formato que pidio el cliente. `run` recibe la sesion con la que debe consultar:
 * la del request en modo JSON (igual que antes) o una propia en modo NDJSON.
 */
export function respondDataChat(c: Context<CoreAuthHonoEnv>, deps: AppDeps, run: DataChatTurnRunner): Response | Promise<Response> {
  const abort = new AbortController();
  const onRawAbort = (): void => abort.abort();
  const raw = c.req.raw.signal;
  if (raw.aborted) abort.abort();
  else raw.addEventListener("abort", onRawAbort, { once: true });

  if (!wantsNdjson(c)) return respondJson(c, run, abort, () => raw.removeEventListener("abort", onRawAbort));

  const userId = c.get("userId");
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: DataChatStreamEvent): void => {
        if (closed || abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        raw.removeEventListener("abort", onRawAbort);
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // ya cerrado por el cliente
        }
      };
      void deps.engine
        .withAppSession({ userId: userId ?? null }, (db) => run(db, (e) => send(e), abort.signal))
        .then(
          (respuesta) => {
            // Con conversacion guardada, el evento `fin` lleva su id y el seq (contrato de CopilotoTransporte).
            send({ t: "fin", respuesta, ...(respuesta.conversationId ? { conversacionId: respuesta.conversationId } : {}), ...(respuesta.seq !== undefined ? { seq: respuesta.seq } : {}) });
            finish();
          },
          (err: unknown) => {
            if (!isDataChatAbortedError(err)) {
              console.error(JSON.stringify({ level: "error", event: "data_chat_stream_error", message: err instanceof Error ? err.message.slice(0, 200) : "error" }));
              send({ t: "error", status: "error", mensaje: NDJSON_ERROR_MENSAJE });
            }
            finish();
          },
        );
    },
    cancel() {
      closed = true;
      abort.abort();
      raw.removeEventListener("abort", onRawAbort);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": NDJSON_CONTENT_TYPE, "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}

/** Respuesta ya resuelta (sin consultar nada): JSON de siempre, o el unico evento `fin` si el cliente pidio NDJSON. */
export function respondDataChatStatic(c: Context<CoreAuthHonoEnv>, respuesta: DataChatAnswer): Response {
  if (!wantsNdjson(c)) return c.json(respuesta);
  return new Response(`${JSON.stringify({ t: "fin", respuesta } satisfies DataChatStreamEvent)}\n`, {
    status: 200,
    headers: { "content-type": NDJSON_CONTENT_TYPE, "cache-control": "no-store, no-transform" },
  });
}

async function respondJson(c: Context<CoreAuthHonoEnv>, run: DataChatTurnRunner, abort: AbortController, cleanup: () => void): Promise<Response> {
  try {
    return c.json(await run(c.get("db"), () => {}, abort.signal));
  } catch (err) {
    // Cliente que cerro la conexion: nadie leera la respuesta; cualquier otro error sigue su camino de siempre.
    if (isDataChatAbortedError(err)) return c.json({ status: "unavailable", text: "La consulta se canceló.", blocks: [], sources: [], toolsUsed: [] });
    throw err;
  } finally {
    cleanup();
  }
}
