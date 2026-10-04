// H-42 -- el espejo en memoria de la reserva directa reproduce las reglas de la migracion 044 (lo que la base garantiza de verdad lo prueba
// scripts/verify-hoteles-reservar-publico contra Postgres real). Aqui: TTL, sin sobreventa, carrera por la ultima habitacion, idempotencia,
// pago, cancelacion con penalidad y KPI.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReservarDirectoRepository, ReservasAgenteUnavailableError } from "../../src/index.ts";

const NOW = new Date("2031-06-01T12:00:00Z");
const PROP = randomUUID();
const RT = randomUUID();
const TOTAL = 357_000;
const base = { propertyId: PROP, roomTypeId: RT, checkInDate: "2031-06-12", checkOutDate: "2031-06-14", guests: 2, guestName: "Ana", contactPhone: "5215550000001", contactEmail: "ana@example.com", expectedTotalCents: TOTAL, consentNoticeVersion: "v1" };

function setup(opts: { rooms?: number; deposit?: number; web?: boolean } = {}) {
  const repo = new InMemoryReservarDirectoRepository();
  repo.clock = () => NOW;
  repo.seedProperty(PROP, { organizationId: randomUUID() });
  repo.seedRoomType(PROP, RT, "Doble", 2);
  repo.seedInventory(PROP, RT, "2031-06-11", "2031-06-20", opts.rooms ?? 2, 150_000);
  repo.setPolicy(PROP, { holdsEnabled: true, webEnabled: opts.web !== false, depositPct: opts.deposit ?? 0.3 });
  return repo;
}

describe("InMemoryReservarDirectoRepository", () => {
  it("cotiza en centavos desde la tarifa NETA + impuestos (2 noches x 1500 + IVA 16 % + ISH 3 % = 357000)", async () => {
    const r = await setup().stayOptions(PROP, "2031-06-12", "2031-06-14");
    expect(r.opciones[0]).toMatchObject({ roomTypeName: "Doble", status: "ok", netCents: 300_000, ivaCents: 48_000, ishCents: 9_000, totalCents: TOTAL, freeRooms: 2 });
  });

  it("fail-closed: sin opt-in web (o con holds apagados) no se crea nada ni se retiene inventario", async () => {
    const repo = setup({ web: false });
    await expect(repo.createWebHold({ ...base, idempotencyKey: "web-aaaaaaaa" })).rejects.toMatchObject({ code: "web_deshabilitado" });
    expect(repo.allHolds()).toHaveLength(0);
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(0);
  });

  it("con anticipo el hold espera el pago; sin anticipo espera a una persona", async () => {
    const con = await setup({ deposit: 0.3 }).createWebHold({ ...base, idempotencyKey: "web-aaaaaaaa" });
    expect(con).toMatchObject({ status: "pendiente_pago", mode: "link_pago", depositCents: 107_100, paymentStatus: "pendiente", channel: "web" });
    const sin = await setup({ deposit: 0 }).createWebHold({ ...base, idempotencyKey: "web-aaaaaaaa" });
    expect(sin).toMatchObject({ status: "pendiente_aprobacion", mode: "aprobacion_humana", depositCents: 0, paymentStatus: "no_requerido" });
  });

  it("guardia de precio: un total distinto responde precio_cambio con el vigente y no retiene nada", async () => {
    const repo = setup();
    await expect(repo.createWebHold({ ...base, idempotencyKey: "web-aaaaaaaa", expectedTotalCents: 100_000 })).rejects.toMatchObject({ code: "precio_cambio", detail: { totalCents: TOTAL } });
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(0);
  });

  it("carrera por la ULTIMA habitacion: una confirmacion gana y la otra recibe sin_disponibilidad, sin retencion parcial", async () => {
    const repo = setup({ rooms: 1 });
    const [a, b] = await Promise.allSettled([
      repo.createWebHold({ ...base, idempotencyKey: "web-carrera-01", contactPhone: "5215550000101", contactEmail: "a@example.com" }),
      repo.createWebHold({ ...base, idempotencyKey: "web-carrera-02", contactPhone: "5215550000102", contactEmail: "b@example.com" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "sin_disponibilidad" });
    expect(repo.allHolds()).toHaveLength(1);
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(1);
    expect(repo.booked(PROP, RT, "2031-06-13")).toBe(1);
  });

  it("idempotencia: la misma llave devuelve el MISMO hold; con otros parametros, conflicto; otra llave NO se mezcla (sin dedupe cruzado)", async () => {
    const repo = setup({ rooms: 5 });
    const h1 = await repo.createWebHold({ ...base, idempotencyKey: "web-idem-0001" });
    const h1b = await repo.createWebHold({ ...base, idempotencyKey: "web-idem-0001" });
    expect(h1b.id).toBe(h1.id);
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(1);
    await expect(repo.createWebHold({ ...base, idempotencyKey: "web-idem-0001", checkOutDate: "2031-06-13", expectedTotalCents: 178_500 })).rejects.toMatchObject({ code: "idempotencia_conflicto" });
    const h2 = await repo.createWebHold({ ...base, idempotencyKey: "web-idem-0002" });
    expect(h2.id).not.toBe(h1.id);
    await expect(repo.createWebHold({ ...base, idempotencyKey: "web-idem-0003" })).rejects.toMatchObject({ code: "limite_holds_contacto" });
  });

  it("TTL: pasado el vencimiento el hold expira y libera el inventario", async () => {
    const repo = setup();
    const h = await repo.createWebHold({ ...base, idempotencyKey: "web-ttl-00001" });
    expect((await repo.getWebHold(PROP, h.id, new Date("2031-06-01T13:59:00Z"))).status).toBe("pendiente_pago");
    expect((await repo.getWebHold(PROP, h.id, new Date("2031-06-01T14:01:00Z"))).status).toBe("expirado");
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(0);
  });

  it("pago capturado confirma y crea la reserva directo_web sin recontar inventario; fallido es reintentable; pago tardio no confirma", async () => {
    const repo = setup();
    const h = await repo.createWebHold({ ...base, idempotencyKey: "web-pago-0001" });
    expect((await repo.recordPayment(PROP, h.id, "fallido", "pi_x")).paymentStatus).toBe("fallido");
    const ok = await repo.recordPayment(PROP, h.id, "capturado", "pi_ok", new Date("2031-06-01T12:05:00Z"));
    expect(ok).toMatchObject({ status: "confirmado", paymentStatus: "capturado", paymentRef: "pi_ok" });
    expect(repo.booked(PROP, RT, "2031-06-12")).toBe(1);
    expect(repo.allReservations()).toMatchObject([{ channel: "directo_web", status: "confirmada" }]);
    expect((await repo.recordPayment(PROP, h.id, "capturado", "pi_ok")).status).toBe("confirmado");
    expect(repo.allReservations()).toHaveLength(1);

    const tarde = await repo.createWebHold({ ...base, idempotencyKey: "web-pago-0002", contactPhone: "5215550000009", contactEmail: "t@example.com" });
    expect((await repo.recordPayment(PROP, tarde.id, "capturado", "pi_late", new Date("2031-06-01T15:00:00Z"))).status).toBe("expirado");
    expect(repo.allReservations()).toHaveLength(1);
  });

  it("cancelacion: abierto sin penalidad; confirmada dentro de la ventana cobra el 50 % del total y no reembolsa; fuera de la ventana reembolsa el anticipo; idempotente", async () => {
    const dentro = setup();
    dentro.setTerms(PROP, { freeUntilHours: 24, penaltyPct: 0.5 });
    const h = await dentro.createWebHold({ ...base, idempotencyKey: "web-canc-0001" });
    await dentro.recordPayment(PROP, h.id, "capturado", "pi_1", new Date("2031-06-01T12:05:00Z"));
    const c = await dentro.cancelWebHold(PROP, h.id, new Date("2031-06-11T12:00:00Z"));
    expect(c).toMatchObject({ cancelPenaltyCents: 178_500, refundCents: 0, refundStatus: "no_aplica" });
    expect(dentro.booked(PROP, RT, "2031-06-12")).toBe(0);
    expect(dentro.allReservations()[0]!.status).toBe("cancelada");
    expect((await dentro.cancelWebHold(PROP, h.id, new Date("2031-06-11T13:00:00Z"))).cancelPenaltyCents).toBe(178_500);

    const fuera = setup();
    fuera.setTerms(PROP, { freeUntilHours: 24, penaltyPct: 0.5 });
    const f = await fuera.createWebHold({ ...base, idempotencyKey: "web-canc-0002" });
    await fuera.recordPayment(PROP, f.id, "capturado", "pi_2", new Date("2031-06-01T12:05:00Z"));
    const cf = await fuera.cancelWebHold(PROP, f.id, new Date("2031-06-05T12:00:00Z"));
    expect(cf).toMatchObject({ cancelPenaltyCents: 0, refundCents: 107_100, refundStatus: "solicitado" });
    expect((await fuera.markRefunded(PROP, f.id, "re_1")).refundStatus).toBe("procesado");
    expect((await fuera.markRefunded(PROP, f.id, "re_1")).refundStatus).toBe("procesado");

    const abierto = setup();
    const o = await abierto.createWebHold({ ...base, idempotencyKey: "web-canc-0003" });
    expect(await abierto.cancelWebHold(PROP, o.id)).toMatchObject({ status: "cancelado", refundStatus: "no_aplica", cancelPenaltyCents: 0 });
    expect(abierto.booked(PROP, RT, "2031-06-12")).toBe(0);
  });

  it("aislamiento: otra property o un id inexistente es no_encontrada", async () => {
    const repo = setup();
    const otra = randomUUID();
    repo.seedProperty(otra, { organizationId: randomUUID() });
    const h = await repo.createWebHold({ ...base, idempotencyKey: "web-aisla-001" });
    await expect(repo.getWebHold(otra, h.id)).rejects.toMatchObject({ code: "no_encontrada" });
    await expect(repo.cancelWebHold(otra, h.id)).rejects.toMatchObject({ code: "no_encontrada" });
    await expect(repo.getWebHold(PROP, randomUUID())).rejects.toMatchObject({ code: "no_encontrada" });
    expect(await repo.webContext(otra, h.id)).toBeNull();
  });

  it("KPI room-nights directas: noches directo_web vs total sin canceladas, recortado al rango", async () => {
    const repo = setup();
    const h = await repo.createWebHold({ ...base, idempotencyKey: "web-kpi-00001" });
    await repo.recordPayment(PROP, h.id, "capturado", "pi_k", new Date("2031-06-01T12:05:00Z"));
    repo.seedReservation(PROP, "2031-06-12", "2031-06-13");
    repo.seedReservation(PROP, "2031-06-12", "2031-06-15", null, "cancelada");
    expect(await repo.roomNightsDirectas(PROP, "2031-06-01", "2031-06-20")).toEqual({ disponible: true, desde: "2031-06-01", hasta: "2031-06-20", directas: 2, total: 3, porcentaje: 0.6667 });
    expect(await repo.roomNightsDirectas(PROP, "2031-06-13", "2031-06-14")).toMatchObject({ directas: 1, total: 1, porcentaje: 1 });
    expect((await repo.roomNightsDirectas(PROP, "2031-07-01", "2031-07-10")).porcentaje).toBeNull();
  });

  it("base SIN migrar: lecturas vacias honestas y escrituras ReservasAgenteUnavailableError", async () => {
    const repo = setup();
    repo.migrationApplied = false;
    expect((await repo.webPolicy(PROP)).disponible).toBe(false);
    expect((await repo.stayOptions(PROP, "2031-06-12", "2031-06-14")).disponible).toBe(false);
    expect((await repo.roomNightsDirectas(PROP, "2031-06-01", "2031-06-20")).disponible).toBe(false);
    await expect(repo.createWebHold({ ...base, idempotencyKey: "web-sinmig-01" })).rejects.toBeInstanceOf(ReservasAgenteUnavailableError);
  });
});
