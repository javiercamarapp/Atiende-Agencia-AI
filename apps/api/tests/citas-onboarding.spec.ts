// C-06 -- GET /v1/citas/properties/:propertyId/onboarding (checklist derivado en el servidor) y la puerta de la reserva
// publica, sobre la app Hono real (InMemoryCitasRepository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

interface PasoBody {
  id: string;
  estado: string;
  requeridoParaPublicar: boolean;
  ruta: string;
}
interface ChecklistBody {
  propertyId: string;
  pasos: PasoBody[];
  completados: number;
  total: number;
  progresoPct: number;
  faltanParaPublicar: string[];
  listoParaRecibirCitas: boolean;
}

const MONDAY_10AM_MERIDA = "2027-09-13T16:00:00.000Z";

describe("GET /v1/citas/properties/:propertyId/onboarding", () => {
  it("owner y admin ven el checklist real de su negocio", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const staff of [ctx.staff.owner, ctx.staff.admin]) {
      const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/onboarding`, { headers: { authorization: `Bearer ${staff.token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChecklistBody;
      expect(body.propertyId).toBe(ctx.propertyId);
      expect(body.total).toBe(9);
      expect(body.listoParaRecibirCitas).toBe(true);
      expect(body.faltanParaPublicar).toEqual([]);
      expect(body.pasos.find((p) => p.id === "whatsapp")?.estado).toBe("completo");
      expect(body.pasos.find((p) => p.id === "cita_prueba")?.estado).toBe("pendiente");
      expect(body.pasos.filter((p) => p.requeridoParaPublicar).map((p) => p.id)).toEqual(["proveedor", "servicio", "asignacion", "horario"]);
    }
  });

  it("el estado sale de los datos: al desactivar el proveedor el negocio deja de estar listo", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.updateProvider(ctx.organizationId, ctx.providerId, { isActive: false });
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/onboarding`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const body = (await res.json()) as ChecklistBody;
    expect(body.listoParaRecibirCitas).toBe(false);
    expect(body.faltanParaPublicar).toContain("proveedor");
    expect(body.progresoPct).toBeLessThan(100);
  });

  it("el rol staff recibe 403 (solo owner/admin)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/onboarding`, { headers: { authorization: `Bearer ${ctx.staff.staffMember.token}` } });
    expect(res.status).toBe(403);
  });

  it("sin JWT da 401 y una sucursal ajena no responde 200", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/onboarding`)).status).toBe(401);
    const ajena = await app.request(`/v1/citas/properties/${randomUUID()}/onboarding`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect([403, 404]).toContain(ajena.status);
  });

  it("ignora cualquier estado que mande el cliente (query/body no cambian el resultado)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.updateProvider(ctx.organizationId, ctx.providerId, { isActive: false });
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/onboarding?listoParaRecibirCitas=true&completados=9`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(((await res.json()) as ChecklistBody).listoParaRecibirCitas).toBe(false);
  });
});

describe("puerta de la reserva publica (canal web)", () => {
  it("un negocio sin el minimo responde 409 claro y no registra al cliente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.citasRepo.seedOrganization({ id: randomUUID(), slug: "sin-configurar", name: "Sin configurar", defaultTimezone: "America/Merida" });
    const org = await ctx.citasRepo.findOrganizationBySlug("sin-configurar");
    const res = await app.request(
      "/v1/citas/sin-configurar/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("todavía no está listo para recibir reservas");
    expect(await ctx.citasRepo.findCustomerByPhone(org!.id, "9991112233")).toBeNull();
  });

  it("un negocio listo sigue reservando igual (201)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA, source: "web" }),
    );
    expect(res.status).toBe(201);
  });

  it("al desactivar al unico proveedor, la web se cierra pero el agente (secreto de herramientas) no pasa por la puerta", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.updateProvider(ctx.organizationId, ctx.providerId, { isActive: false });
    const body = { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: MONDAY_10AM_MERIDA };
    const web = await app.request("/v1/citas/clinica-dental-sonrisas/appointments", jsonRequestInit({ ...body, source: "web" }));
    expect(web.status).toBe(409);
    expect(JSON.stringify(await web.json())).toContain("todavía no está listo para recibir reservas");
    const voz = await app.request("/v1/citas/clinica-dental-sonrisas/appointments", jsonRequestInit({ ...body, source: "voice" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }));
    expect(JSON.stringify(await voz.json())).not.toContain("todavía no está listo para recibir reservas");
  });
});
