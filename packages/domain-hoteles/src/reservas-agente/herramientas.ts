// H-25 -- herramientas del agente de reservas (catalogo UNICO para WhatsApp y voz) y su ejecutor. "Un solo nucleo, varios
// canales": cada llamada se despacha EN PROCESO contra el mismo `ReservasAgenteRepository` (la base es la autoridad).
//
// Garantias estructurales (no dependen de que el modelo "se porte bien"):
//  * NINGUNA herramienta recibe un precio, descuento o total propuesto: el precio lo calcula la base desde rate_plan/tax_config y
//    se valida contra el piso/techo de pricing_rule. `crear_pre_reserva` recibe solo el total que el huesped VIO, y la base lo
//    contrasta con su propio calculo (si cambio, `precio_cambio`).
//  * El agente NUNCA confirma una reserva: solo crea un hold (pre-reserva) que un humano aprueba o cuyo pago registra el hotel.
//  * Cantidades/fechas absurdas se rechazan antes de tocar la base y otra vez DENTRO de la base (politica por hotel).
//  * No se piden ni guardan datos de identificacion/pago por chat: la identidad es solo de check-in.
//  * Todo lo que el huesped escribe es DATO, no instruccion: lo que vuelve al modelo son campos tipados o etiquetas saneadas.
import { createHash } from "node:crypto";
import type { LlmToolDefinition } from "@atiende/agent-core";
import { registerContactoNoOperativo } from "../contacto-no-operativo.ts";
import type { HotelesRepository } from "../repository.ts";
import type { ReservasAgenteRepository } from "./repository.ts";
import { ReservasAgenteError } from "./tipos.ts";
import type { HoldRecord, StayOption } from "./tipos.ts";
import {
  cleanText,
  extractMoneyCents,
  isUuid,
  normalizeContactPhone,
  parseBoundedInt,
  parseGuestName,
  redactSensitive,
  sanitizeLabel,
  validateStayDates,
} from "./validacion.ts";

export const RESERVAS_TOOL_NAMES = [
  "consultar_disponibilidad",
  "cotizar_estancia",
  "crear_pre_reserva",
  "estado_pre_reserva",
  "cancelar_pre_reserva",
  "derivar_a_humano",
] as const;
export type ReservasToolName = (typeof RESERVAS_TOOL_NAMES)[number];

export function isReservasToolName(name: string): name is ReservasToolName {
  return (RESERVAS_TOOL_NAMES as readonly string[]).includes(name);
}

const DATE_PROP = { type: "string", description: "Fecha AAAA-MM-DD. Si el huesped dijo una fecha relativa, usa la fecha de hoy del sistema para calcularla." } as const;

export const RESERVAS_TOOLS: readonly LlmToolDefinition[] = [
  {
    name: "consultar_disponibilidad",
    description:
      "Consulta habitaciones libres y precio total por tipo de cuarto para unas fechas. Los montos son SIEMPRE los que devuelve esta herramienta, en pesos mexicanos; " +
      "nunca calcules, redondees ni inventes un precio, ni ofrezcas descuentos.",
    parameters: {
      type: "object",
      properties: {
        fecha_llegada: DATE_PROP,
        fecha_salida: { ...DATE_PROP, description: "Fecha de salida AAAA-MM-DD (la noche de esta fecha NO se cobra)." },
        huespedes: { type: "integer", description: "Numero de huespedes (1 a 20), si el huesped lo dijo." },
      },
      required: ["fecha_llegada", "fecha_salida"],
    },
  },
  {
    name: "cotizar_estancia",
    description:
      "Cotiza UN tipo de cuarto para unas fechas (desglose por noche e impuestos). Usa el tipo_habitacion_id devuelto por consultar_disponibilidad. " +
      "No acepta precios ni descuentos: el precio lo calcula el hotel.",
    parameters: {
      type: "object",
      properties: {
        tipo_habitacion_id: { type: "string", description: "Id del tipo de cuarto devuelto por consultar_disponibilidad." },
        fecha_llegada: DATE_PROP,
        fecha_salida: DATE_PROP,
        huespedes: { type: "integer", description: "Numero de huespedes (1 a 20)." },
      },
      required: ["tipo_habitacion_id", "fecha_llegada", "fecha_salida"],
    },
  },
  {
    name: "crear_pre_reserva",
    description:
      "Aparta UNA habitacion unas horas (pre-reserva). NO es una reserva confirmada: depende de la aprobacion de una persona del hotel o del pago, segun la politica del hotel. " +
      "Usala solo despues de cotizar y de que el huesped acepte el total exacto cotizado. No pidas ni envies documentos ni datos de tarjeta.",
    parameters: {
      type: "object",
      properties: {
        tipo_habitacion_id: { type: "string", description: "Id del tipo de cuarto cotizado." },
        fecha_llegada: DATE_PROP,
        fecha_salida: DATE_PROP,
        huespedes: { type: "integer", description: "Numero de huespedes (1 a 20)." },
        nombre_huesped: { type: "string", description: "Nombre con el que el huesped quiere la pre-reserva (opcional, solo nombre)." },
        total_cotizado_centavos: { type: "integer", description: "El total_centavos EXACTO que cotizo la herramienta y que el huesped acepto." },
      },
      required: ["tipo_habitacion_id", "fecha_llegada", "fecha_salida", "huespedes", "total_cotizado_centavos"],
    },
  },
  {
    name: "estado_pre_reserva",
    description: "Consulta el estado de una pre-reserva del propio huesped con su pre_reserva_id.",
    parameters: { type: "object", properties: { pre_reserva_id: { type: "string", description: "Id devuelto por crear_pre_reserva." } }, required: ["pre_reserva_id"] },
  },
  {
    name: "cancelar_pre_reserva",
    description: "Cancela una pre-reserva ABIERTA del propio huesped y libera la habitacion. Una reserva ya confirmada la cancela una persona del hotel (usa derivar_a_humano).",
    parameters: { type: "object", properties: { pre_reserva_id: { type: "string", description: "Id devuelto por crear_pre_reserva." } }, required: ["pre_reserva_id"] },
  },
  {
    name: "derivar_a_humano",
    description:
      "Pasa la conversacion a una persona del hotel. Usala para cualquier cosa fuera del catalogo del agente: descuentos o negociacion de precio, grupos o mas de una habitacion, " +
      "cambios o cancelaciones de reservas confirmadas, politicas especiales, facturas, quejas, o cuando una herramienta lo pida.",
    parameters: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Motivo breve (p.ej. 'pide descuento', 'grupo de 12 personas')." },
        resumen: { type: "string", description: "Resumen de lo que pidio el huesped, sin datos de tarjeta ni documentos." },
      },
      required: ["motivo"],
    },
  },
];

export interface ReservasToolContext {
  readonly reservas: ReservasAgenteRepository;
  /** Para el handoff (registrar_contacto_no_operativo). */
  readonly hotelesRepo: HotelesRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  /** Telefono del canal (WhatsApp: el remitente; voz: el numero de la llamada; vacio si la llamada no lo entrego: solo consultas). */
  readonly contactPhone: string;
  readonly channel: "whatsapp" | "voz";
  /** Identificador del turno/llamada: la misma peticion repetida dentro del turno es idempotente. */
  readonly turnId: string;
  readonly now?: Date;
}

export interface ReservasToolOutcome {
  readonly result: Record<string, unknown>;
  /** Importes (centavos) que ESTA herramienta autoriza a mencionar en la respuesta. */
  readonly moneyCents: readonly number[];
  readonly holdCreated: HoldRecord | null;
  readonly handoff: boolean;
}

export function formatMxn(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")} MXN`;
}

function optionView(o: StayOption, guests: number | null) {
  const capacidadOk = guests === null || guests <= o.maxOccupancy;
  const base = { tipo_habitacion_id: o.roomTypeId, tipo: sanitizeLabel(o.roomTypeName), capacidad_maxima: o.maxOccupancy, disponibles: o.freeRooms };
  if (o.status !== "ok") {
    return { ...base, estado: o.status, motivo: STATUS_MESSAGES[o.status], requiere_humano: o.status === "precio_fuera_de_guardia" || o.status === "sin_tarifa" || o.status === "moneda_no_soportada" };
  }
  if (!capacidadOk) return { ...base, estado: "capacidad_insuficiente", motivo: `Este tipo admite hasta ${o.maxOccupancy} huespedes.`, requiere_humano: false };
  return {
    ...base,
    estado: "ok",
    moneda: "MXN",
    total_centavos: o.totalCents,
    total: formatMxn(o.totalCents!),
    subtotal_centavos: o.netCents,
    iva_centavos: o.ivaCents,
    impuesto_hospedaje_centavos: o.ishCents,
    noches: (o.nightly ?? []).map((n) => ({ fecha: n.date, centavos: n.cents, precio: formatMxn(n.cents) })),
  };
}

const STATUS_MESSAGES: Record<string, string> = {
  sin_inventario: "No hay habitaciones libres de este tipo para esas fechas.",
  sin_tarifa: "El hotel aun no publica tarifa para alguna de esas noches; una persona debe cotizar.",
  cerrado_a_llegada: "El hotel no recibe llegadas esa fecha.",
  cerrado_a_salida: "El hotel no permite salidas esa fecha.",
  estadia_minima_no_alcanzada: "Esas fechas exigen una estadia minima mayor.",
  precio_fuera_de_guardia: "Esa tarifa requiere que una persona del hotel la confirme.",
  moneda_no_soportada: "Esa tarifa no esta en pesos; una persona del hotel debe cotizar.",
};

function moneyOf(o: StayOption): number[] {
  if (o.status !== "ok") return [];
  return [o.totalCents!, o.netCents!, o.ivaCents!, o.ishCents!, ...(o.nightly ?? []).map((n) => n.cents)];
}

const ERROR_MESSAGES: Partial<Record<string, { mensaje: string; derivar: boolean }>> = {
  fechas_invalidas: { mensaje: "Las fechas no son validas: pide al huesped fechas de llegada y salida reales (la salida despues de la llegada).", derivar: false },
  fecha_pasada: { mensaje: "Esa fecha de llegada ya paso. Pide una fecha de hoy en adelante.", derivar: false },
  fecha_muy_lejana: { mensaje: "Esa fecha esta mas lejos de lo que el agente reserva. Ofrece que una persona del hotel lo atienda.", derivar: true },
  estadia_muy_larga: { mensaje: "Esa estadia es mas larga de lo que el agente reserva. Una persona del hotel la cotiza.", derivar: true },
  huespedes_invalidos: { mensaje: "El numero de huespedes no cabe en ese tipo de cuarto o excede el maximo. Ofrece otro tipo o una persona del hotel.", derivar: false },
  holds_deshabilitados: { mensaje: "El hotel no aparta habitaciones por este canal. Una persona del hotel continuara la reserva.", derivar: true },
  limite_holds_activos: { mensaje: "En este momento no se pueden apartar mas habitaciones por este canal. Una persona del hotel continuara.", derivar: true },
  limite_holds_contacto: { mensaje: "Ya hay pre-reservas abiertas para este contacto. Ofrece cancelar una o que una persona del hotel ayude.", derivar: true },
  cotizacion_no_disponible: { mensaje: "Esa combinacion no se puede cotizar automaticamente. Una persona del hotel la cotiza.", derivar: true },
  tipo_habitacion_invalido: { mensaje: "Ese tipo de cuarto no existe. Vuelve a consultar disponibilidad.", derivar: false },
  parametros_invalidos: { mensaje: "Algun dato no es valido. Pide al huesped que lo corrija, sin pedir documentos ni datos de tarjeta.", derivar: false },
  idempotencia_conflicto: { mensaje: "La solicitud no coincide con una anterior. Vuelve a cotizar.", derivar: false },
  no_encontrada: { mensaje: "No se encontro esa pre-reserva para este numero.", derivar: false },
  estado_no_valido: { mensaje: "La pre-reserva ya no esta abierta (puede estar confirmada, vencida o cancelada). Una persona del hotel puede ayudar.", derivar: true },
  sin_permiso: { mensaje: "No se pudo completar. Una persona del hotel continuara.", derivar: true },
  no_disponible_aun: { mensaje: "El sistema de reservas no esta disponible por ahora. Una persona del hotel continuara.", derivar: true },
  sin_disponibilidad: { mensaje: "Ya no hay habitaciones libres de ese tipo para esas fechas. Vuelve a consultar disponibilidad.", derivar: false },
};

/** Id estable por (turno, peticion): reintentar la misma llamada en el mismo turno no duplica la pre-reserva. */
export function holdIdempotencyKey(ctx: Pick<ReservasToolContext, "propertyId" | "contactPhone" | "turnId" | "channel">, roomTypeId: string, checkIn: string, checkOut: string, guests: number): string {
  const digest = createHash("sha256").update([ctx.propertyId, ctx.contactPhone, ctx.turnId, roomTypeId, checkIn, checkOut, String(guests)].join("|")).digest("hex");
  return `${ctx.channel === "voz" ? "voz" : "wa"}-${digest.slice(0, 40)}`;
}

function errorOutcome(err: ReservasAgenteError): ReservasToolOutcome {
  const meta = ERROR_MESSAGES[err.code] ?? { mensaje: "No se pudo completar la operacion.", derivar: true };
  const result: Record<string, unknown> = { error: err.code, mensaje: meta.mensaje, requiere_humano: meta.derivar };
  if (err.code === "precio_cambio" && typeof err.detail?.totalCents === "number") {
    result.total_vigente_centavos = err.detail.totalCents;
    result.total_vigente = formatMxn(err.detail.totalCents);
    result.mensaje = "El precio cambio desde la cotizacion. Informa el nuevo total al huesped y pide su aceptacion antes de volver a apartar.";
    return { result, moneyCents: [err.detail.totalCents], holdCreated: null, handoff: false };
  }
  return { result, moneyCents: [], holdCreated: null, handoff: meta.derivar };
}

function holdView(h: HoldRecord) {
  const base = {
    pre_reserva_id: h.id,
    estado: h.status,
    modo: h.mode,
    tipo_habitacion_id: h.roomTypeId,
    fecha_llegada: h.checkInDate,
    fecha_salida: h.checkOutDate,
    noches: h.nights,
    huespedes: h.guests,
    moneda: "MXN",
    total_centavos: h.totalCents,
    total: formatMxn(h.totalCents),
    vence: h.expiresAt,
    confirmada: h.status === "confirmado",
  };
  return base;
}

const NEXT_STEP: Record<string, string> = {
  pendiente_aprobacion: "Esto NO es una reserva confirmada. Una persona del hotel debe aprobarla; el hotel le avisara. La habitacion queda apartada hasta el vencimiento.",
  pendiente_pago: "Esto NO es una reserva confirmada. El hotel le enviara un link de pago; la habitacion queda apartada hasta el vencimiento. No pidas datos de tarjeta por chat.",
  aprobado: "El hotel ya aprobo la pre-reserva; falta que el hotel la confirme. No esta confirmada todavia.",
  confirmado: "El hotel confirmo la reserva.",
  rechazado: "El hotel no pudo aprobar la pre-reserva. La habitacion se libero.",
  expirado: "La pre-reserva vencio y la habitacion se libero.",
  cancelado: "La pre-reserva fue cancelada y la habitacion se libero.",
};

async function handoff(ctx: ReservasToolContext, reason: string, summary: string | null): Promise<void> {
  await registerContactoNoOperativo(ctx.hotelesRepo, {
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    guestPhone: ctx.contactPhone || null,
    guestName: null,
    reason: `reservas: ${reason}`.slice(0, 500),
    message: summary,
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
}

function optString(input: Record<string, unknown>, key: string): unknown {
  return input[key];
}

/** Ejecuta una herramienta de reservas. NUNCA lanza por reglas de negocio: devuelve `{error,...}` para que el modelo se lo explique al huesped. */
export async function executeReservasTool(ctx: ReservasToolContext, name: ReservasToolName, input: Record<string, unknown>): Promise<ReservasToolOutcome> {
  try {
    switch (name) {
      case "consultar_disponibilidad": {
        const stay = validateStayDates(optString(input, "fecha_llegada"), optString(input, "fecha_salida"));
        const guests = input.huespedes === undefined || input.huespedes === null ? null : parseBoundedInt(input.huespedes, 1, 20, "huespedes");
        const res = await ctx.reservas.stayOptions(ctx.propertyId, stay.checkInDate, stay.checkOutDate, ctx.now);
        if (!res.disponible) return errorOutcome(new ReservasAgenteError("no_disponible_aun", "no disponible"));
        return {
          result: { fecha_llegada: stay.checkInDate, fecha_salida: stay.checkOutDate, noches: stay.nights, moneda: "MXN", opciones: res.opciones.map((o) => optionView(o, guests)) },
          moneyCents: res.opciones.flatMap(moneyOf),
          holdCreated: null,
          handoff: false,
        };
      }
      case "cotizar_estancia": {
        const roomTypeId = optString(input, "tipo_habitacion_id");
        if (!isUuid(roomTypeId)) throw new ReservasAgenteError("tipo_habitacion_invalido", "tipo invalido");
        const stay = validateStayDates(optString(input, "fecha_llegada"), optString(input, "fecha_salida"));
        const guests = input.huespedes === undefined || input.huespedes === null ? null : parseBoundedInt(input.huespedes, 1, 20, "huespedes");
        const res = await ctx.reservas.stayOptions(ctx.propertyId, stay.checkInDate, stay.checkOutDate, ctx.now);
        if (!res.disponible) return errorOutcome(new ReservasAgenteError("no_disponible_aun", "no disponible"));
        const option = res.opciones.find((o) => o.roomTypeId === roomTypeId);
        if (!option) throw new ReservasAgenteError("tipo_habitacion_invalido", "tipo invalido");
        return {
          result: { fecha_llegada: stay.checkInDate, fecha_salida: stay.checkOutDate, noches: stay.nights, cotizacion: optionView(option, guests) },
          moneyCents: moneyOf(option),
          holdCreated: null,
          handoff: false,
        };
      }
      case "crear_pre_reserva": {
        const roomTypeId = optString(input, "tipo_habitacion_id");
        if (!isUuid(roomTypeId)) throw new ReservasAgenteError("tipo_habitacion_invalido", "tipo invalido");
        const stay = validateStayDates(optString(input, "fecha_llegada"), optString(input, "fecha_salida"));
        const guests = parseBoundedInt(input.huespedes, 1, 20, "huespedes");
        const expected = parseBoundedInt(input.total_cotizado_centavos, 1, 100_000_000_000, "total_cotizado_centavos");
        const guestName = parseGuestName(input.nombre_huesped);
        const contactPhone = normalizeContactPhone(ctx.contactPhone);
        const hold = await ctx.reservas.createHold({
          propertyId: ctx.propertyId,
          roomTypeId,
          checkInDate: stay.checkInDate,
          checkOutDate: stay.checkOutDate,
          guests,
          guestName,
          contactPhone,
          channel: ctx.channel,
          idempotencyKey: holdIdempotencyKey({ ...ctx, contactPhone }, roomTypeId, stay.checkInDate, stay.checkOutDate, guests),
          expectedTotalCents: expected,
          now: ctx.now,
        });
        return {
          result: { ...holdView(hold), siguiente_paso: NEXT_STEP[hold.status] ?? NEXT_STEP.pendiente_aprobacion },
          moneyCents: [hold.totalCents, hold.netCents, hold.ivaCents, hold.ishCents],
          holdCreated: hold,
          handoff: false,
        };
      }
      case "estado_pre_reserva":
      case "cancelar_pre_reserva": {
        const holdId = optString(input, "pre_reserva_id");
        if (!isUuid(holdId)) throw new ReservasAgenteError("no_encontrada", "id invalido");
        const contactPhone = normalizeContactPhone(ctx.contactPhone);
        const hold = name === "estado_pre_reserva"
          ? await ctx.reservas.holdStatusForContact(ctx.propertyId, holdId, contactPhone, ctx.now)
          : await ctx.reservas.cancelHoldForContact(ctx.propertyId, holdId, contactPhone, ctx.now);
        return { result: { ...holdView(hold), siguiente_paso: NEXT_STEP[hold.status] ?? "" }, moneyCents: [hold.totalCents], holdCreated: null, handoff: false };
      }
      case "derivar_a_humano": {
        const motivo = cleanText(input.motivo, 200);
        if (!motivo) throw new ReservasAgenteError("parametros_invalidos", "motivo requerido");
        const resumenRaw = cleanText(input.resumen, 1000);
        const resumen = resumenRaw ? redactSensitive(resumenRaw) : null;
        await handoff(ctx, redactSensitive(motivo), resumen);
        return { result: { ok: true, mensaje: "Se registro para que una persona del hotel continue. Avisa al huesped que alguien le dara seguimiento." }, moneyCents: [], holdCreated: null, handoff: true };
      }
    }
  } catch (err) {
    if (err instanceof ReservasAgenteError) {
      const outcome = errorOutcome(err);
      if (outcome.handoff) {
        try {
          await handoff(ctx, `herramienta ${name}: ${err.code}`, null);
        } catch {
          // El registro del handoff es de mejor esfuerzo: si falla, el modelo igual recibe `requiere_humano:true`.
        }
        return { ...outcome, result: { ...outcome.result, derivado: true } };
      }
      return outcome;
    }
    throw err;
  }
  throw new ReservasAgenteError("parametros_invalidos", "herramienta desconocida");
}

// ─────────────────────────────────────────────────────────────────────────
// Guardias sobre el TEXTO FINAL del modelo (ultima linea de defensa: los datos ya los fija la base, pero el modelo podria
// narrar algo que no es cierto). Si se viola una, la respuesta se sustituye por un mensaje seguro y se deriva a una persona.
// ─────────────────────────────────────────────────────────────────────────

export type ReplyViolation = "precio_no_respaldado" | "confirmacion_no_autorizada" | "descuento_no_autorizado" | "dato_sensible_solicitado";

export const SAFE_REPLY =
  "Para darte el precio exacto y confirmar tu reserva necesito que una persona del hotel te atienda; ya le avise y te va a contactar en breve.";

const NEGATION_BEFORE = /(\bno\b|\bnunca\b|\bsin\b|\ba[uú]n no\b|\btodav[ií]a no\b|\bpuedo\b[^.]{0,12}\bno\b)[^.!?\n]{0,40}$/i;

/** true si el patron aparece en alguna oracion SIN una negacion que lo preceda ("no puedo ofrecer descuentos" no cuenta). */
function matchesWithoutNegation(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
    const window = before.slice(sentenceStart + 1);
    if (!NEGATION_BEFORE.test(window)) return true;
  }
  return false;
}

const CONFIRM_RE = /(?:(?:tu|su|la)\s+)?(?:reserva(?:ci[oó]n)?|habitaci[oó]n|estancia)\s+(?:ya\s+)?(?:est[aá]|queda|qued[oó]|fue|ha\s+sido|est[aá]n)\s+(?:ya\s+)?(?:confirmad[ao]|asegurad[ao]|garantizad[ao]|reservad[ao]|lista)|(?:te|le)\s+(?:confirmo|aseguro|garantizo)\s+(?:tu|su|la)\s+(?:reserva|habitaci[oó]n)|reserva\s+confirmada|confirmaci[oó]n\s+de\s+(?:tu|su)\s+reserva|ya\s+qued[oó]\s+reservad[ao]|ya\s+(?:est[aá]\s+)?reservad[ao]/i;
const DISCOUNT_RE = /(?:descuento|rebaja|promoci[oó]n|cortes[ií]a|precio\s+especial|tarifa\s+especial|gratis|sin\s+costo|cero\s+costo|oferta)/i;
const SENSITIVE_ASK_RE = /(?:n[uú]mero\s+de\s+(?:tu\s+)?tarjeta|datos\s+de\s+(?:tu\s+)?tarjeta|\bcvv\b|\bcvc\b|pasaporte|\bcurp\b|\bine\b|identificaci[oó]n\s+oficial|licencia\s+de\s+conducir|foto\s+de\s+(?:tu\s+)?(?:identificaci[oó]n|documento))/i;

export interface ReplyGuardInput {
  readonly reply: string;
  /** Importes autorizados por las herramientas de ESTE turno. */
  readonly allowedCents: ReadonlySet<number>;
  /** true si alguna herramienta de reservas corrio en el turno (si no, cualquier precio narrado es inventado). */
  readonly reservasEnabled: boolean;
  /** true solo si un humano ya confirmo (nunca el agente): permite hablar de "confirmada". */
  readonly confirmedByHuman: boolean;
}

export function checkReply(input: ReplyGuardInput): ReplyViolation | null {
  if (!input.reservasEnabled) return null;
  const { reply } = input;
  for (const cents of extractMoneyCents(reply)) {
    if (!input.allowedCents.has(cents)) return "precio_no_respaldado";
  }
  if (!input.confirmedByHuman && matchesWithoutNegation(reply, CONFIRM_RE)) return "confirmacion_no_autorizada";
  if (matchesWithoutNegation(reply, DISCOUNT_RE)) return "descuento_no_autorizado";
  if (matchesWithoutNegation(reply, SENSITIVE_ASK_RE)) return "dato_sensible_solicitado";
  return null;
}
