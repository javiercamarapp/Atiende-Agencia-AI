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
const PERSONAL_DATA_EXPLICIT_RE = /\b(datos personales|mis datos personales|mi informacion personal|informacion personal|aviso de privacidad|privacidad|arco)\b/;
const FACTURA_O_PEDIDO_RE = /\b(factur\w*|rfc|ticket|recibo|comprobante|pedido|orden|ya (te|le|les) (pase|mande|envie|di|dije)|te (pase|mande|envie)|le (pase|mande|envie))\b/;
const THIRD_PARTY_RE =
  /\b(de|del) (mi|su|otro|otra|un|una|el|la) (esposa|esposo|pareja|mama|papa|madre|padre|hij[oa]|hermano|hermana|amig[oa]|cliente|paciente|vecin[oa]|persona|jefe|jefa|ex|novio|novia|senor|senora|familiar)\b|\bde (otra persona|alguien mas|un tercero|terceros)\b/;

const RIGHT_PATTERNS: ReadonlyArray<{ readonly right: DataRightType; readonly re: RegExp }> = [
  { right: "cancelacion", re: /\b(cancelar|cancelacion de|eliminar|elimina|eliminen|borrar|borren|borra|suprimir|supresion|olvidar|olviden|dar de baja|darme de baja)\b/ },
  { right: "oposicion", re: /\b(oponer|oponerme|oposicion|me opongo|revoco|revocar|revocacion|no quiero que (usen|traten|utilicen|compartan)|dejen de (usar|tratar|utilizar|compartir)|no (los |lo )?(usen|compartan|traten|utilicen))\b/ },
  { right: "rectificacion", re: /\b(rectificar|rectificacion|corregir|correccion|corrijan|actualizar|actualicen|modificar|modifiquen|estan mal|incorrectos|erroneos|equivocados)\b/ },
  { right: "acceso", re: /\b(acceso|acceder|conocer|saber|ver|consultar|copia|obtener|que datos|cuales datos|entreguen|envien)\b/ },
];

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
function detectArcoIntentBase(message: string): ArcoIntent | null {
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// RECALL PRIMERO. Una solicitud de derechos que se pierde (la atiende el modelo, o nadie) es el error grave; un menu de mas es solo una molestia que el propio menu
// suaviza ("si solo queria un pedido o su factura, digamelo y seguimos"). Por eso la deteccion NO se parcha mas con regex finas por caso:
//   1. `detectArcoIntentBase` (la logica de siempre) conserva exactamente lo que ya se detectaba;
//   2. `detectarRaizArcoAmplia` agrega RAICES amplias (borrar/eliminar/suprimir/olvidar/cancelar + datos/info/cuenta o pronombre pegado, dar de baja, oposicion,
//      "no quiero que (tengan|guarden|usen|compartan)", "en su sistema", "que tienen de mi", acceso/rectificacion), con jerga q/k, mayusculas, sin acentos;
//   3. todo lo que trae solo el paso 2, o lo que mezcla ARCO con pedido/factura sin nombrar privacidad, va al MENU (nunca registra una solicitud por adivinar);
//   4. UNICO descarte: sin ninguna raiz de derechos no hay ARCO ("ya te pase mis datos, facturame" ya NO tiene raiz de derecho... y aun asi, por la regla 1, si
//      main lo mandaba al menu lo sigue mandando: el menu lo suaviza).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Normalizacion para la deteccion amplia: ademas de `normalizeArcoText`, jerga de chat ("q", "k", "kiero", "xq"). */
function normalizarParaDeteccion(texto: string): string {
  return normalizeArcoText(texto)
    .replace(/\b(?:q|k|ke|xq|porq)\b/g, "que")
    .replace(/\bk(?=[eiou])/g, "qu")
    .replace(/\s+/g, " ")
    .trim();
}
const OBJ_DATOS = "(?:datos|informacion|info|cuenta|perfil|historial|registros?|expediente)";
const OBJ_PERSONAL = "(?:datos|informacion|info|cuenta|perfil|historial|registros?|expediente|numero|telefono|celular|direccion|correo|nombre)";
const VERBO_SUPRIMIR = "(?:borr|elimin|suprim|olvid|destru)\\w*";
const PRONOMBRE = "(?:me|los|las|lo|nos)";
const RAICES_ARCO_AMPLIAS: readonly RegExp[] = [
  // suprimir + datos (en cualquier orden, a distancia) o con pronombre / "todo"
  new RegExp(`\\b${VERBO_SUPRIMIR}\\b.{0,80}\\b${OBJ_PERSONAL}\\b`),
  new RegExp(`\\b${OBJ_PERSONAL}\\b.{0,80}\\b${VERBO_SUPRIMIR}\\b`),
  new RegExp(`\\b(?:borr|elimin|suprim|olvid|destru)\\w*${PRONOMBRE}\\b`), // borralos, bórrenme, eliminenlos, olvidenlos
  new RegExp(`\\b${VERBO_SUPRIMIR}\\s+(?:${PRONOMBRE}|todo|todos|todas)\\b`), // borren todo, eliminen me
  new RegExp(`\\bque\\s+${PRONOMBRE}\\s+(?:borr|elimin|suprim|olvid)\\w*`), // que me borren, que los borren
  // cancelar solo cuenta junto a datos/cuenta o con pronombre pegado (no "cancelen mi pedido")
  new RegExp(`\\bcancel\\w*\\b.{0,80}\\b${OBJ_DATOS}\\b`),
  new RegExp(`\\b${OBJ_DATOS}\\b.{0,80}\\bcancel\\w*`),
  new RegExp(`\\bcancel(?:a|e|en|ar)${PRONOMBRE}\\b`), // cancelenlos, cancelame
  /\b(?:cancelacion|supresion|suprimir|de baja|darme de baja|dar de baja)\b/,
  // sacar / quitar de su sistema, lista, base
  /\b(?:saqu|quit|sac|borr|elimin)\w*\b.{0,40}\b(?:de|en) su (?:sistema|base|bases|lista|listas|registro|registros)\b/,
  /\b(?:aparecer|figurar|estar|seguir|quedar|tener)\w*\b.{0,30}\b(?:en|de) su (?:sistema|base|bases|lista|listas|registro|registros)\b/,
  /\bsu (?:sistema|base de datos|lista|registros?)\b.{0,30}\b(?:ya no|no)\b|\b(?:ya no|no)\b.{0,40}\bsu (?:sistema|base de datos|lista|registros?)\b/,
  // oposicion / consentimiento / no quiero que tengan, guarden, usen, compartan
  /\b(?:oponer\w*|opongo|oposicion|revoc\w*|no autorizo|no consiento|no doy mi consentimiento|retiro mi consentimiento|no acepto (?:el )?(?:uso|tratamiento))\b/,
  /\bno quiero que\b.{0,25}\b(?:tengan|guarden|conserven|almacenen|usen|utilicen|traten|compartan|vendan|ocupen|cedan|sigan)\b/,
  /\bno (?:los |lo |me )?(?:usen|compartan|traten|utilicen|vendan|ocupen|cedan|guarden|tengan)\b/,
  /\bdejen de (?:usar|tratar|utilizar|compartir|guardar|ocupar|vender|mandar\w*|enviar\w*|contactar\w*|llamar\w*)\b/,
  // acceso
  /\b(?:acceso|acceder)\b.{0,25}\b(?:datos|informacion|info)\b/,
  new RegExp(`\\b(?:ver|saber|conocer|consultar|obtener|copia|mandenme|denme|enviame|envienme|pasenme|muestrenme|entreguen\\w*|envien\\w*)\\b.{0,30}\\b${OBJ_DATOS}\\b`),
  /\bque\b.{0,20}\b(?:tienen|saben|guardan|manejan|almacenan|registran|hay)\b.{0,12}\b(?:de|sobre) (?:mi|mis|mi persona)\b/,
  /\bque (?:hacen|hicieron) con (?:mis )?(?:datos|info|informacion)\b/,
  /\b(?:datos|info|informacion)\b.{0,20}\b(?:que )?(?:tienen|guardan|manejan|almacenan)\b/,
  /\b(?:que|cuales) datos\b/,
  // rectificacion
  new RegExp(`\\b(?:rectific|corrij|corrig|actualiz|modific|cambi)\\w*\\b.{0,30}\\b(?:datos|informacion|info|nombre|correo|apellido|rfc)\\b`),
  /\b(?:rectificar|rectificacion|correccion)\b/,
  /\b(?:datos|informacion|info)\b.{0,25}\b(?:estan mal|incorrect\w*|erroneo\w*|equivocad\w*)\b/,
  // privacidad explicita
  /\b(?:datos personales|aviso de privacidad|privacidad|arco|derechos arco|proteccion de datos)\b/,
];

/** Hay una raiz amplia de derechos de privacidad en el mensaje (mas sensible que `detectArcoIntentBase`). */
export function detectarRaizArcoAmplia(message: string): boolean {
  const normalized = normalizarParaDeteccion(message);
  return normalized !== "" && RAICES_ARCO_AMPLIAS.some((re) => re.test(normalized));
}

/**
 * Detecta una solicitud ARCO en un mensaje libre. RECALL PRIMERO (ver arriba): nunca deja pasar al modelo un mensaje con una raiz de derechos; los casos dudosos
 * (los que solo detecta la raiz amplia, o que mezclan ARCO con pedido/factura sin nombrar privacidad) van al MENU, que no bloquea el pedido en curso.
 * Contrato publico sin cambios: `request` | `menu` | `third_party` | null.
 */
export function detectArcoIntent(message: string): ArcoIntent | null {
  const normalized = normalizarParaDeteccion(message);
  if (!normalized) return null;
  const base = detectArcoIntentBase(message);
  const amplia = base === null && RAICES_ARCO_AMPLIAS.some((re) => re.test(normalized));
  if (base === null && !amplia) return null;
  if (THIRD_PARTY_RE.test(normalized) && (base?.kind === "third_party" || amplia)) return { kind: "third_party" };
  if (base !== null && base.kind === "request") {
    // Mezcla con pedido/factura sin nombrar privacidad ("borren mis datos de mi pedido"): al menu, que deja continuar el pedido. Con privacidad explicita, la solicitud.
    const explicita = PERSONAL_DATA_EXPLICIT_RE.test(normalized);
    return !explicita && FACTURA_O_PEDIDO_RE.test(normalized) ? { kind: "menu" } : base;
  }
  return base ?? { kind: "menu" };
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
 * vigente de ESTE teléfono; (2) intención de ARCO nueva.
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
