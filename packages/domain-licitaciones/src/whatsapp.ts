// L-05 -- WhatsApp para licitaciones: logica PURA (sin IO) de tokens de un solo uso,
// botones, palabras clave de opt-in/opt-out y redaccion de mensajes. El almacenamiento
// vive en `whatsapp-repository.ts` (tablas de la migracion 030) y el envio real en
// `@atiende/whatsapp-gateway` (nunca desde aqui, ni en tests ni en CI).
//
// Modelo de seguridad de la decision por boton (go / no-go):
//   - El token es aleatorio (32 bytes, base64url) y SOLO su SHA-256 se guarda en la base.
//   - Viaja en el `id` del boton (`lic-wa:<token>`); el boton vuelve tal cual en el
//     webhook firmado por Meta.
//   - Un solo uso, con expiracion, ligado a usuario + organizacion + convocatoria +
//     accion + telefono. La base lo revalida todo en el consumo
//     (`licitaciones.whatsapp_consume_action_token`).
import { createHash, randomBytes } from "node:crypto";

/** Prefijo del `id` de los botones de este vertical (otros verticales usan `cita:...`). */
export const WHATSAPP_BUTTON_PREFIX = "lic-wa:";
/** Vigencia por omision de una solicitud de decision (la base acepta como maximo 7 dias). */
export const DECISION_TOKEN_TTL_HOURS = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

export type WhatsAppTopic = "plazos" | "convocatorias" | "fallos" | "decisiones";
export const WHATSAPP_TOPICS: readonly WhatsAppTopic[] = ["plazos", "convocatorias", "fallos", "decisiones"];

export type WhatsAppDecisionAction = "go" | "no_go";

/** Resultado del consumo atomico de un token (ver la funcion SQL). */
export type TokenConsumeResult =
  | "ok"
  | "duplicado"
  | "ya_usado"
  | "expirado"
  | "no_encontrado"
  | "contacto_inactivo"
  | "telefono_distinto"
  | "rol_insuficiente";

export class WhatsAppNotAvailableError extends Error {
  constructor() {
    super("Los avisos por WhatsApp aun no estan disponibles en este ambiente (falta aplicar la migracion 030 de licitaciones).");
    this.name = "WhatsAppNotAvailableError";
  }
}

export class WhatsAppValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppValidationError";
  }
}

export function sha256TokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface GeneratedActionToken {
  readonly token: string;
  readonly hash: string;
}

export function generateActionToken(): GeneratedActionToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256TokenHash(token) };
}

export function buttonIdForToken(token: string): string {
  if (!TOKEN_RE.test(token)) throw new WhatsAppValidationError("token con forma invalida");
  return `${WHATSAPP_BUTTON_PREFIX}${token}`;
}

/** Devuelve el token del id de un boton, o `null` si el id no es de este vertical / esta mal formado. */
export function parseActionButtonId(buttonId: string): string | null {
  if (!buttonId.startsWith(WHATSAPP_BUTTON_PREFIX)) return null;
  const token = buttonId.slice(WHATSAPP_BUTTON_PREFIX.length);
  return TOKEN_RE.test(token) ? token : null;
}

/** Normaliza a E.164 (`+<codigo><numero>`). Acepta espacios, guiones y parentesis; exige el `+`. */
export function normalizePhoneE164(input: string): string {
  const cleaned = input.trim().replace(/[\s().-]/g, "");
  if (!E164_RE.test(cleaned)) {
    throw new WhatsAppValidationError("telefono: se esperaba formato internacional, p. ej. +5215512345678.");
  }
  return cleaned;
}

/** El `from` de Meta viene solo con digitos (sin `+`). */
export function phoneFromMeta(from: string): string | null {
  return /^\d{7,20}$/.test(from) && E164_RE.test(`+${from}`) ? `+${from}` : null;
}

export type OptKeyword = "opt_in" | "opt_out";

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Solo reconoce el mensaje COMPLETO (no una palabra suelta dentro de una frase). */
export function parseOptKeyword(body: string): OptKeyword | null {
  const text = stripAccents(body).trim().toLowerCase().replace(/[.!¡¿?\s]+$/g, "").replace(/^[¡¿\s]+/g, "");
  if (["si", "acepto", "alta", "confirmo"].includes(text)) return "opt_in";
  if (["baja", "stop", "alto", "cancelar suscripcion"].includes(text)) return "opt_out";
  return null;
}

export interface OutboxWhatsAppPayload {
  readonly to: string;
  readonly body: string;
  readonly buttons?: readonly { readonly id: string; readonly title: string }[];
}

const MAX_BODY = 1000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface TenderSummaryForMessage {
  readonly title: string;
  /** Fecha ya legible (p. ej. "15 oct 2026, 14:00"); quien llama la formatea en la zona de la organizacion. */
  readonly deadlineLabel?: string | null;
  /** Texto ya redactado por quien detecto el hecho (p. ej. el recordatorio de plazo); sustituye al encabezado generico. */
  readonly rawText?: string;
}

export function buildDecisionRequestMessage(to: string, tender: TenderSummaryForMessage, goToken: string, noGoToken: string): OutboxWhatsAppPayload {
  const plazo = tender.deadlineLabel ? ` Plazo de presentacion: ${tender.deadlineLabel}.` : "";
  return {
    to,
    body: clip(`Atiende Licitaciones: ¿participamos en "${clip(tender.title, 160)}"?${plazo} Elige una opcion; queda registrada a tu nombre en la bitacora de la convocatoria.`, MAX_BODY),
    buttons: [
      { id: buttonIdForToken(goToken), title: "Go" },
      { id: buttonIdForToken(noGoToken), title: "No-Go" },
    ],
  };
}

export type NoticeKind = "plazo" | "convocatoria" | "fallo";

export function buildNoticeMessage(to: string, kind: NoticeKind, tender: TenderSummaryForMessage, extra?: string): OutboxWhatsAppPayload {
  const title = clip(tender.title, 160);
  const cuando = tender.deadlineLabel ? ` Fecha: ${tender.deadlineLabel}.` : "";
  const head =
    tender.rawText ? clip(tender.rawText, 400)
    : kind === "plazo" ? `Recordatorio de plazo: "${title}".${cuando}`
    : kind === "convocatoria" ? `Nueva convocatoria: "${title}".${cuando}`
    : `Fallo publicado: "${title}".`;
  const tail = extra ? ` ${extra}` : "";
  return { to, body: clip(`Atiende Licitaciones: ${head}${tail} Responde BAJA para dejar de recibir estos avisos.`, MAX_BODY) };
}

/** Texto de respuesta al usuario tras tocar un boton. */
export function buildDecisionReplyBody(result: TokenConsumeResult | "error", action?: WhatsAppDecisionAction | null): string {
  switch (result) {
    case "ok":
      return action === "go" ? "Listo: registramos tu decision GO." : "Listo: registramos tu decision NO-GO.";
    case "duplicado":
      return "Esa decision ya estaba registrada.";
    case "ya_usado":
      return "Esa solicitud ya se uso. Si necesitas cambiar la decision, hazlo desde el panel.";
    case "expirado":
      return "Esa solicitud ya expiro. Pide una nueva desde el panel.";
    case "contacto_inactivo":
      return "Tus avisos por WhatsApp estan desactivados. Reactivalos desde el panel.";
    case "telefono_distinto":
    case "no_encontrado":
      return "No pudimos validar esta solicitud.";
    case "rol_insuficiente":
      return "Tu rol actual no permite decidir go/no-go.";
    default:
      return "No pudimos registrar la decision. Intenta de nuevo desde el panel.";
  }
}

export const OPT_IN_CONFIRMED_BODY = "Listo: activamos tus avisos de Atiende Licitaciones por WhatsApp. Responde BAJA cuando quieras dejar de recibirlos.";
export const OPT_OUT_CONFIRMED_BODY = "Listo: dejaste de recibir avisos de Atiende Licitaciones por WhatsApp. Puedes reactivarlos desde el panel.";
