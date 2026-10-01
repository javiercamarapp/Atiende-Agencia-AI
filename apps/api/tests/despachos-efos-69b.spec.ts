// D-04: lista 69-B (EFOS) de punta a punta con el repositorio en memoria -- ingesta interna de la
// edicion, alerta al ingerir un CFDI (definitivo/presunto/desvirtuado), estado/alertas del panel
// y comportamiento sin lista (base sin migrar). Fixture sintetico con RFC ficticios.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

const CSV = readFileSync(fileURLToPath(new URL("../../../packages/domain-despachos/tests/fixtures/efos-69b-muestra.csv", import.meta.url)));

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cfdi(rfcEmisor: string, folio: string, overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: folio, tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE",
    regimenFiscalEmisor: "601", rfcEmisor, rfcReceptor: "RRR010101RR1", emisorNombre: "PROVEEDOR", tieneSello: true,
    noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00", ...overrides,
  };
}

async function ingestarLista(body: BodyInit = CSV, periodo = "2026-07", secret = ctx.deps.env.internalSecret) {
  const app = buildApp(ctx.deps);
  return app.request(`/internal/despachos/efos-69b/ingestar?periodo=${periodo}`, { method: "POST", headers: { "x-atiende-internal-secret": secret, "content-length": String(typeof body === "string" ? Buffer.byteLength(body) : (body as Buffer).byteLength) }, body });
}

async function postCfdi(rfc: string, folio: string, overrides: Record<string, unknown> = {}) {
  const app = buildApp(ctx.deps);
  const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdi(rfc, folio, overrides)));
  return { res, body: (await res.json()) as Record<string, any> };
}

describe("POST /internal/despachos/efos-69b/ingestar", () => {
  it("sin secreto interno -> 401; periodo invalido -> 400; CSV sin encabezado -> 400", async () => {
    expect((await ingestarLista(CSV, "2026-07", "incorrecto")).status).toBe(401);
    expect((await ingestarLista(CSV, "2026-13")).status).toBe(400);
    expect((await ingestarLista("a,b\n1,2\n")).status).toBe(400);
  });

  it("ingiere la edicion, informa filas/descartadas y es idempotente (segunda vez: sin_cambios)", async () => {
    const r1 = await ingestarLista();
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, periodo: "2026-07", resultado: "insertada", filas: 4, descartadas: 3 });
    const r2 = await ingestarLista();
    expect(await r2.json()).toMatchObject({ resultado: "sin_cambios" });
    expect(await ctx.despachosRepo.estadoEfos()).toMatchObject({ estado: "disponible", periodo: "2026-07", filas: 4 });
  });

  it("cuerpo mayor al tope -> 413", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/efos-69b/ingestar?periodo=2026-07", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret, "content-length": String(5 * 1024 * 1024) }, body: "x" });
    expect(res.status).toBe(413);
  });
});

describe("ingesta de CFDI con la lista 69-B cargada", () => {
  beforeEach(async () => {
    expect((await ingestarLista()).status).toBe(200);
  });

  it("emisor DEFINITIVO: el CFDI queda invalido con issue efos_69b_definitivo y entra a revision", async () => {
    const { res, body } = await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000001");
    expect(res.status).toBe(201);
    expect(body.valido).toBe(false);
    expect(body.issues.map((i: { codigo: string }) => i.codigo)).toContain("efos_69b_definitivo");
    expect(body.requiereRevisionHumana).toBe(true);
    expect(body.efos).toEqual({ estado: "disponible", periodoLista: "2026-07", situacion: "definitivo" });
    const pend = await ctx.despachosRepo.listPendingReviews(ctx.propertyId);
    expect(pend).toHaveLength(1);
    expect(pend[0]!.reason).toMatch(/efos_69b_definitivo/);
  });

  it("emisor PRESUNTO: sigue valido, warning y revision con motivo explicito", async () => {
    const { body } = await postCfdi("BBB020202BB2", "11111111-2222-3333-4444-000000000002");
    expect(body.valido).toBe(true);
    expect(body.warnings.some((w: string) => /PRESUNTO/.test(w))).toBe(true);
    expect(body.efos.situacion).toBe("presunto");
    const pend = await ctx.despachosRepo.listPendingReviews(ctx.propertyId);
    expect(pend.some((p) => /presunto en la lista 69-B/.test(p.reason))).toBe(true);
  });

  it("emisor DESVIRTUADO: solo nota informativa, valido", async () => {
    const { body } = await postCfdi("CCC030303CC3", "11111111-2222-3333-4444-000000000003");
    expect(body.valido).toBe(true);
    expect(body.warnings.some((w: string) => /Informativo/.test(w))).toBe(true);
  });

  it("emisor fuera de la lista: sin hallazgos EFOS, efos.situacion null y estado disponible (limpio de verdad)", async () => {
    const { body } = await postCfdi("ZZZ999999ZZ9", "11111111-2222-3333-4444-000000000004");
    expect(body.valido).toBe(true);
    expect(JSON.stringify(body.warnings)).not.toMatch(/69-B/);
    expect(body.efos).toEqual({ estado: "disponible", periodoLista: "2026-07", situacion: null });
  });

  it("RFC en minusculas/espacios coincide igual; nomina (tipo N) no se consulta", async () => {
    const { body } = await postCfdi(" aaa010101aa1 ", "11111111-2222-3333-4444-000000000005");
    expect(body.efos.situacion).toBe("definitivo");
    const n = await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000006", { tipo: "N", metodoPago: "PUE", nomina: { totalPercepciones: 1000 }, subtotal: 1000, total: 1000, iva: null });
    expect(n.body.efos.estado).toBe("no_disponible");
  });

  it("importar-xml con un XML invalido sigue respondiendo 400 (EFOS no altera el flujo)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/xml" }, body: "<no-es-un-cfdi/>" });
    expect(res.status).toBe(400); // rechazado por el parser antes de llegar a EFOS: no se rompe el flujo
  });
});

describe("sin lista 69-B (base sin migrar o sin ingesta) el flujo de hoy NO cambia", () => {
  it("ingesta normal: mismo valido/warnings de siempre y efos.estado = no_disponible (NO 'limpio')", async () => {
    const { res, body } = await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000010");
    expect(res.status).toBe(201);
    expect(body.valido).toBe(true);
    expect(body.efos).toEqual({ estado: "no_disponible", periodoLista: null, situacion: null });
    expect(JSON.stringify(body.warnings)).not.toMatch(/69-B/);
  });
});

describe("GET /despachos/:propertyId/efos/estado y /alertas", () => {
  it("estado: no_disponible sin lista; disponible tras ingerir", async () => {
    const app = buildApp(ctx.deps);
    const antes = await app.request(`/despachos/${ctx.propertyId}/efos/estado`, authedJson(ctx.staff.contador.token));
    expect(await antes.json()).toMatchObject({ estado: "no_disponible", periodo: null });
    await ingestarLista();
    const despues = await app.request(`/despachos/${ctx.propertyId}/efos/estado`, authedJson(ctx.staff.contador.token));
    expect(await despues.json()).toMatchObject({ estado: "disponible", periodo: "2026-07", filas: 4 });
  });

  it("alertas re-evalua invoices YA ingeridos con la edicion nueva y solo muestra los de ESTA property", async () => {
    // CFDI ingeridos ANTES de que existiera la lista (limpios en su momento).
    await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000021");
    await postCfdi("CCC030303CC3", "11111111-2222-3333-4444-000000000022");
    // Invoice de OTRA property con el mismo emisor riesgoso: nunca debe aparecer aqui.
    await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId, propertyId: randomUUID(), folioFiscal: "11111111-2222-3333-4444-000000000023", tipo: "I",
      rfcEmisor: "AAA010101AA1", rfcReceptor: "RRR010101RR1", emisorNombre: null, subtotal: 1, total: 1, iva: null, descuento: 0,
      categoria: "sin_clasificar", fecha: "2026-07-02", valido: true, issues: [], warnings: [], requiresHumanReview: false,
      diot: { proveedoresReportables: [], reportable: false },
    });
    await ingestarLista();
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/efos/alertas`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; alertas: { rfcEmisor: string; situacion: string }[] };
    expect(body.estado).toBe("disponible");
    expect(body.alertas).toHaveLength(1); // el desvirtuado y el de otra property quedan fuera
    expect(body.alertas[0]).toMatchObject({ rfcEmisor: "AAA010101AA1", situacion: "definitivo" });
  });

  it("alertas sin lista: 200 con estado no_disponible y arreglo vacio (honesto, no 500)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/efos/alertas`, authedJson(ctx.staff.readonly.token));
    expect(await res.json()).toMatchObject({ estado: "no_disponible", alertas: [] });
  });

  it("sin sesion -> 401", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`/despachos/${ctx.propertyId}/efos/estado`)).status).toBe(401);
    expect((await app.request(`/despachos/${ctx.propertyId}/efos/alertas`)).status).toBe(401);
  });
});
