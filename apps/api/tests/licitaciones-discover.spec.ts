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

const CDMX_CSV_HEADER =
  "post_title,post_date,no_procedimiento,unidad_responsable,id_convocante,entidad_convocante,id,tipo_contratacion,metodo_contratacion,caracter_convocatoria,clasificador_bien_servicio,servidor_nombre,servidor_cargo,lugar_venta,domicilio_venta,primer_entrega,primer_entrega_fin,segunda_entrega,segunda_entrega_fin,tercera_entrega,tercera_entrega_fin,cuarta_entrega,cuarta_entrega_fin,quinta_entrega,quinta_entrega_fin,costo,forma_pago,datos_pago,documento_bases_url,documento_tecnico_url,contratacion_descripcion,unidad_medida,idioma,considera_anticipo,lugar_entrega,fecha_estimada_inicio,fecha_estimada_fin,concurso_lugar,concurso_direccion,concurso_fecha,propuestas_lugar,propuestas_direccion,propuestas_fecha,fallo_lugar,fallo_direccion,fallo_fecha,dias_trans_prop";

/**
 * Fase 9 — el registro único ahora también incluye `nl_ocds`/`cdmx_ocds`
 * (conectores OCDS reales) y `aggregator` (gateado por credenciales que este
 * archivo NO configura a propósito, ver docs/CREDENCIALES.md). Este stub
 * distingue por URL para que la ingesta REAL de `compras_mx_historico` (lo
 * que este archivo prueba) no quede enmascarada por un fallo de red de los
 * otros 2 conectores nuevos. `aggregator` sigue fallando `not_configured` --
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
