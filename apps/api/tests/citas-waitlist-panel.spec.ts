// POST /v1/citas/properties/:propertyId/waitlist (inscripcion desde el panel): el telefono se guarda en la misma forma canonica que el agente y las citas
// (ultimos 10 digitos), para que el aviso al liberar un horario llegue a la conversacion real del cliente, y el proveedor debe ser de la sucursal de la ruta.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildCitasTestContext } from "./citas-fixtures.ts";
import type { CitasTestContext } from "./citas-fixtures.ts";

function segundaSucursal(ctx: CitasTestContext) {
  const propertyB = randomUUID();
  ctx.engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  ctx.citasRepo.seedCitasProperty({ id: propertyB, organizationId: ctx.organizationId, name: "Sucursal Norte" });
  const providerB = randomUUID();
  ctx.citasRepo.seedProvider({ id: providerB, organizationId: ctx.organizationId, propertyId: propertyB, displayName: "Dr. Norte", roleLabel: "Dentista", isActive: true });
  ctx.citasRepo.seedProviderService(providerB, ctx.serviceId);
  ctx.citasRepo.seedProvider({ id: ctx.providerId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, displayName: "Dra. Fernanda López", roleLabel: "Dentista", isActive: true });
  return { propertyB, providerB };
}

describe("POST /v1/citas/properties/:propertyId/waitlist (panel)", () => {
  it("guarda el telefono canonico (10 digitos) aunque el staff lo teclee con formato, y reintentar con otro formato no duplica", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = ctx.staff.owner.token;
    const a = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, authedJson(owner, { customer_name: "Ana", customer_phone: "+52 (999) 111-2233" }));
    expect(a.status).toBe(201);
    expect(((await a.json()) as { waitlist_entry: { customer_phone: string } }).waitlist_entry.customer_phone).toBe("9991112233");
    const b = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, authedJson(owner, { customer_name: "Ana", customer_phone: "9991112233" }));
    expect(b.status).toBe(200);
    expect(((await b.json()) as { created: boolean }).created).toBe(false);
    expect((await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).map((w) => w.customerPhone)).toEqual(["9991112233"]);
  });

  it("un telefono que no es un numero (menos de 7 digitos) es 400 y no escribe nada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, authedJson(ctx.staff.owner.token, { customer_phone: "hola" }));
    expect(res.status).toBe(400);
    expect(await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).toHaveLength(0);
  });

  it("el proveedor debe ser de la sucursal de la ruta: el de otra sucursal es 400, el propio es 201", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { propertyB, providerB } = segundaSucursal(ctx);
    const owner = ctx.staff.owner.token;
    const ajeno = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, authedJson(owner, { customer_phone: "9991112233", provider_id: providerB }));
    expect(ajeno.status).toBe(400);
    const propio = await app.request(`/v1/citas/properties/${propertyB}/waitlist`, authedJson(owner, { customer_phone: "9991112233", provider_id: providerB }));
    expect(propio.status).toBe(201);
    expect(await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).toHaveLength(1);
  });
});
