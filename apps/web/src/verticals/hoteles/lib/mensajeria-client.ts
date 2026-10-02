// H-29 -- logica de datos de la configuracion del canal WhatsApp y del agente de voz. Consume
// apps/api/.../hoteles/mensajeria-config.ts. El secreto de voz NUNCA se lee: solo la rotacion lo devuelve, una vez.
import { fetchJson, sendJson } from "./admin-client.ts";

const url = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/mensajeria`;

/** Espejo cosmetico de MENSAJERIA_CONFIG_ROLES (owner/gm); el servidor es la barrera real (403). */
export const MENSAJERIA_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

export interface MensajeriaEstado {
  readonly whatsapp: { readonly configurado: boolean; readonly phoneNumberId: string | null; readonly habilitado: boolean; readonly actualizadoEn: string | null };
  readonly voz: { readonly configurado: boolean; readonly habilitado: boolean; readonly secretoConfigurado: boolean; readonly actualizadoEn: string | null };
}
export interface RotacionSecreto {
  readonly configurado: boolean;
  readonly habilitado: boolean;
  readonly secretoConfigurado: boolean;
  readonly actualizadoEn: string | null;
  readonly secreto: string;
  readonly aviso: string;
}

export function fetchMensajeria(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MensajeriaEstado> {
  return fetchJson<MensajeriaEstado>(fetchImpl, url(apiBaseUrl, propertyId), token);
}
export function guardarWhatsApp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { readonly phoneNumberId: string; readonly habilitado: boolean }): Promise<MensajeriaEstado["whatsapp"]> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/whatsapp`, token, "PUT", input);
}
export function cambiarVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, habilitado: boolean): Promise<MensajeriaEstado["voz"]> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/voz`, token, "PUT", { habilitado });
}
export function rotarSecretoVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<RotacionSecreto> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/voz/rotar-secreto`, token, "POST", {});
}
