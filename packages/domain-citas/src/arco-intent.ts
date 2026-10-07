// C-02 (citas) — fast-path DETERMINISTA de derechos ARCO en el agente de WhatsApp.
// Mismo lugar y misma filosofía que `crisis-guardrail.ts`: corre ANTES del LLM, así
// que una solicitud de privacidad nunca depende de que el modelo la entienda ni de
// que "recuerde" registrarla, y el LLM nunca improvisa una respuesta legal.
//
// Identidad: el agente solo actúa sobre el teléfono que escribe (Meta lo autentica);
// ese teléfono viene de `inbound.ts`, NUNCA del texto del mensaje. Un mensaje que
// pide datos de otra persona se responde con una negativa guiada y no registra nada.
// La confirmación exige una frase explícita ("CONFIRMO"), no un "sí" ambiguo que
// podría ser la respuesta a otra pregunta del agente.
//
// El agente jamás devuelve datos personales por chat: 'acceso' lo atiende el staff
// desde el panel tras verificar la identidad. Documentación operativa, no asesoría
// legal.
import type { CitasRepository } from "./repository.ts";
import {
  ARCO_MENU_REPLY,
  ARCO_THIRD_PARTY_REPLY,
  arcoAlreadyOpenReply,
  arcoConfirmedReply,
  arcoPendingConfirmationReply,
  arcoWithdrawnReply,
  type DataRightType,
} from "./data-rights.ts";
import { redactSensitiveInfo } from "./redaction.ts";

/** Minúsculas y sin acentos/diacríticos, espacios colapsados: la detección compara
 * contra texto normalizado, así que "Rectificación" == "rectificacion". */
export function normalizeArcoText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CONFIRM_RE = /^(confirmo|confirmo mi solicitud|si confirmo)$/;
const WITHDRAW_RE = /^(cancelar solicitud|cancela mi solicitud|cancelar mi solicitud|retirar solicitud|retiro mi solicitud|no confirmo)$/;

export type ArcoConfirmationIntent = "confirm" | "withdraw";

/** Respuesta a la pregunta de confirmación — SOLO frases explícitas y exactas. */
export function detectArcoConfirmation(message: string): ArcoConfirmationIntent | null {
  const normalized = normalizeArcoText(message);
  if (CONFIRM_RE.test(normalized)) return "confirm";
  if (WITHDRAW_RE.test(normalized)) return "withdraw";
  return null;
}

// Mención de datos personales / privacidad: exigida para NO confundir "cancelar mi
// cita" o "actualizar mi horario" con una solicitud ARCO.
const PERSONAL_DATA_RE = /\b(datos personales|mis datos|mi informacion personal|informacion personal|mis datos personales|arco)\b/;
// "Aviso de privacidad" / "privacidad" a secas SOLO cuentan si traen un verbo de derecho concreto distinto de "acceso" (borren, corrijan, me opongo...):
// pedir o querer ver el aviso NO es una solicitud ARCO (antes abria una de ACCESO con folio).
const PRIVACIDAD_RE = /\b(aviso de privacidad|privacidad)\b/;
// Palabras de agenda: "cancelar mi cita" no es "cancelar mis datos". Con una de ellas, un verbo suelto (cancelar, borrar, eliminar, dar de baja) se
// lee como accion sobre la CITA; el derecho de cancelacion de datos exige entonces el verbo pegado a "datos"/"informacion personal" (solo se admite "por favor" en medio:
// 'quiero cancelar mi cita mis datos son Ana' ya no se lee como borrado de datos).
const CITA_RE = /\b(cita|citas|turno|reservacion|appointment)\b/;
const BORRAR_DATOS_RE = /\b(borr\w*|elimin\w*|suprim\w*|olvid\w*|cancel\w*)\b(?:\s+por favor)?\s+(?:(?:mis|los|todos mis)\s+)?(?:datos|informacion personal)\b|\bcancelacion de (?:mis )?datos\b/;
const THIRD_PARTY_RE =
  /\b(de|del) (mi|su|otro|otra|un|una|el|la) (esposa|esposo|pareja|mama|papa|madre|padre|hij[oa]|hermano|hermana|amig[oa]|cliente|paciente|vecin[oa]|persona|jefe|jefa|ex|novio|novia|senor|senora|familiar)\b|\bde (otra persona|alguien mas|un tercero|terceros)\b/;

const RIGHT_PATTERNS: ReadonlyArray<{ readonly right: DataRightType; readonly re: RegExp }> = [
  { right: "cancelacion", re: /\b(cancelar|cancelacion de|eliminar|elimina|eliminen|borrar|borren|borra|suprimir|supresion|olvidar|olviden|dar de baja|darme de baja)\b/ },
  { right: "oposicion", re: /\b(oponer|oponerme|oposicion|me opongo|revoco|revocar|revocacion|no quiero que (usen|traten|utilicen|compartan)|dejen de (usar|tratar|utilizar|compartir)|no (los |lo )?(usen|compartan|traten|utilicen))\b/ },
  { right: "rectificacion", re: /\b(rectificar|rectificacion|corregir|correccion|corrijan|actualizar|actualicen|modificar|modifiquen|estan mal|incorrectos|erroneos|equivocados)\b/ },
  { right: "acceso", re: /\b(acceso|acceder|conocer|saber|ver|consultar|copia|obtener|que datos|cuales datos|entreguen|envien)\b/ },
];

export type ArcoIntent =
  | { readonly kind: "request"; readonly right: DataRightType; /** El mensaje tambien habla de una cita: la cita NO se toca por esta via. */ readonly conCita?: true }
  | { readonly kind: "menu" }
  | { readonly kind: "third_party" };

/**
 * Detecta una solicitud ARCO en un mensaje libre. Conservadora a propósito: exige
 * mención de datos personales/privacidad (o "ARCO") Y un verbo de derecho. Si el
 * mensaje menciona privacidad/ARCO sin un derecho concreto, o mezcla varios
 * derechos, devuelve `menu` (se le pide elegir UNO), sin registrar nada.
 */
export function detectArcoIntent(message: string): ArcoIntent | null {
  const normalized = normalizeArcoText(message);
  const datosPersonales = PERSONAL_DATA_RE.test(normalized);
  if (!normalized || (!datosPersonales && !PRIVACIDAD_RE.test(normalized))) return null;

  if (THIRD_PARTY_RE.test(normalized)) return { kind: "third_party" };

  const hayCita = CITA_RE.test(normalized);
  const matched = RIGHT_PATTERNS.filter(({ right, re }) => (hayCita && right === "cancelacion" ? BORRAR_DATOS_RE.test(normalized) : re.test(normalized))).map(({ right }) => right);
  // Solo "privacidad"/"aviso de privacidad": exige un derecho concreto que no sea el generico "acceso" (ver, saber, conocer).
  if (!datosPersonales && !matched.some((right) => right !== "acceso")) return null;
  // Hablaba de su cita y no pidio ningun derecho sobre sus datos: no es ARCO (que el agente atienda la cita).
  if (hayCita && matched.length === 0) return null;
  // "acceso" es el verbo más genérico ("ver", "saber"): si coincide junto con otro
  // derecho, manda el otro ("quiero ver cómo borrar mis datos" -> cancelación).
  const specific = matched.filter((right) => right !== "acceso");
  const candidates = specific.length > 0 ? specific : matched;

  if (candidates.length === 1) return hayCita ? { kind: "request", right: candidates[0]!, conCita: true } : { kind: "request", right: candidates[0]! };
  return { kind: "menu" };
}

export const ARCO_CITA_VIGENTE_NOTA = "Tu cita no se modificó con esta solicitud: si también quieres cancelarla o cambiarla, escríbeme \"cancelar mi cita\" o \"cambiar mi cita\" en un mensaje aparte.";

export interface ArcoFastPathResult {
  readonly reply: string;
}

/**
 * Procesa UN mensaje entrante. Devuelve la respuesta a enviar, o `null` cuando el
 * mensaje no es de ARCO (o la migración 024 no está aplicada en esta base: cae al
 * camino anterior, el agente LLM) — nunca lanza por una base sin migrar.
 *
 * Orden: (1) frase de confirmación/retiro, solo si hay una solicitud pendiente
 * vigente de ESTE teléfono; (2) intención de ARCO nueva.
 */
export async function runArcoFastPath(repo: CitasRepository, organizationId: string, customerPhone: string, message: string): Promise<ArcoFastPathResult | null> {
  const confirmation = detectArcoConfirmation(message);
  if (confirmation) {
    const outcome = await repo.resolveDataRightsConfirmationAsSystem(organizationId, customerPhone, confirmation === "confirm");
    // Sin solicitud pendiente (o base sin migrar): "CONFIRMO" puede ser parte de otra
    // conversación (p. ej. una cita) -- se deja pasar al agente.
    if (!outcome.available || !outcome.found) return null;
    const timezone = await resolveTimezone(repo, organizationId);
    if (confirmation === "confirm") {
      return { reply: arcoConfirmedReply(outcome.rightType, outcome.id, outcome.responseDueAt, outcome.executionDueAt, timezone) };
    }
    return { reply: arcoWithdrawnReply(outcome.rightType, outcome.id) };
  }

  const intent = detectArcoIntent(message);
  if (!intent) return null;
  if (intent.kind === "menu") return { reply: ARCO_MENU_REPLY };
  if (intent.kind === "third_party") return { reply: ARCO_THIRD_PARTY_REPLY };

  const outcome = await repo.registerDataRightsRequestAsSystem({
    organizationId,
    customerPhone,
    rightType: intent.right,
    detail: redactSensitiveInfo(message).slice(0, 300),
  });
  // Base sin migrar: sin dónde registrar, se cae al camino anterior (LLM) en vez de
  // prometer un seguimiento que no existiría.
  if (!outcome.available) return null;

  // El mismo mensaje hablaba de una cita: se atiende la solicitud de datos y se avisa que la cita sigue como estaba (nada se pierde en silencio).
  const nota = intent.conCita ? ` ${ARCO_CITA_VIGENTE_NOTA}` : "";
  if (outcome.alreadyOpen) {
    const timezone = await resolveTimezone(repo, organizationId);
    return { reply: `${arcoAlreadyOpenReply(intent.right, outcome.id, outcome.status, outcome.responseDueAt, timezone)}${nota}` };
  }
  return { reply: `${arcoPendingConfirmationReply(intent.right, outcome.id)}${nota}` };
}

async function resolveTimezone(repo: CitasRepository, organizationId: string): Promise<string> {
  const config = await repo.findTenantConfig(organizationId);
  return config?.defaultTimezone ?? "America/Mexico_City";
}
