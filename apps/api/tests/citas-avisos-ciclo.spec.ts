// C-16 -- avisos in-app del ciclo de citas que nacen de un BARRIDO (cron de recordatorios, cada 30 min): citas por confirmar, recordatorios
// agotados y escalaciones sin seguimiento. Una emision por categoria con el conteo (sin PII), dedupe estable, una transaccion POR organizacion y
// best-effort: nunca cambia el 200 del cron. Base sin migrar: no emite y no rompe.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { zonedDateStr } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { emitirAvisosDeCitas } from "../src/routes/verticals/citas/avisos-ciclo.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const cron = (app: ReturnType<typeof buildApp>, secret: string) => app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": secret } });

async function seedPendiente(ctx: CitasTestContext, horas: number): Promise<void> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, `99800${Math.floor(Math.random() * 1e6)}`, "Cliente Privado", null);
  const startsAt = new Date(Date.now() + horas * 3_600_000).toISOString();
  ctx.citasRepo.seedAppointment({
    id: randomUUID(), organizationId: ctx.organizationId, propertyId: null, providerId: ctx.providerId, serviceId: ctx.serviceId, customerId: customer.id,
    startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(), status: "pending", source: "web", notes: null, dedupeFingerprint: null, idempotencyKey: null,
    reminder24hSentAt: null, createdAt: new Date().toISOString(), googleEventId: null, googleSyncStatus: "skipped", googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null,
  });
}

afterEach(() => vi.useRealTimers());

describe("barrido de avisos de citas (cron de recordatorios)", () => {
  it("citas pendientes que empiezan en 48 h: UNA emision citas.cita.por_confirmar con el conteo, sin datos del cliente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedPendiente(ctx, 100); // fuera de las 48 h: no cuenta
    await seedPendiente(ctx, 30);
    await seedPendiente(ctx, 40);
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    const mias = emisiones.filter((e) => e.organizationId === ctx.organizationId && e.evento === "citas.cita.por_confirmar");
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ categoria: "operacion", severidad: "atencion", titulo: "Citas por confirmar en las próximas 48 horas", cuerpo: "Por confirmar: 2.", enlace: "/citas/{orgSlug}/avisos", roles: ["staff"] });
    expect(mias[0]!.dedupeKey).toBe(`citas.cita.por_confirmar:${ctx.organizationId}:${zonedDateStr(new Date(), "America/Merida")}`);
    expect(JSON.stringify(mias[0])).not.toMatch(/Cliente Privado|99800/);
  });

  it("recordatorio agotado (dead): emision citas.recordatorio.agotado con clave = instante del ultimo agotado (no repite el mismo conteo)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await ctx.citasRepo.enqueueMessagingOutbox(ctx.organizationId, "whatsapp", "appointment.reminder_24h", "reminder-24h:z", { to: "x" });
    const [fila] = await ctx.citasRepo.claimMessagingOutboxBatch(5, 60);
    await ctx.citasRepo.markMessagingOutboxDead(fila!.id, 5, "http_500");
    await cron(buildApp(deps), ctx.deps.env.internalSecret);
    await cron(buildApp(deps), ctx.deps.env.internalSecret);
    const mias = emisiones.filter((e) => e.evento === "citas.recordatorio.agotado" && e.organizationId === ctx.organizationId);
    expect(mias).toHaveLength(2); // el productor se invoca en cada corrida; el DEDUPE lo resuelve la base con la MISMA clave
    expect(new Set(mias.map((m) => m.dedupeKey)).size).toBe(1);
    expect(mias[0]).toMatchObject({ categoria: "salud", cuerpo: "Agotaron sus reintentos: 1.", roles: null });
    expect(mias[0]!.dedupeKey).toMatch(new RegExp(`^citas\\.recordatorio\\.agotado:${ctx.organizationId}:\\d{10}$`));
  });

  it("escalacion de crisis con mas de 1 h sin seguimiento: citas.escalacion.sin_seguimiento critica; con seguimiento ya no", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const esc = await ctx.citasRepo.insertEmergencyEscalation({ organizationId: ctx.organizationId, customerPhone: "+5219980000000", channel: "whatsapp", keywordMatched: "k", messageExcerpt: "m" });
    vi.setSystemTime(new Date("2026-10-01T12:30:00.000Z"));
    await cron(buildApp(deps), ctx.deps.env.internalSecret);
    expect(emisiones.filter((e) => e.evento === "citas.escalacion.sin_seguimiento")).toHaveLength(0); // aun no pasa 1 h
    vi.setSystemTime(new Date("2026-10-01T14:00:00.000Z"));
    await cron(buildApp(deps), ctx.deps.env.internalSecret);
    const mias = emisiones.filter((e) => e.evento === "citas.escalacion.sin_seguimiento");
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ severidad: "critica", cuerpo: "Sin seguimiento: 1.", enlace: "/citas/{orgSlug}/avisos", roles: null, dedupeKey: `citas.escalacion.sin_seguimiento:${ctx.organizationId}:2026-10-01` });
    await ctx.citasRepo.setEscalacionSeguimiento(ctx.organizationId, esc.id, "in_progress", null);
    await cron(buildApp(deps), ctx.deps.env.internalSecret);
    expect(emisiones.filter((e) => e.evento === "citas.escalacion.sin_seguimiento")).toHaveLength(1);
  });

  it("sin nada que avisar no emite", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    expect(emisiones.filter((e) => /^citas\.(cita\.por_confirmar|recordatorio\.agotado|escalacion\.sin_seguimiento)$/.test(e.evento))).toHaveLength(0);
  });

  it("base sin migrar (resumen null): no emite y el cron responde 200", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedPendiente(ctx, 30);
    ctx.citasRepo.avisosMigrationPending = true;
    expect((await cron(buildApp(deps), ctx.deps.env.internalSecret)).status).toBe(200);
    expect(emisiones.filter((e) => e.evento === "citas.cita.por_confirmar")).toHaveLength(0);
  });

  it("una emision que falla (base sin 0039, 42883) deja el 200 y el detalle del barrido intactos", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification(uuid, uuid, text) does not exist"), { code: "42883" });
      },
    });
    await seedPendiente(ctx, 30);
    const res = await cron(buildApp(deps), ctx.deps.env.internalSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, failures: [] });
  });
});

describe("emitirAvisosDeCitas: una transaccion por organizacion", () => {
  function depsFalsos(resumen: (orgId: string) => Promise<unknown>) {
    const llamadasEmit: string[] = [];
    let sesiones = 0;
    const session: TenantDbSession = {
      exec: async () => undefined,
      query: async <T>(sql: string, params?: unknown[]) => {
        if (/core\.emit_notification/.test(sql)) llamadasEmit.push(String(params?.[0]));
        return { rows: [{ emit_notification: 1 }] as unknown as T[] };
      },
    };
    const deps = {
      engine: { withAppSession: async <T>(_c: unknown, fn: (s: TenantDbSession) => Promise<T>) => { sesiones += 1; return fn(session); } },
      citasRepo: () => ({ systemAvisosResumen: resumen }) as unknown as CitasRepository,
    };
    return { deps: deps as unknown as Parameters<typeof emitirAvisosDeCitas>[0], llamadasEmit, sesiones: () => sesiones };
  }

  it("el error real de UNA organizacion no frena a las demas ni se propaga; cada una usa su propia sesion", async () => {
    const { deps, llamadasEmit, sesiones } = depsFalsos(async (orgId) => {
      if (orgId === "org-mala") throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return { porConfirmar: 2, recordatoriosAgotados: 0, ultimoAgotadoEpoch: null, escalacionesSinSeguimiento: 0 };
    });
    const r = await emitirAvisosDeCitas(deps, ["org-ok-1", "org-mala", "org-ok-2"], new Date("2026-10-01T12:00:00Z"));
    expect(llamadasEmit).toEqual(["org-ok-1", "org-ok-2"]);
    expect(sesiones()).toBe(3);
    expect(r).toEqual({ organizaciones: 3, emitidas: 2 });
  });
});
