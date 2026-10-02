// H-28 / H-12 -- "hoy" es el dia de NEGOCIO de la property, no el dia UTC del servidor: a las 23:30 en CDMX (UTC-6) y en Cancun
// (UTC-5) el dia UTC ya es manana. Con el reloj simulado en esa frontera, una llegada de "hoy" (local) es valida y la de "ayer" no,
// tanto en el cambio de fechas como al agregar a la lista de espera. Debe pasar IGUAL con cualquier TZ del proceso (clock-guard).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCambioFechasRepository, InMemoryListaEsperaRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

const CASOS = [
  { zona: "America/Mexico_City", ahora: "2026-11-21T05:30:00Z", hoy: "2026-11-20", ayer: "2026-11-19" }, // 23:30 CDMX del 20 nov
  { zona: "America/Cancun", ahora: "2026-11-21T04:30:00Z", hoy: "2026-11-20", ayer: "2026-11-19" }, // 23:30 Cancun del 20 nov
];

describe.each(CASOS)("reloj simulado 23:30 en $zona (el dia UTC ya es el siguiente)", ({ zona, ahora, hoy, ayer }) => {
  async function setup() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(ahora));
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.hotelesRepo.upsertPropertyTimezone(ctx.propertyId, ctx.organizationId, zona, ctx.staff.owner.id);
    const dias = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 10, 18 + i)).toISOString().slice(0, 10));
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, dias.map((date) => ({ date, price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false })));
    for (const d of dias) ctx.hotelesRepo.seedAvailability(ctx.propertyId, ctx.roomTypeId, d, 3, 0);
    const app = buildApp({ ...ctx.deps, hotelesFechasRepo: () => new InMemoryCambioFechasRepository(ctx.hotelesRepo), hotelesListaEsperaRepo: () => new InMemoryListaEsperaRepository() });
    return { ctx, app };
  }

  it("lista de espera: una llegada de hoy (local) se acepta y la de ayer no", async () => {
    const { ctx, app } = await setup();
    const url = `/hoteles/${ctx.propertyId}/lista-espera`;
    const cuerpo = (entrada: string, salida: string) => ({ roomTypeId: ctx.roomTypeId, checkInDate: entrada, checkOutDate: salida, huespedes: 1, nombre: "Ana Torres", telefono: "5511112222" });
    expect((await app.request(url, authedJson(ctx.staff.frontdesk.token, cuerpo(hoy, "2026-11-22")))).status).toBe(201);
    expect((await app.request(url, authedJson(ctx.staff.frontdesk.token, cuerpo(ayer, "2026-11-22")))).status).toBe(400);
  });

  it("cambio de fechas: mover la llegada a hoy (local) es valido; a ayer queda bloqueado como llegada_pasada", async () => {
    const { ctx, app } = await setup();
    const id = randomUUID();
    ctx.hotelesRepo.seedReservation({ id, organizationId: ctx.organizationId, propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, guestId: ctx.guestId, checkInDate: "2026-11-22", checkOutDate: "2026-11-24", status: "confirmada", totalAmount: 2000, cancellationPenaltyAmount: null, canceledAt: null, createdAt: ahora, roomId: null });
    const previsualizar = async (entrada: string, salida: string) =>
      (await (await app.request(`/hoteles/${ctx.propertyId}/reservas/${id}/fechas/previsualizar`, authedJson(ctx.staff.frontdesk.token, { checkInDate: entrada, checkOutDate: salida }))).json()) as { puedeCambiar: boolean; bloqueos: { codigo: string }[] };
    expect((await previsualizar(hoy, "2026-11-24")).puedeCambiar).toBe(true);
    const pasada = await previsualizar(ayer, "2026-11-24");
    expect(pasada.puedeCambiar).toBe(false);
    expect(pasada.bloqueos.map((b) => b.codigo)).toContain("llegada_pasada");
  });
});
