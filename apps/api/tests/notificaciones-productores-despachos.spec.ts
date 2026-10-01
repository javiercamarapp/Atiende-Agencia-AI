// Productores de notificaciones in-app de despachos: escalamiento manual de un vencimiento, barrido de
// vencimientos (por vencer / vencido) y REP con documentos sin ligar o saldo incoherente. Cada emision
// llega con el evento, el enlace a la pantalla origen y los roles del catalogo; una emision que falla
// (base sin 0039) no cambia la respuesta de negocio.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function contexto(opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildDespachosTestContext(buildApp);
  return { ctx, ...conEmisiones(ctx.deps, opciones) };
}

describe("despachos.fiscal.vencimiento_escalado", () => {
  it("escalar un vencimiento emite UN aviso con el nivel, clave por vencimiento y nivel, a contadores", async () => {
    const { ctx, deps, emisiones } = await contexto();
    const app = buildApp(deps);
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2020, month: 1 }));
    const [deadline] = (await (await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token))).json()) as { id: string }[];

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/escalar`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(201);

    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "despachos.fiscal.vencimiento_escalado",
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      categoria: "fiscal",
      cuerpo: "Nivel de escalamiento: nivel_4.",
      enlace: "/despachos/{orgSlug}/vencimientos",
      dedupeKey: `despachos.fiscal.vencimiento_escalado:${deadline!.id}:nivel_4`,
      roles: ["contador"],
    });
  });

  it("una emision que falla (base sin migrar) no cambia el 201 del escalamiento", async () => {
    const { ctx, deps } = await contexto({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const app = buildApp(deps);
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2020, month: 1 }));
    const [deadline] = (await (await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token))).json()) as { id: string }[];
    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/escalar`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(201);
  });
});

describe("despachos.fiscal.vencimiento_vencido (barrido)", () => {
  it("el barrido de una property con vencimientos ya vencidos emite el aviso con la cantidad, una por property por dia", async () => {
    const { ctx, deps, emisiones } = await contexto();
    const app = buildApp(deps);
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2020, month: 1 }));

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos/barrido`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { escalados: unknown[] };
    expect(body.escalados.length).toBeGreaterThan(0);

    const vencidas = emisiones.filter((e) => e.evento === "despachos.fiscal.vencimiento_vencido");
    expect(vencidas).toHaveLength(1);
    expect(vencidas[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, severidad: "critica", enlace: "/despachos/{orgSlug}/vencimientos", roles: ["contador"] });
    expect(vencidas[0]!.cuerpo).toBe(`Vencidas sin presentar: ${body.escalados.length}.`);
  });
});

describe("despachos.rep.incoherente", () => {
  const UUID_FACTURA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const EMISOR = "EKU9003173C9";
  const RECEPTOR = "XAXX010101000";
  const repXml = (saldoInsoluto: string) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-09-20T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P" NoCertificado="00001000000500000000" Sello="AbC=">
  <cfdi:Emisor Rfc="${EMISOR}" Nombre="Escuela Kemper Urgate" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${RECEPTOR}" UsoCFDI="CP01"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ValorUnitario="0" Importe="0"/></cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0"><pago20:Pago FechaPago="2026-09-18T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="580.00"><pago20:DoctoRelacionado IdDocumento="${UUID_FACTURA.toUpperCase()}" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="1160.00" ImpPagado="580.00" ImpSaldoInsoluto="${saldoInsoluto}" ObjetoImpDR="02"><pago20:ImpuestosDR><pago20:TrasladosDR><pago20:TrasladoDR BaseDR="500.00" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="80.00"/></pago20:TrasladosDR></pago20:ImpuestosDR></pago20:DoctoRelacionado></pago20:Pago></pago20:Pagos>
    <tfd:TimbreFiscalDigital UUID="CCCCCCCC-3333-4333-8333-CCCCCCCCCCCC" FechaTimbrado="2026-09-20T12:00:05"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

  const sembrarFactura = (ctx: Awaited<ReturnType<typeof contexto>>["ctx"]) =>
    ctx.despachosRepo.insertInvoice({
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
      metodoPago: "PPD",
    } as never);

  it("un REP con saldo insoluto incoherente emite el aviso (cantidad, sin PII) con clave por REP", async () => {
    const { ctx, deps, emisiones } = await contexto();
    await sembrarFactura(ctx);
    const res = await buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, authedJson(ctx.staff.contador.token, { xml: repXml("999.00"), rfcContribuyente: EMISOR }));
    expect(res.status).toBe(200);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "despachos.rep.incoherente",
      organizationId: ctx.organizationId,
      cuerpo: "Documentos a revisar: 1.",
      enlace: "/despachos/{orgSlug}/cfdi",
      roles: ["contador", "auditor"],
    });
    expect(emisiones[0]!.dedupeKey).toBe(`despachos.rep.incoherente:${ctx.propertyId}:cccccccc-3333-4333-8333-cccccccccccc`);
    expect(`${emisiones[0]!.titulo} ${emisiones[0]!.cuerpo}`).not.toMatch(/Kemper|EKU9003173C9|XAXX/);
  });

  it("un REP coherente y ligado no emite nada", async () => {
    const { ctx, deps, emisiones } = await contexto();
    await sembrarFactura(ctx);
    const res = await buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, authedJson(ctx.staff.contador.token, { xml: repXml("580.00"), rfcContribuyente: EMISOR }));
    expect(res.status).toBe(200);
    expect(emisiones).toHaveLength(0);
  });

  it("un REP cuya factura no esta en el despacho (sin ligar) emite el aviso", async () => {
    const { ctx, deps, emisiones } = await contexto();
    const res = await buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, authedJson(ctx.staff.contador.token, { xml: repXml("580.00"), rfcContribuyente: EMISOR }));
    expect(res.status).toBe(200);
    expect(emisiones.map((e) => e.evento)).toEqual(["despachos.rep.incoherente"]);
  });
});
