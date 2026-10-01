// D-29: POST .../cfdi/importar-xml (staff) tiene las mismas garantías XML que el portal del cliente.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

const CFDI = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" TipoDeComprobante="I" SubTotal="1000.00" Total="1160.00" FormaPago="03" MetodoPago="PUE" Fecha="2026-09-10T10:00:00" Sello="AbC=" NoCertificado="00001000000500000000">
  <cfdi:Emisor Rfc="EKU9003173C9" Nombre="Escuela Kemper Urgate" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ValorUnitario="1000.00" Importe="1000.00"/></cfdi:Conceptos>
  <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-09-10T10:00:05"/></cfdi:Complemento>
</cfdi:Comprobante>`;

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const importar = (xml: string) =>
  buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` }, body: xml });

describe("importar-xml (staff) -- defensas XML (D-29)", () => {
  it("rechaza DOCTYPE/entidades externas con 400, sin ingestar nada", async () => {
    const res = await importar(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///nada">]>${CFDI}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/DTD ni entidades/);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("rechaza hojas de estilo y codificación distinta de UTF-8", async () => {
    expect((await importar(`<?xml-stylesheet href="x.xsl"?>${CFDI}`)).status).toBe(400);
    expect((await importar(`<?xml version="1.0" encoding="ISO-8859-1"?>${CFDI}`)).status).toBe(400);
  });

  it("un CFDI limpio sigue importándose (201)", async () => {
    const res = await importar(`<?xml version="1.0" encoding="UTF-8"?>${CFDI}`);
    expect(res.status).toBe(201);
  });
});
