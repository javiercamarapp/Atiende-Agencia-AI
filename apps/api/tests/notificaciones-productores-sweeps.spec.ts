// Productores de notificaciones in-app de licitaciones (plazos), despachos (cobranza) y del latido de crons
// (superadmin): una emision por organizacion por dia solo cuando hubo algo nuevo, y una emision que falla
// (p. ej. base sin la 0039) nunca cambia el barrido ni la respuesta.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { withHeartbeat } from "../src/salud/with-heartbeat.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const errorSinMigrar = () => {
  throw Object.assign(new Error("function core.emit_notification(uuid) does not exist"), { code: "42883" });
};

describe("licitaciones.plazo.por_vencer", () => {
  async function setup(opciones: { alEmitir?: () => number } = {}) {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
    return { ctx, emisiones, app: buildApp(deps) };
  }
  const cron = (s: Awaited<ReturnType<typeof setup>>) => s.app.request("/internal/licitaciones/deadline-reminders", { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });

  it("emite una por organizacion con la cantidad de recordatorios nuevos, a analistas, redactores y revisores", async () => {
    const s = await setup();
    const pronto = new Date(Date.now() + 2 * 86_400_000).toISOString();
    s.ctx.repo.seedTender({ id: randomUUID(), organizationId: s.ctx.organizationId, title: "Vence pronto", submissionDeadline: pronto, updatedAt: new Date().toISOString() });
    const res = await cron(s);
    expect(res.status).toBe(200);
    const mias = s.emisiones.filter((e) => e.organizationId === s.ctx.organizationId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      evento: "licitaciones.plazo.por_vencer",
      categoria: "operacion",
      enlace: "/licitaciones/{orgSlug}/seguimiento",
      roles: ["analyst", "writer", "reviewer"],
    });
    expect(mias[0]!.cuerpo).toMatch(/^Recordatorios nuevos: [1-9]\d*\.$/);
    expect(mias[0]!.dedupeKey).toBe(`licitaciones.plazo.por_vencer:${s.ctx.organizationId}:${new Date().toISOString().slice(0, 10)}`);
    expect(`${mias[0]!.titulo} ${mias[0]!.cuerpo}`).not.toContain("Vence pronto");
  });

  it("sin convocatorias dentro de la ventana no emite", async () => {
    const s = await setup();
    expect((await cron(s)).status).toBe(200);
    expect(s.emisiones).toHaveLength(0);
  });

  it("una emision que falla deja el barrido intacto (200, ok, recordatorio creado)", async () => {
    const s = await setup({ alEmitir: errorSinMigrar });
    const pronto = new Date(Date.now() + 2 * 86_400_000).toISOString();
    s.ctx.repo.seedTender({ id: randomUUID(), organizationId: s.ctx.organizationId, title: "Vence pronto", submissionDeadline: pronto, updatedAt: new Date().toISOString() });
    const res = await cron(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect((await s.ctx.repo.listTenderDeadlineReminders(s.ctx.organizationId)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("despachos.cobranza.recordatorios", () => {
  async function setup(opciones: { alEmitir?: () => number } = {}) {
    const ctx = await buildDespachosTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
    const invoice = await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioFiscal: randomUUID(),
      tipo: "I",
      rfcEmisor: "CON950820K12",
      rfcReceptor: "XAXX010101000",
      emisorNombre: "PROVEEDOR",
      subtotal: 1000,
      total: 1160,
      iva: 160,
      descuento: 0,
      categoria: "sin_clasificar",
      valido: true,
      issues: [],
      warnings: [],
      requiresHumanReview: false,
      diot: { proveedoresReportables: [], reportable: false },
      fecha: "2026-08-01",
    });
    await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: invoice.id, fechaVencimiento: hoyFechaNegocio(), clienteNombre: "Cliente de Prueba", clienteEmail: "cliente@example.com" });
    return { ctx, emisiones, app: buildApp(deps) };
  }
  const cron = (s: Awaited<ReturnType<typeof setup>>) => s.app.request("/internal/despachos/cobranza-reminders", { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });

  it("emite una por organizacion al contador con la cantidad, sin nombres de cliente ni correos", async () => {
    const s = await setup();
    expect((await cron(s)).status).toBe(200);
    const mias = s.emisiones.filter((e) => e.organizationId === s.ctx.organizationId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ evento: "despachos.cobranza.recordatorios", categoria: "cobranza", enlace: "/despachos/{orgSlug}/cola-cobranza", roles: ["contador"], cuerpo: "Cuentas con recordatorio: 1." });
    expect(`${mias[0]!.titulo} ${mias[0]!.cuerpo}`).not.toMatch(/Cliente de Prueba|@|XAXX/);
  });

  it("una emision que falla deja el barrido intacto", async () => {
    const s = await setup({ alEmitir: errorSinMigrar });
    const res = await cron(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reminders_due: 1 });
  });
});

describe("superadmin.cron.fallo (withHeartbeat)", () => {
  function depsConEngine(alEmitir?: () => number) {
    const sesion = { query: vi.fn(async () => ({ rows: [] })), exec: vi.fn(async () => undefined) };
    const base = { saludRepo: new InMemorySaludRepository(), engine: { withAppSession: async (_c: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) } };
    const { deps, emisiones } = conEmisiones(base as never, { alEmitir });
    return { deps: deps as unknown as AppDeps, emisiones };
  }

  it("un cron que falla emite UN aviso de plataforma con el nombre del cron (no el error), clave por cron y dia", async () => {
    const { deps, emisiones } = depsConEngine();
    const err = new Error("password=secreto123 fallo la base");
    await expect(withHeartbeat(deps, "/internal/licitaciones/alert-notifications", async () => { throw err; })()).rejects.toBe(err);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.cron.fallo",
      organizationId: null,
      severidad: "critica",
      enlace: "/superadmin/resumen",
      cuerpo: "Tarea: licitaciones.alert-notifications.",
      dedupeKey: `superadmin.cron.fallo:licitaciones.alert-notifications:${new Date().toISOString().slice(0, 10)}`,
    });
    expect(`${emisiones[0]!.titulo} ${emisiones[0]!.cuerpo}`).not.toMatch(/secreto|password/);
  });

  it("un cron que termina bien no emite", async () => {
    const { deps, emisiones } = depsConEngine();
    await withHeartbeat(deps, "/internal/test/ok", async () => new Response("{}"))();
    expect(emisiones).toHaveLength(0);
  });

  it("si la emision falla, el cron sigue fallando con SU excepcion original", async () => {
    const { deps } = depsConEngine(errorSinMigrar);
    const err = new Error("boom");
    await expect(withHeartbeat(deps, "/internal/test/cron", async () => { throw err; })()).rejects.toBe(err);
  });
});
