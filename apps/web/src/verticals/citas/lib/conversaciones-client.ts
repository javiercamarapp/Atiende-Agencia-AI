// C-11 -- cliente de la bandeja de conversaciones de WhatsApp de citas con handoff a humano (ver apps/api/src/routes/verticals/citas/conversaciones.ts).
// El telefono llega ya enmascarado (`***1234`) y las acciones estan gobernadas por el servidor (403/409): los booleanos `esMia` / `puedeGestionar`
// solo deciden que botones se muestran.
import { fetchJson, postJson } from "./admin-client.ts";

export type HandoffEstado = "agente" | "pendiente" | "tomada" | "devuelta" | "cerrada";

export const ESTADO_ROTULO: Readonly<Record<HandoffEstado, string>> = {
  agente: "Con el agente",
  pendiente: "Pide una persona",
  tomada: "Atendiendo una persona",
  devuelta: "Devuelta al agente",
  cerrada: "Cerrada",
};

export const ESTADOS_FILTRO: readonly HandoffEstado[] = ["pendiente", "tomada", "agente", "devuelta", "cerrada"];

export interface BandejaItemWire {
  readonly conversationId: string;
  readonly telefono: string;
  readonly vistaPrevia: string;
  readonly actividadEn: string;
  readonly estado: HandoffEstado;
  readonly handoffId: string | null;
  readonly motivo: string | null;
  readonly crisis: boolean;
  readonly solicitadaEn: string | null;
  readonly ultimoClienteEn: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly tomadaEn: string | null;
  readonly esMia: boolean;
  readonly cita: { readonly id: string; readonly iniciaEn: string | null; readonly estado: string | null } | null;
}

export interface BandejaWire {
  /** false = la base todavia no tiene la migracion 031: NUNCA se confunde con una bandeja vacia. */
  readonly disponible: boolean;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly puedeGestionar: boolean;
  readonly items: readonly BandejaItemWire[];
}

export interface HandoffWire {
  readonly handoffId: string;
  readonly estado: Exclude<HandoffEstado, "agente">;
  readonly solicitadoPor: "agente" | "staff";
  readonly motivo: string | null;
  readonly crisis: boolean;
  readonly solicitadaEn: string;
  readonly ultimoClienteEn: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly tomadaEn: string | null;
  readonly esMia: boolean;
}

export interface DetalleWire {
  readonly conversationId: string;
  readonly telefono: string;
  readonly citaId: string | null;
  readonly puedeGestionar: boolean;
  readonly mensajes: readonly { readonly rol: "cliente" | "agente" | "humano"; readonly texto: string }[];
  readonly handoff: HandoffWire | null;
  readonly notas: readonly { readonly id: string; readonly autor: string | null; readonly autorId: string | null; readonly texto: string; readonly creadoEn: string }[];
}

export const NOTA_MAX = 2000;
export const RESPUESTA_MAX = 1000;

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin`;

export function fetchBandeja(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtro: { readonly estado?: HandoffEstado | ""; readonly offset?: number } = {}): Promise<BandejaWire> {
  const q = new URLSearchParams({ limit: "50" });
  if (filtro.estado) q.set("estado", filtro.estado);
  if (filtro.offset) q.set("offset", String(filtro.offset));
  return fetchJson<BandejaWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones?${q.toString()}`, token);
}

export function fetchDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conversationId: string): Promise<DetalleWire> {
  return fetchJson<DetalleWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones/${conversationId}`, token);
}

export function tomarConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conversationId: string): Promise<{ handoffId: string; estado: "tomada" }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones/${conversationId}/tomar`, token, {});
}

export function liberarHandoff(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, accion: "devolver" | "cerrar"): Promise<{ handoffId: string; estado: string; cambio: boolean }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${handoffId}/${accion}`, token, {});
}

export function agregarNota(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, texto: string): Promise<{ id: string }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${handoffId}/notas`, token, { texto });
}

export function responderConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, texto: string): Promise<{ encolado: boolean; outboxId: string }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${handoffId}/responder`, token, { texto });
}
