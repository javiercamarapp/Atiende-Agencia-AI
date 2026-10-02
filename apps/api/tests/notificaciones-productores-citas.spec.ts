// Productor `citas.recordatorio.fallido`: el cron del recordatorio de 24 h avisa (una por organizacion por dia, solo el conteo) cuando
// algun recordatorio no salio; sin fallos no emite, y una emision que falla (base sin 0039) no cambia el barrido ni el 200.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function seedCita(ctx: CitasTestContext, phone: string): Promise<string> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, phone, "Cliente de prueba", null);
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  ctx.citasRepo.seedAppointment({
    id,
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
  return id;
}

/** Hace fallar con un error real de Postgres el encolado del recordatorio de UN telefono. */
function envenenar(ctx: CitasTestContext, phone: string) {
  const original = ctx.citasRepo.enqueueMessagingOutbox.bind(ctx.citasRepo);
  return vi.spyOn(ctx.citasRepo, "enqueueMessagingOutbox").mockImplementation(async (organizationId, channel, eventType, dedupeKey, payload) => {
    if ((payload as { to?: string }).to === phone) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    return original(organizationId, channel, eventType, dedupeKey, payload);
  });
}

const cron = (app: ReturnType<typeof buildApp>, secret: string) => app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": secret } });

describe("citas.recordatorio.fallido", () => {
  it("un recordatorio que falla emite UNA por organizacion con el conteo, sin datos de la cita ni del cliente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedCita(ctx, "9990000011");
    await seedCita(ctx, "9990000012");
    const spy = envenenar(ctx, "9990000011");
    const res = await cron(buildApp(deps), ctx.deps.env.internalSecret);
    spy.mockRestore();
    expect(res.status).toBe(200);
    // Los avisos de ciclo de C-16 (por_confirmar, etc.) comparten el cron: aqui solo interesa este evento.
    const mias = emisiones.filter((e) => e.organizationId === ctx.organizationId && e.evento === "citas.recordatorio.fallido");
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ evento: "citas.recordatorio.fallido", categoria: "salud", severidad: "atencion", cuerpo: "Sin enviar: 1.", enlace: "/citas/{orgSlug}/mensajes-whatsapp", roles: null });
    expect(mias[0]!.dedupeKey).toBe(`citas.recordatorio.fallido:${ctx.organizationId}:${new Date().toISOString().slice(0, 10)}`);
    expect(JSON.stringify(mias[0])).not.toContain("99900000");
  });

  it("sin recordatorios fallidos no emite", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedCita(ctx, "9990000013");
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    expect(emisiones.filter((e) => e.evento === "citas.recordatorio.fallido")).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) deja el 200 del barrido y su detalle intactos", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    await seedCita(ctx, "9990000014");
    const spy = envenenar(ctx, "9990000014");
    const res = await cron(buildApp(deps), ctx.deps.env.internalSecret);
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { failures: unknown[] }).failures).toHaveLength(1);
  });
});
