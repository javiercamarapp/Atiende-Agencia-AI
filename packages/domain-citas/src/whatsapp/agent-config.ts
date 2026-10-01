// C-15 -- personalidad editable del agente de WhatsApp de citas (nombre, tono, mensaje de bienvenida y reglas del negocio) y
// conexion del numero. Todo es PURO (sin base): la API lo usa para validar, previsualizar y comparar ANTES de guardar, y el
// agente lo usa para armar su prompt. Mismo patron que el editor del agente de restaurantes (#254) y los mensajes de C-04.
//
// Lo editable es texto corto de UNA linea por campo (las reglas son hasta 5 lineas de 160 caracteres): nunca el prompt
// completo. Las REGLAS DURAS (nunca inventar horarios, no doble creacion, etc.) viven en el codigo
// (`llm-turn-handler.ts::APPOINTMENT_HARD_RULES`) y se envian ANTES de este texto: ninguna edicion de aqui las puede quitar.
export const TONOS_AGENTE_CITAS = ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"] as const;
export type TonoAgenteCitas = (typeof TONOS_AGENTE_CITAS)[number];

export const TONO_ETIQUETAS: Readonly<Record<TonoAgenteCitas, string>> = {
  calido_cercano: "Cálido y cercano",
  formal_directo: "Formal y directo",
  profesional_neutro: "Profesional y neutro",
  divertido_desenfadado: "Divertido y desenfadado",
};

/** Instruccion de tono que entra al prompt. Todas mantienen "mensajes cortos": es WhatsApp, no un formulario. */
export const TONO_INSTRUCCION: Readonly<Record<TonoAgenteCitas, string>> = {
  calido_cercano: "Tono cálido y cercano, mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.",
  formal_directo: "Tono formal y directo, trata al cliente de usted, mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.",
  profesional_neutro: "Tono profesional y neutro, sin diminutivos ni modismos, mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.",
  divertido_desenfadado: "Tono divertido y desenfadado, con calidez y algún emoji ocasional, pero siempre claro; mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.",
};

/** Topes (los mismos CHECK de la migracion 028). */
export const AGENTE_LIMITES = { agentName: 60, greetingText: 200, rulesMaxLines: 5, ruleLength: 160, rulesText: 800 } as const;

/** Lo que el negocio puede cambiar del agente. `null` = usa el valor de fabrica. */
export interface WhatsappAgentConfig {
  readonly agentName: string | null;
  readonly toneStyle: TonoAgenteCitas | null;
  readonly greetingText: string | null;
  /** Hasta 5 reglas, una por linea (separadas por "\n"). */
  readonly rulesText: string | null;
}

export const AGENTE_CONFIG_POR_OMISION: WhatsappAgentConfig = { agentName: null, toneStyle: null, greetingText: null, rulesText: null };

export interface WhatsappAgentConfigRecord {
  readonly config: WhatsappAgentConfig;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** Resultado de guardar: nunca lanza por una base sin migrar ni por quien no es owner/admin. */
export type AgenteConfigGuardado =
  | { readonly status: "saved"; readonly version: number }
  | { readonly status: "conflict" }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

export type ResultadoValidacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function textoUnaLinea(raw: unknown, campo: string, max: number): ResultadoValidacion<string | null> {
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "string") return { ok: false, error: `${campo}: se esperaba un texto o null.` };
  const recortado = raw.trim();
  if (recortado.length === 0) return { ok: true, valor: null };
  if (recortado.length > max || CONTROL.test(recortado)) return { ok: false, error: `${campo}: de 1 a ${max} caracteres, en una sola línea.` };
  return { ok: true, valor: recortado };
}

function reglas(raw: unknown): ResultadoValidacion<string | null> {
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "string") return { ok: false, error: "rulesText: se esperaba un texto o null." };
  const lineas = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lineas.length === 0) return { ok: true, valor: null };
  if (lineas.length > AGENTE_LIMITES.rulesMaxLines) return { ok: false, error: `rulesText: máximo ${AGENTE_LIMITES.rulesMaxLines} reglas (una por línea).` };
  if (lineas.some((l) => l.length > AGENTE_LIMITES.ruleLength || CONTROL.test(l))) {
    return { ok: false, error: `rulesText: cada regla de 1 a ${AGENTE_LIMITES.ruleLength} caracteres.` };
  }
  return { ok: true, valor: lineas.join("\n") };
}

/** Valida el cuerpo de un guardado o de una vista previa. Los textos vacios pasan a `null` (usar el de fabrica). */
export function validarConfigAgente(raw: unknown): ResultadoValidacion<WhatsappAgentConfig> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const o = raw as Record<string, unknown>;
  if (o.toneStyle !== undefined && o.toneStyle !== null && !(TONOS_AGENTE_CITAS as readonly unknown[]).includes(o.toneStyle)) {
    return { ok: false, error: `toneStyle: uno de ${TONOS_AGENTE_CITAS.join(", ")} o null.` };
  }
  const agentName = textoUnaLinea(o.agentName, "agentName", AGENTE_LIMITES.agentName);
  if (!agentName.ok) return agentName;
  const greetingText = textoUnaLinea(o.greetingText, "greetingText", AGENTE_LIMITES.greetingText);
  if (!greetingText.ok) return greetingText;
  const rulesText = reglas(o.rulesText);
  if (!rulesText.ok) return rulesText;
  return { ok: true, valor: { agentName: agentName.valor, toneStyle: (o.toneStyle ?? null) as TonoAgenteCitas | null, greetingText: greetingText.valor, rulesText: rulesText.valor } };
}

/** Reconstruye la configuracion desde lo que devuelve la base (columnas ya validadas por CHECK), con red de seguridad. */
export function configAgenteDesdeFila(row: { agent_name: string | null; tone_style: string | null; greeting_text: string | null; rules_text: string | null }): WhatsappAgentConfig {
  const tono = (TONOS_AGENTE_CITAS as readonly string[]).includes(row.tone_style ?? "") ? (row.tone_style as TonoAgenteCitas) : null;
  return { agentName: row.agent_name, toneStyle: tono, greetingText: row.greeting_text, rulesText: row.rules_text };
}

export function reglasComoLista(config: Pick<WhatsappAgentConfig, "rulesText">): readonly string[] {
  return config.rulesText ? config.rulesText.split("\n").filter((l) => l.length > 0) : [];
}

const ETIQUETAS_CAMPO: Readonly<Record<keyof WhatsappAgentConfig, string>> = {
  agentName: "Nombre del agente",
  toneStyle: "Tono",
  greetingText: "Mensaje de bienvenida",
  rulesText: "Reglas del negocio",
};

/** Foto de los campos editables (la forma que viaja en la API y en la bitacora). */
export function fotoConfigAgente(config: WhatsappAgentConfig): Record<string, unknown> {
  return { agentName: config.agentName, toneStyle: config.toneStyle, greetingText: config.greetingText, rulesText: config.rulesText };
}

export interface DiferenciaCampoAgente {
  readonly campo: string;
  readonly antes: string;
  readonly despues: string;
}

/** Campos que cambian entre dos configuraciones (`antes` = `null` si nunca se configuro). Vacio y ausente cuentan igual. */
export function diferenciasConfigAgente(antes: WhatsappAgentConfig | null, despues: WhatsappAgentConfig): readonly DiferenciaCampoAgente[] {
  const base = antes ?? AGENTE_CONFIG_POR_OMISION;
  const out: DiferenciaCampoAgente[] = [];
  for (const campo of Object.keys(ETIQUETAS_CAMPO) as (keyof WhatsappAgentConfig)[]) {
    const a = base[campo] ?? "";
    const d = despues[campo] ?? "";
    if (a !== d) out.push({ campo: ETIQUETAS_CAMPO[campo], antes: campo === "toneStyle" && a ? TONO_ETIQUETAS[a as TonoAgenteCitas] : a, despues: campo === "toneStyle" && d ? TONO_ETIQUETAS[d as TonoAgenteCitas] : d });
  }
  return out;
}

// ---- Conexion del numero ----

/** `phone_number_id` de Meta: solo digitos (5-40), el mismo patron que valida la funcion SQL. */
export const PHONE_NUMBER_ID_RE = /^[0-9]{5,40}$/;

export function validarPhoneNumberId(raw: unknown): ResultadoValidacion<string> {
  if (typeof raw !== "string") return { ok: false, error: "phoneNumberId: se esperaba un texto con el identificador del número (solo dígitos)." };
  const id = raw.trim();
  if (!PHONE_NUMBER_ID_RE.test(id)) return { ok: false, error: "phoneNumberId: solo dígitos, de 5 a 40. Es el «Identificador del número de teléfono» de WhatsApp Business en Meta." };
  return { ok: true, valor: id };
}

export interface WhatsappConnection {
  readonly phoneNumberId: string;
  readonly isActive: boolean;
}

export type ConectarNumeroResultado =
  | { readonly status: "connected"; readonly phoneNumberId: string }
  | { readonly status: "in_use" }
  | { readonly status: "invalid" }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

export type DesconectarNumeroResultado = { readonly status: "disconnected"; readonly removed: boolean } | { readonly status: "forbidden" } | { readonly status: "unavailable" };

/** Estado de la conexion que ve el negocio. Siempre honesto: lo que NO se puede comprobar desde aqui (que Meta reconozca el
 * numero) no se afirma. */
export type EstadoConexionWhatsapp =
  /** Sin numero registrado: el agente no recibe ni envia nada. */
  | "sin_numero"
  /** Registrado pero pausado: el webhook no lo enruta y los avisos no salen. */
  | "pausado"
  /** Registrado y activo, pero la plataforma no tiene la credencial de envio de Meta: se reciben mensajes, no se puede responder. */
  | "sin_credenciales_de_envio"
  /** Registrado, activo y con credencial de envio. No equivale a "verificado con Meta". */
  | "registrado";

export function estadoConexion(conexion: WhatsappConnection | null, credencialDeEnvioDisponible: boolean): EstadoConexionWhatsapp {
  if (!conexion) return "sin_numero";
  if (!conexion.isActive) return "pausado";
  return credencialDeEnvioDisponible ? "registrado" : "sin_credenciales_de_envio";
}
