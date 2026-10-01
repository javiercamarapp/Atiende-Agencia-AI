// D-22 / D-29: el parser ahora (1) rechaza DTD/entidades/hojas de estilo/NUL/codificación ajena/tamaño
// excesivo ANTES de parsear (XXE y expansión de entidades) y (2) entrega moneda, tipo de cambio y el
// desglose de impuestos con sumas exactas. Los XML son sintéticos (sin PAC ni SAT).
import { describe, expect, it } from 'vitest';
import { CFDI_XML_MAX_CARACTERES, CfdiXmlParseError, parseCfdiXml } from '../src/cfdi/xml-parser.ts';

function cfdi(opts: { prefijo?: string; moneda?: string; tipoCambio?: string; conceptos?: string; impuestosComprobante?: string; nombre?: string } = {}): string {
  const moneda = opts.moneda === undefined ? 'Moneda="MXN"' : opts.moneda;
  const tc = opts.tipoCambio ? ` TipoCambio="${opts.tipoCambio}"` : '';
  const conceptos =
    opts.conceptos ??
    `<cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>`;
  const impuestosComprobante = opts.impuestosComprobante ?? '';
  return `${opts.prefijo ?? ''}<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-07-01T10:00:00" FormaPago="03" NoCertificado="00001000000500000000" Sello="AbCd==" SubTotal="1000.00" ${moneda}${tc} Total="1160.00" TipoDeComprobante="I" MetodoPago="PUE" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="${opts.nombre ?? 'Emisor SA de CV'}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="BBB010101BBB" Nombre="Receptor" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>${conceptos}</cfdi:Conceptos>
  ${impuestosComprobante}
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-07-01T10:05:00"/></cfdi:Complemento>
</cfdi:Comprobante>`;
}

describe('parseCfdiXml -- entrada hostil', () => {
  it('rechaza un DOCTYPE con entidad externa (XXE) sin intentar resolverla', () => {
    const xml = cfdi({ prefijo: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/hosts">]>', nombre: '&xxe;' });
    expect(() => parseCfdiXml(xml)).toThrow(/DTD ni entidades/);
  });

  it('rechaza expansion de entidades anidadas (billion laughs)', () => {
    const xml = cfdi({ prefijo: '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>', nombre: '&b;' });
    expect(() => parseCfdiXml(xml)).toThrow(CfdiXmlParseError);
  });

  it('rechaza DOCTYPE aunque venga en minusculas/mixto', () => {
    expect(() => parseCfdiXml(cfdi({ prefijo: '<!doctype x>' }))).toThrow(/DTD/);
    expect(() => parseCfdiXml(cfdi({ prefijo: '<!DocType x>' }))).toThrow(/DTD/);
  });

  it('rechaza hoja de estilo, NUL, codificacion distinta de UTF-8 y documentos enormes', () => {
    expect(() => parseCfdiXml(cfdi({ prefijo: '<?xml-stylesheet type="text/xsl" href="x.xsl"?>' }))).toThrow(/hojas de estilo/);
    expect(() => parseCfdiXml(cfdi({ nombre: 'Emi\u0000sor' }))).toThrow(/no permitidos/);
    expect(() => parseCfdiXml(cfdi({ prefijo: '<?xml version="1.0" encoding="ISO-8859-1"?>' }))).toThrow(/UTF-8/);
    expect(() => parseCfdiXml(cfdi({ nombre: 'x'.repeat(CFDI_XML_MAX_CARACTERES) }))).toThrow(/tamaño máximo/);
  });

  it('un comentario y un CDATA legitimos NO se rechazan', () => {
    const xml = cfdi({ prefijo: '<?xml version="1.0" encoding="UTF-8"?><!-- generado por el PAC -->' });
    expect(parseCfdiXml(xml).folioFiscal).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('las entidades predefinidas (&amp;) siguen decodificandose en el nombre', () => {
    expect(parseCfdiXml(cfdi({ nombre: 'Pérez &amp; Hijos' })).emisorNombre).toBe('Pérez & Hijos');
  });
});

describe('parseCfdiXml -- moneda y tipo de cambio', () => {
  it('lee Moneda y TipoCambio', () => {
    const r = parseCfdiXml(cfdi({ moneda: 'Moneda="USD"', tipoCambio: '17.512345' }));
    expect(r.moneda).toBe('USD');
    expect(r.tipoCambio).toBe(17.512345);
  });
  it('MXN sin TipoCambio: tipoCambio undefined', () => {
    const r = parseCfdiXml(cfdi());
    expect(r.moneda).toBe('MXN');
    expect(r.tipoCambio).toBeUndefined();
  });
  it('sin Moneda (obligatoria en 4.0) se rechaza', () => {
    expect(() => parseCfdiXml(cfdi({ moneda: '' }))).toThrow(/Moneda/);
  });
});

describe('parseCfdiXml -- desglose de impuestos', () => {
  it('IVA 16% por concepto: un renglon con base e importe exactos', () => {
    const r = parseCfdiXml(cfdi());
    expect(r.impuestos).toEqual([{ naturaleza: 'traslado', impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: '0.160000', base: '1000.000000', importe: '160.000000' }]);
  });

  it('suma exacta por grupo (sin error de flotante) y separa tasas distintas, retencion y exento', () => {
    const conceptos = `
      <cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="a" ValorUnitario="0.10" Importe="0.10" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="0.10" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="0.016000"/></cfdi:Traslados>
        <cfdi:Retenciones><cfdi:Retencion Base="0.10" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.100000" Importe="0.010000"/></cfdi:Retenciones></cfdi:Impuestos></cfdi:Concepto>
      <cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="b" ValorUnitario="0.20" Importe="0.20" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="0.20" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="0.032000"/>
        <cfdi:Traslado Base="0.20" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.000000"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>
      <cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="c" ValorUnitario="5.00" Importe="5.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="5.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`;
    const r = parseCfdiXml(cfdi({ conceptos }));
    const iva16 = r.impuestos.find((i) => i.impuesto === '002' && i.tasaOCuota === '0.160000');
    expect(iva16).toMatchObject({ base: '0.300000', importe: '0.048000', naturaleza: 'traslado' });
    expect(r.impuestos.find((i) => i.tasaOCuota === '0.000000')).toMatchObject({ importe: '0.000000' });
    expect(r.impuestos.find((i) => i.tipoFactor === 'Exento')).toMatchObject({ tasaOCuota: null, importe: null, base: '5.000000' });
    expect(r.impuestos.find((i) => i.naturaleza === 'retencion')).toMatchObject({ impuesto: '001', tasaOCuota: '0.100000', importe: '0.010000' });
    expect(r.impuestos).toHaveLength(4);
  });

  it('sin detalle por concepto usa los traslados del nivel comprobante', () => {
    const conceptos = `<cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="a" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"/>`;
    const impuestosComprobante = `<cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>`;
    const r = parseCfdiXml(cfdi({ conceptos, impuestosComprobante }));
    expect(r.impuestos).toHaveLength(1);
    expect(r.impuestos[0]).toMatchObject({ impuesto: '002', importe: '160.000000' });
  });

  it('descarta renglones malformados (impuesto fuera de catalogo, factor raro, tasa no numerica) sin fallar', () => {
    const conceptos = `<cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="a" ValorUnitario="1.00" Importe="1.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="1.00" Impuesto="009" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="0.16"/>
      <cfdi:Traslado Base="1.00" Impuesto="002" TipoFactor="Raro" TasaOCuota="0.160000" Importe="0.16"/>
      <cfdi:Traslado Base="1.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="abc" Importe="0.16"/>
      <cfdi:Traslado Base="1.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="1e3"/>
    </cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`;
    expect(parseCfdiXml(cfdi({ conceptos })).impuestos).toEqual([]);
  });
});

describe('parseCfdiXml -- IVA exento (regresion)', () => {
  it('un CFDI con IVA Exento (sin Importe) se lee; iva queda null en vez de lanzar', () => {
    const conceptos = `<cfdi:Concepto ClaveProdServ="1" Cantidad="1" ClaveUnidad="E48" Descripcion="Renta casa habitacion" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`;
    const r = parseCfdiXml(cfdi({ conceptos }));
    expect(r.iva).toBeNull();
    expect(r.impuestos).toEqual([{ naturaleza: 'traslado', impuesto: '002', tipoFactor: 'Exento', tasaOCuota: null, base: '1000.000000', importe: null }]);
  });
});
