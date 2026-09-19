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
import { makeAbortSimulatingRepo, makePerCallTransactionalWithRepo } from "./support/fake-transactional-engine.ts";

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

    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId);
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
    await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId);

    const csvV2 = csvFixture(["CTR-1,EXP-1,Prov,Titulo nuevo,,,,,,1500,MXN,,,,,"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csvV2, { status: 200 })));
    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId);
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

    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId);
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

    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId, { limit: 2 });
    expect(results.find((r) => r.source === "compras_mx_historico")!.discovered).toBe(2);
  });
});

describe("runDiscoverTendersForOrganization -- Fase 9: conectores OCDS nuevos (nl_ocds/cdmx_ocds/aggregator) se invocan genéricamente", () => {
  let repo: InMemoryLicitacionesRepository;
  let organizationId: string;

  beforeEach(() => {
    repo = new InMemoryLicitacionesRepository();
    organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "org-test-ocds", name: "Org de prueba OCDS" });
  });

  it("invoca nl_ocds (registro único, sin comparar ids a mano) y una licitación con fecha límite real alimenta scanUpcomingDeadlineReminders", async () => {
    const now = new Date("2026-09-19T12:00:00Z");
    // Forma real observada de la API OCDS de Nuevo León (ver evidencia en connector-registry.ts):
    // paginación Laravel, `data: [{numberPublication, releases}]`. `tenderPeriod` presente en
    // combinación con `status: "active"` no se vio simultáneamente en las páginas reales leídas en
    // esta fase (gap documentado), pero SÍ es una forma válida real de OCDS -- este fixture ejercita
    // ese camino de código (alimentar recordatorios de plazo) con una fecha límite a 2 días, dentro
    // de la ventana default de `scanUpcomingDeadlineReminders` (3 días).
    const nlPage = {
      current_page: 1,
      last_page: 1,
      per_page: 10,
      total: 1,
      data: [
        {
          numberPublication: 1,
          releases: [
            {
              ocid: "ocds-k3ufh7-999001",
              date: "2026-09-19T00:00:00Z",
              buyer: { name: "SECRETARÍA DE ADMINISTRACIÓN" },
              tender: {
                title: "Convocatoria con plazo próximo (Fase 9)",
                status: "active",
                tenderPeriod: { endDate: "2026-09-21T18:00:00-06:00" },
              },
            },
          ],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("api-ocds.nl.gob.mx")) {
          return new Response(JSON.stringify(nlPage), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId, { now: () => now });
    const nlResult = results.find((r) => r.source === "nl_ocds")!;
    expect(nlResult).toBeDefined();
    expect(nlResult.state).toBe("ok");
    expect(nlResult.created).toBe(1);

    const tenders = (await repo.listTenders(organizationId)).filter((t) => t.source === "nl_ocds");
    expect(tenders).toHaveLength(1);
    expect(tenders[0]!.externalId).toBe("ocds-k3ufh7-999001");
    expect(tenders[0]!.submissionDeadline).toBe("2026-09-21T18:00:00-06:00");

    // La licitación con fecha límite real alimenta los recordatorios de plazo (REQ del brief).
    const scan = await repo.scanUpcomingDeadlineReminders(organizationId, { nowIso: now.toISOString() });
    expect(scan.created).toBe(1);
    const reminders = await repo.listTenderDeadlineReminders(organizationId, tenders[0]!.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.submissionDeadline).toBe("2026-09-21T18:00:00-06:00");
  });

  it("aggregator sin credenciales se registra 'not_configured' (nunca intenta una petición real) -- el barrido de los demás conectores continúa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const results = await runDiscoverTendersForOrganization((fn) => fn(repo), organizationId);
    const aggregatorResult = results.find((r) => r.source === "aggregator")!;
    expect(aggregatorResult.state).toBe("not_configured");
    expect(aggregatorResult.created).toBe(0);
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

    const sweep = await runDiscoverTendersSweep((fn) => fn(repo));
    expect(sweep.map((s) => s.organizationId).sort()).toEqual([org1, org2].sort());
    for (const orgResult of sweep) {
      expect(orgResult.error).toBeUndefined();
      expect(orgResult.results.find((r) => r.source === "compras_mx_historico")!.state).toBe("ok");
    }
  });
});

// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #2b) --
// reproduce el defecto "PEOR de lo reportado" propio de este archivo: el
// `recordSourceRun` de la rama de ERROR reutilizaba la MISMA transacción que
// acababa de fallar (p. ej. un error SQL real de `ingestTendersFromSource`), así que
// ese INSERT de "corrida fallida" TAMBIÉN fallaba (25P02) y se tragaba en silencio
// -- la fuente se iba SIN NINGÚN registro de corrida, y (con la sesión compartida de
// antes) el resto de fuentes de la MISMA organización quedaban contagiadas también.
describe("r4-fix-crons-transaccion-por-unidad -- transacción por FUENTE (reproduce el bug + prueba el fix)", () => {
  let repo: InMemoryLicitacionesRepository;
  let organizationId: string;

  beforeEach(() => {
    repo = new InMemoryLicitacionesRepository();
    organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org de prueba" });
    // Sin stub de red URL-aware: compras_mx_historico es el ÚNICO que necesita un CSV
    // real para este test (ver abajo) -- los demás conectores (nl_ocds/cdmx_ocds/
    // aggregator) fallan su propio parseo/red con esta respuesta genérica, lo cual es
    // exactamente lo que se quiere: cada uno intenta igual su `recordSourceRun` de la
    // rama de error, que es lo que este test verifica que quede aislado por fuente.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
  });

  it("ANTES del fix (patrón reconstruido): el error SQL real de compras_mx_historico deja SIN NINGÚN registro de corrida también a nl_ocds/cdmx_ocds (misma sesión contagiada)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("api-ocds")) return new Response("not found", { status: 404 });
        return new Response(csvFixture(["CTR-1,EXP-1,Prov,Uno,,,,,,1,MXN,,,,,"]), { status: 200 });
      }),
    );
    const { proxy, isAborted } = makeAbortSimulatingRepo(repo, (method, args) => method === "ingestTendersFromSource" && args[1] === "compras_mx_historico", "40P01: deadlock detected (SQL real simulado)");

    // Reconstruye LITERALMENTE el bucle pre-fix: una sola `repo` (sesión) para TODAS
    // las fuentes, con `recordSourceRun` de la rama de error reutilizando esa MISMA
    // sesión ya potencialmente abortada -- ver el defecto tal como vivía en este
    // archivo antes de este fix.
    const results = await runDiscoverTendersForOrganization((fn) => fn(proxy), organizationId);
    // La sesión SÍ debe haber quedado abortada -- si no, este test no reconstruyó
    // el escenario que dice reconstruir (revisión r4, no bloqueante #7).
    expect(isAborted()).toBe(true);
    // COMMIT sobre una transacción abortada devuelve ROLLBACK sin lanzar -- ningún
    // `recordSourceRun` de esta corrida (ok o error) sobrevivió de verdad, sin
    // importar lo que `results` (en memoria, nunca lanzó) reporte.
    expect(await repo.listSourceRuns(organizationId, {})).toHaveLength(0);
    expect(results.find((r) => r.source === "compras_mx_historico")!.state).not.toBe("ok");
  });

  it("DESPUÉS del fix (código real): transacción POR fuente -- compras_mx_historico falla y SÍ queda registrada como fallida, nl_ocds/cdmx_ocds/aggregator conservan su propio registro real", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("api-ocds")) return new Response("not found", { status: 404 });
        return new Response(csvFixture(["CTR-1,EXP-1,Prov,Uno,,,,,,1,MXN,,,,,"]), { status: 200 });
      }),
    );
    const { proxy, reset } = makeAbortSimulatingRepo(repo, (method, args) => method === "ingestTendersFromSource" && args[1] === "compras_mx_historico", "40P01: deadlock detected (SQL real simulado)");
    const perCallTxn = makePerCallTransactionalWithRepo(repo);
    const withRepo = async <T>(fn: (r: InMemoryLicitacionesRepository) => Promise<T>): Promise<T> => {
      try {
        return await perCallTxn(() => fn(proxy));
      } finally {
        reset();
      }
    };

    const results = await runDiscoverTendersForOrganization(withRepo, organizationId);
    const compras = results.find((r) => r.source === "compras_mx_historico")!;
    expect(compras.state).not.toBe("ok");

    // El registro de la corrida FALLIDA de compras_mx_historico SÍ sobrevivió (a
    // diferencia de "antes"): transacción nueva para `recordSourceRun`, nunca la que
    // acaba de fallar en `ingestTendersFromSource`.
    const runs = await repo.listSourceRuns(organizationId, { source: "compras_mx_historico" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).not.toBe("ok");

    // Las demás fuentes de la MISMA organización nunca se vieron contagiadas -- cada
    // una tiene su propio registro real, sin importar si su propio resultado fue ok o
    // error (aquí fallan su red, no la base de datos).
    for (const source of ["nl_ocds", "cdmx_ocds", "aggregator"] as const) {
      const sourceRuns = await repo.listSourceRuns(organizationId, { source });
      expect(sourceRuns.length).toBeGreaterThanOrEqual(1);
    }
  });
});
