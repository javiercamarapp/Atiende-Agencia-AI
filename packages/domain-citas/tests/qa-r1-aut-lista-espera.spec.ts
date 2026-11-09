// QA ronda 1 (citas, lente AUTOMATIZACION) -- lista de espera: hueco pasado y cupo de aviso (05, 06). Reloj simulado (`now` explicito) sobre InMemoryCitasRepository
// (replica `citas.enqueue_messaging_outbox`: on conflict solo actualiza filas pending/failed).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { runOptimizadorCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MERIDA = "America/Merida";

// Reloj fijo: los huecos del escenario son del 21-oct-2026 y el de 05 se calcula como 'ayer' respecto de este instante.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Drena el canal de WhatsApp como lo haria el dispatcher con Meta respondiendo 200. */
async function despacharWhatsApp(repo: InMemoryCitasRepository): Promise<{ id: string; payload: unknown }[]> {
  const items = await repo.claimMessagingOutboxBatch(100, 120);
  for (const it of items) await repo.markMessagingOutboxSent(it.id);
  return items.map((i) => ({ id: i.id, payload: i.payload }));
}


describe("QA-citas-R1-automatizacion-05: lista de espera -- hueco que ya paso", () => {
  it("cancelar una cita cuyo horario ya paso no ofrece ese hueco a la lista de espera", async () => {
    const { repo, organizationId, providerId } = buildCitasFixture();
    repo.seedWaitlistEntry({ organizationId, customerPhone: "9995500001", customerName: "Ivan", providerId: null, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const ayer = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const r = await runOptimizadorCore(repo, organizationId, MERIDA, { providerId, startsAt: ayer });
    expect(r.matched).toBe(false);
    expect(repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(0);
  });
});

describe("QA-citas-R1-automatizacion-06: lista de espera -- cupo de aviso consumido sin mensaje", () => {
  it("el mismo hueco liberado dos veces no gasta un segundo aviso del cliente si no se le envia nada nuevo", async () => {
    const { repo, organizationId, providerId } = buildCitasFixture();
    const id = repo.seedWaitlistEntry({ organizationId, customerPhone: "9995500002", customerName: "Juana", providerId: null, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const evento = { providerId, startsAt: zonedTimeToUtc("2026-10-21", "10:00", MERIDA).toISOString() };
    await runOptimizadorCore(repo, organizationId, MERIDA, evento);
    await despacharWhatsApp(repo);
    // Otra persona toma el hueco y vuelve a cancelar: el MISMO hueco se libera otra vez.
    await runOptimizadorCore(repo, organizationId, MERIDA, evento);
    const mensajes = repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered");
    const entrada = repo.getWaitlistEntry(id)!;
    // Invariante: avisos consumidos == mensajes realmente encolados para el cliente.
    expect(entrada.notifiedCount).toBe(mensajes.length);
  });
});
