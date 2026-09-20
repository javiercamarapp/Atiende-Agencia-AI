// Fase 5 pieza 1 — test de integración HTTP real de licitacionesSourcesRoutes
// (REQ-004/005/146..150): registro único de conectores, historial de
// corridas del conector "manual" (único real hoy), y frescura/obsolescencia
// por fuente.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("GET /licitaciones/:propertyId/sources -- registro único de conectores (REQ-004/146/150)", () => {
  it("cualquier miembro (incluido viewer) puede leer el registro -- lista las 12 fuentes conocidas", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: { id: string; liveVerification: { verified: boolean } }[] };
    expect(body.connectors).toHaveLength(12);
    expect(body.connectors.map((c) => c.id).sort()).toEqual(
      ["aggregator", "cdmx_ocds", "compras_mx_historico", "comprasmx", "dof", "guadalajara_ocds", "manual", "nl_ocds", "ocds_shcp", "pdn_s6", "state_portal", "yucatan_ocds"].sort(),
    );
    // REQ-150 (tolerancia cero): ningún conector automatizado se declara verificado sin evidencia -- 'manual', 'nl_ocds', 'yucatan_ocds' y 'guadalajara_ocds' (evidencia real) lo están.
    const verified = body.connectors.filter((c) => c.liveVerification.verified);
    expect(verified.map((c) => c.id).sort()).toEqual(["guadalajara_ocds", "manual", "nl_ocds", "yucatan_ocds"].sort());
  });

  it("sin sesión -> 401", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources`);
    expect(res.status).toBe(401);
  });
});

describe("GET /licitaciones/:propertyId/sources/runs -- historial de corridas (REQ-147)", () => {
  it("dar de alta una convocatoria registra automáticamente una corrida 'ok' del conector 'manual'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "Convocatoria de prueba", externalId: "LA-10/2026" }));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/runs`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { source: string; state: string }[] };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    expect(body.runs[0]!.source).toBe("manual");
    expect(body.runs[0]!.state).toBe("ok");
  });

  it("?source= filtra por conector; un id no registrado -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-11/2026" }));

    const empty = await app.request(`/licitaciones/${ctx.propertyId}/sources/runs?source=comprasmx`, authedJson(ctx.staff.viewer.token));
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { runs: unknown[] }).runs).toEqual([]);

    const invalid = await app.request(`/licitaciones/${ctx.propertyId}/sources/runs?source=no-existe`, authedJson(ctx.staff.viewer.token));
    expect(invalid.status).toBe(400);
  });
});

describe("GET /licitaciones/:propertyId/sources/freshness -- REQ-149", () => {
  it("incluye las 12 fuentes SIEMPRE, marcando 'stale' explícito para las que nunca corrieron", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/freshness`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { freshness: { source: string; stale: boolean; lastSuccessAt: string | null }[] };
    expect(body.freshness).toHaveLength(12);
    const comprasmx = body.freshness.find((f) => f.source === "comprasmx")!;
    expect(comprasmx.stale).toBe(true);
    expect(comprasmx.lastSuccessAt).toBeNull();
  });

  it("después de un alta manual, la fuente 'manual' deja de estar obsoleta", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/licitaciones/${ctx.propertyId}/tenders`, authedJson(ctx.staff.writer.token, { title: "X", externalId: "LA-12/2026" }));
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/freshness`, authedJson(ctx.staff.viewer.token));
    const body = (await res.json()) as { freshness: { source: string; stale: boolean }[] };
    expect(body.freshness.find((f) => f.source === "manual")!.stale).toBe(false);
  });
});

// Fase 8 — recordatorios de vencimiento (ver deadline-reminders.ts): leer es de cualquier miembro, reconocer exige un rol de escritura.
describe("GET/POST /licitaciones/:propertyId/sources/deadline-reminders", () => {
  it("cualquier miembro (incluido viewer) puede listar los recordatorios de la organización", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/deadline-reminders`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminders: unknown[] };
    expect(Array.isArray(body.reminders)).toBe(true);
  });

  it("viewer NO puede reconocer un recordatorio (403); writer sí puede", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto", submissionDeadline: soon, updatedAt: new Date().toISOString() });
    const scan = await ctx.repo.scanUpcomingDeadlineReminders(ctx.organizationId);
    const reminderId = scan.reminders[0]!.id;

    const forbidden = await app.request(`/licitaciones/${ctx.propertyId}/sources/deadline-reminders/${reminderId}/ack`, authedJson(ctx.staff.viewer.token, {}));
    expect(forbidden.status).toBe(403);

    const ok = await app.request(`/licitaciones/${ctx.propertyId}/sources/deadline-reminders/${reminderId}/ack`, authedJson(ctx.staff.writer.token, {}));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { reminder: { acknowledgedAt: string | null } };
    expect(body.reminder.acknowledgedAt).not.toBeNull();
  });

  it("reconocer un recordatorio inexistente -> 404", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/deadline-reminders/${randomUUID()}/ack`, authedJson(ctx.staff.writer.token, {}));
    expect(res.status).toBe(404);
  });
});
