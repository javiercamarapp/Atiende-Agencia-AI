// D-22 -- modelo CFDI completo persistido: direccion (emitido/recibido segun el RFC de la ficha del cliente),
// MetodoPago/FormaPago/UsoCFDI/Moneda/TipoCambio, montos en centavos, impuestos desglosados y estado SAT. XML sinteticos
// (sin PAC ni SAT). Incluye XML malicioso (XXE/entidades), montos absurdos y la base sin migrar.
import { beforeEach, describe, expect, it } from "vitest";
import { validarFichaCliente } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const CLIENTE_RFC = "CLI010101CL1";
const OTRO_RFC = "OTR010101OT1";

async function sembrarFicha(rfc = CLIENTE_RFC) {
  const f = validarFichaCliente({ rfc, razonSocial: "Cliente SA", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha de prueba invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}

interface XmlOpts {
  readonly uuid?: string;
  readonly emisor?: string;
  readonly receptor?: string;
  readonly moneda?: string;
  readonly tipoCambio?: string;
  readonly prefijo?: string;
  readonly conceptos?: string;
  readonly total?: string;
  readonly subtotal?: string;
}

function cfdiXml(o: XmlOpts = {}): string {
  const { uuid = "11111111-2222-3333-4444-555555555555", emisor = OTRO_RFC, receptor = CLIENTE_RFC, moneda = "MXN", prefijo = "" } = o;
  const tc = o.tipoCambio ? ` TipoCambio="${o.tipoCambio}"` : "";
  const conceptos =
    o.conceptos ??
    `<cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`;
  return `${prefijo}<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-07-01T10:00:00" Sello="AbCdEf1234==" FormaPago="03" NoCertificado="00001000000504465028" Certificado="MIIF" SubTotal="${o.subtotal ?? "1000.00"}" Moneda="${moneda}"${tc} Total="${o.total ?? "1160.00"}" TipoDeComprobante="I" Exportacion="01" MetodoPago="PPD" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="${emisor}" Nombre="Emisor de Prueba SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptor}" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>${conceptos}</cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid}" FechaTimbrado="2026-07-01T10:05:00" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/></cfdi:Complemento>
</cfdi:Comprobante>`;
}

function xmlReq(token: string, xml: string): RequestInit {
  return { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/xml", "content-length": String(new TextEncoder().encode(xml).byteLength) }, body: xml };
}
const importar = (xml: string, token = ctx.staff.contador.token) => buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlReq(token, xml));
const get = (path: string, token = ctx.staff.admin.token) => buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}${path}`, authedJson(token));
const put = (path: string, body: unknown, token = ctx.staff.contador.token) => {
  const raw = JSON.stringify(body);
  return buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw });
};

describe("direccion emitido / recibido por el RFC de la ficha del cliente", () => {
  it("receptor = RFC del cliente -> recibido; persiste pago, uso, moneda y centavos", async () => {
    await sembrarFicha();
    const res = await importar(cfdiXml());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      direccion: "recibido",
      metodoPago: "PPD",
      formaPago: "03",
      usoCfdi: "G03",
      moneda: "MXN",
      tipoCambio: null,
      montosCentavos: { subtotal: 100000, descuento: 0, total: 116000, ivaTrasladado: 16000, isrRetenido: null, ivaRetenido: null, ieps: null },
      estadoSat: "pendiente",
    });
  });

  it("emisor = RFC del cliente -> emitido", async () => {
    await sembrarFicha();
    const res = await importar(cfdiXml({ emisor: CLIENTE_RFC, receptor: "PUB010101PB1" }));
    expect(((await res.json()) as { direccion: string }).direccion).toBe("emitido");
  });

  it("sin ficha de cartera -> indeterminado (jamas se adivina)", async () => {
    const res = await importar(cfdiXml());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { direccion: string }).direccion).toBe("indeterminado");
  });

  it("un CFDI que no involucra al cliente -> indeterminado", async () => {
    await sembrarFicha();
    const res = await importar(cfdiXml({ emisor: "AAA010101AA1", receptor: "BBB010101BB1" }));
    expect(((await res.json()) as { direccion: string }).direccion).toBe("indeterminado");
  });

  it("el listado filtra por direccion y rechaza un valor desconocido", async () => {
    await sembrarFicha();
    await importar(cfdiXml({ uuid: "11111111-2222-3333-4444-555555555551" }));
    await importar(cfdiXml({ uuid: "11111111-2222-3333-4444-555555555552", emisor: CLIENTE_RFC, receptor: "PUB010101PB1" }));
    const recibidos = (await (await get("/cfdi?direccion=recibido")).json()) as { direccion: string }[];
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]!.direccion).toBe("recibido");
    expect(((await (await get("/cfdi?direccion=emitido")).json()) as unknown[]).length).toBe(1);
    expect(((await (await get("/cfdi")).json()) as unknown[]).length).toBe(2);
    expect((await get("/cfdi?direccion=sideral")).status).toBe(400);
  });
});

describe("moneda, tipo de cambio e impuestos desglosados", () => {
  const conceptosConRetencion = `<cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos>
      <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados>
      <cfdi:Retenciones><cfdi:Retencion Base="1000.00" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.100000" Importe="100.00"/></cfdi:Retenciones></cfdi:Impuestos></cfdi:Concepto>`;

  it("USD con tipo de cambio: se persisten y el detalle trae el desglose (traslado IVA + retencion ISR) en centavos", async () => {
    await sembrarFicha();
    const res = await importar(cfdiXml({ moneda: "USD", tipoCambio: "17.512345", conceptos: conceptosConRetencion, total: "1060.00" }));
    expect(res.status).toBe(201);
    const creado = (await res.json()) as { id: string; moneda: string; tipoCambio: number; montosCentavos: { isrRetenido: number; ivaTrasladado: number } };
    expect(creado).toMatchObject({ moneda: "USD", tipoCambio: 17.512345 });

    const detalle = (await (await get(`/cfdi/${creado.id}`)).json()) as { impuestos: { naturaleza: string; impuesto: string; nombre: string; tasaOCuota: string; baseCentavos: number; importeCentavos: number }[] };
    expect(detalle.impuestos).toHaveLength(2);
    expect(detalle.impuestos).toContainEqual(expect.objectContaining({ naturaleza: "traslado", impuesto: "002", nombre: "IVA", tasaOCuota: "0.160000", baseCentavos: 100000, importeCentavos: 16000 }));
    expect(detalle.impuestos).toContainEqual(expect.objectContaining({ naturaleza: "retencion", impuesto: "001", nombre: "ISR", tasaOCuota: "0.100000", importeCentavos: 10000 }));
    // El listado NO arrastra el desglose (solo el detalle).
    const lista = (await (await get("/cfdi")).json()) as Record<string, unknown>[];
    expect(lista[0]).not.toHaveProperty("impuestos");
  });

  it("IVA exento: se ingiere (antes lanzaba) y el desglose conserva el renglon Exento sin importe", async () => {
    const exento = `<cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Renta casa" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`;
    const res = await importar(cfdiXml({ conceptos: exento, total: "1000.00" }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const detalle = (await (await get(`/cfdi/${id}`)).json()) as { impuestos: { tipoFactor: string; importeCentavos: number | null }[]; montosCentavos: { ivaTrasladado: number | null } };
    expect(detalle.impuestos).toEqual([expect.objectContaining({ tipoFactor: "Exento", importeCentavos: null })]);
    expect(detalle.montosCentavos.ivaTrasladado).toBeNull();
  });

  it("POST JSON: moneda y tipo de cambio opcionales; sin ellos quedan null (no se inventa MXN)", async () => {
    const base = { folioFiscal: "22222222-2222-3333-4444-555555555555", tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160, conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE", regimenFiscalEmisor: "601", rfcEmisor: OTRO_RFC, rfcReceptor: CLIENTE_RFC, emisorNombre: "E", tieneSello: true, noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00" };
    const sin = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, base));
    expect(sin.status).toBe(201);
    expect(await sin.json()).toMatchObject({ moneda: null, tipoCambio: null, metodoPago: "PUE", montosCentavos: { total: 116000 } });
    const con = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, { ...base, folioFiscal: "33333333-2222-3333-4444-555555555555", moneda: "usd", tipoCambio: 18.25 }));
    expect(await con.json()).toMatchObject({ moneda: "USD", tipoCambio: 18.25 });
  });

  it("catalogos con forma invalida (metodoPago XYZ, moneda PESOS) NO tumban la ingesta: se guardan null y el hallazgo queda", async () => {
    const body = { folioFiscal: "44444444-2222-3333-4444-555555555555", tipo: "I", subtotal: 1000, total: 1160, descuento: 0, iva: 160, conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "ZZZ-LARGO", formaPago: "3", metodoPago: "XYZ", moneda: "PESOS", tipoCambio: -4, regimenFiscalEmisor: "601", rfcEmisor: OTRO_RFC, rfcReceptor: CLIENTE_RFC, emisorNombre: "E", tieneSello: true, noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00", fechaTimbrado: "2026-07-01T10:05:00" };
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, body));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ metodoPago: null, formaPago: null, usoCfdi: null, moneda: null, tipoCambio: null, valido: false });
  });

  it("monto fuera de rango -> 400 y no se persiste nada", async () => {
    const body = { folioFiscal: "55555555-2222-3333-4444-555555555555", tipo: "I", subtotal: 1e20, total: 1e20, descuento: 0, iva: null, conceptos: [{ cantidad: 1, valorUnitario: 1, importe: 1 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE", regimenFiscalEmisor: "601", rfcEmisor: OTRO_RFC, rfcReceptor: CLIENTE_RFC, tieneSello: true, noCertificado: "00001000000504465028", fecha: "2026-07-01T10:00:00" };
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, body));
    expect(res.status).toBe(400);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });
});

describe("XML malicioso: se rechaza ANTES de parsear y no deja rastro", () => {
  const casos: [string, string][] = [
    ["XXE con entidad externa", '<?xml version="1.0"?><!DOCTYPE c [<!ENTITY xxe SYSTEM "file:///etc/hostname">]>'],
    ["entidades anidadas (billion laughs)", '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>'],
    ["hoja de estilo", '<?xml-stylesheet type="text/xsl" href="http://127.0.0.1/x.xsl"?>'],
    ["codificacion distinta de UTF-8", '<?xml version="1.0" encoding="UTF-16"?>'],
  ];
  it.each(casos)("%s -> 400, ningun CFDI ni revision creados", async (_n, prefijo) => {
    const res = await importar(cfdiXml({ prefijo }));
    expect(res.status).toBe(400);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
    expect(await ctx.despachosRepo.listPendingReviews(ctx.propertyId)).toHaveLength(0);
  });
  it("auditor y readonly no importan XML (403)", async () => {
    expect((await importar(cfdiXml(), ctx.staff.auditor.token)).status).toBe(403);
    expect((await importar(cfdiXml(), ctx.staff.readonly.token)).status).toBe(403);
  });
});

describe("PUT /despachos/:propertyId/cfdi/:invoiceId/estado-sat", () => {
  async function crear() {
    const res = await importar(cfdiXml());
    return ((await res.json()) as { id: string }).id;
  }

  it("el contador registra el estado y queda con fecha de verificacion; el detalle lo refleja", async () => {
    const id = await crear();
    const res = await put(`/cfdi/${id}/estado-sat`, { estado: "vigente" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, estadoSat: "vigente" });
    expect(((await (await get(`/cfdi/${id}`)).json()) as { estadoSatVerificadoEn: string | null }).estadoSatVerificadoEn).not.toBeNull();
  });

  it("un CFDI cancelado ya no cambia de estado (409) pero cancelado -> cancelado es idempotente", async () => {
    const id = await crear();
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "cancelado" })).status).toBe(200);
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "vigente" })).status).toBe(409);
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "cancelado" })).status).toBe(200);
  });

  it("estado invalido -> 400; CFDI inexistente -> 404", async () => {
    const id = await crear();
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "caducado" })).status).toBe(400);
    expect((await put(`/cfdi/${id}/estado-sat`, {})).status).toBe(400);
    expect((await put(`/cfdi/99999999-9999-9999-9999-999999999999/estado-sat`, { estado: "vigente" })).status).toBe(404);
  });

  it("auditor/readonly NO escriben (403) y el estado no cambia", async () => {
    const id = await crear();
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "vigente" }, ctx.staff.auditor.token)).status).toBe(403);
    expect((await put(`/cfdi/${id}/estado-sat`, { estado: "vigente" }, ctx.staff.readonly.token)).status).toBe(403);
    expect(((await (await get(`/cfdi/${id}`)).json()) as { estadoSat: string }).estadoSat).toBe("pendiente");
  });

  it("sin token -> 401", async () => {
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/x/estado-sat`, { method: "PUT" });
    expect(res.status).toBe(401);
  });
});
