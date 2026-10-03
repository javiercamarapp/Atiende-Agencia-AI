// H-42 -- dominio puro de la reserva directa: tokens firmados (cotizacion y estado), guardia de precio, anticipo, TTL, validacion estricta de la
// entrada publica y vista publica sin inventario exacto.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ESTADO_TOKEN_TTL_SECONDS,
  QUOTE_TOKEN_TTL_SECONDS,
  ReservarValidationError,
  calcularAnticipo,
  esCancelable,
  estadoPublico,
  estadoTokenKey,
  issueEstadoToken,
  issueQuoteToken,
  opcionesPublicas,
  parseConfirmarBody,
  parseCotizacionBody,
  parseDisponibilidadQuery,
  parseIdempotencyKey,
  previsionCancelacion,
  quoteTokenKey,
  terminosPublicos,
  verificarPrecio,
  verifyEstadoToken,
  verifyQuoteToken,
} from "../../src/reservar-directo/index.ts";
import type { StayOption, WebHoldRecord } from "../../src/index.ts";

const ORG = randomUUID();
const PROP = randomUUID();
const RT = randomUUID();
const HOLD = randomUUID();
const QKEY = quoteTokenKey("secreto-de-prueba");
const EKEY = estadoTokenKey("secreto-de-prueba");
const T0 = Date.parse("2031-06-01T12:00:00Z");
const claims = { org: ORG, prop: PROP, rt: RT, in: "2031-06-12", out: "2031-06-14", g: 2, tot: 357_000 };

describe("token de cotizacion", () => {
  it("firma y verifica ida y vuelta con lo cotizado", () => {
    const v = verifyQuoteToken(QKEY, issueQuoteToken(QKEY, claims, T0), T0 + 1000);
    expect(v).toMatchObject({ ok: true, claims: { org: ORG, prop: PROP, rt: RT, in: "2031-06-12", out: "2031-06-14", g: 2, tot: 357_000 } });
  });

  it("vence en 15 minutos (TTL corto) y no antes", () => {
    const token = issueQuoteToken(QKEY, claims, T0);
    expect(QUOTE_TOKEN_TTL_SECONDS).toBe(900);
    expect(verifyQuoteToken(QKEY, token, T0 + 899_000).ok).toBe(true);
    expect(verifyQuoteToken(QKEY, token, T0 + 900_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("cualquier alteracion del payload o de la firma se rechaza (bad_signature / malformed)", () => {
    const token = issueQuoteToken(QKEY, claims, T0);
    const [p, payload, sig] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), tot: 100 })).toString("base64url");
    expect(verifyQuoteToken(QKEY, `${p}.${forged}.${sig}`, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyQuoteToken(QKEY, `${p}.${payload}.AAAA`, T0)).toEqual({ ok: false, reason: "bad_signature" });
    for (const junk of ["", "x", "a.b", "q1..", "q1.a.b.c", `q1.${payload}`, "z".repeat(2000)]) expect(verifyQuoteToken(QKEY, junk, T0).ok).toBe(false);
  });

  it("un token de estado NUNCA valida como cotizacion (y al reves), y otra llave tampoco", () => {
    const estado = issueEstadoToken(EKEY, { org: ORG, prop: PROP, hold: HOLD }, T0);
    const quote = issueQuoteToken(QKEY, claims, T0);
    expect(verifyQuoteToken(QKEY, estado, T0).ok).toBe(false);
    expect(verifyEstadoToken(EKEY, quote, T0).ok).toBe(false);
    expect(verifyQuoteToken(quoteTokenKey("otro-secreto"), quote, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyEstadoToken(QKEY, estado, T0).ok).toBe(false);
  });

  it("rechaza claims con forma invalida aunque la firma sea correcta (total <= 0, ids que no son uuid)", () => {
    expect(verifyQuoteToken(QKEY, issueQuoteToken(QKEY, { ...claims, tot: 0 }, T0), T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyQuoteToken(QKEY, issueQuoteToken(QKEY, { ...claims, rt: "no-uuid" }, T0), T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyQuoteToken(QKEY, issueQuoteToken(QKEY, { ...claims, in: "manana" }, T0), T0)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("token de estado", () => {
  it("ida y vuelta, ligado a organizacion + property + hold, con TTL de un año", () => {
    const token = issueEstadoToken(EKEY, { org: ORG, prop: PROP, hold: HOLD }, T0);
    expect(verifyEstadoToken(EKEY, token, T0 + 1000)).toMatchObject({ ok: true, claims: { org: ORG, prop: PROP, hold: HOLD } });
    expect(verifyEstadoToken(EKEY, token, T0 + ESTADO_TOKEN_TTL_SECONDS * 1000)).toEqual({ ok: false, reason: "expired" });
  });
  it("es opaco: no contiene correo, telefono ni nombre", () => {
    const token = issueEstadoToken(EKEY, { org: ORG, prop: PROP, hold: HOLD }, T0);
    const payload = Buffer.from(token.split(".")[1]!, "base64url").toString();
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["exp", "hold", "iat", "org", "prop"]);
  });
});

describe("guardia de precio y anticipo", () => {
  it("el total debe coincidir EXACTAMENTE; si difiere devuelve el vigente", () => {
    expect(verificarPrecio(357_000, 357_000)).toEqual({ ok: true });
    expect(verificarPrecio(357_000, 357_001)).toEqual({ ok: false, vigenteCents: 357_001 });
    expect(verificarPrecio(1, 357_000)).toEqual({ ok: false, vigenteCents: 357_000 });
  });
  it("anticipo = porcentaje del total redondeado half-up y nunca mayor al total", () => {
    expect(calcularAnticipo(357_000, 0.3)).toBe(107_100);
    expect(calcularAnticipo(100_001, 0.5)).toBe(50_001);
    expect(calcularAnticipo(357_000, 0)).toBe(0);
    expect(calcularAnticipo(357_000, 1)).toBe(357_000);
    expect(calcularAnticipo(357_000, 1.5)).toBe(0);
    expect(calcularAnticipo(-5, 0.3)).toBe(0);
    expect(calcularAnticipo(357_000.5, 0.3)).toBe(0);
  });
});

describe("cancelacion: terminos y prevision (misma regla que la base)", () => {
  const terminos = { freeUntilHours: 24, penaltyPct: 0.5 };
  it("dentro de la ventana cobra el porcentaje del TOTAL y el reembolso es lo pagado menos la penalidad", () => {
    const p = previsionCancelacion({ totalCents: 357_000, pagadoCents: 107_100, checkInDate: "2031-06-12", now: new Date("2031-06-11T12:00:00Z"), terminos });
    expect(p).toEqual({ penalidadCents: 178_500, reembolsoCents: 0 });
  });
  it("fuera de la ventana no hay penalidad y se devuelve todo lo pagado", () => {
    const p = previsionCancelacion({ totalCents: 357_000, pagadoCents: 107_100, checkInDate: "2031-06-12", now: new Date("2031-06-05T12:00:00Z"), terminos });
    expect(p).toEqual({ penalidadCents: 0, reembolsoCents: 107_100 });
  });
  it("sin politica configurada no hay penalidad", () => {
    expect(previsionCancelacion({ totalCents: 357_000, pagadoCents: 100, checkInDate: "2031-06-12", now: new Date("2031-06-11T23:00:00Z"), terminos: null })).toEqual({ penalidadCents: 0, reembolsoCents: 100 });
  });
  it("terminosPublicos calcula hasta cuando es gratis (llegada 00:00 UTC menos la ventana)", () => {
    expect(terminosPublicos(terminos, "2031-06-12")).toEqual({ gratisHasta: "2031-06-11T00:00:00.000Z", penalidadPct: 0.5 });
    expect(terminosPublicos(null, "2031-06-12")).toEqual({ gratisHasta: null, penalidadPct: 0 });
  });
});

describe("vista publica de la disponibilidad", () => {
  const base: Omit<StayOption, "roomTypeId" | "roomTypeName" | "maxOccupancy" | "freeRooms" | "status" | "totalCents"> = { netCents: null, ivaCents: null, ishCents: null, nightly: null };
  const opts: StayOption[] = [
    { ...base, roomTypeId: "a", roomTypeName: "Doble <b>", maxOccupancy: 2, freeRooms: 7, status: "ok", totalCents: 357_001 },
    { ...base, roomTypeId: "b", roomTypeName: "Suite", maxOccupancy: 4, freeRooms: 0, status: "sin_inventario", totalCents: null },
    { ...base, roomTypeId: "c", roomTypeName: "Sencilla", maxOccupancy: 1, freeRooms: 3, status: "ok", totalCents: 100_000 },
    { ...base, roomTypeId: "d", roomTypeName: "Junior", maxOccupancy: 3, freeRooms: 2, status: "precio_fuera_de_guardia", totalCents: null },
    { ...base, roomTypeId: "e", roomTypeName: "Penthouse", maxOccupancy: 3, freeRooms: 2, status: "cerrado_a_llegada", totalCents: null },
  ];
  const vista = opcionesPublicas(opts, 2, 2);

  it("nunca expone el inventario exacto ni topes internos; solo un si/no y el precio desde (impuestos incluidos, hacia arriba)", () => {
    for (const o of vista) expect(Object.keys(o).sort()).toEqual(["desdePorNocheCentavos", "disponible", "maxOcupacion", "motivo", "nombre", "tipoHabitacionId", "totalCentavos"]);
    expect(JSON.stringify(vista)).not.toMatch(/freeRooms|free_rooms|libres/);
    expect(vista.find((o) => o.tipoHabitacionId === "a")).toMatchObject({ disponible: true, motivo: null, totalCentavos: 357_001, desdePorNocheCentavos: 178_501 });
  });
  it("descarta los tipos donde no caben los huespedes y sanea el nombre", () => {
    expect(vista.map((o) => o.tipoHabitacionId)).toEqual(["a", "b", "d", "e"]);
    expect(vista[0]!.nombre).toBe("Doble b");
  });
  it("traduce los motivos sin filtrar la regla interna (precio fuera de guardia => no reservable en linea)", () => {
    expect(vista.find((o) => o.tipoHabitacionId === "b")).toMatchObject({ disponible: false, motivo: "sin_disponibilidad", totalCentavos: null });
    expect(vista.find((o) => o.tipoHabitacionId === "d")).toMatchObject({ disponible: false, motivo: "no_reservable_en_linea" });
    expect(vista.find((o) => o.tipoHabitacionId === "e")).toMatchObject({ disponible: false, motivo: "cerrado_en_estas_fechas" });
  });
});

describe("estado publico del hold", () => {
  const hold = (patch: Partial<WebHoldRecord>) => ({ status: "pendiente_pago", canceledAt: null, ...patch }) as Pick<WebHoldRecord, "status" | "canceledAt">;
  it("mapea los estados internos a los que ve el huesped", () => {
    expect(estadoPublico(hold({}), { reservationStatus: null })).toBe("pago_pendiente");
    expect(estadoPublico(hold({ status: "pendiente_aprobacion" }), { reservationStatus: null })).toBe("en_revision");
    expect(estadoPublico(hold({ status: "aprobado" }), { reservationStatus: null })).toBe("aprobada");
    expect(estadoPublico(hold({ status: "confirmado" }), { reservationStatus: "confirmada" })).toBe("confirmada");
    expect(estadoPublico(hold({ status: "confirmado" }), { reservationStatus: "cancelada" })).toBe("cancelada");
    expect(estadoPublico(hold({ status: "confirmado", canceledAt: "2031-06-02T00:00:00Z" }), { reservationStatus: "confirmada" })).toBe("cancelada");
    expect(estadoPublico(hold({ status: "rechazado" }), { reservationStatus: null })).toBe("rechazada");
    expect(estadoPublico(hold({ status: "expirado" }), { reservationStatus: null })).toBe("expirada");
  });
  it("solo se cancela en linea un hold abierto o una reserva confirmada sin check-in", () => {
    expect(esCancelable(hold({}), { reservationStatus: null })).toBe(true);
    expect(esCancelable(hold({ status: "confirmado" }), { reservationStatus: "confirmada" })).toBe(true);
    expect(esCancelable(hold({ status: "confirmado" }), { reservationStatus: "check_in" })).toBe(false);
    expect(esCancelable(hold({ status: "confirmado", canceledAt: "x" }), { reservationStatus: "cancelada" })).toBe(false);
    for (const s of ["rechazado", "expirado", "cancelado"] as const) expect(esCancelable(hold({ status: s }), { reservationStatus: null })).toBe(false);
  });
});

describe("validacion estricta de la entrada publica", () => {
  const validConfirm = { quoteToken: "q".repeat(40), consentimientoAviso: true, huesped: { nombre: "Ana Lopez", telefono: "+52 55 1234 5678", correo: "Ana@Example.com" } };

  it("disponibilidad: fechas reales y huespedes acotados", () => {
    expect(parseDisponibilidadQuery({ llegada: "2031-06-12", salida: "2031-06-14", huespedes: "2" })).toMatchObject({ nights: 2, guests: 2, propiedad: null });
    for (const bad of [
      { llegada: "2031-02-30", salida: "2031-03-02", huespedes: "2" },
      { llegada: "2031-06-14", salida: "2031-06-12", huespedes: "2" },
      { llegada: "2031-06-12", salida: "2031-06-14", huespedes: "0" },
      { llegada: "2031-06-12", salida: "2031-06-14", huespedes: "dos" },
      { llegada: "2031-06-12", salida: "2031-06-14", huespedes: "2.5" },
      { llegada: "2031-06-12", salida: "2031-09-14", huespedes: "2" },
      { llegada: "2031-06-12", salida: "2031-06-14", huespedes: "2", property: "No Valido!" },
      {},
    ]) expect(() => parseDisponibilidadQuery(bad)).toThrow(ReservarValidationError);
  });

  it("cotizacion: ningun campo de precio se acepta o se propaga; tipo debe ser uuid", () => {
    const parsed = parseCotizacionBody({ tipoHabitacionId: RT, llegada: "2031-06-12", salida: "2031-06-14", huespedes: 2, precio: 1, total: 1, descuento: 99 });
    expect(Object.keys(parsed).sort()).toEqual(["checkInDate", "checkOutDate", "guests", "nights", "propiedad", "roomTypeId"]);
    expect(() => parseCotizacionBody({ tipoHabitacionId: "x", llegada: "2031-06-12", salida: "2031-06-14", huespedes: 2 })).toThrow(ReservarValidationError);
    expect(() => parseCotizacionBody("texto")).toThrow(ReservarValidationError);
    expect(() => parseCotizacionBody([1])).toThrow(ReservarValidationError);
  });

  it("confirmar: normaliza telefono y correo y exige el consentimiento del aviso", () => {
    const ok = parseConfirmarBody(validConfirm);
    expect(ok).toMatchObject({ guestName: "Ana Lopez", contactPhone: "+525512345678", contactEmail: "ana@example.com", paymentMethodToken: null, honeypot: false });
    expect(() => parseConfirmarBody({ ...validConfirm, consentimientoAviso: false })).toThrow(/aviso de privacidad/);
    expect(() => parseConfirmarBody({ ...validConfirm, consentimientoAviso: "true" })).toThrow(ReservarValidationError);
  });

  it("confirmar: rechaza nombre con datos sensibles, correo y telefono invalidos, y un PAN en el metodo de pago", () => {
    const con = (huesped: object, extra: object = {}) => parseConfirmarBody({ ...validConfirm, huesped: { ...validConfirm.huesped, ...huesped }, ...extra });
    expect(() => con({ nombre: "A" })).toThrow(ReservarValidationError);
    expect(() => con({ nombre: "4111 1111 1111 1111" })).toThrow(ReservarValidationError);
    expect(() => con({ nombre: "ana@x.com" })).toThrow(ReservarValidationError);
    expect(() => con({ correo: "no-es-correo" })).toThrow(ReservarValidationError);
    expect(() => con({ correo: "a b@x.com" })).toThrow(ReservarValidationError);
    expect(() => con({ telefono: "12" })).toThrow(ReservarValidationError);
    expect(() => con({}, { metodoPagoToken: "4111111111111111" })).toThrow(/tokenizado/);
    expect(con({}, { metodoPagoToken: "pm_1Abcdefgh123" }).paymentMethodToken).toBe("pm_1Abcdefgh123");
  });

  it("confirmar: el honeypot lleno corta antes de validar nada", () => {
    expect(parseConfirmarBody({ sitioWeb: "http://spam.example", huesped: 5 })).toMatchObject({ honeypot: true });
  });

  it("Idempotency-Key obligatoria con formato acotado", () => {
    expect(parseIdempotencyKey(" abc-12345_X ")).toBe("abc-12345_X");
    for (const bad of [null, undefined, "", "corta", "con espacios aqui", "x".repeat(101), "emoji-😀-12345"]) expect(() => parseIdempotencyKey(bad as string | null)).toThrow(ReservarValidationError);
  });
});
