// Test de integración end-to-end del flujo 3 (REQ-REV-001/REQ-RES-002: motor de
// cotización determinista, guardia anti-alucinación de precio) — HTTP real.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

describe("POST /hoteles/:propertyId/quotes", () => {
  it("cotiza 2 noches reales desde hoteles.rate_plan, con impuestos calculados server-side", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nights: number; netAmount: number; totalAmount: number };
    expect(body.nights).toBe(2);
    expect(body.netAmount).toBe(3000);
    expect(body.totalAmount).toBe(3000 * 1.19);
  });

  it("un precio/total inyectado en el body es ignorado por completo -- el guardia anti-alucinación es estructural", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.frontdesk.token, {
        roomTypeId: ctx.roomTypeId,
        checkInDate: "2026-12-01",
        checkOutDate: "2026-12-02",
        // Campos que NO existen en el contrato de la ruta -- deben ser ignorados sin
        // error y sin afectar el cálculo, nunca usados como precio.
        totalAmount: 1,
        llmSuggestedPrice: 1,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { netAmount: number };
    expect(body.netAmount).toBe(1500); // el precio real de rate_plan, no el "1" inyectado
  });

  it("sin tarifa configurada para una noche dentro de la estadía -> 409 sin_tarifa", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // La fixture solo siembra rate_plan hasta 2026-12-03: la noche de llegada
    // (2026-12-03) SÍ tiene tarifa, pero la siguiente (2026-12-04) no -- exactamente
    // el caso real de "sin_tarifa" (huésped pide más noches de las que el hotel
    // cargó tarifa), distinto de "el rango completo no tiene ninguna fila" (eso es un
    // 400 de validación de forma, ver el siguiente test).
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-03", checkOutDate: "2026-12-05" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "sin_tarifa" });
  });

  it("sin NINGUNA tarifa en todo el rango pedido -> 400 (nada que cotizar, ni una fila real)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2027-01-01", checkOutDate: "2027-01-02" }),
    );
    expect(res.status).toBe(400);
  });

  it("un tipo de habitación que no pertenece a esta property -> 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: "00000000-0000-4000-8000-000000000000", checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }),
    );
    expect(res.status).toBe(404);
  });

  it("housekeeping (sin restricción de rol fino en quotes -- cualquier miembro del staff puede cotizar) SÍ puede cotizar", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/quotes`,
      authedJson(ctx.staff.housekeeping.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }),
    );
    expect(res.status).toBe(200);
  });
});
