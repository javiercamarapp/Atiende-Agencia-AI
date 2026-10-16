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
  ARCO_MENU_APENDICE,
  ARCO_MENU_REPLY,
  ARCO_THIRD_PARTY_REPLY,
  arcoAlreadyOpenReply,
  arcoConfirmedReply,
  arcoConjeturaReply,
  arcoPendingConfirmationReply,
  arcoWithdrawnReply,
  type DataRightType,
  type DataRightsChannel,
} from "./data-rights.ts";
import { detectArcoIntent, detectarEleccionDeMenu, normalizeArcoText, type ArcoIntent, type EstadoMenuArco } from "./arco-deteccion.ts";
import { debeClasificarArco, decidirConClasificador, type ClasificadorArco, type ResultadoClasificadorArco } from "./clasificador-arco.ts";

// La deteccion (pura) vive en arco-deteccion.ts; aqui queda el tramite: confirmacion, registro y respuesta. Se re-exporta para no romper a los llamadores.
export { detectArcoIntent, detectarEleccionDeMenu, esOposicionDeContacto, estadoDeMenuArco, hayAlgunaSenalArco, normalizeArcoText, normalizarParaArco, raicesQueCoinciden, RAICES_ARCO } from "./arco-deteccion.ts";
export type { ArcoIntent, EleccionDeMenu, EstadoMenuArco, FuerzaArco, RaizArco } from "./arco-deteccion.ts";

/**
 * UN solo formato de telefono para registrar y buscar solicitudes ARCO: «+52» + 10 digitos nacionales. WhatsApp entrega el wa_id como «521…», la voz como 10 digitos o «+52…»:
 * sin esto una solicitud registrada por voz no se encontraba al responder CONFIRMO por WhatsApp (y vencia a las 24 h sin que nadie lo notara). Numeros que no son mexicanos
 * se dejan como «+digitos».
 */
export function telefonoCanonicoArco(telefono: string): string {
  const digitos = (typeof telefono === "string" ? telefono : "").replace(/\D/g, "");
  if (digitos.length === 10) return `+52${digitos}`;
  if (digitos.length === 12 && digitos.startsWith("52")) return `+${digitos}`;
  if (digitos.length === 13 && digitos.startsWith("521")) return `+52${digitos.slice(3)}`;
  return digitos ? `+${digitos}` : telefono;
}

const DEFAULT_TIMEZONE = "America/Mexico_City";

const CONFIRM_RE = /^(confirmo|confirmo mi solicitud|si confirmo)$/;
const WITHDRAW_RE = /^(cancelar solicitud|cancela mi solicitud|cancelar mi solicitud|retirar solicitud|retiro mi solicitud|no confirmo)$/;

export type ArcoConfirmationIntent = "confirm" | "withdraw";

/** Respuesta a la pregunta de confirmación — SOLO frases explícitas y exactas. */
export function detectArcoConfirmation(message: string): ArcoConfirmationIntent | null {
  if (typeof message !== "string") return null;
  const normalized = normalizeArcoText(message);
  if (CONFIRM_RE.test(normalized)) return "confirm";
  if (WITHDRAW_RE.test(normalized)) return "withdraw";
  return null;
}

/** `reemplaza`: la respuesta sustituye el turno del agente (solicitud registrada o menu explicito). `agrega`: el agente SIGUE atendiendo el mensaje y esta oferta se agrega al final. */
export type ArcoModo = "reemplaza" | "agrega";

export interface ArcoFastPathResult {
  readonly reply: string;
  readonly modo: ArcoModo;
  /** Quedo una solicitud registrada (o ya abierta): corre el plazo aunque ademas se escale a una persona. */
  readonly registrada: boolean;
  /** Hay que ceder la conversacion a una persona (no se pudo identificar el derecho, o se eligieron varios): motivo `privacidad_arco`. */
  readonly escalar: boolean;
}

/** Mensajes consecutivos de la rafaga que se juntan SOLO para el clasificador («no me manden | mas mensajes»); el registro guarda el texto del propio cliente. */
const VENTANA_RAFAGA_CLASIFICADOR = 3;

/**
 * Intenciones por mensaje: capa regex (fuerte, alta precision) y, donde la regex no vio nada fuerte, el clasificador LLM como red de seguridad.
 * - peticion regex fuerte -> se respeta (sin llamar al modelo), salvo las raices `arbitrable` (precision media): el modelo puede descartarlas con «ninguna» muy segura.
 * - senal regex debil -> el modelo puede subirla a peticion o descartarla.
 * - nada -> el modelo puede detectar una peticion o una senal debil. Los mensajes claramente solo-pedido no llegan al modelo (`debeClasificarArco`).
 * El clasificador que falla o excede su timeout devuelve `null`: se queda con la capa regex y el pedido NUNCA se bloquea.
 */
export async function intencionesPorMensaje(
  mensajes: readonly string[],
  clasificador: ClasificadorArco | undefined,
  organizationId: string,
): Promise<{ texto: string; intent: ArcoIntent }[]> {
  // Defensa en profundidad: el contrato del clasificador es no lanzar, pero un doble o un adaptador defectuoso NUNCA debe tumbar el turno del cliente.
  const clasificar = async (texto: string): Promise<ResultadoClasificadorArco | null> => {
    try {
      return (await clasificador?.clasificar({ texto, organizationId })) ?? null;
    } catch {
      return null;
    }
  };
  const base: { texto: string; intent: ArcoIntent | null }[] = mensajes.map((texto) => ({ texto, intent: detectArcoIntent(texto) }));
  if (clasificador) {
    const esCandidato = (i: ArcoIntent | null): boolean => i === null || (i.kind === "menu" && i.fuerza === "debil") || (i.kind === "request" && i.arbitrable === true);
    const candidatos = base.filter((x) => esCandidato(x.intent) && debeClasificarArco(x.texto));
    const decisiones = await Promise.all(candidatos.map(async (c) => ({ c, d: decidirConClasificador(await clasificar(c.texto)) })));
    let hayPeticion = base.some((x) => x.intent?.kind === "request" && x.intent.arbitrable !== true);
    for (const { c, d } of decisiones) {
      if (d.tipo === "peticion") {
        c.intent = { kind: "request", right: d.right, contacto: d.contacto };
        hayPeticion = true;
      } else if (d.tipo === "debil" && c.intent === null) {
        c.intent = { kind: "menu", fuerza: "debil", derechoProbable: d.derechoProbable };
      } else if (d.tipo === "ninguna_segura" && c.intent !== null && c.intent.kind !== "third_party") {
        c.intent = null;
      }
    }
    // Rafaga partida («borren | mis datos»): ningun mensaje solo fue una peticion; el clasificador lee los ultimos mensajes JUNTOS (nunca para registrar texto ajeno).
    if (!hayPeticion && mensajes.length >= 2) {
      const unido = mensajes.slice(-VENTANA_RAFAGA_CLASIFICADOR).join(" | ");
      if (debeClasificarArco(unido)) {
        const d = decidirConClasificador(await clasificar(unido));
        if (d.tipo === "peticion") base.push({ texto: unido, intent: { kind: "request", right: d.right, contacto: d.contacto } });
        else if (d.tipo === "debil" && !base.some((x) => x.intent !== null)) base.push({ texto: unido, intent: { kind: "menu", fuerza: "debil", derechoProbable: d.derechoProbable } });
      }
    }
  }
  return base.filter((x): x is { texto: string; intent: ArcoIntent } => x.intent !== null);
}

export interface OpcionesArco {
  readonly channel?: DataRightsChannel;
  readonly timezone?: string;
  /** El ultimo mensaje del asistente fue un menu ARCO sin contestar (`estadoDeMenuArco`). La respuesta del cliente se lee como eleccion; nunca se vuelve a pedir elegir. */
  readonly menu?: EstadoMenuArco | null;
  /** Red de seguridad LLM (ver clasificador-arco.ts). Ausente = solo la capa regex. */
  readonly clasificador?: ClasificadorArco;
}

const PRIORIDAD: readonly DataRightType[] = ["cancelacion", "oposicion", "rectificacion", "acceso"];

function textosDe(message: string | readonly string[]): string[] {
  const lista = typeof message === "string" ? [message] : Array.isArray(message) ? message : [];
  return lista.filter((m): m is string => typeof m === "string" && m.trim() !== "");
}

/**
 * Registra la solicitud (pendiente de CONFIRMO) y arma la respuesta. Lo usan el atajo determinista, la eleccion del menu, el clasificador y la herramienta
 * `registrar_solicitud_arco` del agente: TODOS registran igual (misma confirmacion, mismos plazos, telefono canonico). `null` = base sin la migracion 030.
 */
export async function registrarSolicitudArco(
  repo: PrivacidadRepository,
  e: { readonly organizationId: string; readonly customerPhone: string; readonly right: DataRightType; readonly textos: readonly string[]; readonly conjetura?: boolean; readonly escalar?: boolean; readonly channel?: DataRightsChannel; readonly timezone?: string },
): Promise<ArcoFastPathResult | null> {
  const timezone = e.timezone ?? DEFAULT_TIMEZONE;
  const customerPhone = telefonoCanonicoArco(e.customerPhone);
  const outcome = await repo.registerDataRightsRequestAsSystem({
    organizationId: e.organizationId,
    customerPhone,
    rightType: e.right,
    channel: e.channel ?? "whatsapp",
    detail: redactarTranscripcion(e.textos.join(" / ")).slice(0, 300),
  });
  // Base sin migrar: sin dónde registrar, se cae al camino anterior (LLM) en vez de prometer un seguimiento que no existiría.
  if (!outcome.available) return null;
  const reply = outcome.alreadyOpen
    ? arcoAlreadyOpenReply(e.right, outcome.id, outcome.status, outcome.responseDueAt, timezone)
    : e.conjetura
      ? arcoConjeturaReply(e.right, outcome.id)
      : arcoPendingConfirmationReply(e.right, outcome.id);
  return { reply, modo: "reemplaza", registrada: true, escalar: e.escalar === true };
}

/**
 * Procesa los mensajes pendientes del cliente (UNO por elemento: la deteccion corre POR MENSAJE, nunca sobre una rafaga unida). Devuelve la respuesta, o `null`
 * cuando no es de ARCO (o la migración 030 no está aplicada en esta base: cae al camino anterior, el agente LLM) — nunca lanza por una base sin migrar.
 *
 * Orden: (1) frase de confirmación/retiro, solo si hay una solicitud pendiente vigente de ESTE teléfono; (2) respuesta a un menu pendiente (eleccion);
 * (3) intención de ARCO nueva. Una senal debil no registra ni descarta nada: devuelve el menu en modo `agrega`.
 */
export async function runArcoFastPath(
  repo: PrivacidadRepository,
  organizationId: string,
  customerPhone: string,
  message: string | readonly string[],
  channel: DataRightsChannel = "whatsapp",
  timezone: string = DEFAULT_TIMEZONE,
  opciones: Pick<OpcionesArco, "menu" | "clasificador"> = {},
): Promise<ArcoFastPathResult | null> {
  const mensajes = textosDe(message);
  if (mensajes.length === 0) return null;
  customerPhone = telefonoCanonicoArco(customerPhone);

  for (const texto of mensajes) {
    const confirmation = detectArcoConfirmation(texto);
    if (!confirmation) continue;
    const outcome = await repo.resolveDataRightsConfirmationAsSystem(organizationId, customerPhone, confirmation === "confirm");
    // Sin solicitud pendiente (o base sin migrar): "CONFIRMO" puede ser parte de otra conversación (p. ej. un pedido) -- se deja pasar al agente.
    if (!outcome.available || !outcome.found) continue;
    const reply =
      confirmation === "confirm"
        ? arcoConfirmedReply(outcome.rightType, outcome.id, outcome.responseDueAt, outcome.executionDueAt, timezone)
        : arcoWithdrawnReply(outcome.rightType, outcome.id);
    return { reply, modo: "reemplaza", registrada: true, escalar: false };
  }

  const registrar = (right: DataRightType, textos: readonly string[], conjetura: boolean, escalar: boolean): Promise<ArcoFastPathResult | null> =>
    registrarSolicitudArco(repo, { organizationId, customerPhone, right, textos, conjetura, escalar, channel, timezone });

  const menu = opciones.menu ?? null;

  // (2) Respuesta a un menu pendiente: se evalua el PRIMER mensaje pendiente (el que contesta al menu).
  if (menu !== null) {
    const eleccion = detectarEleccionDeMenu(mensajes[0]!, menu);
    if (eleccion?.tipo === "derechos") {
      // Varios derechos a la vez: se registra el mas amplio y se avisa a una persona para que atienda el resto (el detalle lleva el texto completo).
      return registrar(eleccion.derechos[0]!, [mensajes[0]!], false, eleccion.derechos.length > 1);
    }
    if (eleccion?.tipo === "ambigua") return registrar("acceso", [mensajes[0]!], true, true);
  }

  // (3) Intencion nueva, mensaje por mensaje.
  const intents = await intencionesPorMensaje(mensajes, opciones.clasificador, organizationId);
  if (intents.length === 0) return null;

  const peticiones = intents.filter((x) => x.intent.kind === "request");
  if (peticiones.length > 0) {
    const derechos = new Set(peticiones.map((x) => (x.intent as Extract<ArcoIntent, { kind: "request" }>).right));
    const right = PRIORIDAD.find((r) => derechos.has(r))!;
    return registrar(right, peticiones.map((x) => x.texto), false, false);
  }
  if (intents.some((x) => x.intent.kind === "third_party")) return { reply: ARCO_THIRD_PARTY_REPLY, modo: "reemplaza", registrada: false, escalar: false };

  const menus = intents.map((x) => x.intent as Extract<ArcoIntent, { kind: "menu" }>);
  const probable = menus.find((m) => m.derechoProbable !== null)?.derechoProbable ?? "acceso";
  // Ya se ofrecio el menu numerado y el cliente sigue hablando de ARCO sin elegir: NO se repite el menu (bucle). Se registra la mejor conjetura y se escala.
  if (menu === "numerado") return registrar(probable, intents.map((x) => x.texto), true, true);
  if (menus.some((m) => m.fuerza === "fuerte")) return { reply: ARCO_MENU_REPLY, modo: "reemplaza", registrada: false, escalar: false };
  // Senal debil: si ya se ofrecio la oferta, no se repite; si no, el agente sigue con el pedido y se agrega la oferta.
  if (menu !== null) return null;
  return { reply: ARCO_MENU_APENDICE, modo: "agrega", registrada: false, escalar: false };
}
