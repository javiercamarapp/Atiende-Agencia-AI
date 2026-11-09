// PM PR-9 (restaurantes) — fast-path DETERMINISTA de derechos ARCO en el agente de WhatsApp y de
// voz. Mismo patrón que domain-citas/src/arco-intent.ts: corre ANTES del LLM, así
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
import { redactarTranscripcion } from "../voz/transcripcion.ts";
import type { PrivacidadRepository } from "./repository.ts";
import {
  ARCO_MENU_REPLY,
  ARCO_THIRD_PARTY_REPLY,
  arcoAlreadyOpenReply,
  arcoConfirmedReply,
  arcoPendingConfirmationReply,
  arcoWithdrawnReply,
  type DataRightType,
  type DataRightsChannel,
} from "./data-rights.ts";

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

const DEFAULT_TIMEZONE = "America/Mexico_City";

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
// pedido" o "actualizar mi dirección de entrega" con una solicitud ARCO.
const PERSONAL_DATA_RE = /\b(datos personales|mis datos|mi informacion personal|informacion personal|mis datos personales|aviso de privacidad|privacidad|arco)\b/;
const THIRD_PARTY_RE =
  /\b(de|del) (mi|su|otro|otra|un|una|el|la) (esposa|esposo|pareja|mama|papa|madre|padre|hij[oa]|hermano|hermana|amig[oa]|cliente|paciente|vecin[oa]|persona|jefe|jefa|ex|novio|novia|senor|senora|familiar)\b|\bde (otra persona|alguien mas|un tercero|terceros)\b/;

const RIGHT_PATTERNS: ReadonlyArray<{ readonly right: DataRightType; readonly re: RegExp }> = [
  { right: "cancelacion", re: /\b(cancelar|cancelacion de|eliminar|elimina|eliminen|borrar|borren|borra|suprimir|supriman|supresion|olvidar|olviden|dar de baja|darme de baja)\b/ },
  { right: "oposicion", re: /\b(oponer|oponerme|oposicion|me opongo|revoco|revocar|revocacion|no quiero que (usen|traten|utilicen|compartan)|dejen de (usar|tratar|utilizar|compartir)|no (los |lo )?(usen|compartan|traten|utilicen))\b/ },
  { right: "rectificacion", re: /\b(rectificar|rectificacion|rectifiquen|corregir|correccion|corrijan|actualizar|actualicen|modificar|modifiquen|estan mal|incorrectos|erroneos|equivocados)\b/ },
  { right: "acceso", re: /\b(acceso|acceder|conocer|saber|ver|consultar|copia|obtener|que datos|cuales datos|entreguen|envien)\b/ },
];

// Seguimiento de una solicitud ya hecha: pregunta por el aviso, el plazo o el estado del trámite («¿me avisan cuando…?», «¿cuánto tarda?»).
// OJO: «me avisan / me confirman / me dicen» es también la forma normal de PEDIR algo en español («Borren mis datos y me avisan»), así que este patrón
// NUNCA descarta un mensaje por sí solo: solo cuenta dentro de `runArcoFastPath` y solo si ESE teléfono ya tiene una solicitud abierta (revisión del PR #757).
const FOLLOW_UP_RE =
  /\b(me avisan|me avisas|me avisaran|me avisen|me van a avisar|me notifican|me notificaran|me van a notificar|me dicen|me confirman|cuanto tarda|cuanto tiempo|cuando me (responden|contestan)|ya quedo|como va|en que va|estatus|status|seguimiento)\b/;
// Petición explícita: «quiero / solicito / pido…», «que borren…», los imperativos directos («borren», «corrijan», «dame una copia», «denme»…),
// «me opongo», «revoco», «dejen de…», «¿me dicen qué datos…?» y «necesito saber qué datos…». «quiero saber» a secas es la coletilla de una pregunta, no una petición.
const EXPLICIT_REQUEST_RE = new RegExp(
  [
    "\\b(quiero|quisiera|solicito|deseo|pido|necesito|requiero|me gustaria)\\b(?! saber\\b)",
    "\\bque (los |las |me )?(borren|eliminen|supriman|corrijan|rectifiquen|actualicen|modifiquen|den|envien|manden|entreguen)\\b",
    // «cuando borren…» es subjuntivo (pregunta por el aviso), no una orden.
    "(?<!\\b(?:cuando|si|en cuanto) )\\b(borren|borra|borrame|borrenme|eliminen|elimina|eliminame|eliminenme|supriman|suprime|corrijan|corrige|corrijanme|rectifiquen|rectifica|actualicen|actualiza|modifiquen|modifica|dame|denme|envienme|enviame|mandenme|mandame|entreguenme|entregame)\\b",
    "\\b(me opongo|revoco|dejen de|no quiero que)\\b",
    "\\b(me (dicen|digan|dices|informan|indican)|quiero saber|quisiera saber|necesito saber|deseo saber) (que|cuales|cual) (datos|informacion)\\b",
  ].join("|"),
);

/** `true` si el mensaje es una PREGUNTA sobre un trámite ARCO (aviso, plazo, estado) y no trae una petición explícita.
 * No basta para descartar el mensaje: `runArcoFastPath` solo lo trata como seguimiento si ya hay una solicitud abierta. */
export function isArcoFollowUp(message: string): boolean {
  const normalized = normalizeArcoText(message);
  if (!normalized || !PERSONAL_DATA_RE.test(normalized) || THIRD_PARTY_RE.test(normalized)) return false;
  return FOLLOW_UP_RE.test(normalized) && !EXPLICIT_REQUEST_RE.test(normalized);
}

export type ArcoIntent =
  | { readonly kind: "request"; readonly right: DataRightType }
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
  if (!normalized || !PERSONAL_DATA_RE.test(normalized)) return null;

  if (THIRD_PARTY_RE.test(normalized)) return { kind: "third_party" };

  const matched = RIGHT_PATTERNS.filter(({ re }) => re.test(normalized)).map(({ right }) => right);
  // "acceso" es el verbo más genérico ("ver", "saber"): si coincide junto con otro
  // derecho, manda el otro ("quiero ver cómo borrar mis datos" -> cancelación).
  const specific = matched.filter((right) => right !== "acceso");
  const candidates = specific.length > 0 ? specific : matched;

  if (candidates.length === 1) return { kind: "request", right: candidates[0]! };
  return { kind: "menu" };
}

export interface ArcoFastPathResult {
  readonly reply: string;
}

/**
 * Procesa UN mensaje entrante. Devuelve la respuesta a enviar, o `null` cuando el
 * mensaje no es de ARCO (o la migración 030 no está aplicada en esta base: cae al
 * camino anterior, el agente LLM) — nunca lanza por una base sin migrar.
 *
 * Orden: (1) frase de confirmación/retiro, solo si hay una solicitud pendiente
 * vigente de ESTE teléfono; (2) pregunta de seguimiento («¿me avisan cuando…?»), solo
 * si ESTE teléfono ya tiene una solicitud abierta: se contesta con su estado y plazo
 * reales, sin abrir otra; (3) intención de ARCO nueva.
 */
export async function runArcoFastPath(
  repo: PrivacidadRepository,
  organizationId: string,
  customerPhone: string,
  message: string,
  channel: DataRightsChannel = "whatsapp",
  timezone: string = DEFAULT_TIMEZONE,
): Promise<ArcoFastPathResult | null> {
  const confirmation = detectArcoConfirmation(message);
  if (confirmation) {
    const outcome = await repo.resolveDataRightsConfirmationAsSystem(organizationId, customerPhone, confirmation === "confirm");
    // Sin solicitud pendiente (o base sin migrar): "CONFIRMO" puede ser parte de otra
    // conversación (p. ej. un pedido) -- se deja pasar al agente.
    if (!outcome.available || !outcome.found) return null;
    if (confirmation === "confirm") {
      return { reply: arcoConfirmedReply(outcome.rightType, outcome.id, outcome.responseDueAt, outcome.executionDueAt, timezone) };
    }
    return { reply: arcoWithdrawnReply(outcome.rightType, outcome.id) };
  }

  if (isArcoFollowUp(message)) {
    const open = await repo.findOpenDataRightsRequestAsSystem(organizationId, customerPhone);
    if (open.available && open.found) {
      return { reply: arcoAlreadyOpenReply(open.rightType, open.id, open.status, open.responseDueAt, timezone) };
    }
    // Sin solicitud abierta (o base sin la 106): no hay trámite del que dar seguimiento, así que se trata como
    // cualquier otro mensaje. Preferimos pedir CONFIRMO de más a perder una solicitud real con su plazo legal.
  }

  const intent = detectArcoIntent(message);
  if (!intent) return null;
  if (intent.kind === "menu") return { reply: ARCO_MENU_REPLY };
  if (intent.kind === "third_party") return { reply: ARCO_THIRD_PARTY_REPLY };

  const outcome = await repo.registerDataRightsRequestAsSystem({
    organizationId,
    customerPhone,
    rightType: intent.right,
    channel,
    detail: redactarTranscripcion(message).slice(0, 300),
  });
  // Base sin migrar: sin dónde registrar, se cae al camino anterior (LLM) en vez de
  // prometer un seguimiento que no existiría.
  if (!outcome.available) return null;

  if (outcome.alreadyOpen) {
    return { reply: arcoAlreadyOpenReply(intent.right, outcome.id, outcome.status, outcome.responseDueAt, timezone) };
  }
  return { reply: arcoPendingConfirmationReply(intent.right, outcome.id) };
}
