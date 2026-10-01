// Cliente de la configuracion de WhatsApp de licitaciones (L-05). Llama a
// `.../whatsapp/settings`, `.../whatsapp/opt-out` y `.../tenders/:id/whatsapp/request-decision`
// (apps/api/src/routes/verticals/licitaciones/whatsapp.ts). El servidor es la autoridad: el opt-in
// solo se activa cuando la persona contesta SI desde su propio numero.
import { fetchJson, postJson, putJson } from "./admin-client.ts";

export type WhatsAppContactStatus = "pendiente" | "activo" | "baja";

export interface WhatsAppContact {
  readonly phoneE164: string;
  readonly status: WhatsAppContactStatus;
  readonly notifyPlazos: boolean;
  readonly notifyConvocatorias: boolean;
  readonly notifyFallos: boolean;
  readonly notifyDecisiones: boolean;
}

export interface WhatsAppEvent {
  readonly id: string;
  readonly event: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface WhatsAppSettings {
  /** `false` con la base sin la migracion 030 (o sin repositorio): la pantalla lo dice en vez de fingir. */
  readonly available: boolean;
  /** `false` si el ambiente no tiene numero remitente: se puede guardar el telefono pero no llegaran mensajes. */
  readonly configured: boolean;
  readonly contact: WhatsAppContact | null;
  readonly events: readonly WhatsAppEvent[];
}

export interface WhatsAppSettingsInput {
  readonly phone: string;
  readonly notifyPlazos: boolean;
  readonly notifyConvocatorias: boolean;
  readonly notifyFallos: boolean;
  readonly notifyDecisiones: boolean;
}

export interface DecisionRequestResult {
  readonly requested: number;
  readonly alreadyPending: number;
  readonly eligible: number;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/licitaciones/${propertyId}`;

export function fetchWhatsAppSettings(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<WhatsAppSettings> {
  return fetchJson<WhatsAppSettings>(f, `${base(apiBaseUrl, propertyId)}/whatsapp/settings`, token);
}

export function saveWhatsAppSettings(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: WhatsAppSettingsInput): Promise<{ contact: WhatsAppContact; configured: boolean }> {
  return putJson<{ contact: WhatsAppContact; configured: boolean }>(f, `${base(apiBaseUrl, propertyId)}/whatsapp/settings`, token, input);
}

export function optOutWhatsApp(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ ok: boolean; changed: boolean }> {
  return postJson<{ ok: boolean; changed: boolean }>(f, `${base(apiBaseUrl, propertyId)}/whatsapp/opt-out`, token, {});
}

export function requestWhatsAppDecision(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<DecisionRequestResult> {
  return postJson<DecisionRequestResult>(f, `${base(apiBaseUrl, propertyId)}/tenders/${tenderId}/whatsapp/request-decision`, token, {});
}
