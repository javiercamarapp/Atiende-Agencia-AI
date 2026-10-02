// H-20 -- cliente de la bandeja de conversaciones de WhatsApp con handoff a humano. Consume
// apps/api/src/routes/verticals/hoteles/conversaciones.ts (contrato identico: nada inventado en el cliente).
import { fetchJson, sendJson } from "./admin-client.ts";

export type ConversacionEstado = "agente" | "humano" | "cerrada";
export type ConversacionFiltroEstado = ConversacionEstado | "por_atender";
export type EstadoEnvio = "pendiente_envio" | "enviando" | "enviado" | "fallido";

export const ESTADO_FILTRO_LABELS: Record<ConversacionFiltroEstado, string> = {
  por_atender: "Por atender",
  humano: "En atención humana",
  agente: "Con el agente",
  cerrada: "Cerradas",
};

export const ESTADO_LABELS: Record<ConversacionEstado, string> = {
  agente: "Con el agente",
  humano: "En atención humana",
  cerrada: "Cerrada",
};

export const ENVIO_LABELS: Record<EstadoEnvio, string> = {
  pendiente_envio: "Pendiente de envío",
  enviando: "Enviando…",
  enviado: "Enviado",
  fallido: "No se pudo enviar",
};

/** Espejo cosmetico de CONVERSACIONES_ROLES: el servidor es la unica barrera real (403). */
export const CONVERSACIONES_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);
/** Espejo cosmetico de quienes pueden reasignar (owner/gm). */
export const CONVERSACIONES_REASIGNAR_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

export interface ConversacionItemWire {
  readonly id: string;
  /** Completo para owner/gm; enmascarado (••••1234) para el resto. */
  readonly telefono: string;
  readonly estado: ConversacionEstado;
  /** En atencion humana y sin responsable: nadie la ha tomado. */
  readonly porAtender: boolean;
  readonly responsable: { readonly id: string; readonly nombre: string | null } | null;
  readonly tomadaEn: string | null;
  readonly motivo: string | null;
  readonly motivoTexto: string | null;
  readonly derivadaEn: string | null;
  readonly noLeidos: number;
  readonly ultimoMensajeDelHuespedEn: string | null;
  readonly actividadEn: string;
  readonly vistaPrevia: string | null;
  readonly ultimoRol: "user" | "assistant" | null;
  readonly huesped: { readonly id: string; readonly nombre: string | null } | null;
}

export interface BandejaWire {
  /** false = la base aun no tiene la migracion 043: NUNCA se confunde con una bandeja vacia. */
  readonly disponible: boolean;
  readonly total: number;
  readonly siguiente: number | null;
  readonly sinTelefono: boolean;
  readonly items: readonly ConversacionItemWire[];
}

export interface MensajeWire {
  readonly rol: "user" | "assistant";
  readonly origen: "huesped" | "agente" | "personal";
  readonly texto: string;
  readonly creadoEn: string | null;
  readonly envio: EstadoEnvio | null;
}

export interface NotaWire {
  readonly id: string;
  readonly autor: string | null;
  readonly autorId: string | null;
  readonly texto: string;
  readonly creadaEn: string;
}

export interface DetalleWire extends ConversacionItemWire {
  readonly cerradaEn: string | null;
  readonly derivaciones: number;
  readonly esResponsable: boolean;
  readonly totalMensajes: number;
  readonly mensajes: readonly MensajeWire[];
  readonly notas: readonly NotaWire[];
}

export interface FiltrosBandeja {
  readonly estado: ConversacionFiltroEstado | "";
  readonly soloNoLeidas: boolean;
  readonly huespedId?: string;
  readonly offset?: number;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/conversaciones`;

export function fetchBandeja(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, f: FiltrosBandeja): Promise<BandejaWire> {
  const q = new URLSearchParams();
  if (f.estado) q.set("estado", f.estado);
  if (f.soloNoLeidas) q.set("noLeidas", "1");
  if (f.huespedId) q.set("huespedId", f.huespedId);
  if (f.offset) q.set("offset", String(f.offset));
  const qs = q.toString();
  return fetchJson<BandejaWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}${qs ? `?${qs}` : ""}`, token);
}

export function fetchDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<DetalleWire> {
  return fetchJson<DetalleWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}`, token);
}

export function marcarLeida(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ id: string; noLeidos: number }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/leer`, token, "POST", {});
}

export function tomarConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, reasignar = false): Promise<{ id: string; estado: ConversacionEstado }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/tomar`, token, "POST", reasignar ? { reasignar: true } : {});
}

export function devolverAlAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ id: string; estado: ConversacionEstado }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/devolver-al-agente`, token, "POST", {});
}

export function cerrarConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ id: string; estado: ConversacionEstado }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/cerrar`, token, "POST", {});
}

export function agregarNota(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, texto: string): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/notas`, token, "POST", { texto });
}

export function responderConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, texto: string): Promise<{ encolado: boolean; outboxId: string; envio: EstadoEnvio }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/responder`, token, "POST", { texto });
}

/** Mismo criterio que las notas del huesped y la base (043): 13 a 19 digitos seguidos = tarjeta o documento. */
export function textoTieneDatoSensible(texto: string): boolean {
  return /[0-9]{13,19}/.test(texto.replace(/[ -]/g, ""));
}

/** Tono del badge de estado (StatusBadge de @atiende/ui). */
export function tonoEstado(item: Pick<ConversacionItemWire, "estado" | "porAtender">): "warning" | "info" | "success" | "neutral" {
  if (item.porAtender) return "warning";
  if (item.estado === "humano") return "info";
  if (item.estado === "agente") return "success";
  return "neutral";
}

export function etiquetaEstado(item: Pick<ConversacionItemWire, "estado" | "porAtender">): string {
  return item.porAtender ? "Por atender" : ESTADO_LABELS[item.estado];
}
