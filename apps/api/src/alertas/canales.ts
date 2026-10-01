// Canales de salida de las alertas: correo (Resend), webhook generico y Sentry (opcional).
// Ninguno lanza: cada uno devuelve un resultado tipado. Todos reciben `fetchImpl` inyectable --
// los tests NUNCA hacen una peticion de red real.
import { createHmac } from "node:crypto";
import { escapeHtml, renderCorreo } from "@atiende/core-email";
import type { AlertaSaliente } from "./tipos.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const TIMEOUT_CANAL_MS = 5_000;

export interface ResultadoCanal {
  readonly ok: boolean;
  /** Detalle corto y SIN secretos (codigo HTTP o motivo). */
  readonly detalle: string;
}

const COLOR_SEVERIDAD: Record<AlertaSaliente["severidad"], string> = { critica: "#B91C1C", alta: "#B45309", media: "#1D4ED8" };

function textoPlano(a: AlertaSaliente): string {
  const contexto = a.contexto ? `\n\n${Object.entries(a.contexto).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}` : "";
  return `[${a.severidad.toUpperCase()}] ${a.titulo}\n\n${a.detalle}${a.href ? `\n\nVer: ${a.href}` : ""}${contexto}`;
}

// ── Correo (Resend) ─────────────────────────────────────────────────────────
export interface OpcionesCorreo {
  readonly apiKey: string;
  readonly from: string;
  readonly to: string;
  readonly alerta: AlertaSaliente;
  /** Ventana de deduplicacion del lado de Resend (24 h): mismo tipo + destino + hora = un solo correo. */
  readonly claveIdempotencia: string;
  readonly fetchImpl: FetchLike;
}

export async function enviarAlertaPorCorreo(o: OpcionesCorreo): Promise<ResultadoCanal> {
  const a = o.alerta;
  const subject = `[${a.severidad}] ${a.titulo}`.slice(0, 200);
  const html = renderCorreo({
    titulo: a.titulo,
    preheader: a.detalle.slice(0, 140),
    etiqueta: { texto: `Alerta ${a.severidad}`, color: COLOR_SEVERIDAD[a.severidad] },
    parrafosHtml: [escapeHtml(a.detalle)],
    nota: "Alerta automatica de plataforma. Los datos sensibles ya fueron redactados; no contiene informacion de clientes.",
    marcaTagline: "atiende · alertas de plataforma",
    piePorQueLlego: "Recibes este correo porque tu direccion esta configurada como destino de alertas de plataforma en Atiende.",
  });
  try {
    const res = await o.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": o.claveIdempotencia },
      body: JSON.stringify({ from: o.from, to: [o.to], subject, html, text: textoPlano(a) }),
      signal: AbortSignal.timeout(TIMEOUT_CANAL_MS),
    });
    return res.ok ? { ok: true, detalle: `http_${res.status}` } : { ok: false, detalle: `http_${res.status}` };
  } catch (err) {
    return { ok: false, detalle: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error_red" };
  }
}

// ── Webhook generico ────────────────────────────────────────────────────────
const HOST_PRIVADO = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** Un webhook de alertas es una salida hacia un tercero: solo https y nunca hacia un host
 *  local/privado (defensa en profundidad contra una URL mal configurada que apunte a la red
 *  interna). Devuelve el motivo del rechazo, o null si la URL es aceptable. */
export function motivoUrlWebhookInvalida(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url_invalida";
  }
  if (u.protocol !== "https:") return "solo_https";
  if (u.username || u.password) return "credenciales_en_url";
  if (HOST_PRIVADO.test(u.hostname)) return "host_privado";
  return null;
}

export interface OpcionesWebhook {
  readonly url: string;
  /** Si existe, la peticion se firma: `X-Atiende-Signature: sha256=HMAC(secret, "<ts>.<cuerpo>")`. */
  readonly secreto: string | null;
  readonly alerta: AlertaSaliente;
  readonly ahora: Date;
  readonly fetchImpl: FetchLike;
}

export function firmarWebhook(secreto: string, timestamp: string, cuerpo: string): string {
  return `sha256=${createHmac("sha256", secreto).update(`${timestamp}.${cuerpo}`).digest("hex")}`;
}

export async function enviarAlertaPorWebhook(o: OpcionesWebhook): Promise<ResultadoCanal> {
  const rechazo = motivoUrlWebhookInvalida(o.url);
  if (rechazo) return { ok: false, detalle: rechazo };
  const cuerpo = JSON.stringify({
    tipo: o.alerta.tipo,
    severidad: o.alerta.severidad,
    titulo: o.alerta.titulo,
    detalle: o.alerta.detalle,
    href: o.alerta.href ?? null,
    contexto: o.alerta.contexto ?? {},
    ocurrioEn: o.ahora.toISOString(),
  });
  const timestamp = String(Math.floor(o.ahora.getTime() / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "atiende-alertas/1", "X-Atiende-Timestamp": timestamp };
  if (o.secreto) headers["X-Atiende-Signature"] = firmarWebhook(o.secreto, timestamp, cuerpo);
  try {
    // redirect: "error" -- un 30x hacia otro host no se sigue (evita salir a un destino no validado).
    const res = await o.fetchImpl(o.url, { method: "POST", headers, body: cuerpo, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_CANAL_MS) });
    return res.ok ? { ok: true, detalle: `http_${res.status}` } : { ok: false, detalle: `http_${res.status}` };
  } catch (err) {
    return { ok: false, detalle: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error_red" };
  }
}

// ── Sentry (opcional, SIN SDK: solo si hay DSN) ─────────────────────────────
export interface DsnSentry {
  readonly clavePublica: string;
  readonly host: string;
  readonly proyectoId: string;
  readonly endpoint: string;
}

/** Parsea `https://<clave>@<host>/<proyecto>`; null si no es un DSN valido (entonces Sentry
 *  queda apagado, jamas rompe nada). */
export function parsearDsnSentry(dsn: string | null | undefined): DsnSentry | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const proyectoId = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(proyectoId)) return null;
    return { clavePublica: u.username, host: u.host, proyectoId, endpoint: `https://${u.host}/api/${proyectoId}/envelope/` };
  } catch {
    return null;
  }
}

const NIVEL_SENTRY: Record<AlertaSaliente["severidad"], string> = { critica: "fatal", alta: "error", media: "warning" };

export interface OpcionesSentry {
  readonly dsn: DsnSentry;
  readonly alerta: AlertaSaliente;
  readonly ahora: Date;
  readonly eventId: string;
  readonly fetchImpl: FetchLike;
}

export async function enviarAlertaASentry(o: OpcionesSentry): Promise<ResultadoCanal> {
  const evento = {
    event_id: o.eventId,
    timestamp: o.ahora.toISOString(),
    platform: "node",
    level: NIVEL_SENTRY[o.alerta.severidad],
    logger: "atiende.alertas",
    message: `${o.alerta.titulo}: ${o.alerta.detalle}`.slice(0, 1000),
    // La huella agrupa por tipo de alerta: Sentry deduplica del lado servidor.
    fingerprint: [o.alerta.tipo],
    tags: { tipo: o.alerta.tipo, severidad: o.alerta.severidad },
    extra: { href: o.alerta.href ?? null, ...(o.alerta.contexto ?? {}) },
  };
  const cuerpo = `${JSON.stringify({ event_id: o.eventId, sent_at: o.ahora.toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(evento)}\n`;
  try {
    const res = await o.fetchImpl(o.dsn.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=atiende-alertas/1, sentry_key=${o.dsn.clavePublica}`,
      },
      body: cuerpo,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_CANAL_MS),
    });
    return res.ok ? { ok: true, detalle: `http_${res.status}` } : { ok: false, detalle: `http_${res.status}` };
  } catch (err) {
    return { ok: false, detalle: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error_red" };
  }
}
