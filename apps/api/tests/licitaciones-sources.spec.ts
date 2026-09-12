// Fase 5 pieza 1 — test de integración HTTP real de licitacionesSourcesRoutes
// (REQ-004/005/146..150): registro único de conectores, historial de
// corridas del conector "manual" (único real hoy), y frescura/obsolescencia
// por fuente.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("GET /licitaciones/:propertyId/sources -- registro único de conectores (REQ-004/146/150)", () => {
  it("cualquier miembro (incluido viewer) puede leer el registro -- lista las 6 fuentes conocidas", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: { id: string; liveVerification: { verified: boolean } }[] };
    expect(body.connectors).toHaveLength(6);
    expect(body.connectors.map((c) => c.id).sort()).toEqual(["comprasmx", "dof", "manual", "ocds_shcp", "pdn_s6", "state_portal"]);
    // REQ-150 (tolerancia cero): ningún conector automatizado se declara verificado sin evidencia.
    const automated = body.connectors.filter((c) => c.id !== "manual");
    expect(automated.every((c) => c.liveVerification.verified === false)).toBe(true);
    expect(body.connectors.find((c) => c.id === "manual")!.liveVerification.verified).toBe(true);
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
  it("incluye las 6 fuentes SIEMPRE, marcando 'stale' explícito para las que nunca corrieron", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/sources/freshness`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { freshness: { source: string; stale: boolean; lastSuccessAt: string | null }[] };
    expect(body.freshness).toHaveLength(6);
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
