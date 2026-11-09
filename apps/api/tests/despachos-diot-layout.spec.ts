// D-05: GET /despachos/:propertyId/declaraciones/diot/:periodo/layout -- layout TXT/XML
// reconstruido desde invoices persistidos, sin firma ni envio, con el mismo rol de lectura
// que la DIOT agregada.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext, sembrarFichaCliente } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
  await sembrarFichaCliente(ctx, "AAA010101AAA");
});

function cfdi(overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: "11111111-2222-3333-4444-555555555555",
    tipo: "I",
    subtotal: 1234.56,
    total: 1432.09,
    descuento: 0,
    iva: 197.53,
    conceptos: [{ cantidad: 1, valorUnitario: 1234.56, importe: 1234.56 }],
    usoCfdi: "G03",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "AAA010101AAA",
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

const layoutUrl = (periodo: string) => `/despachos/${ctx.propertyId}/declaraciones/diot/${periodo}/layout`;

describe("GET .../declaraciones/diot/:periodo/layout", () => {
  it("genera TXT y XML desde un CFDI reportable real, en pesos enteros y sin firma", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdi()))).status).toBe(201);

    const res = await app.request(layoutUrl("2026-07"), authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rfcContribuyente: string; txt: string; xml: string; renglones: { valorActos16: number }[]; advertencias: string[] };
    expect(body.rfcContribuyente).toBe("AAA010101AAA");
    expect(body.renglones).toHaveLength(1);
    expect(body.renglones[0]!.valorActos16).toBe(1235);
    const campos = body.txt.split("\r\n")[0]!.split("|");
    expect(campos.slice(0, 3)).toEqual(["04", "85", "CON950820K12"]);
    expect(campos[7]).toBe("1235");
    expect(body.xml).toContain('firmado="false"');
    expect(body.advertencias.length).toBeGreaterThan(0);
  });

  it("periodo sin CFDI reportables: 200 con archivo vacio y advertencia honesta (no error)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(layoutUrl("2026-08"), authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { txt: string; renglones: unknown[]; advertencias: string[] };
    expect(body.txt).toBe("");
    expect(body.renglones).toEqual([]);
    expect(body.advertencias[0]).toMatch(/no contiene renglones/);
  });

  it("D-P3-01: un CFDI emitido por el cliente (su venta) no entra al layout como proveedor", async () => {
    const app = buildApp(ctx.deps);
    const venta = cfdi({ rfcEmisor: "AAA010101AAA", rfcReceptor: "CON950820K12", folioFiscal: "99999999-2222-3333-4444-555555555555" });
    expect((await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, venta))).status).toBe(201);
    const res = await app.request(layoutUrl("2026-07"), authedJson(ctx.staff.contador.token));
    const body = (await res.json()) as { rfcContribuyente: string | null; renglones: unknown[]; txt: string };
    expect(body.renglones).toEqual([]);
    expect(body.txt).toBe("");
  });

  it("D-P3-01: sin ficha de cartera el layout no se arma y la advertencia lo dice", async () => {
    const sinFicha = await buildDespachosTestContext(buildApp);
    const app = buildApp(sinFicha.deps);
    await app.request(`/despachos/${sinFicha.propertyId}/cfdi`, authedJson(sinFicha.staff.contador.token, cfdi()));
    const res = await app.request(`/despachos/${sinFicha.propertyId}/declaraciones/diot/2026-07/layout`, authedJson(sinFicha.staff.contador.token));
    const body = (await res.json()) as { rfcContribuyente: string | null; renglones: unknown[]; advertencias: string[] };
    expect(body.rfcContribuyente).toBeNull();
    expect(body.renglones).toEqual([]);
    expect(body.advertencias[0]).toMatch(/ficha/);
  });

  it("periodo mal formado -> 400 de validacion", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(layoutUrl("2026-13"), authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(400);
  });

  it("sin sesion -> 401; auditor/readonly SI pueden leer (VER_DECLARACIONES_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(layoutUrl("2026-07"))).status).toBe(401);
    expect((await app.request(layoutUrl("2026-07"), authedJson(ctx.staff.auditor.token))).status).toBe(200);
    expect((await app.request(layoutUrl("2026-07"), authedJson(ctx.staff.readonly.token))).status).toBe(200);
  });
});
