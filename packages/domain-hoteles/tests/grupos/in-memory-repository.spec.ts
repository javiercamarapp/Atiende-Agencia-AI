// H-06 -- repositorio en memoria de grupos: espejo de la migracion 036 (la verdad vive en scripts/verify-hoteles-grupos
// contra Postgres real; aqui se cubre el contrato que consume la API).
import { describe, expect, it } from "vitest";
import {
  GruposAccessDeniedError,
  GruposConflictError,
  GruposInvalidInputError,
  GruposNotFoundError,
  GruposUnavailableError,
  InMemoryGruposRepository,
  type GrupoActor,
  type InventoryNight,
  type NewQuoteInput,
} from "../../src/index.ts";

const P1 = "00000000-0000-0000-0000-0000000a1a01";
const P2 = "00000000-0000-0000-0000-0000000a1a02";
const DBL = "00000000-0000-0000-0000-0000000d0001";
const SUITE = "00000000-0000-0000-0000-0000000d0002";
const owner: GrupoActor = { userId: "u-owner", role: "owner" };
const reservations: GrupoActor = { userId: "u-res", role: "reservations" };
const frontdesk: GrupoActor = { userId: "u-fd", role: "frontdesk" };
const accountant: GrupoActor = { userId: "u-acc", role: "accountant" };
const housekeeping: GrupoActor = { userId: "u-hk", role: "housekeeping" };
const outsider: GrupoActor = { userId: "u-x", role: null };

const NOW = new Date("2031-05-01T12:00:00Z");
const NIGHTS = ["2031-06-12", "2031-06-13", "2031-06-14"];
const inv = (property: string, rt: string, total: number, booked = 0): InventoryNight[] => NIGHTS.map((date) => ({ propertyId: property, roomTypeId: rt, date, totalRooms: total, bookedRooms: booked }));

function repo(extra: Partial<ConstructorParameters<typeof InMemoryGruposRepository>[0]> = {}): InMemoryGruposRepository {
  return new InMemoryGruposRepository({
    now: () => NOW,
    timeZones: { [P1]: "America/Mexico_City", [P2]: "America/Tijuana" },
    roomTypes: { [P1]: [DBL, SUITE], [P2]: [DBL] },
    inventory: [...inv(P1, DBL, 10), ...inv(P1, SUITE, 2), ...inv(P2, DBL, 10)],
    ...extra,
  });
}
const quoteInput = (over: Partial<NewQuoteInput> = {}): NewQuoteInput => ({
  propertyId: P1, groupName: "Boda Garcia", contactName: "Ana", contactEmail: "ana@example.com", checkInDate: "2031-06-12", checkOutDate: "2031-06-15",
  cutoffDate: "2031-06-05", validUntil: "2031-05-08T12:00:00Z", discountBps: 0, depositRequiredCents: 0, lines: [{ roomTypeId: DBL, rooms: 5, rateCents: 150_000 }], ...over,
});
async function blocked(r: InMemoryGruposRepository, over: Partial<NewQuoteInput> = {}) {
  const q = await r.createQuote(quoteInput(over), owner);
  await r.sendQuote(over.propertyId ?? P1, q.id, owner);
  return { quote: q, block: await r.acceptQuote(over.propertyId ?? P1, q.id, owner) };
}

describe("cotizacion", () => {
  it("crea con total en centavos y la envia; vigencia vencida al enviar es conflicto", async () => {
    const r = repo();
    const q = await r.createQuote(quoteInput({ discountBps: 1000, depositRequiredCents: 500_000 }), reservations);
    expect(q).toMatchObject({ grossCents: 2_250_000, totalCents: 2_025_000, status: "borrador", nights: 3 });
    expect((await r.sendQuote(P1, q.id, reservations)).status).toBe("enviada");
    const late = await r.createQuote(quoteInput(), owner);
    await expect(r.sendQuote(P1, late.id, owner, new Date("2031-05-09T00:00:00Z"))).rejects.toBeInstanceOf(GruposConflictError);
  });

  it("valida roles, fechas, vigencia, tipo de habitacion y anticipo", async () => {
    const r = repo();
    await expect(r.createQuote(quoteInput(), frontdesk)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.createQuote(quoteInput(), outsider)).rejects.toBeInstanceOf(GruposNotFoundError);
    await expect(r.createQuote(quoteInput({ cutoffDate: "2031-06-13" }), owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.createQuote(quoteInput({ cutoffDate: "2031-04-30" }), owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.createQuote(quoteInput({ validUntil: "2031-04-30T00:00:00Z" }), owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.createQuote(quoteInput({ lines: [{ roomTypeId: "00000000-0000-0000-0000-0000000d0009", rooms: 1, rateCents: 1 }] }), owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.createQuote(quoteInput({ depositRequiredCents: 2_250_001 }), owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.createQuote(quoteInput({ depositRequiredCents: 2_250_000 }), owner)).resolves.toBeDefined();
  });

  it("el descuento sobre el tope (30 %) lo autoriza solo owner/gm; en el borde exacto pasa", async () => {
    const r = repo();
    await expect(r.createQuote(quoteInput({ discountBps: 3001 }), reservations)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.createQuote(quoteInput({ discountBps: 3000 }), reservations)).resolves.toBeDefined();
    await expect(r.createQuote(quoteInput({ discountBps: 5000 }), owner)).resolves.toBeDefined();
    await expect(repo({ maxDiscountPct: 10 }).createQuote(quoteInput({ discountBps: 1001 }), reservations)).rejects.toBeInstanceOf(GruposAccessDeniedError);
  });

  it("rechazar/cancelar exige motivo y estado abierto; solo una enviada se rechaza", async () => {
    const r = repo();
    const q = await r.createQuote(quoteInput(), owner);
    await expect(r.closeQuote(P1, q.id, "rechazada", "No era enviada", owner)).rejects.toBeInstanceOf(GruposConflictError);
    await expect(r.closeQuote(P1, q.id, "cancelada", "abc", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    expect((await r.closeQuote(P1, q.id, "cancelada", "El cliente desistio", owner)).status).toBe("cancelada");
    await expect(r.closeQuote(P1, q.id, "cancelada", "Otra vez cancelada", owner)).rejects.toBeInstanceOf(GruposConflictError);
  });

  it("vencimiento por vigencia: borradores y enviadas, no aceptadas; idempotente", async () => {
    const r = repo();
    const a = await r.createQuote(quoteInput(), owner);
    await r.sendQuote(P1, a.id, owner);
    await r.createQuote(quoteInput(), owner);
    await blocked(r);
    const later = new Date("2031-06-01T00:00:00Z");
    expect(await r.expireQuotes(later)).toBe(2);
    expect(await r.expireQuotes(later)).toBe(0);
    expect(await r.expireQuotes(new Date("2031-04-01T00:00:00Z"))).toBe(0);
  });

  it("una cotizacion de otra property no se ve ni se opera (cross-tenant)", async () => {
    const r = repo();
    const q = await r.createQuote(quoteInput(), owner);
    expect(await r.getQuote(P2, q.id)).toBeNull();
    await expect(r.sendQuote(P2, q.id, owner)).rejects.toBeInstanceOf(GruposNotFoundError);
    expect((await r.listQuotes(P2)).cotizaciones).toHaveLength(0);
  });
});

describe("bloqueo (allotment) sin sobreventa", () => {
  it("aceptar retiene cada noche y crea el bloqueo con su cutoff", async () => {
    const r = repo();
    const { block, quote } = await blocked(r);
    expect(block).toMatchObject({ status: "activo", cutoffDate: "2031-06-05" });
    expect(block.pickup).toMatchObject({ blockedRoomNights: 15, pickedUpRoomNights: 0, pendingRoomNights: 15 });
    for (const d of NIGHTS) expect(r.booked(P1, DBL, d)).toBe(5);
    expect(r.booked(P1, DBL, "2031-06-15")).toBeNull();
    expect((await r.getQuote(P1, quote.id))?.blockId).toBe(block.id);
  });

  it("es atomico: una noche sin cupo no retiene ninguna ni deja bloqueo", async () => {
    const r = repo({ inventory: [{ propertyId: P1, roomTypeId: DBL, date: "2031-06-12", totalRooms: 10, bookedRooms: 0 }, { propertyId: P1, roomTypeId: DBL, date: "2031-06-13", totalRooms: 10, bookedRooms: 0 }, { propertyId: P1, roomTypeId: DBL, date: "2031-06-14", totalRooms: 10, bookedRooms: 8 }] });
    const q = await r.createQuote(quoteInput(), owner);
    await r.sendQuote(P1, q.id, owner);
    await expect(r.acceptQuote(P1, q.id, owner)).rejects.toBeInstanceOf(GruposConflictError);
    expect(r.booked(P1, DBL, "2031-06-12")).toBe(0);
    expect((await r.listBlocks(P1)).bloqueos).toHaveLength(0);
    expect((await r.getQuote(P1, q.id))?.status).toBe("enviada");
  });

  it("nunca sobrevende: dos bloqueos compiten por los ultimos cuartos y el segundo falla", async () => {
    const r = repo();
    const a = await r.createQuote(quoteInput({ lines: [{ roomTypeId: DBL, rooms: 6, rateCents: 100 }] }), owner);
    const b = await r.createQuote(quoteInput({ lines: [{ roomTypeId: DBL, rooms: 6, rateCents: 100 }] }), owner);
    await r.sendQuote(P1, a.id, owner);
    await r.sendQuote(P1, b.id, owner);
    await r.acceptQuote(P1, a.id, owner);
    await expect(r.acceptQuote(P1, b.id, owner)).rejects.toBeInstanceOf(GruposConflictError);
    for (const d of NIGHTS) expect(r.booked(P1, DBL, d)).toBe(6);
  });

  it("exige estado enviada, vigencia y fecha de liberacion no vencidas; frontdesk no acepta", async () => {
    const r = repo();
    const q = await r.createQuote(quoteInput(), owner);
    await expect(r.acceptQuote(P1, q.id, owner)).rejects.toBeInstanceOf(GruposConflictError);
    await r.sendQuote(P1, q.id, owner);
    await expect(r.acceptQuote(P1, q.id, frontdesk)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.acceptQuote(P1, q.id, owner, new Date("2031-05-09T00:00:00Z"))).rejects.toBeInstanceOf(GruposConflictError);
    const cut = repo();
    const c = await cut.createQuote(quoteInput({ validUntil: "2031-07-01T00:00:00Z" }), owner);
    await cut.sendQuote(P1, c.id, owner);
    await expect(cut.acceptQuote(P1, c.id, owner, new Date("2031-06-05T12:00:00Z"))).rejects.toBeInstanceOf(GruposConflictError);
    expect(cut.booked(P1, DBL, "2031-06-12")).toBe(0);
    await blocked(r);
  });
});

describe("pickup, rooming y liberacion", () => {
  const entry = { roomTypeId: DBL, guestName: "Luis Perez", checkInDate: "2031-06-12", checkOutDate: "2031-06-15" };

  it("confirmar consume un cuarto del bloqueo por noche sin tocar el inventario; no mas que lo bloqueado", async () => {
    const r = repo();
    const { block } = await blocked(r, { lines: [{ roomTypeId: SUITE, rooms: 1, rateCents: 100 }] });
    const e1 = await r.addRoomingEntry(P1, block.id, { ...entry, roomTypeId: SUITE, guestName: "Uno Perez" }, frontdesk);
    const e2 = await r.addRoomingEntry(P1, block.id, { ...entry, roomTypeId: SUITE, guestName: "Dos Perez" }, frontdesk);
    await r.confirmRoomingEntry(P1, e1.id, null, frontdesk);
    expect(r.booked(P1, SUITE, "2031-06-13")).toBe(1);
    await expect(r.confirmRoomingEntry(P1, e2.id, null, frontdesk)).rejects.toBeInstanceOf(GruposConflictError);
    await expect(r.confirmRoomingEntry(P1, e1.id, null, frontdesk)).rejects.toBeInstanceOf(GruposConflictError);
    expect((await r.getBlock(P1, block.id))?.pickup.pickedUpRoomNights).toBe(3);
  });

  it("valida fechas dentro del bloqueo, tipo ajeno y roles (housekeeping/accountant no)", async () => {
    const r = repo();
    const { block } = await blocked(r);
    await expect(r.addRoomingEntry(P1, block.id, { ...entry, checkInDate: "2031-06-11" }, owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.addRoomingEntry(P1, block.id, { ...entry, checkOutDate: "2031-06-16" }, owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.addRoomingEntry(P1, block.id, { ...entry, roomTypeId: SUITE }, owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.addRoomingEntry(P1, block.id, entry, housekeeping)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.addRoomingEntry(P1, block.id, entry, accountant)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.addRoomingEntry(P2, block.id, entry, owner)).rejects.toBeInstanceOf(GruposNotFoundError);
  });

  it("desde la fecha de liberacion (hora local de la property) ya no se confirma pickup", async () => {
    const r = repo();
    const { block } = await blocked(r);
    const e = await r.addRoomingEntry(P1, block.id, entry, owner);
    await expect(r.confirmRoomingEntry(P1, e.id, null, owner, new Date("2031-06-05T06:00:00Z"))).rejects.toBeInstanceOf(GruposConflictError);
    await expect(r.confirmRoomingEntry(P1, e.id, null, owner, new Date("2031-06-05T05:59:59Z"))).resolves.toMatchObject({ status: "confirmada" });
  });

  it("cancelar un confirmado devuelve el cuarto al bloqueo; tras liberar lo devuelve al inventario", async () => {
    const r = repo();
    const { block } = await blocked(r);
    const e = await r.addRoomingEntry(P1, block.id, entry, owner);
    await r.confirmRoomingEntry(P1, e.id, null, owner);
    await r.cancelRoomingEntry(P1, e.id, owner);
    expect((await r.getBlock(P1, block.id))?.pickup.pickedUpRoomNights).toBe(0);
    expect(r.booked(P1, DBL, "2031-06-12")).toBe(5);
    const e2 = await r.addRoomingEntry(P1, block.id, { ...entry, guestName: "Dos Perez" }, owner);
    await r.confirmRoomingEntry(P1, e2.id, null, owner);
    expect(await r.releaseBlock(P1, block.id, owner)).toBe(12);
    expect(r.booked(P1, DBL, "2031-06-12")).toBe(1);
    await r.cancelRoomingEntry(P1, e2.id, owner);
    expect(r.booked(P1, DBL, "2031-06-12")).toBe(0);
    await expect(r.cancelRoomingEntry(P1, e2.id, owner)).rejects.toBeInstanceOf(GruposConflictError);
  });

  it("liberacion manual devuelve solo lo no confirmado y es idempotente (conflicto la segunda vez)", async () => {
    const r = repo();
    const { block } = await blocked(r);
    const e = await r.addRoomingEntry(P1, block.id, entry, owner);
    await r.confirmRoomingEntry(P1, e.id, null, owner);
    expect(await r.releaseBlock(P1, block.id, reservations)).toBe(12);
    expect(r.booked(P1, DBL, "2031-06-14")).toBe(1);
    expect((await r.getBlock(P1, block.id))).toMatchObject({ status: "liberado", releaseKind: "manual" });
    await expect(r.releaseBlock(P1, block.id, owner)).rejects.toBeInstanceOf(GruposConflictError);
    await expect(r.addRoomingEntry(P1, block.id, entry, owner)).rejects.toBeInstanceOf(GruposConflictError);
    await expect(r.releaseBlock(P1, block.id, frontdesk)).rejects.toBeInstanceOf(GruposAccessDeniedError);
  });

  it("cancelar bloqueo: motivo, sin pickup confirmado, libera todo", async () => {
    const r = repo();
    const { block } = await blocked(r);
    const e = await r.addRoomingEntry(P1, block.id, entry, owner);
    await r.confirmRoomingEntry(P1, e.id, null, owner);
    await expect(r.cancelBlock(P1, block.id, "abc", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.cancelBlock(P1, block.id, "Se cae el evento", owner)).rejects.toBeInstanceOf(GruposConflictError);
    await r.cancelRoomingEntry(P1, e.id, owner);
    expect(await r.cancelBlock(P1, block.id, "Se cae el evento", owner)).toBe(15);
    for (const d of NIGHTS) expect(r.booked(P1, DBL, d)).toBe(0);
    expect((await r.getBlock(P1, block.id))?.status).toBe("cancelado");
  });

  it("barrido por cutoff: respeta la zona de cada property (Mexico_City ya, Tijuana aun) e idempotente", async () => {
    const r = repo();
    const a = await blocked(r);
    const b = await blocked(r, { propertyId: P2 });
    const at = new Date("2031-06-05T06:30:00Z");
    expect(await r.releaseDueBlocks(null, new Date("2031-06-04T12:00:00Z"))).toEqual([]);
    expect(await r.releaseDueBlocks(null, at)).toEqual([{ blockId: a.block.id, releasedRoomNights: 15 }]);
    expect(r.booked(P1, DBL, "2031-06-12")).toBe(0);
    expect(r.booked(P2, DBL, "2031-06-12")).toBe(5);
    expect(await r.releaseDueBlocks(null, at)).toEqual([]);
    expect(await r.releaseDueBlocks(P2, new Date("2031-06-05T07:30:00Z"))).toEqual([{ blockId: b.block.id, releasedRoomNights: 15 }]);
    expect((await r.getBlock(P1, a.block.id))).toMatchObject({ status: "liberado", releaseKind: "cutoff" });
  });

  it("el barrido filtra por property y nunca deja inventario negativo", async () => {
    const r = repo();
    await blocked(r);
    await blocked(r, { propertyId: P2 });
    const out = await r.releaseDueBlocks(P1, new Date("2032-01-01T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(r.booked(P2, DBL, "2031-06-12")).toBe(5);
    for (const d of NIGHTS) expect(r.booked(P1, DBL, d)).toBeGreaterThanOrEqual(0);
  });
});

describe("anticipos: solo registro", () => {
  it("exige cotizacion aceptada, monto entero positivo, referencia unica y tope en el total exacto", async () => {
    const r = repo();
    const q = await r.createQuote(quoteInput({ lines: [{ roomTypeId: DBL, rooms: 1, rateCents: 100_000 }], checkOutDate: "2031-06-13" }), owner);
    await expect(r.registerDeposit(P1, q.id, 100, "REF-0001", owner)).rejects.toBeInstanceOf(GruposConflictError);
    await r.sendQuote(P1, q.id, owner);
    await r.acceptQuote(P1, q.id, owner);
    await expect(r.registerDeposit(P1, q.id, 0, "REF-0001", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.registerDeposit(P1, q.id, 10.5, "REF-0001", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.registerDeposit(P1, q.id, 100_001, "REF-0001", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await expect(r.registerDeposit(P1, q.id, 100, "ab", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
    await r.registerDeposit(P1, q.id, 99_999, "REF-0001", accountant);
    await expect(r.registerDeposit(P1, q.id, 1, "REF-0001", accountant)).rejects.toBeInstanceOf(GruposConflictError);
    const done = await r.registerDeposit(P1, q.id, 1, "REF-0002", owner);
    expect(done.depositRecordedCents).toBe(100_000);
    expect(done.deposits).toHaveLength(2);
    await expect(r.registerDeposit(P1, q.id, 1, "REF-0003", owner)).rejects.toBeInstanceOf(GruposInvalidInputError);
  });

  it("reservations y frontdesk no registran anticipos", async () => {
    const r = repo();
    const { quote } = await blocked(r);
    await expect(r.registerDeposit(P1, quote.id, 100, "REF-0001", reservations)).rejects.toBeInstanceOf(GruposAccessDeniedError);
    await expect(r.registerDeposit(P1, quote.id, 100, "REF-0001", frontdesk)).rejects.toBeInstanceOf(GruposAccessDeniedError);
  });
});

describe("base sin la migracion 036", () => {
  it("lecturas vacias honestas y escrituras 503", async () => {
    const r = repo({ migrated: false });
    expect(await r.listQuotes(P1)).toEqual({ disponible: false, cotizaciones: [] });
    expect(await r.listBlocks(P1)).toEqual({ disponible: false, bloqueos: [] });
    expect(await r.getQuote(P1, "x")).toBeNull();
    await expect(r.createQuote(quoteInput(), owner)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(r.releaseDueBlocks(null, NOW)).rejects.toBeInstanceOf(GruposUnavailableError);
  });
});
