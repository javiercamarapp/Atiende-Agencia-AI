// paridad3 L-P3-14: GET .../tenders/:id/sources lista la fuente primaria y las enlazadas por huella cruzada; solo de la organizacion propia.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const CAND = {
  externalId: "ocds-1",
  title: "Equipo de computo",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  contractingBody: "IMSS",
  cpvCodes: [],
  budgetAmount: 100,
  currency: "MXN",
  state: "NL",
  procedureTypeRaw: null,
  procedureNumber: "LA-1-2026",
};

describe("GET .../tenders/:tenderId/sources (L-P3-14)", () => {
  it("una convocatoria ingerida por dos fuentes lista ambas, con la primaria primero y los conflictos de la enlazada", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const a = await ctx.repo.ingestTendersFromSource(ctx.organizationId, "nl_ocds", [CAND]);
    await ctx.repo.ingestTendersFromSource(ctx.organizationId, "cdmx_ocds", [{ ...CAND, externalId: "cdmx-9", budgetAmount: 200 }]);
    const res = await buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}/tenders/${a.tenders[0]!.id}/sources`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { source: string; primary: boolean; conflicts: { field: string }[] }[] };
    expect(body.sources.map((s) => [s.source, s.primary])).toEqual([["nl_ocds", true], ["cdmx_ocds", false]]);
    expect(body.sources[1]!.conflicts.map((c) => c.field)).toEqual(["budget_amount"]);
  });

  it("convocatoria inexistente: 404; sin sesion: 401", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/licitaciones/${ctx.propertyId}/tenders/00000000-0000-0000-0000-00000000dead/sources`, authedJson(ctx.staff.owner.token))).status).toBe(404);
    expect((await app.request(`/licitaciones/${ctx.propertyId}/tenders/x/sources`)).status).toBe(401);
  });
});
