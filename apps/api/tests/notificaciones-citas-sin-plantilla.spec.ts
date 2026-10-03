// Productor `citas.whatsapp.sin_plantilla` (PL-31): el cron del recordatorio de 24 h avisa (una por organizacion, evento y dia, solo el
// conteo) cuando un WhatsApp no salio por falta de plantilla aprobada fuera de la ventana de 24 h; con plantilla o dentro de la ventana no emite.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function seedCita(ctx: CitasTestContext, phone: string): Promise<void> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, phone, "Cliente de prueba", null);
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  ctx.citasRepo.seedAppointment({
    id: randomUUID(),
    organizationId: ctx.organizationId,
    propertyId: null,
    providerId: ctx.providerId,
    serviceId: ctx.serviceId,
    customerId: customer.id,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
    status: "pending",
    source: "web",
    notes: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    reminder24hSentAt: null,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    googleEventId: null,
    googleSyncStatus: "skipped",
    googleSyncAttempts: 0,
    googleSyncNextRetryAt: null,
    googleSyncError: null,
  });
}

const cron = (app: ReturnType<typeof buildApp>, secret: string) => app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": secret } });
const sinPlantilla = (emisiones: readonly { evento: string; organizationId?: string | null; dedupeKey?: string }[], org: string) => emisiones.filter((e) => e.organizationId === org && e.evento === "citas.whatsapp.sin_plantilla");

describe("citas.whatsapp.sin_plantilla", () => {
  it("sin plantilla aprobada y fuera de la ventana: emite UNA por organizacion y dia con el conteo, sin datos del cliente, y no encola WhatsApp", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    ctx.citasRepo.habilitarPlantillasYVentanaWhatsapp();
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedCita(ctx, "9990000021");
    await seedCita(ctx, "9990000022");
    const res = await cron(buildApp(deps), ctx.deps.env.internalSecret);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sin_plantilla: number }).sin_plantilla).toBe(2);
    const mias = sinPlantilla(emisiones, ctx.organizationId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ evento: "citas.whatsapp.sin_plantilla", categoria: "salud", severidad: "atencion", enlace: "/citas/{orgSlug}/mensajes-whatsapp", roles: null });
    expect(String((mias[0] as { cuerpo?: string }).cuerpo)).toContain("2");
    expect(mias[0]!.dedupeKey).toBe(`citas.whatsapp.sin_plantilla:${ctx.organizationId}:appointment.reminder_24h:${new Date().toISOString().slice(0, 10)}`);
    expect(JSON.stringify(mias[0])).not.toContain("99900000");
    expect(ctx.citasRepo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(0);
  });

  it("con plantilla aprobada del evento no emite y el WhatsApp sale con template", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    ctx.citasRepo.habilitarPlantillasYVentanaWhatsapp();
    ctx.citasRepo.seedPlantillaWhatsappAprobada(ctx.organizationId, "appointment.reminder_24h", { name: "recordatorio_cita_24h", language: "es_MX", variables: ["nombre"] });
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedCita(ctx, "9990000023");
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    expect(sinPlantilla(emisiones, ctx.organizationId)).toHaveLength(0);
    const wa = ctx.citasRepo.getOutbox().filter((o) => o.channel === "whatsapp");
    expect(wa).toHaveLength(1);
    expect((wa[0]!.payload as { template: { name: string } }).template.name).toBe("recordatorio_cita_24h");
  });

  it("base sin la migracion 0048 (comportamiento anterior): no emite y el WhatsApp sale como siempre", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedCita(ctx, "9990000024");
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    expect(sinPlantilla(emisiones, ctx.organizationId)).toHaveLength(0);
    expect(ctx.citasRepo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(1);
  });
});
