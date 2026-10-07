// QA-citas-R1-agentes-18: POST /v1/citas/properties/:propertyId/waitlist -- la puerta de entrada de la lista de espera (staff, sesion con RLS).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const diaEnDias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function montar() {
  const ctx = await buildCitasTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const post = (body: unknown, token: string | null = ctx.staff.owner.token, propertyId = ctx.propertyId) =>
    app.request(`/v1/citas/properties/${propertyId}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  return { ctx, app, post };
}

type Entrada = { entry: { id: string; position: number; customer_name: string; customer_phone: string; provider_id: string | null; service_id: string | null; preferred_time_window: string }; already_enrolled: boolean };

describe("POST /v1/citas/properties/:propertyId/waitlist", () => {
  it("inscribe a un cliente: 201, queda en la lista viva con su posicion y el telefono normalizado", async () => {
    const { ctx, app, post } = await montar();
    const res = await post({ customer_name: "Mario Chan", customer_phone: "+52 999 123 4567", provider_id: ctx.providerId, service_id: ctx.serviceId, preferred_time_window: "morning", preferred_date_from: diaEnDias(1), preferred_date_to: diaEnDias(5) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Entrada;
    expect(body.already_enrolled).toBe(false);
    expect(body.entry).toMatchObject({ position: 1, customer_name: "Mario Chan", customer_phone: "9991234567", provider_id: ctx.providerId, service_id: ctx.serviceId, preferred_time_window: "morning" });

    const lista = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const { waitlist } = (await lista.json()) as { waitlist: readonly { id: string }[] };
    expect(waitlist.map((w) => w.id)).toContain(body.entry.id);
  });

  it("repetir la misma alta es idempotente: 200, la misma entrada y sin duplicar ni auditar otra vez", async () => {
    const { ctx, post } = await montar();
    const cuerpo = { customer_name: "Mario Chan", customer_phone: "9991234567", service_id: ctx.serviceId };
    const a = (await (await post(cuerpo)).json()) as Entrada;
    const res = await post(cuerpo);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Entrada;
    expect(b.already_enrolled).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    expect(ctx.citasRepo.auditLog.filter((r) => r.action === "lista_espera.alta_manual")).toHaveLength(1);
  });

  it("la bitacora guarda quien la anoto y a que, sin nombre ni telefono del cliente", async () => {
    const { ctx, post } = await montar();
    await post({ customer_name: "Mario Chan", customer_phone: "9991234567", provider_id: ctx.providerId });
    const fila = ctx.citasRepo.auditLog.find((r) => r.action === "lista_espera.alta_manual")!;
    expect(fila.organizationId).toBe(ctx.organizationId);
    expect(JSON.stringify(fila)).not.toMatch(/Mario|9991234567/);
  });

  it("el orden es FIFO: la segunda inscripcion queda en la posicion 2", async () => {
    const { post } = await montar();
    await post({ customer_name: "Uno", customer_phone: "9990000001" });
    const dos = (await (await post({ customer_name: "Dos", customer_phone: "9990000002" })).json()) as Entrada;
    expect(dos.entry.position).toBe(2);
  });

  it.each([
    ["sin nombre", { customer_phone: "9990000001" }],
    ["nombre vacio", { customer_name: "  ", customer_phone: "9990000001" }],
    ["sin telefono", { customer_name: "Ana" }],
    ["telefono inutil", { customer_name: "Ana", customer_phone: "123" }],
    ["franja invalida", { customer_name: "Ana", customer_phone: "9990000001", preferred_time_window: "madrugada" }],
    ["fecha mal formada", { customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: "mañana" }],
    ["fecha imposible", { customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: "2099-02-30" }],
    ["hasta antes que desde", { customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: diaEnDias(5), preferred_date_to: diaEnDias(2) }],
    ["fechas ya pasadas", { customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: diaEnDias(-10), preferred_date_to: diaEnDias(-5) }],
  ])("400 %s", async (_nombre, cuerpo) => {
    const { ctx, post } = await montar();
    const res = await post(cuerpo);
    expect(res.status).toBe(400);
    expect(await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).toHaveLength(0);
  });

  it("400 si el proveedor o el servicio no son de este negocio", async () => {
    const { ctx, post } = await montar();
    expect((await post({ customer_name: "Ana", customer_phone: "9990000001", provider_id: randomUUID() })).status).toBe(400);
    expect((await post({ customer_name: "Ana", customer_phone: "9990000001", service_id: randomUUID() })).status).toBe(400);
    expect(await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).toHaveLength(0);
  });

  it("tope: un mismo telefono no puede tener mas de 5 lugares vivos", async () => {
    const { ctx, post } = await montar();
    for (let i = 1; i <= 5; i++) expect((await post({ customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: diaEnDias(i) })).status).toBe(201);
    const res = await post({ customer_name: "Ana", customer_phone: "9990000001", preferred_date_from: diaEnDias(9) });
    expect(res.status).toBe(400);
    expect(await ctx.citasRepo.loadLiveWaitlistCandidates(ctx.organizationId)).toHaveLength(5);
  });

  it("401 sin sesion y 403 para un staff que no pertenece a esa sucursal", async () => {
    const { post } = await montar();
    expect((await post({ customer_name: "Ana", customer_phone: "9990000001" }, null)).status).toBe(401);
    expect((await post({ customer_name: "Ana", customer_phone: "9990000001" }, undefined, randomUUID())).status).toBe(403);
  });

  it("una entrada de otra organizacion no cuenta para el tope ni para la idempotencia (aislamiento por tenant)", async () => {
    const { ctx, post } = await montar();
    ctx.citasRepo.seedWaitlistEntry({ organizationId: randomUUID(), customerPhone: "9990000001", customerName: "Ana", providerId: null, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    const res = await post({ customer_name: "Ana", customer_phone: "9990000001" });
    expect(res.status).toBe(201);
  });
});
