// D-25 -- pagos provisionales ISR/IVA: papel por flujo de efectivo, parametros, guardar, presentar, exportar y pagos de REP.
// Cubre roles, validacion (centavos enteros, coeficiente), presentar con confirmacion, REP (XML real parseado, RFC de la ficha, PPD,
// sobrepago, idempotencia), exportes y base sin migrar (018/020), nunca 500.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { validarFichaCliente } from "@atiende/domain-despachos";
import type { FacturaProvisional } from "@atiende/domain-despachos";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const CLIENTE_RFC = "CLI010101CL1";
const OTRO_RFC = "OTR010101OT1";

function req(token: string, method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    init.body = raw;
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    (init.headers as Record<string, string>)["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  }
  return init;
}
const base = () => `/despachos/${ctx.propertyId}/pagos-provisionales`;

async function sembrarFicha(regimenes: string[] = ["601"]) {
  const f = validarFichaCliente({ rfc: CLIENTE_RFC, razonSocial: "Cliente SA de CV", regimenesFiscales: regimenes, cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}

let n = 0;
function factura(p: Partial<FacturaProvisional> & { base?: number } = {}): FacturaProvisional {
  n += 1;
  const b = p.base ?? 1_000_000;
  const iva = p.ivaTrasladadoCentavos ?? Math.round(b * 0.16);
  return { id: randomUUID(), folioFiscal: `folio-${n}`, tipo: "I", valido: true, fecha: "2026-07-10", direccion: "emitido", metodoPago: "PUE", formaPago: "03", usoCfdi: "G03", moneda: "MXN", subtotalCentavos: b, descuentoCentavos: 0, totalCentavos: b + iva, ivaTrasladadoCentavos: iva, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, estadoSat: "vigente", ...p };
}

describe("GET papel calculado", () => {
  it("601: sin coeficiente el ISR queda 'faltan_parametros' y el IVA se calcula; no inventa cifras", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 4_000_000 }), factura({ direccion: "recibido", base: 2_000_000 }));
    const res = await buildApp(ctx.deps).request(`${base()}/2026-07`, req(ctx.staff.auditor.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { regimen: string; papel: { isr: { estado: string }; iva: { estado: string; aCargoCentavos: number } }; cliente: { rfc: string } };
    expect(body.regimen).toBe("601");
    expect(body.cliente.rfc).toBe(CLIENTE_RFC);
    expect(body.papel.isr.estado).toBe("faltan_parametros");
    expect(body.papel.iva).toMatchObject({ estado: "calculado", aCargoCentavos: 320_000 });
  });

  it("sin ficha del cliente -> 409 con la instruccion; periodo mal formado -> 400; sin token -> 401", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/2026-07`, req(ctx.staff.admin.token, "GET"))).status).toBe(409);
    await sembrarFicha();
    expect((await app.request(`${base()}/2026-7`, req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    expect((await app.request(`${base()}/2026-07`)).status).toBe(401);
    expect((await app.request(`${base()}/2026-07?regimen=612`, req(ctx.staff.admin.token, "GET"))).status).toBe(400); // el cliente no tiene 612
  });

  it("regimen sin papel modelado (603) responde no_soportado, no un error", async () => {
    await sembrarFicha(["603"]);
    const body = (await (await buildApp(ctx.deps).request(`${base()}/2026-07`, req(ctx.staff.admin.token, "GET"))).json()) as { papel: { isr: { estado: string; motivo: string } } };
    expect(body.papel.isr.estado).toBe("no_soportado");
    expect(body.papel.isr.motivo).toMatch(/no está modelado/);
  });
});

describe("POST calcular (no guarda) con parametros", () => {
  it("coeficiente 0.2 sobre 10,000,000 de ingresos: ISR 600,000 (30%) y nada se persiste", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 6_000_000, fecha: "2026-06-05" }), factura({ base: 4_000_000 }));
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base()}/2026-07/calcular`, req(ctx.staff.contador.token, "POST", { coeficienteUtilidad: "0.2", ajustePagosPreviosCentavos: 200_000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { papel: { isr: { estado: string; baseCentavos: number; determinadoCentavos: number; aCargoCentavos: number } } };
    expect(body.papel.isr).toMatchObject({ estado: "calculado", baseCentavos: 2_000_000, determinadoCentavos: 600_000, aCargoCentavos: 400_000 });
    expect((await ctx.pagosRepo.listarPapeles(ctx.propertyId, 2026)).papeles).toHaveLength(0);
  });

  it("D-P3-06: actosExentosCentavos aplica la proporcion del IVA acreditable y se guarda con el papel; sin el dato avisa", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 1_000_000 }), factura({ direccion: "recibido", base: 500_000 }));
    const app = buildApp(ctx.deps);
    type Cuerpo = { papel: { iva: { acreditableCentavos: number; aCargoCentavos: number }; advertencias: string[] } };
    const sin = (await (await app.request(`${base()}/2026-07/calcular`, req(ctx.staff.contador.token, "POST", {}))).json()) as Cuerpo;
    expect(sin.papel.iva.acreditableCentavos).toBe(80_000);
    expect(sin.papel.advertencias.some((a) => a.startsWith("Proporción no aplicada"))).toBe(true);
    const con = (await (await app.request(`${base()}/2026-07/calcular`, req(ctx.staff.contador.token, "POST", { actosExentosCentavos: 250_000 }))).json()) as Cuerpo;
    expect(con.papel.iva).toMatchObject({ acreditableCentavos: 64_000, aCargoCentavos: 96_000 });
    expect((await app.request(`${base()}/2026-07`, req(ctx.staff.contador.token, "PUT", { actosExentosCentavos: 250_000 }))).status).toBe(200);
    const papeles = (await ctx.pagosRepo.listarPapeles(ctx.propertyId, 2026)).papeles;
    expect(papeles.find((p) => p.impuesto === "IVA")?.parametros).toMatchObject({ actosExentosCentavos: 250_000 });
  });

  it.each([
    ["actos exentos con decimales", { actosExentosCentavos: 10.5 }],
    ["actos gravados negativos", { actosGravadosCentavos: -1 }],
    ["coeficiente mal formado", { coeficienteUtilidad: "0.2345678" }],
    ["coeficiente con coma", { coeficienteUtilidad: "0,2" }],
    ["centavos con decimales", { coeficienteUtilidad: "0.2", perdidasPendientesCentavos: 10.5 }],
    ["centavos negativos", { coeficienteUtilidad: "0.2", ajustePagosPreviosCentavos: -1 }],
    ["centavos en texto", { coeficienteUtilidad: "0.2", saldoFavorAnteriorCentavos: "100" }],
    ["monto fuera de tope", { coeficienteUtilidad: "0.2", perdidasPendientesCentavos: 1e15 }],
  ])("rechaza con 400: %s", async (_n, body) => {
    await sembrarFicha();
    expect((await buildApp(ctx.deps).request(`${base()}/2026-07/calcular`, req(ctx.staff.admin.token, "POST", body))).status).toBe(400);
  });
});

describe("PUT guardar y POST presentar", () => {
  async function guardar(token = ctx.staff.contador.token, body: Record<string, unknown> = { coeficienteUtilidad: "0.2" }) {
    return buildApp(ctx.deps).request(`${base()}/2026-07`, req(token, "PUT", body));
  }

  it("guarda ISR e IVA como borrador, deja bitacora y el siguiente GET usa los parametros guardados", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 10_000_000 }));
    const res = await guardar();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { guardado: { isr: boolean; iva: boolean } }).guardado).toEqual({ isr: true, iva: true });
    const papeles = (await ctx.pagosRepo.listarPapeles(ctx.propertyId, 2026)).papeles;
    expect(papeles.map((p) => `${p.impuesto}:${p.estado}`).sort()).toEqual(["ISR:borrador", "IVA:borrador"]);
    expect(papeles.find((p) => p.impuesto === "ISR")?.parametros).toMatchObject({ coeficienteUtilidad: "0.2", regimen: "601" });
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.pagos-provisionales:guardar")).toBe(true);
    const otra = (await (await buildApp(ctx.deps).request(`${base()}/2026-07`, req(ctx.staff.readonly.token, "GET"))).json()) as { papel: { isr: { estado: string; determinadoCentavos: number } }; parametros: { coeficienteUtilidad: string } };
    expect(otra.papel.isr).toMatchObject({ estado: "calculado", determinadoCentavos: 600_000 });
    expect(otra.parametros.coeficienteUtilidad).toBe("0.2");
  });

  it("sin coeficiente guarda solo el IVA (el ISR no se inventa)", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura());
    const res = await guardar(ctx.staff.contador.token, {});
    expect(((await res.json()) as { guardado: { isr: boolean; iva: boolean } }).guardado).toEqual({ isr: false, iva: true });
  });

  it("auditor y readonly NO guardan ni presentan (403)", async () => {
    await sembrarFicha();
    for (const t of [ctx.staff.auditor.token, ctx.staff.readonly.token]) {
      expect((await guardar(t)).status).toBe(403);
      expect((await buildApp(ctx.deps).request(`${base()}/2026-07/presentar`, req(t, "POST", {}))).status).toBe(403);
      expect((await buildApp(ctx.deps).request(`${base()}/rep`, req(t, "POST", { xml: "<x/>" }))).status).toBe(403);
    }
  });

  it("presentar exige la confirmacion exacta, una fecha real no futura y monto en centavos; luego ya no se recalcula", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 10_000_000 }));
    await guardar();
    const app = buildApp(ctx.deps);
    const presentar = (body: unknown) => app.request(`${base()}/2026-07/presentar`, req(ctx.staff.contador.token, "POST", body));
    const ok = { impuesto: "ISR", montoPagadoCentavos: 600_000, fechaPresentacion: "2026-08-14", confirmacion: "ISR 2026-07" };
    expect((await presentar({ ...ok, confirmacion: "ISR 2026-08" })).status).toBe(400);
    expect((await presentar({ ...ok, montoPagadoCentavos: 6000.5 })).status).toBe(400);
    expect((await presentar({ ...ok, montoPagadoCentavos: undefined })).status).toBe(400);
    expect((await presentar({ ...ok, fechaPresentacion: "2026-02-30" })).status).toBe(400);
    expect((await presentar({ ...ok, fechaPresentacion: "2099-01-01" })).status).toBe(400);
    expect((await presentar({ ...ok, impuesto: "IEPS" })).status).toBe(400);
    expect((await presentar(ok)).status).toBe(200);
    expect((await presentar(ok)).status).toBe(409); // ya presentado
    expect((await guardar()).status).toBe(409); // ya no se recalcula
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.pagos-provisionales:presentar" && e.metadata?.montoPagadoCentavos === 600_000)).toBe(true);
  });

  it("el ISR presentado de meses anteriores se acredita en el siguiente mes (monto pagado)", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 10_000_000, fecha: "2026-06-10" }), factura({ base: 10_000_000, fecha: "2026-07-10" }));
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/2026-06`, req(ctx.staff.contador.token, "PUT", { coeficienteUtilidad: "0.2" }));
    await app.request(`${base()}/2026-06/presentar`, req(ctx.staff.contador.token, "POST", { impuesto: "ISR", montoPagadoCentavos: 600_000, fechaPresentacion: "2026-07-14", confirmacion: "ISR 2026-06" }));
    const julio = (await (await app.request(`${base()}/2026-07/calcular`, req(ctx.staff.contador.token, "POST", { coeficienteUtilidad: "0.2" }))).json()) as { papel: { isr: { determinadoCentavos: number; aCargoCentavos: number } } };
    expect(julio.papel.isr.determinadoCentavos).toBe(1_200_000); // 20,000,000 acumulados x 0.2 x 30%
    expect(julio.papel.isr.aCargoCentavos).toBe(600_000); // menos el pago provisional de junio
  });
});

describe("exportar PDF y XLSX", () => {
  it("genera un PDF y un XLSX reales del papel; formato invalido -> 400", async () => {
    await sembrarFicha();
    ctx.pagosRepo.sembrarFacturas(factura({ base: 10_000_000 }));
    const app = buildApp(ctx.deps);
    const pdf = await app.request(`${base()}/2026-07/exportar?formato=pdf`, req(ctx.staff.auditor.token, "GET"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const xlsx = await app.request(`${base()}/2026-07/exportar?formato=xlsx`, req(ctx.staff.auditor.token, "GET"));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = new Uint8Array(await xlsx.arrayBuffer());
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    expect((await app.request(`${base()}/2026-07/exportar?formato=docx`, req(ctx.staff.auditor.token, "GET"))).status).toBe(400);
  });
});

const FOLIO_PPD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FOLIO_REP = "99999999-9999-9999-9999-999999999999";
function repXml(o: { receptor?: string; emisor?: string; pagadoPesos?: number; saldoAntPesos?: number; doc?: string } = {}): string {
  const { emisor = CLIENTE_RFC, receptor = OTRO_RFC, pagadoPesos = 29000, saldoAntPesos = 58000, doc = FOLIO_PPD } = o;
  const f = (x: number) => x.toFixed(2);
  const iva = Math.round((pagadoPesos / 1.16) * 0.16 * 100) / 100;
  const baseDr = Math.round((pagadoPesos - iva) * 100) / 100;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-07-15T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P" Exportacion="01" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${emisor}" Nombre="Emisor" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptor}" Nombre="Receptor" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601" UsoCFDI="CP01"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/></cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Totales MontoTotalPagos="${f(pagadoPesos)}"/>
      <pago20:Pago FechaPago="2026-07-15T12:00:00" FormaDePagoP="03" MonedaP="MXN" TipoCambioP="1" Monto="${f(pagadoPesos)}">
        <pago20:DoctoRelacionado IdDocumento="${doc}" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="${f(saldoAntPesos)}" ImpPagado="${f(pagadoPesos)}" ImpSaldoInsoluto="${f(saldoAntPesos - pagadoPesos)}" ObjetoImpDR="02">
          <pago20:ImpuestosDR><pago20:TrasladosDR><pago20:TrasladoDR BaseDR="${f(baseDr)}" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="${f(iva)}"/></pago20:TrasladosDR></pago20:ImpuestosDR>
        </pago20:DoctoRelacionado>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${FOLIO_REP}" FechaTimbrado="2026-07-15T12:00:05" RfcProvCertif="AAA010101AAA" SelloCFD="x" NoCertificadoSAT="00001000000500000000" SelloSAT="x"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

describe("POST rep (pagos del complemento de pago persistidos)", () => {
  async function sembrarPpd() {
    const f = factura({ id: randomUUID(), metodoPago: "PPD", formaPago: "99", base: 5_000_000, fecha: "2026-06-20" });
    // el REP liga por FOLIO FISCAL: la factura se registra tambien en el repo de CFDI con ese folio
    await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: FOLIO_PPD, tipo: "I", rfcEmisor: CLIENTE_RFC, rfcReceptor: OTRO_RFC, emisorNombre: null, subtotal: 50000, total: 58000, iva: 8000, descuento: 0,
      categoria: "honorarios", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { reportable: false } as never, fecha: "2026-06-20", direccion: "emitido", metodoPago: "PPD", moneda: "MXN",
      subtotalCentavos: 5_000_000, descuentoCentavos: 0, totalCentavos: 5_800_000, ivaTrasladadoCentavos: 800_000,
    }).then((inv) => ctx.pagosRepo.sembrarFacturas({ ...f, id: inv.id, folioFiscal: FOLIO_PPD }));
  }

  it("registra el pago (base prorrateada de la factura persistida) y es idempotente", async () => {
    await sembrarFicha();
    await sembrarPpd();
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base()}/rep`, req(ctx.staff.contador.token, "POST", { xml: repXml() }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { registrados: number; yaExistian: number; flujo: string; omitidos: unknown[] };
    expect(body).toMatchObject({ registrados: 1, yaExistian: 0, flujo: "trasladado", omitidos: [] });
    const otra = await app.request(`${base()}/rep`, req(ctx.staff.contador.token, "POST", { xml: repXml() }));
    expect(otra.status).toBe(200);
    expect(((await otra.json()) as { registrados: number; yaExistian: number })).toMatchObject({ registrados: 0, yaExistian: 1 });
    const baseLeida = await ctx.pagosRepo.leerBase(ctx.propertyId, 2026, 7);
    expect(baseLeida.pagos).toEqual([expect.objectContaining({ importePagadoCentavos: 2_900_000, baseCentavos: 2_500_000, ivaCentavos: 400_000, flujo: "trasladado" })]);
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.pagos-provisionales:registrar-rep")).toHaveLength(1);
  });

  it("el pago registrado alimenta el papel del mes del PAGO (IVA trasladado 400,000)", async () => {
    await sembrarFicha();
    await sembrarPpd();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/rep`, req(ctx.staff.contador.token, "POST", { xml: repXml() }));
    const papel = (await (await app.request(`${base()}/2026-07`, req(ctx.staff.contador.token, "GET"))).json()) as { papel: { iva: { determinadoCentavos: number }; pendientesPpd: { cantidad: number } } };
    expect(papel.papel.iva.determinadoCentavos).toBe(400_000);
    expect(papel.papel.pendientesPpd.cantidad).toBe(0);
  });

  it("el RFC sale de la ficha: un REP ajeno al cliente -> 400; sin ficha -> 409; XML invalido -> 400", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: repXml() }))).status).toBe(409);
    await sembrarFicha();
    await sembrarPpd();
    expect((await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: repXml({ emisor: "AJE010101AJ1", receptor: "RRR010101RR1" }) }))).status).toBe(400);
    expect((await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: "<no-es-un-cfdi/>" }))).status).toBe(400);
    expect((await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: "" }))).status).toBe(400);
  });

  it("un pago a un CFDI que no esta en el cliente se OMITE con motivo (no se crea nada)", async () => {
    await sembrarFicha();
    const res = await buildApp(ctx.deps).request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: repXml({ doc: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registrados: number; omitidos: { motivo: string }[] };
    expect(body.registrados).toBe(0);
    expect(body.omitidos[0]!.motivo).toMatch(/no está en este cliente/);
  });

  it("sobrepago: la base lo rechaza por pago y el resto de la peticion sigue (rechazados, sin 500)", async () => {
    await sembrarFicha();
    await sembrarPpd();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: repXml({ pagadoPesos: 50000 }) }));
    const res = await app.request(`${base()}/rep`, req(ctx.staff.admin.token, "POST", { xml: repXml({ pagadoPesos: 29000, saldoAntPesos: 8000 }).replace(FOLIO_REP, "77777777-7777-7777-7777-777777777777") }));
    const body = (await res.json()) as { registrados: number; rechazados: { motivo: string }[] };
    expect(body.registrados).toBe(0);
    expect(body.rechazados[0]!.motivo).toMatch(/suman más que el total/);
  });
});

describe("base sin migrar", () => {
  it("sin la 020: el papel se calcula con los PPD excluidos y avisados; guardar/presentar/REP -> 503", async () => {
    await sembrarFicha();
    ctx.pagosRepo.disponible = false;
    ctx.pagosRepo.sembrarFacturas(factura({ metodoPago: "PPD" }), factura());
    const app = buildApp(ctx.deps);
    const res = await app.request(`${base()}/2026-07`, req(ctx.staff.admin.token, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guardadoDisponible: boolean; papel: { advertencias: string[] } };
    expect(body.guardadoDisponible).toBe(false);
    expect(body.papel.advertencias.join(" ")).toMatch(/REP\) no están disponibles/);
    expect((await app.request(`${base()}/2026-07`, req(ctx.staff.admin.token, "PUT", { coeficienteUtilidad: "0.2" }))).status).toBe(503);
    expect((await app.request(`${base()}/2026-07/presentar`, req(ctx.staff.admin.token, "POST", { impuesto: "IVA", montoPagadoCentavos: 0, fechaPresentacion: "2026-08-14", confirmacion: "IVA 2026-07" }))).status).toBe(503);
  });

  it("sin la 018 (CFDI completo): 503 'no disponible aun', nunca 500", async () => {
    await sembrarFicha();
    ctx.pagosRepo.facturasDisponibles = false;
    const res = await buildApp(ctx.deps).request(`${base()}/2026-07`, req(ctx.staff.admin.token, "GET"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toMatch(/migración 018/);
  });
});
