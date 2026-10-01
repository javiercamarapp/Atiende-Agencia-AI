// C-04 -- cliente de los mensajes de WhatsApp editables de citas (ver
// apps/api/src/routes/verticals/citas/whatsapp-mensajes.ts). Mismo patron que restaurantes/lib/agente-whatsapp-client.ts.
import { fetchJson, sendJson } from "./admin-client.ts";

export type MensajeKind = "recordatorio" | "confirmacion" | "cancelacion" | "reagendado";
export const MENSAJE_KINDS: readonly MensajeKind[] = ["recordatorio", "confirmacion", "cancelacion", "reagendado"];

/** Misma forma que `WhatsappMessageConfig` del dominio (lo que viaja en el cable). */
export interface ConfigMensajesWire {
  readonly reminderEnabled: boolean;
  readonly reminderText: string | null;
  readonly reminderLeadHours: number;
  readonly confirmationEnabled: boolean;
  readonly confirmationText: string | null;
  readonly cancellationEnabled: boolean;
  readonly cancellationText: string | null;
  readonly rescheduleEnabled: boolean;
  readonly rescheduleText: string | null;
  readonly sendWindowStart: number | null;
  readonly sendWindowEnd: number | null;
}

export interface VistaPreviaMensajeWire {
  readonly kind: MensajeKind;
  readonly activo: boolean;
  readonly texto: string;
  readonly esPorDefecto: boolean;
}

export interface DiferenciaWire {
  readonly campo: string;
  readonly antes: string;
  readonly despues: string;
}

export interface MensajesWire {
  /** `false` cuando la migracion 026 todavia no esta aplicada: la pantalla no ofrece editar. */
  readonly disponible: boolean;
  /** 0 = nunca se guardo nada. */
  readonly version: number;
  readonly config: ConfigMensajesWire;
  readonly actualizadoEn: string | null;
  readonly vistaPrevia: readonly VistaPreviaMensajeWire[];
}

export interface OpcionesMensajesWire {
  readonly mensajes: readonly { readonly kind: MensajeKind; readonly etiqueta: string; readonly variables: readonly string[]; readonly textoPorOmision: string }[];
  readonly porOmision: ConfigMensajesWire;
  readonly limites: { readonly texto: number; readonly anticipacionMin: number; readonly anticipacionMax: number };
}

export interface VistaPreviaWire {
  readonly vistaPrevia: readonly VistaPreviaMensajeWire[];
  readonly diferencias: readonly DiferenciaWire[];
  readonly version: number;
}

export interface HistorialMensajesEntradaWire {
  readonly version: number;
  readonly accion: "actualizado" | "restablecido";
  readonly nuevo: Record<string, unknown>;
  readonly diferencias: readonly DiferenciaWire[];
  readonly actorNombre: string | null;
  readonly creadoEn: string;
}

/** Formulario: los numeros viajan como texto mientras se escriben. `""` en una hora = sin horario de envio. */
export interface FormMensajes {
  readonly reminderEnabled: boolean;
  readonly reminderText: string;
  readonly reminderLeadHours: string;
  readonly confirmationEnabled: boolean;
  readonly confirmationText: string;
  readonly cancellationEnabled: boolean;
  readonly cancellationText: string;
  readonly rescheduleEnabled: boolean;
  readonly rescheduleText: string;
  readonly sendWindowStart: string;
  readonly sendWindowEnd: string;
}

export function formDesdeConfig(c: ConfigMensajesWire): FormMensajes {
  return {
    reminderEnabled: c.reminderEnabled,
    reminderText: c.reminderText ?? "",
    reminderLeadHours: String(c.reminderLeadHours),
    confirmationEnabled: c.confirmationEnabled,
    confirmationText: c.confirmationText ?? "",
    cancellationEnabled: c.cancellationEnabled,
    cancellationText: c.cancellationText ?? "",
    rescheduleEnabled: c.rescheduleEnabled,
    rescheduleText: c.rescheduleText ?? "",
    sendWindowStart: c.sendWindowStart === null ? "" : String(c.sendWindowStart),
    sendWindowEnd: c.sendWindowEnd === null ? "" : String(c.sendWindowEnd),
  };
}

/** Cuerpo del cable a partir del formulario. */
export function cuerpoDesdeForm(f: FormMensajes): Record<string, unknown> {
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  return {
    reminderEnabled: f.reminderEnabled,
    reminderText: f.reminderText.trim() === "" ? null : f.reminderText,
    reminderLeadHours: num(f.reminderLeadHours) ?? 24,
    confirmationEnabled: f.confirmationEnabled,
    confirmationText: f.confirmationText.trim() === "" ? null : f.confirmationText,
    cancellationEnabled: f.cancellationEnabled,
    cancellationText: f.cancellationText.trim() === "" ? null : f.cancellationText,
    rescheduleEnabled: f.rescheduleEnabled,
    rescheduleText: f.rescheduleText.trim() === "" ? null : f.rescheduleText,
    sendWindowStart: num(f.sendWindowStart),
    sendWindowEnd: num(f.sendWindowEnd),
  };
}

export const TEXTO_CAMPO: Readonly<Record<MensajeKind, { texto: keyof FormMensajes; activo: keyof FormMensajes }>> = {
  recordatorio: { texto: "reminderText", activo: "reminderEnabled" },
  confirmacion: { texto: "confirmationText", activo: "confirmationEnabled" },
  cancelacion: { texto: "cancellationText", activo: "cancellationEnabled" },
  reagendado: { texto: "rescheduleText", activo: "rescheduleEnabled" },
};

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/whatsapp-mensajes`;

export function fetchMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MensajesWire> {
  return fetchJson<MensajesWire>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function fetchOpcionesMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<OpcionesMensajesWire> {
  return fetchJson<OpcionesMensajesWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/opciones`, token);
}

export async function fetchHistorialMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ disponible: boolean; entradas: readonly HistorialMensajesEntradaWire[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/historial?limite=20`, token);
}

export function vistaPreviaMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: FormMensajes): Promise<VistaPreviaWire> {
  return sendJson<VistaPreviaWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/vista-previa`, token, "POST", cuerpoDesdeForm(form));
}

export function guardarMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: FormMensajes, versionEsperada: number): Promise<MensajesWire> {
  return sendJson<MensajesWire>(fetchImpl, base(apiBaseUrl, propertyId), token, "PUT", { ...cuerpoDesdeForm(form), versionEsperada });
}

export function restablecerMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, versionEsperada: number): Promise<MensajesWire> {
  return sendJson<MensajesWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/restablecer`, token, "POST", { versionEsperada });
}
