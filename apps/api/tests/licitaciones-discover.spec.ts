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
import { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const REAL_HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";

function csvFixture(rows: string[]): string {
  return [REAL_HEADER, ...rows].join("\n") + "\n";
}

const CDMX_CSV_HEADER =
  "post_title,post_date,no_procedimiento,unidad_responsable,id_convocante,entidad_convocante,id,tipo_contratacion,metodo_contratacion,caracter_convocatoria,clasificador_bien_servicio,servidor_nombre,servidor_cargo,lugar_venta,domicilio_venta,primer_entrega,primer_entrega_fin,segunda_entrega,segunda_entrega_fin,tercera_entrega,tercera_entrega_fin,cuarta_entrega,cuarta_entrega_fin,quinta_entrega,quinta_entrega_fin,costo,forma_pago,datos_pago,documento_bases_url,documento_tecnico_url,contratacion_descripcion,unidad_medida,idioma,considera_anticipo,lugar_entrega,fecha_estimada_inicio,fecha_estimada_fin,concurso_lugar,concurso_direccion,concurso_fecha,propuestas_lugar,propuestas_direccion,propuestas_fecha,fallo_lugar,fallo_direccion,fallo_fecha,dias_trans_prop";

/**
 * Fase 9 — el registro único ahora también incluye `nl_ocds`/`cdmx_ocds`
 * (conectores OCDS reales) y `aggregator` (gateado por credenciales que este
 * archivo NO configura a propósito, ver docs/CREDENCIALES.md). Fase 13 agrega
 * `yucatan_ocds`/`guadalajara_ocds` (misma plataforma "contratacionesabiertas",
 * ver `connectors/ocds/contratacionesabiertas-connector.ts`) -- responden
 * `/edca/fiscalYears` con un único año real y `/edca/contractingprocess/{year}`
 * vacío, para que sean 'ok' con 0 candidatos (mismo criterio que nl_ocds/
 * cdmx_ocds arriba: reales pero sin datos en este stub). Este stub distingue
 * por URL para que la ingesta REAL de `compras_mx_historico` (lo que este
 * archivo prueba) no quede enmascarada por un fallo de red de los otros 4
 * conectores nuevos. `aggregator` sigue fallando `not_configured` --
 * intencional (REQ-150: nunca se configura solo para hacer pasar un test).
 */
function stubFetchForDiscoverTenders(comprasMxCsv: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("api-ocds.nl.gob.mx")) {
      return new Response(JSON.stringify({ current_page: 1, data: [], last_page: 1, per_page: 10, total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("datos.cdmx.gob.mx")) {
      return new Response(`${CDMX_CSV_HEADER}\n`, { status: 200, headers: { "content-type": "text/csv" } });
    }
    if (url.includes("contratacionesabiertas")) {
      if (url.endsWith("/edca/fiscalYears")) return new Response(JSON.stringify({ fiscalYears: [{ id: 1, year: 2025, status: true }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ arrayReleasePackage: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(comprasMxCsv, { status: 200 });
  });
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
    vi.stubGlobal("fetch", stubFetchForDiscoverTenders(csv));

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      organizations_checked: number;
      corridas: { organization_id: string; fuentes: { source: string; estado: string; creados: number }[] }[];
      failures: { source: string | null }[];
    };
    // 'aggregator' sigue 'not_configured' a propósito (sin credenciales en este test) -- es el ÚNICO fallo esperado; nl_ocds/cdmx_ocds/compras_mx_historico deben ser 'ok' con el stub URL-aware de arriba.
    expect(body.failures.map((f) => f.source)).toEqual(["aggregator"]);
    expect(body.organizations_checked).toBeGreaterThanOrEqual(1);
    const own = body.corridas.find((c) => c.organization_id === ctx.organizationId)!;
    const source = own.fuentes.find((f) => f.source === "compras_mx_historico")!;
    expect(source.estado).toBe("ok");
    expect(source.creados).toBe(1);
    expect(own.fuentes.find((f) => f.source === "nl_ocds")!.estado).toBe("ok");
    expect(own.fuentes.find((f) => f.source === "cdmx_ocds")!.estado).toBe("ok");

    const tenders = await ctx.repo.listTenders(ctx.organizationId);
    expect(tenders.some((t) => t.source === "compras_mx_historico" && t.externalId === "CTR-1")).toBe(true);
  });
});

// r4-fix-crons-transaccion-por-unidad (re-revisión, bloqueante único): 'aggregator'
// sin credenciales (`SourceNotConfiguredError` -> state 'not_configured') es el
// camino feliz esperado mientras no se elija proveedor -- NO debe hacer que el
// latido quede en "error". Solo una fuente con un estado de fallo REAL (p. ej.
// 'down', por un 500 real de la fuente) debe disparar CronPartialFailureError.
describe("latido de /internal/licitaciones/discover-tenders -- 'not_configured' no es un fallo del cron", () => {
  const SUPERADMIN_ID = "superadmin-test-latido";

  function heartbeatReaderFor(saludRepo: InMemorySaludRepository) {
    saludRepo.addPlatformSuperadmin(SUPERADMIN_ID);
    return async () => {
      const latidos = await saludRepo.listCronHeartbeatsForSuperadmin(SUPERADMIN_ID);
      return latidos.find((l) => l.cronName === "/internal/licitaciones/discover-tenders") ?? null;
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("(a) solo el aggregator sin configurar -- el cron NO lanza y el latido queda 'ok'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const readLatido = heartbeatReaderFor(ctx.deps.saludRepo as InMemorySaludRepository);
    const csv = csvFixture(["CTR-A,EXP-A,Prov,Contrato A,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]);
    vi.stubGlobal("fetch", stubFetchForDiscoverTenders(csv));

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { source: string | null }[] };
    // El body/`ok` NO cambian de comportamiento -- 'aggregator' sigue reportado como fallo ahí (sin este PR ya era así).
    expect(body.ok).toBe(false);
    expect(body.failures.map((f) => f.source)).toEqual(["aggregator"]);

    const latido = await readLatido();
    expect(latido?.lastStatus).toBe("ok");
    expect(latido?.consecutiveFailures).toBe(0);
  });

  const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  /** compras 403 (WAF), guadalajara TLS vencido, cdmx connect timeout; `cdmxResponde500` convierte cdmx en un fallo REAL. */
  function stubFuentesNoDisponibles(opciones: { cdmxResponde500?: boolean } = {}): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("api-ocds.nl.gob.mx")) return new Response(JSON.stringify({ current_page: 1, data: [], last_page: 1, per_page: 10, total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("datos.cdmx.gob.mx")) {
        if (opciones.cdmxResponde500) return new Response("boom", { status: 500 });
        throw fetchFailed("UND_ERR_CONNECT_TIMEOUT");
      }
      if (url.includes("guadalajara")) throw fetchFailed("CERT_HAS_EXPIRED");
      if (url.includes("contratacionesabiertas")) {
        if (url.endsWith("/edca/fiscalYears")) return new Response(JSON.stringify({ fiscalYears: [{ id: 1, year: 2025, status: true }] }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ arrayReleasePackage: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("<HTML><TITLE>Access Denied</TITLE></HTML>", { status: 403, headers: { "content-type": "text/html" } });
    });
  }

  async function setupNoDisponibles() {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const alertas: { tipo: string; severidad: string }[] = [];
    const { deps, emisiones } = conEmisiones({ ...ctx.deps, alertas: { notificar: async (a: { tipo: string; severidad: string }) => (alertas.push({ tipo: a.tipo, severidad: a.severidad }), { resultados: [] }) } }, {});
    const app = buildApp(deps);
    const readLatido = heartbeatReaderFor(ctx.deps.saludRepo as InMemorySaludRepository);
    const run = () => app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    return { ctx, alertas, emisiones, readLatido, run };
  }

  it("(c) fuentes no disponibles (WAF 403, TLS vencido, inalcanzable) que NUNCA tuvieron exito -- latido 'ok', pero ESCALAN: alerta alta + campana, una por fuente", async () => {
    const s = await setupNoDisponibles();
    vi.stubGlobal("fetch", stubFuentesNoDisponibles());

    const res = await s.run();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fuentes_escaladas: string[]; failures: { source: string | null; error: string; no_disponible?: boolean }[] };
    expect(body.failures.filter((f) => f.no_disponible).map((f) => f.source).sort()).toEqual(["cdmx_ocds", "compras_mx_historico", "guadalajara_ocds"]);
    expect(body.failures.find((f) => f.source === "guadalajara_ocds")!.error).toContain("CERT_HAS_EXPIRED");
    expect([...body.fuentes_escaladas].sort()).toEqual(["cdmx_ocds", "compras_mx_historico", "guadalajara_ocds"]);

    expect(s.alertas.filter((a) => a.tipo.startsWith("licitaciones_fuente_no_disponible:")).map((a) => a.severidad)).toEqual(["alta", "alta", "alta"]);
    const campana = s.emisiones.filter((e) => e.evento === "superadmin.cron.fallo");
    expect(campana.map((e) => e.dedupeKey).sort()).toEqual(
      ["cdmx_ocds", "compras_mx_historico", "guadalajara_ocds"].map((f) => `superadmin.cron.fallo:licitaciones.discover-tenders.${f}:${new Date().toISOString().slice(0, 10)}`),
    );

    const latido = await s.readLatido();
    expect(latido?.lastStatus).toBe("ok");
    expect(latido?.consecutiveFailures).toBe(0);
  });

  it("(d) fuente no disponible pero DENTRO de su umbral de obsolescencia (exito reciente) -- no escala ni alerta, latido 'ok'", async () => {
    const s = await setupNoDisponibles();
    const ahora = new Date().toISOString();
    for (const source of ["compras_mx_historico", "cdmx_ocds", "guadalajara_ocds"] as const) {
      await s.ctx.repo.recordSourceRun(s.ctx.organizationId, { source, state: "ok", startedAt: ahora, finishedAt: ahora, evidence: { message: "ok previo", coverage: { expected: 1, obtained: 1 } }, correlationId: null });
    }
    vi.stubGlobal("fetch", stubFuentesNoDisponibles());

    const body = (await (await s.run()).json()) as { fuentes_escaladas: string[] };
    expect(body.fuentes_escaladas).toEqual([]);
    expect(s.alertas.filter((a) => a.tipo.startsWith("licitaciones_fuente_no_disponible:"))).toEqual([]);
    expect(s.emisiones.filter((e) => e.evento === "superadmin.cron.fallo")).toEqual([]);
    expect((await s.readLatido())?.lastStatus).toBe("ok");
  });

  it("(e) caso mixto: fuentes no disponibles MAS una falla real (cdmx responde 500) en la misma corrida -- el latido queda 'error' y nombra solo la falla real", async () => {
    const s = await setupNoDisponibles();
    vi.stubGlobal("fetch", stubFuentesNoDisponibles({ cdmxResponde500: true }));

    const res = await s.run();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failures: { source: string | null; no_disponible?: boolean }[] };
    expect(body.failures.find((f) => f.source === "cdmx_ocds")!.no_disponible).toBeUndefined();
    expect(body.failures.find((f) => f.source === "compras_mx_historico")!.no_disponible).toBe(true);

    const latido = await s.readLatido();
    expect(latido?.lastStatus).toBe("error");
    expect(latido?.lastError).toContain("cdmx_ocds");
    expect(latido?.lastError).not.toContain("compras_mx_historico");
    expect(latido?.lastError).not.toContain("guadalajara_ocds");
  });

  it("(b) una fuente configurada que falla de verdad (con aggregator TAMBIÉN configurado y ok) -- SÍ lanza CronPartialFailureError, latido 'error'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const readLatido = heartbeatReaderFor(ctx.deps.saludRepo as InMemorySaludRepository);
    vi.stubEnv("LICITACIONES_AGGREGATOR_API_KEY", "clave-de-prueba");
    vi.stubEnv("LICITACIONES_AGGREGATOR_BASE_URL", "https://aggregator.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("api-ocds.nl.gob.mx")) return new Response(JSON.stringify({ current_page: 1, data: [], last_page: 1, per_page: 10, total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.includes("datos.cdmx.gob.mx")) return new Response(`${CDMX_CSV_HEADER}\n`, { status: 200, headers: { "content-type": "text/csv" } });
        if (url.includes("contratacionesabiertas")) {
          if (url.endsWith("/edca/fiscalYears")) return new Response(JSON.stringify({ fiscalYears: [{ id: 1, year: 2025, status: true }] }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ arrayReleasePackage: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("aggregator.test")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
        // compras_mx_historico -- fuente CONFIGURADA que falla de verdad (500 real).
        return new Response("boom", { status: 500 });
      }),
    );

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { source: string | null; error: string }[] };
    expect(body.failures.map((f) => f.source)).toEqual(["compras_mx_historico"]);

    const latido = await readLatido();
    expect(latido?.lastStatus).toBe("error");
    expect(latido?.lastError).toContain("compras_mx_historico");
  });

  it("(c) 'not_configured' (aggregator) + un fallo real (compras_mx_historico) a la vez -- lanza, y el detalle del latido nombra SOLO la fuente realmente fallida", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const readLatido = heartbeatReaderFor(ctx.deps.saludRepo as InMemorySaludRepository);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("api-ocds.nl.gob.mx")) return new Response(JSON.stringify({ current_page: 1, data: [], last_page: 1, per_page: 10, total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.includes("datos.cdmx.gob.mx")) return new Response(`${CDMX_CSV_HEADER}\n`, { status: 200, headers: { "content-type": "text/csv" } });
        if (url.includes("contratacionesabiertas")) {
          if (url.endsWith("/edca/fiscalYears")) return new Response(JSON.stringify({ fiscalYears: [{ id: 1, year: 2025, status: true }] }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ arrayReleasePackage: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        // compras_mx_historico -- fuente configurada que falla de verdad; 'aggregator' sigue not_configured (sin credenciales en este test).
        return new Response("boom", { status: 500 });
      }),
    );

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { source: string | null; error: string }[] };
    // El body sigue reportando AMBAS fuentes (comportamiento sin cambios) ...
    expect(body.failures.map((f) => f.source).sort()).toEqual(["aggregator", "compras_mx_historico"]);

    const latido = await readLatido();
    expect(latido?.lastStatus).toBe("error");
    // ... pero el detalle del latido nombra SOLO la fuente realmente fallida.
    expect(latido?.lastError).toContain("compras_mx_historico");
    expect(latido?.lastError).not.toContain("aggregator");
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

// Fase 12 (cierre del hallazgo ALTA "sin cron configurado") — `vercel.json` ya
// declara `crons` reales para estas 2 rutas + las 2 de alertNotifications.ts.
// Vercel Cron dispara SIEMPRE con GET y solo puede mandar el secreto vía
// `Authorization: Bearer $CRON_SECRET` (no permite headers custom en su config) —
// estos tests cubren esa forma nueva de invocación sin tocar la existente de arriba.
describe("GET /internal/licitaciones/discover-tenders (invocación real de Vercel Cron)", () => {
  it("rechaza sin ningún secreto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("con Authorization: Bearer <INTERNAL_SECRET> (lo que Vercel Cron manda automáticamente cuando CRON_SECRET está alineado), ingesta igual que el POST manual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const csv = csvFixture(["CTR-2,EXP-2,Prov,Contrato vía cron,,,,,,2000,MXN,2020-01-01,2020-06-01,,,"]);
    vi.stubGlobal("fetch", stubFetchForDiscoverTenders(csv));

    const res = await app.request("/internal/licitaciones/discover-tenders", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { source: string | null }[] };
    // Mismo criterio que el POST manual: 'aggregator' sin credenciales es el único fallo esperado.
    expect(body.failures.map((f) => f.source)).toEqual(["aggregator"]);

    const tenders = await ctx.repo.listTenders(ctx.organizationId);
    expect(tenders.some((t) => t.source === "compras_mx_historico" && t.externalId === "CTR-2")).toBe(true);
  });
});

describe("GET /internal/licitaciones/deadline-reminders (invocación real de Vercel Cron)", () => {
  it("rechaza sin ningún secreto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/deadline-reminders", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("con Authorization: Bearer <INTERNAL_SECRET>, crea el recordatorio igual que el POST manual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto (cron)", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const res = await app.request("/internal/licitaciones/deadline-reminders", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: number };
    expect(body.ok).toBe(true);
    expect(body.created).toBeGreaterThanOrEqual(1);
  });
});
