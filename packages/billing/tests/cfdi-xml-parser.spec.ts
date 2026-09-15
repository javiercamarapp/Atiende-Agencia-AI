// Cierre de gap de auditoría (ver TAREA): "no existe ningún parser de XML CFDI en
// el monorepo" — estas pruebas fijan el contrato de `parseCfdiXml` contra XMLs
// estructuralmente válidos de CFDI 4.0 (construidos a mano, no descargados de un
// PAC real -- no hay credenciales de PAC/SAT en este repo, ver alcance de la
// TAREA) cubriendo el camino feliz Y los rechazos explícitos documentados en el
// encabezado de xml-parser.ts.
import { describe, expect, it } from 'vitest';
import { CfdiXmlParseError, parseCfdiXml } from '../src/cfdi/xml-parser.ts';

interface CfdiXmlOptions {
  readonly tipo?: string;
  readonly folioFiscal?: string;
  readonly conceptosXml?: string;
  readonly impuestosComprobanteXml?: string;
  readonly complementoXml?: string;
  readonly subtotal?: string;
  readonly total?: string;
  readonly descuento?: string;
  readonly cfdiRelacionadosXml?: string;
  readonly sello?: string;
  readonly incluirTimbre?: boolean;
}

/** Constructor de un CFDI 4.0 mínimo pero estructuralmente real — un concepto con
 * IVA trasladado al 16%, timbrado. Cada test override solo lo que le importa. */
function cfdiXml(opts: CfdiXmlOptions = {}): string {
  const {
    tipo = 'I',
    folioFiscal = '11111111-2222-3333-4444-555555555555',
    subtotal = '1000.00',
    total = '1160.00',
    descuento,
    sello = 'AbCdEf1234==',
    incluirTimbre = true,
    cfdiRelacionadosXml = '',
  } = opts;

  const conceptosXml =
    opts.conceptosXml ??
    `<cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>`;

  const impuestosComprobanteXml =
    opts.impuestosComprobanteXml ??
    `<cfdi:Impuestos TotalImpuestosTrasladados="160.00">
      <cfdi:Traslados>
        <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
      </cfdi:Traslados>
    </cfdi:Impuestos>`;

  const complementoXml =
    opts.complementoXml ??
    (incluirTimbre
      ? `<cfdi:Complemento>
          <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${folioFiscal}" FechaTimbrado="2026-07-01T10:05:00" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/>
        </cfdi:Complemento>`
      : '');

  const descuentoAttr = descuento !== undefined ? ` Descuento="${descuento}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd"
  Version="4.0" Fecha="2026-07-01T10:00:00" Sello="${sello}" FormaPago="03" NoCertificado="00001000000504465028"
  Certificado="MIIF" SubTotal="${subtotal}" Moneda="MXN" Total="${total}"${descuentoAttr} TipoDeComprobante="${tipo}" Exportacion="01" MetodoPago="PUE" LugarExpedicion="06000">
  ${cfdiRelacionadosXml}
  <cfdi:Emisor Rfc="CON950820K12" Nombre="PROVEEDOR DE PRUEBA SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="616" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    ${conceptosXml}
  </cfdi:Conceptos>
  ${impuestosComprobanteXml}
  ${complementoXml}
</cfdi:Comprobante>`;
}

describe('parseCfdiXml — camino feliz (CFDI 4.0, un concepto, IVA trasladado 16%, TimbreFiscalDigital)', () => {
  it('extrae todos los campos que POST /cfdi ya exige a mano', () => {
    const r = parseCfdiXml(cfdiXml());
    expect(r.folioFiscal).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.tipo).toBe('I');
    expect(r.subtotal).toBe(1000);
    expect(r.total).toBe(1160);
    expect(r.descuento).toBe(0);
    expect(r.iva).toBe(160);
    expect(r.conceptos).toEqual([{ cantidad: 1, valorUnitario: 1000, importe: 1000 }]);
    expect(r.usoCfdi).toBe('G03');
    expect(r.formaPago).toBe('03');
    expect(r.metodoPago).toBe('PUE');
    expect(r.regimenFiscalEmisor).toBe('601');
    expect(r.rfcEmisor).toBe('CON950820K12');
    expect(r.rfcReceptor).toBe('XAXX010101000');
    expect(r.emisorNombre).toBe('PROVEEDOR DE PRUEBA SA DE CV');
    expect(r.tieneSello).toBe(true);
    expect(r.noCertificado).toBe('00001000000504465028');
    expect(r.fecha).toBe('2026-07-01T10:00:00');
    expect(r.fechaTimbrado).toBe('2026-07-01T10:05:00');
    expect(r.retencionIsr).toBeNull();
    expect(r.retencionIva).toBeNull();
    expect(r.ieps).toBeNull();
  });

  it('varios conceptos: cada uno se extrae en orden, y el IVA global sigue viniendo del nodo Impuestos a nivel comprobante', () => {
    const xml = cfdiXml({
      subtotal: '1500.00',
      total: '1740.00',
      conceptosXml: `
        <cfdi:Concepto Cantidad="1" ClaveUnidad="E48" Descripcion="Concepto A" ValorUnitario="1000.00" Importe="1000.00"/>
        <cfdi:Concepto Cantidad="2" ClaveUnidad="E48" Descripcion="Concepto B" ValorUnitario="250.00" Importe="500.00"/>
      `,
      impuestosComprobanteXml: `<cfdi:Impuestos TotalImpuestosTrasladados="240.00">
        <cfdi:Traslados>
          <cfdi:Traslado Base="1500.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="240.00"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>`,
    });
    const r = parseCfdiXml(xml);
    expect(r.conceptos).toEqual([
      { cantidad: 1, valorUnitario: 1000, importe: 1000 },
      { cantidad: 2, valorUnitario: 250, importe: 500 },
    ]);
    expect(r.iva).toBe(240);
  });

  it('un Descuento explícito en el comprobante se extrae (default 0 cuando no viene)', () => {
    const r = parseCfdiXml(cfdiXml({ descuento: '50.00', total: '1110.00' }));
    expect(r.descuento).toBe(50);
  });

  it('nota de crédito (tipo E) con CfdiRelacionados: extrae los UUID relacionados y el tipo de relación', () => {
    const xml = cfdiXml({
      tipo: 'E',
      cfdiRelacionadosXml: `<cfdi:CfdiRelacionados TipoRelacion="01">
        <cfdi:CfdiRelacionado UUID="99999999-8888-7777-6666-555555555555"/>
      </cfdi:CfdiRelacionados>`,
    });
    const r = parseCfdiXml(xml);
    expect(r.tipo).toBe('E');
    expect(r.tipoRelacion).toBe('01');
    expect(r.cfdiRelacionados).toEqual(['99999999-8888-7777-6666-555555555555']);
  });

  it('honorarios con retención de ISR e IVA (a nivel concepto): las suma y las separa de los trasladados', () => {
    const xml = cfdiXml({
      conceptosXml: `<cfdi:Concepto Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios legales" ValorUnitario="1000.00" Importe="1000.00">
        <cfdi:Impuestos>
          <cfdi:Traslados>
            <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
          </cfdi:Traslados>
          <cfdi:Retenciones>
            <cfdi:Retencion Base="1000.00" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.100000" Importe="100.00"/>
            <cfdi:Retencion Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.106667" Importe="106.67"/>
          </cfdi:Retenciones>
        </cfdi:Impuestos>
      </cfdi:Concepto>`,
      impuestosComprobanteXml: `<cfdi:Impuestos TotalImpuestosTrasladados="160.00" TotalImpuestosRetenidos="206.67">
        <cfdi:Traslados>
          <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
        </cfdi:Traslados>
        <cfdi:Retenciones>
          <cfdi:Retencion Impuesto="001" Importe="100.00"/>
          <cfdi:Retencion Impuesto="002" Importe="106.67"/>
        </cfdi:Retenciones>
      </cfdi:Impuestos>`,
    });
    const r = parseCfdiXml(xml);
    expect(r.iva).toBe(160);
    expect(r.retencionIsr).toBe(100);
    expect(r.retencionIva).toBeCloseTo(106.67, 2);
  });
});

describe('parseCfdiXml — rechazos explícitos (alcance documentado, nunca se finge un dato ausente)', () => {
  it('XML vacío', () => {
    expect(() => parseCfdiXml('')).toThrow(CfdiXmlParseError);
  });

  it('XML mal formado (etiqueta sin cerrar)', () => {
    const malformado = '<cfdi:Comprobante Version="4.0"><cfdi:Emisor Rfc="ABC"></cfdi:Comprobante>';
    expect(() => parseCfdiXml(malformado)).toThrow(CfdiXmlParseError);
  });

  it('sin nodo cfdi:Comprobante', () => {
    expect(() => parseCfdiXml('<algo>no es un cfdi</algo>')).toThrow(CfdiXmlParseError);
  });

  it('versión distinta de 4.0 se rechaza explícitamente (no se intenta adivinar CFDI 3.3)', () => {
    const xml = cfdiXml().replace('Version="4.0"', 'Version="3.3"');
    expect(() => parseCfdiXml(xml)).toThrow(/versión 4\.0/);
  });

  it('sin tfd:TimbreFiscalDigital: sin folio fiscal no hay CFDI con efecto fiscal', () => {
    const xml = cfdiXml({ incluirTimbre: false });
    expect(() => parseCfdiXml(xml)).toThrow(/TimbreFiscalDigital/);
  });

  it('sin ningún cfdi:Concepto', () => {
    const xml = cfdiXml({ conceptosXml: '' });
    expect(() => parseCfdiXml(xml)).toThrow(/Concepto/);
  });

  it('falta un atributo obligatorio (UsoCFDI del receptor)', () => {
    const xml = cfdiXml().replace(' UsoCFDI="G03"', '');
    expect(() => parseCfdiXml(xml)).toThrow(/UsoCFDI/);
  });
});
