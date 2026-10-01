// H-05 -- espejo en memoria: politica de SLA, SLA congelado, transiciones, una resena un ticket
// activo, bitacora y barrido de SLA (escalar + aviso al 75%, idempotente).
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryGuestTicketRepository, TicketConflictError, TicketInvalidInputError, TicketUnavailableError } from "../../src/index.ts";
import type { NewGuestTicketInput } from "../../src/index.ts";

const P = "prop-1";
const FD = "u-frontdesk";
const T0 = new Date("2026-03-10T10:00:00.000Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);

let clock = T0;
let repo: InMemoryGuestTicketRepository;

function input(over: Partial<NewGuestTicketInput> = {}): NewGuestTicketInput {
  return { propertyId: P, roomId: null, guestReviewId: null, department: "frontdesk", priority: "media", channel: "staff", guestMessage: "Toallas", slaMinutes: 120, assignedTo: null, createdBy: FD, ...over };
}

beforeEach(() => {
  clock = T0;
  repo = new InMemoryGuestTicketRepository({ now: () => clock });
  repo.seedStaff(P, "u-hk");
});

describe("crear y SLA", () => {
  it("congela el SLA al crear y la politica de la property manda sobre el valor propuesto", async () => {
    const sin = await repo.createTicket(input());
    expect(sin.slaMinutes).toBe(120);
    expect(sin.slaDueAt).toBe(min(120).toISOString());
    await repo.upsertSlaPolicy(P, "frontdesk", "media", 20);
    const con = await repo.createTicket(input({ slaMinutes: 9999 }));
    expect(con.slaMinutes).toBe(20);
    expect(con.slaDueAt).toBe(min(20).toISOString());
    // cambiar la politica despues no mueve el vencimiento de un ticket ya abierto
    await repo.upsertSlaPolicy(P, "frontdesk", "media", 5);
    expect((await repo.findTicket(P, con.id))!.slaDueAt).toBe(min(20).toISOString());
  });

  it("la bitacora registra 'creado' con el actor", async () => {
    const t = await repo.createTicket(input());
    expect(repo.eventsOf(t.id)).toMatchObject([{ eventType: "creado", actorId: FD }]);
  });

  it("un responsable que no es staff de la property se rechaza", async () => {
    await expect(repo.createTicket(input({ assignedTo: "u-ajeno" }))).rejects.toBeInstanceOf(TicketInvalidInputError);
    await expect(repo.createTicket(input({ assignedTo: "u-hk" }))).resolves.toMatchObject({ assignedTo: "u-hk" });
  });

  it("reasignar departamento NO reinicia el SLA", async () => {
    const t = await repo.createTicket(input({ department: "housekeeping" }));
    clock = min(30);
    const r = (await repo.reassignDepartment(P, t.id, "maintenance"))!;
    expect(r.department).toBe("maintenance");
    expect(r.slaDueAt).toBe(t.slaDueAt);
    expect(r.slaMinutes).toBe(t.slaMinutes);
  });
});

describe("estado", () => {
  it("transiciones validas, terminales inmutables, closed_at y nota", async () => {
    const t = await repo.createTicket(input());
    await repo.setStatus(P, t.id, "en_progreso", null);
    const c = (await repo.setStatus(P, t.id, "cerrado", "Resuelto"))!;
    expect(c).toMatchObject({ status: "cerrado", resolutionNote: "Resuelto" });
    expect(c.closedAt).not.toBeNull();
    await expect(repo.setStatus(P, t.id, "en_progreso", null)).rejects.toBeInstanceOf(TicketInvalidInputError);
    await expect(repo.reassignDepartment(P, t.id, "fnb")).rejects.toBeInstanceOf(TicketInvalidInputError);
  });

  it("en_progreso no regresa a abierto", async () => {
    const t = await repo.createTicket(input());
    await repo.setStatus(P, t.id, "en_progreso", null);
    await expect(repo.setStatus(P, t.id, "abierto", null)).rejects.toBeInstanceOf(TicketInvalidInputError);
  });

  it("ticket de otra property: null (no se filtra entre tenants)", async () => {
    const t = await repo.createTicket(input());
    expect(await repo.findTicket("otra", t.id)).toBeNull();
    expect(await repo.setStatus("otra", t.id, "cerrado", null)).toBeNull();
  });
});

describe("desde resena", () => {
  const review = { id: "rev-1", propertyId: P, source: "google", texto: "Sucio", calificacion: 1, sentiment: "muy_negativo", topics: [{ topic: "limpieza", menciones: 1 }], createdAt: "2026-03-09T00:00:00.000Z" };

  it("lista solo las resenas con queja sin ticket y un segundo ticket activo da conflicto", async () => {
    repo.seedReview(review);
    repo.seedReview({ ...review, id: "rev-pos", sentiment: "positivo" });
    expect((await repo.listReviewsPendingTicket(P, 10)).resenas.map((r) => r.id)).toEqual(["rev-1"]);
    await repo.createTicket(input({ guestReviewId: "rev-1", channel: "resena" }));
    expect((await repo.listReviewsPendingTicket(P, 10)).resenas).toEqual([]);
    await expect(repo.createTicket(input({ guestReviewId: "rev-1", channel: "resena" }))).rejects.toBeInstanceOf(TicketConflictError);
  });

  it("guestReviewId exige canal resena", async () => {
    await expect(repo.createTicket(input({ guestReviewId: "rev-1", channel: "staff" }))).rejects.toBeInstanceOf(TicketInvalidInputError);
  });
});

describe("barrido de SLA", () => {
  it("al 75% solo avisa (sin escalar) y es idempotente", async () => {
    const t = await repo.createTicket(input());
    expect(await repo.sweepSla(P, min(60))).toEqual([]);
    const aviso = await repo.sweepSla(P, min(100));
    expect(aviso).toEqual([{ ticketId: t.id, kind: "aviso_sla", department: "frontdesk", priority: "media", assignedTo: null }]);
    expect((await repo.findTicket(P, t.id))!).toMatchObject({ status: "abierto", slaWarningNotifiedAt: min(100).toISOString() });
    expect(await repo.sweepSla(P, min(100))).toEqual([]);
  });

  it("al vencer escala a gerente/dueno, deja bitacora de sistema y no vuelve a tocarlo", async () => {
    const t = await repo.createTicket(input());
    const out = await repo.sweepSla(P, min(121));
    expect(out).toMatchObject([{ ticketId: t.id, kind: "escalado" }]);
    expect(await repo.findTicket(P, t.id)).toMatchObject({ status: "escalado", escalatedToRoles: ["gm", "owner"], escalatedAt: min(121).toISOString() });
    expect(repo.eventsOf(t.id).find((e) => e.eventType === "escalado")).toMatchObject({ actorId: null, detail: { origen: "sla_vencido" } });
    expect(await repo.sweepSla(P, min(500))).toEqual([]);
  });

  it("ignora tickets cerrados y los de otra property", async () => {
    const t = await repo.createTicket(input());
    await repo.setStatus(P, t.id, "cerrado", null);
    await repo.createTicket(input({ propertyId: "otra" }));
    expect(await repo.sweepSla(P, min(500))).toEqual([]);
  });
});

describe("base sin migrar 034", () => {
  it("lecturas vacias honestas y escrituras 503 (TicketUnavailableError)", async () => {
    repo.migrated = false;
    expect(await repo.listTickets(P, {})).toEqual({ disponible: false, tickets: [] });
    expect(await repo.listSlaPolicies(P)).toEqual({ disponible: false, politicas: [] });
    await expect(repo.createTicket(input())).rejects.toBeInstanceOf(TicketUnavailableError);
    await expect(repo.sweepSla(P, T0)).rejects.toBeInstanceOf(TicketUnavailableError);
  });
});
