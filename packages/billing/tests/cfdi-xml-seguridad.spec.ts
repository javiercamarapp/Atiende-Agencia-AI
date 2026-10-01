// D-29: defensa de la ingesta XML (DTD, entidades, hojas de estilo, UTF-8, tope de tamano). Fixtures construidos
// a mano; no hay llamadas a SAT/PAC.
import { describe, expect, it } from 'vitest';
import { CFDI_XML_MAX_BYTES, CfdiXmlParseError, parseCfdiXml, parseCfdiXmlBytes } from '../src/cfdi/xml-parser.ts';

const CUERPO = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" TipoDeComprobante="I" SubTotal="1000.00" Total="1160.00" FormaPago="03" MetodoPago="PUE" Fecha="2026-09-10T10:00:00" Sello="AbC=" NoCertificado="00001000000500000000">
  <cfdi:Emisor Rfc="EKU9003173C9" Nombre="Escuela Kemper Urgate" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ValorUnitario="1000.00" Importe="1000.00" ClaveProdServ="80131500" Descripcion="Honorarios"/></cfdi:Conceptos>
  <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-09-10T10:00:05"/></cfdi:Complemento>
</cfdi:Comprobante>`;

describe('parseCfdiXml endurecido (D-29)', () => {
  it('un CFDI limpio sigue parseando (con y sin declaracion UTF-8 y con BOM)', () => {
    expect(parseCfdiXml(CUERPO).folioFiscal).toBe('11111111-2222-3333-4444-555555555555');
    expect(parseCfdiXml(`<?xml version="1.0" encoding="UTF-8"?>\n${CUERPO}`).total).toBe(1160);
    expect(parseCfdiXml(`﻿<?xml version="1.0" encoding="utf-8"?>${CUERPO}`).total).toBe(1160);
  });

  it('rechaza DOCTYPE con entidad externa', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///nada">]>${CUERPO}`;
    expect(() => parseCfdiXml(xml)).toThrow(/DTD ni entidades/);
  });

  it('rechaza expansion de entidades internas (billion laughs) sin evaluarla', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>${CUERPO}`;
    expect(() => parseCfdiXml(xml)).toThrow(CfdiXmlParseError);
  });

  it('rechaza declaracion ENTITY suelta y hojas de estilo', () => {
    expect(() => parseCfdiXml(`<!ENTITY a "b">${CUERPO}`)).toThrow(/DTD ni entidades/);
    expect(() => parseCfdiXml(`<?xml-stylesheet href="x.xsl"?>${CUERPO}`)).toThrow(/hojas de estilo/);
  });

  it('comentarios y CDATA siguen permitidos', () => {
    expect(parseCfdiXml(CUERPO.replace('<cfdi:Emisor', '<!-- nota --><cfdi:Emisor')).total).toBe(1160);
  });

  it('rechaza codificacion distinta de UTF-8 y NUL', () => {
    expect(() => parseCfdiXml(`<?xml version="1.0" encoding="ISO-8859-1"?>${CUERPO}`)).toThrow(/UTF-8/);
    expect(() => parseCfdiXml(CUERPO.replace('Honorarios', 'Hono\u0000rarios'))).toThrow(/no permitidos/);
  });

  it('rechaza el XML mayor al tope (en bytes, no en caracteres)', () => {
    const grande = CUERPO.replace('Honorarios', 'ñ'.repeat(CFDI_XML_MAX_BYTES / 2));
    expect(() => parseCfdiXml(grande)).toThrow(/excede el tope/);
  });

  it('parseCfdiXmlBytes: UTF-8 estricto y tope', () => {
    expect(parseCfdiXmlBytes(new TextEncoder().encode(CUERPO)).total).toBe(1160);
    expect(() => parseCfdiXmlBytes(Uint8Array.from([0x3c, 0xff, 0xfe, 0x3e]))).toThrow(/UTF-8/);
    expect(() => parseCfdiXmlBytes(new Uint8Array(CFDI_XML_MAX_BYTES + 1))).toThrow(/excede el tope/);
  });

  it('texto con U+FFFD (bytes no UTF-8 ya sustituidos por Request.text()) se rechaza', () => {
    expect(() => parseCfdiXml(CUERPO.replace('Honorarios', 'Hono�rarios'))).toThrow(/UTF-8/);
  });
});
