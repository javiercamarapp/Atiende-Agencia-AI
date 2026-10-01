// D-23: POST .../cfdi/rep/analizar (solo lectura) con facturas persistidas y roles reales. XML sintético: RFC de
// prueba del SAT y UUID inventados; sin llamadas al SAT ni a un PAC.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

const UUID_FACTURA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const EMISOR = "EKU9003173C9";
const RECEPTOR = "XAXX010101000";

function repXml(doctos?: string): string {
  const docto =
    doctos ??
    `<pago20:DoctoRelacionado IdDocumento="${UUID_FACTURA.toUpperCase()}" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="1160.00" ImpPagado="580.00" ImpSaldoInsoluto="580.00" ObjetoImpDR="02"><pago20:ImpuestosDR><pago20:TrasladosDR><pago20:TrasladoDR BaseDR="500.00" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="80.00"/></pago20:TrasladosDR></pago20:ImpuestosDR></pago20:DoctoRelacionado>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-09-20T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P" NoCertificado="00001000000500000000" Sello="AbC=">
  <cfdi:Emisor Rfc="${EMISOR}" Nombre="Escuela Kemper Urgate" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${RECEPTOR}" UsoCFDI="CP01"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ValorUnitario="0" Importe="0"/></cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0"><pago20:Pago FechaPago="2026-09-18T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="580.00">${docto}</pago20:Pago></pago20:Pagos>
    <tfd:TimbreFiscalDigital UUID="CCCCCCCC-3333-4333-8333-CCCCCCCCCCCC" FechaTimbrado="2026-09-20T12:00:05"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const analizar = (body: unknown, token = ctx.staff.contador.token) => buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, authedJson(token, body));

function sembrarFactura(overrides: Record<string, unknown> = {}) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    folioFiscal: UUID_FACTURA,
    tipo: "I",
    rfcEmisor: EMISOR,
    rfcReceptor: RECEPTOR,
    emisorNombre: "Escuela Kemper Urgate",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "sin_clasificar",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { proveedoresReportables: [], reportable: false },
    fecha: "2026-09-01",
    ...overrides,
  } as never);
}

describe("POST /despachos/:propertyId/cfdi/rep/analizar", () => {
  it("liga el REP a la factura del despacho y devuelve saldo insoluto e IVA trasladado por mes de pago", async () => {
    await sembrarFactura();
    const res = await analizar({ xml: repXml(), rfcContribuyente: EMISOR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flujo: string;
      documentos: { ligado: boolean; saldoInsolutoCalculadoCentavos: number; ivaCentavos: number; fuenteIva: string }[];
      totales: { pagadoCentavos: number; ivaCentavos: number };
      porPeriodo: Record<string, { ivaCentavos: number }>;
    };
    expect(body.flujo).toBe("trasladado");
    expect(body.documentos[0]).toMatchObject({ ligado: true, saldoInsolutoCalculadoCentavos: 58000, ivaCentavos: 8000, fuenteIva: "rep" });
    expect(body.totales).toMatchObject({ pagadoCentavos: 58000, ivaCentavos: 8000 });
    expect(body.porPeriodo["2026-09"]).toMatchObject({ ivaCentavos: 8000 });
  });

  it("como receptor del REP el flujo es acreditable", async () => {
    await sembrarFactura();
    const body = (await (await analizar({ xml: repXml(), rfcContribuyente: RECEPTOR })).json()) as { flujo: string };
    expect(body.flujo).toBe("acreditable");
  });

  it("sin la factura en el despacho: no ligado, no 500", async () => {
    const body = (await (await analizar({ xml: repXml(), rfcContribuyente: EMISOR })).json()) as { documentosSinLigar: number };
    expect(body.documentosSinLigar).toBe(1);
  });

  it("aislamiento: una factura del MISMO folio en otra property del despacho no se liga", async () => {
    await sembrarFactura({ propertyId: "00000000-0000-0000-0000-00000000dead" });
    const body = (await (await analizar({ xml: repXml(), rfcContribuyente: EMISOR })).json()) as { documentosSinLigar: number };
    expect(body.documentosSinLigar).toBe(1);
  });

  it("un IdDocumento que no es UUID no revienta la consulta (no ligado)", async () => {
    const xml = repXml(`<pago20:DoctoRelacionado IdDocumento="no-es-uuid" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="10.00" ImpPagado="10.00" ImpSaldoInsoluto="0.00" ObjetoImpDR="01"/>`).replace('Monto="580.00"', 'Monto="10.00"');
    const res = await analizar({ xml, rfcContribuyente: EMISOR });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { documentosSinLigar: number }).documentosSinLigar).toBe(1);
  });

  it("validaciones: xml ausente, RFC inválido, RFC ajeno, XML con DTD, Pagos 1.0 y XML que no es REP -> 4xx", async () => {
    expect((await analizar({ rfcContribuyente: EMISOR })).status).toBe(400);
    expect((await analizar({ xml: repXml(), rfcContribuyente: "no" })).status).toBe(400);
    expect((await analizar({ xml: repXml(), rfcContribuyente: "AAA010101AAA" })).status).toBe(400);
    expect((await analizar({ xml: `<!DOCTYPE x [<!ENTITY e "a">]>${repXml()}`, rfcContribuyente: EMISOR })).status).toBe(400);
    expect((await analizar({ xml: repXml().replace('Version="2.0"', 'Version="1.0"'), rfcContribuyente: EMISOR })).status).toBe(400);
    expect((await analizar({ xml: "<a/>", rfcContribuyente: EMISOR })).status).toBe(400);
  });

  it("auditor y readonly pueden analizar (solo lectura); sin token, 401", async () => {
    expect((await analizar({ xml: repXml(), rfcContribuyente: EMISOR }, ctx.staff.auditor.token)).status).toBe(200);
    expect((await analizar({ xml: repXml(), rfcContribuyente: EMISOR }, ctx.staff.readonly.token)).status).toBe(200);
    const sin = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(sin.status).toBe(401);
  });

  it("importar-xml (factura) rechaza un REP con un mensaje claro", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` }, body: repXml() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/CFDI de pago/);
  });
});
