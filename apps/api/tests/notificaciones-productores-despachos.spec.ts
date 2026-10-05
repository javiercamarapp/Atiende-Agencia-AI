// Productores de notificaciones in-app de despachos: escalamiento manual de un vencimiento, barrido de
// vencimientos (por vencer / vencido) y el analisis de REP (que NO emite: es sin estado). Cada emision
// llega con el evento, el enlace a la pantalla origen y los roles del catalogo; una emision que falla
// (base sin 0039) no cambia la respuesta de negocio.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      cuerpo: "Nivel de escalamiento: 4.",
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

describe("despachos.rep.incoherente (pendiente de conectar: el analisis de REP no emite)", () => {
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

  // El analisis es SIN estado y lo pueden llamar los roles de solo lectura/auditor (VER_CFDI_ROLES): no debe emitir NUNCA, ni con un REP
  // incoherente ni sin ligar, o cualquiera llenaria la campana de owner/admin con XML arbitrario.
  it("el analisis de un REP incoherente o sin ligar responde 200 y NO emite avisos, tampoco para un rol de solo lectura", async () => {
    const { ctx, deps, emisiones } = await contexto();
    const app = buildApp(deps);
    const analizar = (token: string, xml: string) => app.request(`/despachos/${ctx.propertyId}/cfdi/rep/analizar`, authedJson(token, { xml, rfcContribuyente: EMISOR }));
    await sembrarFactura(ctx);
    expect((await analizar(ctx.staff.contador.token, repXml("999.00"))).status).toBe(200); // saldo insoluto incoherente
    expect((await analizar(ctx.staff.auditor.token, repXml("999.00"))).status).toBe(200);
    expect((await analizar(ctx.staff.auditor.token, repXml("580.00").replaceAll(UUID_FACTURA.toUpperCase(), "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"))).status).toBe(200); // documento sin ligar
    expect(emisiones).toHaveLength(0);
  });
});

describe("despachos.efos.alerta", () => {
  const CSV = readFileSync(fileURLToPath(new URL("../../../packages/domain-despachos/tests/fixtures/efos-69b-muestra.csv", import.meta.url)));
  const cfdi = (rfcEmisor: string, folio: string) => ({
    folioFiscal: folio, tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE",
    regimenFiscalEmisor: "601", rfcEmisor, rfcReceptor: "RRR010101RR1", emisorNombre: "PROVEEDOR SECRETO", tieneSello: true,
    noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00",
  });
  async function conLista(opciones: { alEmitir?: () => number } = {}) {
    const c = await contexto(opciones);
    await buildApp(c.ctx.deps).request("/internal/despachos/efos-69b/ingestar?periodo=2026-07", { method: "POST", headers: { "x-atiende-internal-secret": c.ctx.deps.env.internalSecret, "content-length": String(CSV.byteLength) }, body: CSV });
    return { ...c, postCfdi: (rfc: string, folio: string) => buildApp(c.deps).request(`/despachos/${c.ctx.propertyId}/cfdi`, authedJson(c.ctx.staff.contador.token, cfdi(rfc, folio))) };
  }

  it("un CFDI de emisor DEFINITIVO o PRESUNTO emite UN aviso por CFDI, a contadores y auditores, sin RFC ni nombre", async () => {
    const { ctx, emisiones: todas, postCfdi } = await conLista();
    // Un CFDI tipo I tambien avisa "requiere revision" (D-P3-18): aqui solo se juzga la alerta de EFOS.
    const definitivo = await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000001");
    expect(definitivo.status).toBe(201);
    const presunto = await postCfdi("BBB020202BB2", "11111111-2222-3333-4444-000000000002");
    expect(presunto.status).toBe(201);
    const emisiones = todas.filter((e) => e.evento === "despachos.efos.alerta");
    expect(emisiones).toHaveLength(2);
    expect(emisiones[0]).toMatchObject({ evento: "despachos.efos.alerta", organizationId: ctx.organizationId, propertyId: ctx.propertyId, severidad: "critica", categoria: "fiscal", enlace: "/despachos/{orgSlug}/cfdi", roles: ["contador", "auditor"] });
    expect(emisiones[0]!.dedupeKey).toMatch(/^despachos\.efos\.alerta:[0-9a-f-]{36}$/);
    expect(emisiones[0]!.dedupeKey).not.toBe(emisiones[1]!.dedupeKey);
    expect(JSON.stringify(emisiones)).not.toMatch(/AAA010101AA1|BBB020202BB2|SECRETO/);
  });

  it("un emisor que no esta en la lista no emite; sin lista cargada tampoco", async () => {
    const { emisiones: todas, postCfdi } = await conLista();
    const emisiones = { get length() { return todas.filter((e) => e.evento === "despachos.efos.alerta").length; } };
    expect((await postCfdi("ZZZ990909ZZ9", "11111111-2222-3333-4444-000000000003")).status).toBe(201);
    expect(emisiones).toHaveLength(0);
    const sinLista = await contexto();
    expect((await buildApp(sinLista.deps).request(`/despachos/${sinLista.ctx.propertyId}/cfdi`, authedJson(sinLista.ctx.staff.contador.token, cfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000004")))).status).toBe(201);
    expect(sinLista.emisiones.filter((e) => e.evento === "despachos.efos.alerta")).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 201 de la ingesta", async () => {
    const { postCfdi } = await conLista({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    expect((await postCfdi("AAA010101AA1", "11111111-2222-3333-4444-000000000005")).status).toBe(201);
  });
});
