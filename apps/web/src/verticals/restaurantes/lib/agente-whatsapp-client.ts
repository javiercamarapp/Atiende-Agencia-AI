// Cliente HTTP tipado del editor del agente de WhatsApp (R-10, migracion 033). Contrato real:
// apps/api/src/routes/verticals/restaurantes/admin-config.ts (`.../admin/config/agente-whatsapp[/opciones|/vista-previa|/historial|/restablecer]`).
// Mismo criterio que el resto de lib/*.ts: `fetchImpl` inyectado y renovacion de sesion via `fetchJson`/`sendJson`.
import { fetchJson, sendJson } from "./admin-client.ts";

export type PerfilAgente = "generico" | "taqueria_pm";
export type TonoAgente = "calido_cercano" | "formal_directo" | "profesional_neutro" | "divertido_desenfadado";
export type AlcanceAgente = "organizacion" | "sucursal";

export const PERFIL_LABEL: Readonly<Record<PerfilAgente, string>> = {
  generico: "Genérico (tutea, solo domicilio)",
  taqueria_pm: "Taquería PM (de usted, recoger y domicilio)",
};

export const TONO_LABEL: Readonly<Record<TonoAgente, string>> = {
  calido_cercano: "Cálido y cercano",
  formal_directo: "Formal y directo",
  profesional_neutro: "Profesional y neutro",
  divertido_desenfadado: "Divertido y desenfadado",
};

/** Motivos de escalacion que se pueden apagar (los demas protegen al cliente y no se tocan). */
export const MOTIVO_LABEL: Readonly<Record<string, string>> = {
  pedido_grande: "Pedido muy grande",
  zona_ambigua: "El cliente insiste en otra sucursal para domicilio",
  producto_agotado: "Producto agotado sin alternativa",
  no_entiende: "No se le entiende al cliente",
};

/** Campos editables. Texto vacio = usar el valor del perfil. */
export interface ConfigAgenteForm {
  readonly perfil: PerfilAgente;
  readonly agentName: string;
  readonly businessName: string;
  readonly toneStyle: TonoAgente | "";
  readonly deliveryTimeText: string;
  readonly greetingText: string;
  readonly salsasText: string;
  readonly promosText: string;
  readonly escalationReasonsOff: readonly string[];
}

export interface ConfigAgenteWire {
  readonly perfil: PerfilAgente;
  readonly agentName: string | null;
  readonly businessName: string | null;
  readonly toneStyle: TonoAgente | null;
  readonly deliveryTimeText: string | null;
  readonly greetingText: string | null;
  readonly salsasText: string | null;
  readonly promosText: string | null;
  readonly escalationReasonsOff: readonly string[];
  /** `null` = la base todavia no tiene la migracion 033 (sin version ni historial). */
  readonly version: number | null;
}

export interface AgenteWhatsappWire {
  readonly organizacion: ConfigAgenteWire | null;
  readonly sucursal: ConfigAgenteWire | null;
}

export interface OpcionesAgenteWire {
  readonly perfiles: readonly { readonly perfil: PerfilAgente; readonly agentName: string | null; readonly businessName: string; readonly toneStyle: TonoAgente; readonly deliveryTimeText: string; readonly salsasText: string | null; readonly promosText: string | null }[];
  readonly tonos: readonly TonoAgente[];
  readonly motivosDesactivables: readonly string[];
  readonly limites: Readonly<Record<"agentName" | "businessName" | "deliveryTimeText" | "greetingText" | "salsasText" | "promosText", number>>;
}

export interface LineaDiffWire {
  readonly tipo: "igual" | "agregada" | "quitada";
  readonly texto: string;
}

export interface VistaPreviaWire {
  readonly prompt: string;
  readonly promptVigente: string;
  readonly diferenciasCampos: readonly { readonly campo: string; readonly antes: string; readonly despues: string }[];
  readonly diferenciasPrompt: readonly LineaDiffWire[];
  readonly version: number;
}

export interface HistorialEntradaWire {
  readonly version: number;
  readonly accion: "actualizado" | "restablecido";
  readonly anterior: Readonly<Record<string, unknown>> | null;
  readonly nuevo: Readonly<Record<string, unknown>>;
  readonly actorUserId: string | null;
  readonly actorNombre: string | null;
  readonly creadoEn: string;
}

const base = (apiBaseUrl: string, propertyId: string): string => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/agente-whatsapp`;

export function formDesdeWire(c: ConfigAgenteWire | null, perfilPorOmision: PerfilAgente = "taqueria_pm"): ConfigAgenteForm {
  return {
    perfil: c?.perfil ?? perfilPorOmision,
    agentName: c?.agentName ?? "",
    businessName: c?.businessName ?? "",
    toneStyle: c?.toneStyle ?? "",
    deliveryTimeText: c?.deliveryTimeText ?? "",
    greetingText: c?.greetingText ?? "",
    salsasText: c?.salsasText ?? "",
    promosText: c?.promosText ?? "",
    escalationReasonsOff: c?.escalationReasonsOff ?? [],
  };
}

/** Cuerpo del PUT / vista previa. Los campos que solo existen en el perfil PM se omiten en el generico (el servidor los rechaza). */
export function cuerpoDesdeForm(form: ConfigAgenteForm, alcance: AlcanceAgente, versionEsperada?: number | null) {
  const pm = form.perfil === "taqueria_pm";
  const t = (v: string): string | null => (v.trim().length > 0 ? v.trim() : null);
  return {
    alcance,
    perfil: form.perfil,
    agentName: t(form.agentName),
    businessName: t(form.businessName),
    toneStyle: form.toneStyle === "" ? null : form.toneStyle,
    deliveryTimeText: t(form.deliveryTimeText),
    greetingText: pm ? t(form.greetingText) : null,
    salsasText: pm ? t(form.salsasText) : null,
    promosText: pm ? t(form.promosText) : null,
    escalationReasonsOff: pm ? [...form.escalationReasonsOff] : [],
    ...(versionEsperada === undefined || versionEsperada === null ? {} : { versionEsperada }),
  };
}

export function fetchAgenteWhatsapp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AgenteWhatsappWire> {
  return fetchJson<AgenteWhatsappWire>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function fetchOpcionesAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<OpcionesAgenteWire> {
  return fetchJson<OpcionesAgenteWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/opciones`, token);
}

export function guardarAgenteWhatsapp(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  form: ConfigAgenteForm,
  alcance: AlcanceAgente,
  versionEsperada: number | null,
): Promise<ConfigAgenteWire> {
  return sendJson<ConfigAgenteWire>(fetchImpl, base(apiBaseUrl, propertyId), token, "PUT", cuerpoDesdeForm(form, alcance, versionEsperada));
}

export function vistaPreviaAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: ConfigAgenteForm, alcance: AlcanceAgente): Promise<VistaPreviaWire> {
  return sendJson<VistaPreviaWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/vista-previa`, token, "POST", cuerpoDesdeForm(form, alcance));
}

export async function fetchHistorialAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alcance: AlcanceAgente): Promise<readonly HistorialEntradaWire[]> {
  const r = await fetchJson<{ entradas: HistorialEntradaWire[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/historial?alcance=${alcance}&limite=20`, token);
  return r.entradas;
}

export function restablecerAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alcance: AlcanceAgente, versionEsperada: number | null): Promise<ConfigAgenteWire> {
  return sendJson<ConfigAgenteWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/restablecer`, token, "POST", { alcance, ...(versionEsperada === null ? {} : { versionEsperada }) });
}

const CAMPO_LABEL: Readonly<Record<string, string>> = {
  perfil: "Perfil",
  agentName: "Nombre del agente",
  businessName: "Nombre del negocio",
  toneStyle: "Tono",
  deliveryTimeText: "Tiempos de entrega",
  greetingText: "Saludo",
  salsasText: "Salsas incluidas",
  promosText: "Promociones",
  escalationReasonsOff: "Motivos de escalación desactivados",
};

function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? [...v].map(String).sort().join(",") : String(v);
}

/** Etiquetas de los campos que cambian entre dos fotos del historial (`anterior` null = primera configuracion). */
export function camposCambiados(anterior: Readonly<Record<string, unknown>> | null, nuevo: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(CAMPO_LABEL)
    .filter((k) => comoTexto(anterior?.[k]) !== comoTexto(nuevo[k]))
    .map((k) => CAMPO_LABEL[k]!);
}

/** Foto del historial -> formulario (para "usar esta version" y revisarla antes de guardarla). */
export function formDesdeFoto(foto: Readonly<Record<string, unknown>>): ConfigAgenteForm {
  const t = (v: unknown): string => (typeof v === "string" ? v : "");
  const tono = typeof foto.toneStyle === "string" && foto.toneStyle in TONO_LABEL ? (foto.toneStyle as TonoAgente) : "";
  return {
    perfil: foto.perfil === "generico" ? "generico" : "taqueria_pm",
    agentName: t(foto.agentName),
    businessName: t(foto.businessName),
    toneStyle: tono,
    deliveryTimeText: t(foto.deliveryTimeText),
    greetingText: t(foto.greetingText),
    salsasText: t(foto.salsasText),
    promosText: t(foto.promosText),
    escalationReasonsOff: Array.isArray(foto.escalationReasonsOff) ? foto.escalationReasonsOff.map(String) : [],
  };
}
