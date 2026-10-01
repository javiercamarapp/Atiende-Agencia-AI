// C-15 -- cliente de la conexion del numero de WhatsApp y la personalidad del agente de citas (ver
// apps/api/src/routes/verticals/citas/whatsapp-agente.ts). Mismo patron que whatsapp-mensajes-client.ts.
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export type TonoAgente = "calido_cercano" | "formal_directo" | "profesional_neutro" | "divertido_desenfadado";

export interface ConfigAgenteWire {
  readonly agentName: string | null;
  readonly toneStyle: TonoAgente | null;
  readonly greetingText: string | null;
  readonly rulesText: string | null;
}

export type EstadoConexion = "sin_numero" | "pausado" | "sin_credenciales_de_envio" | "registrado";

export interface ConexionWire {
  readonly numero: { readonly phoneNumberId: string; readonly activo: boolean } | null;
  readonly estado: EstadoConexion;
  readonly credencialDeEnvioDisponible: boolean;
  readonly nota: string;
}

export interface AgenteWire {
  readonly version: number;
  readonly config: ConfigAgenteWire;
  readonly actualizadoEn: string | null;
  readonly promptDeMuestra: string;
}

export interface OpcionesAgenteWire {
  readonly tonos: readonly { readonly valor: TonoAgente; readonly etiqueta: string }[];
  readonly limites: { readonly agentName: number; readonly greetingText: number; readonly rulesMaxLines: number; readonly ruleLength: number; readonly rulesText: number };
}

export interface PanelAgenteWire {
  /** `false` cuando la migracion 028 todavia no esta aplicada: la pantalla no ofrece conectar ni editar. */
  readonly disponible: boolean;
  readonly agente: AgenteWire;
  readonly conexion: ConexionWire;
  readonly opciones: OpcionesAgenteWire;
}

export interface VistaPreviaAgenteWire {
  readonly prompt: string;
  readonly diferencias: readonly { readonly campo: string; readonly antes: string; readonly despues: string }[];
  readonly version: number;
}

/** Formulario: todo viaja como texto mientras se escribe. `""` = usar el valor de fabrica. */
export interface FormAgente {
  readonly agentName: string;
  readonly toneStyle: string;
  readonly greetingText: string;
  readonly rulesText: string;
}

export function formDesdeConfig(c: ConfigAgenteWire): FormAgente {
  return { agentName: c.agentName ?? "", toneStyle: c.toneStyle ?? "", greetingText: c.greetingText ?? "", rulesText: c.rulesText ?? "" };
}

/** Cuerpo del cable a partir del formulario. */
export function cuerpoDesdeForm(f: FormAgente): Record<string, unknown> {
  const texto = (v: string): string | null => (v.trim() === "" ? null : v);
  return { agentName: texto(f.agentName), toneStyle: f.toneStyle === "" ? null : f.toneStyle, greetingText: texto(f.greetingText), rulesText: texto(f.rulesText) };
}

/** `true` si el formulario difiere de lo guardado (para no ofrecer guardar sin cambios). */
export function formCambio(form: FormAgente, vigente: ConfigAgenteWire): boolean {
  const v = formDesdeConfig(vigente);
  return form.agentName.trim() !== v.agentName || form.toneStyle !== v.toneStyle || form.greetingText.trim() !== v.greetingText || form.rulesText.trim() !== v.rulesText;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/whatsapp-agente`;

export function fetchPanelAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PanelAgenteWire> {
  return fetchJson<PanelAgenteWire>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function vistaPreviaAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: FormAgente): Promise<VistaPreviaAgenteWire> {
  return sendJson<VistaPreviaAgenteWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/vista-previa`, token, "POST", cuerpoDesdeForm(form));
}

export function guardarAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: FormAgente, versionEsperada: number): Promise<{ agente: AgenteWire }> {
  return sendJson(fetchImpl, base(apiBaseUrl, propertyId), token, "PUT", { ...cuerpoDesdeForm(form), versionEsperada });
}

export function restablecerAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, versionEsperada: number): Promise<{ agente: AgenteWire }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/restablecer`, token, "POST", { versionEsperada });
}

export function conectarNumero(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, phoneNumberId: string, activo: boolean): Promise<{ conexion: ConexionWire }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/conexion`, token, "PUT", { phoneNumberId, activo });
}

export function desconectarNumero(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ conexion: ConexionWire }> {
  return deleteJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/conexion`, token);
}
