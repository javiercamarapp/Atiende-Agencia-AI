// Fase 8 — test de integración real (HTTP, sin mockear el motor de dominio)
// de las rutas internas de ingesta automática/recordatorios de plazo. Mismo
// patrón gateado por `x-atiende-internal-secret` que
// `apps/api/tests/citas-reminders.spec.ts` (leído primero como plantilla).
// `vi.stubGlobal("fetch", ...)` sustituye SOLO el transporte HTTP real que
// haría el conector `compras_mx_historico` (ver
// `apps/worker/tests/discover-tenders-job.spec.ts` para el detalle de por
// qué esto es seguro/no es un mock de lógica de negocio).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

const REAL_HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";

function csvFixture(rows: string[]): string {
  return [REAL_HEADER, ...rows].join("\n") + "\n";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /internal/licitaciones/discover-tenders", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, ingesta candidatos reales del conector compras_mx_historico para la organización activa", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Contrato de prueba,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv, { status: 200 })));

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; organizations_checked: number; corridas: { organization_id: string; fuentes: { source: string; estado: string; creados: number }[] }[]; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.organizations_checked).toBeGreaterThanOrEqual(1);
    const own = body.corridas.find((c) => c.organization_id === ctx.organizationId)!;
    const source = own.fuentes.find((f) => f.source === "compras_mx_historico")!;
    expect(source.estado).toBe("ok");
    expect(source.creados).toBe(1);

    const tenders = await ctx.repo.listTenders(ctx.organizationId);
    expect(tenders.some((t) => t.source === "compras_mx_historico" && t.externalId === "CTR-1")).toBe(true);
  });
});

describe("POST /internal/licitaciones/deadline-reminders", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/deadline-reminders", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, crea un recordatorio para una convocatoria con vencimiento dentro de la ventana", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const res = await app.request("/internal/licitaciones/deadline-reminders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.created).toBeGreaterThanOrEqual(1);

    const reminders = await ctx.repo.listTenderDeadlineReminders(ctx.organizationId);
    expect(reminders.length).toBeGreaterThanOrEqual(1);
  });
});
