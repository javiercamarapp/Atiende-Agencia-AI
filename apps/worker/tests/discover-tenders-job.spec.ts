// Fase 8 licitaciones — integración real (InMemoryLicitacionesRepository +
// el registro ÚNICO real de producción `LICITACIONES_CONNECTOR_REGISTRY`,
// sin sustituir el conector) del PRIMER job de ingesta automática de todo el
// vertical. `vi.stubGlobal("fetch", ...)` reemplaza la única llamada de red
// real que haría el conector -- no se sustituye ninguna lógica de negocio
// (parseo CSV, clasificación de bloqueo, upsert), solo el transporte HTTP,
// igual que cualquier prueba de un cliente HTTP real (ver
// `packages/domain-licitaciones/src/connectors/compras-mx-historico.ts`
// para por qué el conector resuelve `fetch` en tiempo de llamada y no en su
// construcción -- precisamente para que esto funcione).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLicitacionesRepository } from "@atiende/domain-licitaciones";
import { runDiscoverTendersForOrganization, runDiscoverTendersSweep } from "../src/jobs/licitaciones/discover-tenders.ts";

const REAL_HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";

function csvFixture(rows: string[]): string {
  return [REAL_HEADER, ...rows].join("\n") + "\n";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runDiscoverTendersForOrganization", () => {
  let repo: InMemoryLicitacionesRepository;
  let organizationId: string;

  beforeEach(() => {
    repo = new InMemoryLicitacionesRepository();
    organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org de prueba" });
  });

  it("ingesta candidatos reales del CSV histórico (fetch real del conector, stubbed a nivel de red) -- crea tenders con source='compras_mx_historico' y registra la corrida 'ok'", async () => {
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Contrato Uno,,,,,,1000,MXN,2020-01-01,2020-06-01,,,", "CTR-2,EXP-2,Prov,Contrato Dos,,,,,,2000,MXN,2021-01-01,2021-06-01,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv, { status: 200, headers: { "content-type": "text/csv" } })));

    const results = await runDiscoverTendersForOrganization(repo, organizationId);
    const own = results.find((r) => r.source === "compras_mx_historico")!;
    expect(own.state).toBe("ok");
    expect(own.discovered).toBe(2);
    expect(own.created).toBe(2);
    expect(own.updated).toBe(0);

    const tenders = await repo.listTenders(organizationId);
    const ingested = tenders.filter((t) => t.source === "compras_mx_historico");
    expect(ingested.map((t) => t.externalId).sort()).toEqual(["CTR-1", "CTR-2"]);
    expect(ingested.every((t) => t.submissionDeadline === null)).toBe(true);

    const runs = await repo.listSourceRuns(organizationId, { source: "compras_mx_historico" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("ok");
    expect(runs[0]!.evidence.coverage).toEqual({ expected: 2, obtained: 2 });
  });

  it("reingestar el MISMO externalId actualiza en vez de duplicar", async () => {
    const csvV1 = csvFixture(["CTR-1,EXP-1,Prov,Titulo viejo,,,,,,1000,MXN,,,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csvV1, { status: 200 })));
    await runDiscoverTendersForOrganization(repo, organizationId);

    const csvV2 = csvFixture(["CTR-1,EXP-1,Prov,Titulo nuevo,,,,,,1500,MXN,,,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csvV2, { status: 200 })));
    const results = await runDiscoverTendersForOrganization(repo, organizationId);
    const own = results.find((r) => r.source === "compras_mx_historico")!;
    expect(own.created).toBe(0);
    expect(own.updated).toBe(1);

    const tenders = (await repo.listTenders(organizationId)).filter((t) => t.source === "compras_mx_historico");
    expect(tenders).toHaveLength(1);
    expect(tenders[0]!.title).toBe("Titulo nuevo");
    expect(tenders[0]!.budgetAmount).toBe(1500);
  });

  it("SR-14 real: ante un bloqueo (HTML de 'Access Denied') la corrida se registra como 'captcha_detected', NUNCA como 'ok' con 0 nuevas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><h1>Access Denied</h1></body></html>", { status: 200 })));

    const results = await runDiscoverTendersForOrganization(repo, organizationId);
    const own = results.find((r) => r.source === "compras_mx_historico")!;
    expect(own.state).toBe("captcha_detected");
    expect(own.created).toBe(0);

    const runs = await repo.listSourceRuns(organizationId, { source: "compras_mx_historico" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("captcha_detected");

    expect(await repo.listTenders(organizationId)).toHaveLength(0);
  });

  it("respeta el límite por corrida (evita descargar/ingestar el dataset completo cada vez)", async () => {
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Uno,,,,,,1,MXN,,,,,", "CTR-2,EXP-2,Prov,Dos,,,,,,2,MXN,,,,,", "CTR-3,EXP-3,Prov,Tres,,,,,,3,MXN,,,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv, { status: 200 })));

    const results = await runDiscoverTendersForOrganization(repo, organizationId, { limit: 2 });
    expect(results.find((r) => r.source === "compras_mx_historico")!.discovered).toBe(2);
  });
});

describe("runDiscoverTendersSweep", () => {
  it("recorre TODAS las organizaciones activas del vertical -- un fallo en una no detiene el barrido de las demás", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const org1 = randomUUID();
    const org2 = randomUUID();
    repo.seedOrganization({ id: org1, slug: "org-1", name: "Org 1" });
    repo.seedOrganization({ id: org2, slug: "org-2", name: "Org 2" });
    repo.seedOrganization({ id: randomUUID(), slug: "org-inactiva", name: "Inactiva", isActive: false });

    const csv = csvFixture(["CTR-1,EXP-1,Prov,Uno,,,,,,1,MXN,,,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv, { status: 200 })));

    const sweep = await runDiscoverTendersSweep(repo);
    expect(sweep.map((s) => s.organizationId).sort()).toEqual([org1, org2].sort());
    for (const orgResult of sweep) {
      expect(orgResult.error).toBeUndefined();
      expect(orgResult.results.find((r) => r.source === "compras_mx_historico")!.state).toBe("ok");
    }
  });
});
