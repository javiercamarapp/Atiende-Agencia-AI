// Rastreo de errores no controlados de la API (los 500 de `app.onError`) hacia Sentry, SIN SDK: mismo
// envelope HTTP que ya usa el canal de alertas (`alertas/canales.ts`). Se activa solo con `SENTRY_DSN`
// (el mismo DSN del canal de alertas); sin DSN, o con uno invalido, `crearReportadorErrores` devuelve
// `undefined` y la API se comporta exactamente como antes (solo el log `apps_api_error_interno`).
//
// Datos personales (LFPDPPP): el evento NUNCA lleva cuerpo, cabeceras, query, cookies, IP ni usuario.
//   - mensaje del error: `scrubTexto` de @atiende/core-pii (correos, telefonos, tarjetas, tokens, UUID...);
//   - ruta: solo el path, con UUID, numeros y segmentos con pinta de token reemplazados (`:id` / `:token`);
//   - pila: solo funcion, archivo, linea y columna de cada marco (sin variables locales ni codigo);
//   - `send_default_pii` no existe aqui: no hay SDK que pueda adjuntar nada por su cuenta.
// Nunca lanza ni bloquea mas alla de su timeout; tope por instancia para que una racha de 500 no
// inunde la cuota de Sentry.
import { randomUUID } from "node:crypto";
import { scrubTexto } from "@atiende/core-pii";
import { parsearDsnSentry, type DsnSentry, type FetchLike } from "../alertas/canales.ts";

export const TIMEOUT_SENTRY_MS = 2_000;
export const MAX_EVENTOS_POR_MINUTO = 30;
const MAX_MARCOS = 30;

export interface ContextoError {
  readonly requestId?: string | null;
  readonly method?: string;
  readonly path?: string;
}

export interface ReportadorErrores {
  /** Envia el error a Sentry; resuelve `true` si Sentry lo acepto. Nunca rechaza. */
  reportar(err: unknown, contexto?: ContextoError): Promise<boolean>;
}

export interface OpcionesReportador {
  readonly fetchImpl?: FetchLike;
  readonly ahora?: () => Date;
  readonly entorno?: string | null;
  readonly release?: string | null;
  readonly maxPorMinuto?: number;
}

/** Path sin identificadores: UUID y numeros -> `:id`; segmentos largos con letras y digitos (tokens de enlace) -> `:token`. */
export function rutaSinIdentificadores(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(seg) || /^\d+$/u.test(seg)) return ":id";
      if (seg.length >= 16 && /[a-z]/iu.test(seg) && /\d/u.test(seg)) return ":token";
      if (seg.includes("@")) return ":token";
      return seg.slice(0, 64);
    })
    .join("/")
    .slice(0, 200);
}

export interface MarcoSentry {
  readonly function?: string;
  readonly filename: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app: boolean;
}

/** Marcos de una pila de V8, del mas antiguo al mas reciente (orden que espera Sentry). */
export function marcosDePila(stack: string | undefined): MarcoSentry[] {
  if (!stack) return [];
  const marcos: MarcoSentry[] = [];
  for (const linea of stack.split("\n").slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/u.exec(linea);
    if (!m) continue;
    const filename = m[2]!.replace(/^file:\/\//u, "");
    marcos.push({
      ...(m[1] ? { function: m[1].slice(0, 120) } : {}),
      filename: filename.slice(-200),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
    if (marcos.length >= MAX_MARCOS) break;
  }
  return marcos.reverse();
}

/** Evento de Sentry ya redactado (exportado para pruebas). */
export function eventoDeError(err: unknown, contexto: ContextoError, meta: { eventId: string; ahora: Date; entorno: string | null; release: string | null }) {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "error no Error");
  const valor = scrubTexto(e.message || "(sin mensaje)", { maxLargo: 500 });
  const ruta = contexto.path ? rutaSinIdentificadores(contexto.path) : null;
  const metodo = contexto.method ? contexto.method.toUpperCase().slice(0, 10) : null;
  return {
    event_id: meta.eventId,
    timestamp: meta.ahora.toISOString(),
    platform: "node",
    level: "error",
    logger: "atiende.api",
    ...(meta.entorno ? { environment: meta.entorno } : {}),
    ...(meta.release ? { release: meta.release } : {}),
    ...(ruta ? { transaction: `${metodo ?? ""} ${ruta}`.trim() } : {}),
    exception: { values: [{ type: (e.name || "Error").slice(0, 80), value: valor, stacktrace: { frames: marcosDePila(e.stack) } }] },
    tags: { ...(metodo ? { metodo } : {}), ...(ruta ? { ruta } : {}) },
    extra: { ...(contexto.requestId ? { requestId: String(contexto.requestId).slice(0, 64) } : {}) },
  };
}

export function crearReportadorErrores(dsnRaw: string | null | undefined, opciones: OpcionesReportador = {}): ReportadorErrores | undefined {
  const dsn: DsnSentry | null = parsearDsnSentry(dsnRaw);
  if (!dsn) return undefined;
  const fetchImpl: FetchLike = opciones.fetchImpl ?? ((url, init) => fetch(url, init));
  const ahora = opciones.ahora ?? (() => new Date());
  const maxPorMinuto = opciones.maxPorMinuto ?? MAX_EVENTOS_POR_MINUTO;
  let ventana = { inicioMs: 0, enviados: 0 };

  return {
    async reportar(err, contexto = {}) {
      try {
        const t = ahora();
        if (t.getTime() - ventana.inicioMs >= 60_000) ventana = { inicioMs: t.getTime(), enviados: 0 };
        if (ventana.enviados >= maxPorMinuto) return false;
        ventana.enviados += 1;
        const eventId = randomUUID().replace(/-/g, "");
        const evento = eventoDeError(err, contexto, { eventId, ahora: t, entorno: opciones.entorno ?? null, release: opciones.release ?? null });
        const cuerpo = `${JSON.stringify({ event_id: eventId, sent_at: t.toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(evento)}\n`;
        const res = await fetchImpl(dsn.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=atiende-api/1, sentry_key=${dsn.clavePublica}`,
          },
          body: cuerpo,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_SENTRY_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
