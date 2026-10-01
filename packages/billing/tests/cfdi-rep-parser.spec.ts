import { describe, expect, it } from 'vitest';
import { CfdiXmlParseError, decimalACentavos, parseCfdiXml, parseComplementoPagoXml } from '../src/index.ts';
import { UUID_FACTURA_1, UUID_FACTURA_2, UUID_REP, doctoXml, repXml } from './fixtures/rep-xml.ts';

describe('decimalACentavos (sin punto flotante)', () => {
  it('convierte exacto', () => {
    expect(decimalACentavos('1160.00', 'x')).toBe(116000);
    expect(decimalACentavos('0.10', 'x')).toBe(10);
    expect(decimalACentavos('580', 'x')).toBe(58000);
    expect(decimalACentavos('0.1', 'x')).toBe(10);
    expect(decimalACentavos('-5.25', 'x')).toBe(-525);
  });
  it('redondea half-up a centavos los importes con más decimales (Anexo 20)', () => {
    expect(decimalACentavos('80.004', 'x')).toBe(8000);
    expect(decimalACentavos('80.005', 'x')).toBe(8001);
    expect(decimalACentavos('0.285', 'x')).toBe(29);
  });
  it('no cae en el error clásico de coma flotante (1.15 * 100)', () => {
    expect(decimalACentavos('1.15', 'x')).toBe(115);
    expect(decimalACentavos('4.35', 'x')).toBe(435);
  });
  it('rechaza lo que no es decimal', () => {
    for (const malo of ['', 'abc', '1,160.00', '1e3', '12.', '.5']) expect(() => decimalACentavos(malo, 'x')).toThrow(CfdiXmlParseError);
  });
});

describe('parseComplementoPagoXml — REP 2.0', () => {
  it('extrae emisor, UUID del REP en minúsculas, pago y documento relacionado en centavos', () => {
    const r = parseComplementoPagoXml(repXml());
    expect(r).toMatchObject({ folioFiscal: UUID_REP, rfcEmisor: 'EKU9003173C9', rfcReceptor: 'XAXX010101000', emisorNombre: 'Escuela Kemper Urgate' });
    expect(r.pagos).toHaveLength(1);
    const pago = r.pagos[0]!;
    expect(pago).toMatchObject({ formaDePagoP: '03', monedaP: 'MXN', montoCentavos: 58000 });
    expect(pago.documentos[0]).toMatchObject({
      idDocumento: UUID_FACTURA_1,
      serie: 'A',
      folio: '10',
      monedaDR: 'MXN',
      equivalenciaDR: '1',
      numParcialidad: 1,
      impSaldoAntCentavos: 116000,
      impPagadoCentavos: 58000,
      impSaldoInsolutoCentavos: 58000,
      objetoImpDR: '02',
    });
    expect(pago.documentos[0]!.traslados).toEqual([{ impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: '0.160000', baseCentavos: 50000, importeCentavos: 8000 }]);
    expect(pago.documentos[0]!.retenciones).toEqual([]);
  });

  it('varios documentos relacionados en un mismo pago', () => {
    const r = parseComplementoPagoXml(repXml({ doctos: doctoXml() + doctoXml({ id: UUID_FACTURA_2, saldoAnt: '232.00', pagado: '232.00', insoluto: '0.00', base: '200.00', iva: '32.00' }) }));
    expect(r.pagos[0]!.documentos.map((d) => [d.idDocumento, d.impSaldoInsolutoCentavos])).toEqual([[UUID_FACTURA_1, 58000], [UUID_FACTURA_2, 0]]);
  });

  it('ObjetoImpDR 01 (no objeto de impuesto): sin desglose', () => {
    const r = parseComplementoPagoXml(repXml({ doctos: doctoXml({ objetoImp: '01' }) }));
    expect(r.pagos[0]!.documentos[0]!.traslados).toEqual([]);
  });

  it('rechaza Pagos 1.0 (obsoleto), tipo distinto de P, y falta de complemento', () => {
    expect(() => parseComplementoPagoXml(repXml({ version: '1.0' }))).toThrow(/2\.0/);
    expect(() => parseComplementoPagoXml(repXml({ tipo: 'I' }))).toThrow(/tipo|'P'/);
    expect(() => parseComplementoPagoXml(repXml().replace(/<pago20:Pagos[\s\S]*<\/pago20:Pagos>/, ''))).toThrow(/pago20:Pagos/);
  });

  it('falta un atributo obligatorio del documento relacionado', () => {
    expect(() => parseComplementoPagoXml(repXml().replace(' ImpSaldoInsoluto="580.00"', ''))).toThrow(/ImpSaldoInsoluto/);
    expect(() => parseComplementoPagoXml(repXml().replace('NumParcialidad="1"', 'NumParcialidad="0"'))).toThrow(/NumParcialidad/);
  });

  it('un pago sin documentos relacionados se rechaza', () => {
    expect(() => parseComplementoPagoXml(repXml({ doctos: '' }))).toThrow(/DoctoRelacionado/);
  });

  it('mismas defensas XML que la factura: DTD/entidades, hojas de estilo, tope', () => {
    expect(() => parseComplementoPagoXml(`<!DOCTYPE x [<!ENTITY e "a">]>${repXml()}`)).toThrow(/DTD ni entidades/);
    expect(() => parseComplementoPagoXml(`<?xml-stylesheet href="x"?>${repXml()}`)).toThrow(/hojas de estilo/);
    expect(() => parseComplementoPagoXml('')).toThrow(CfdiXmlParseError);
  });

  it('parseCfdiXml (factura) rechaza un REP con un mensaje claro en vez de un error de atributo', () => {
    expect(() => parseCfdiXml(repXml())).toThrow(/CFDI de pago/);
  });
});
