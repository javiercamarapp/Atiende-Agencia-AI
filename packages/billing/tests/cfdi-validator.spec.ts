import { describe, it, expect } from 'vitest';
import { validarCfdi, type DatosCfdi, esRfcValido, cfdiCatalogs } from '../src/index.ts';

const { esUsoCfdiValido, esRegimenValido } = cfdiCatalogs;

function cfdiBase(overrides: Partial<DatosCfdi> = {}): DatosCfdi {
  return {
    tipo: 'I',
    subtotal: 1000,
    total: 1160,
    descuento: 0,
    iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: 'G03',
    formaPago: '03',
    metodoPago: 'PUE',
    regimenFiscalEmisor: '601',
    rfcEmisor: 'FUS850101AB1',
    rfcReceptor: 'XAXX010101000',
    tieneSello: true,
    noCertificado: '00001000000500001234',
    folioFiscal: '11111111-2222-3333-4444-555555555555',
    ...overrides,
  };
}

describe('validarCfdi — validaciones fiscales deterministas (CFDI 4.0)', () => {
  it('un CFDI coherente pasa sin issues', () => {
    const r = validarCfdi(cfdiBase());
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('detecta un concepto cuya aritmética no cuadra', () => {
    const r = validarCfdi(cfdiBase({
      conceptos: [{ cantidad: 2, valorUnitario: 100, importe: 999 }], // 2*100=200 != 999
      subtotal: 999,
      total: 1158.84,
      iva: 159.84,
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.codigo === 'importe_concepto_incoherente')).toBe(true);
  });

  it('detecta que la suma de conceptos no cuadra con el subtotal', () => {
    const r = validarCfdi(cfdiBase({
      conceptos: [{ cantidad: 1, valorUnitario: 500, importe: 500 }],
      subtotal: 1000, // debería ser 500
    }));
    expect(r.issues.some((i) => i.codigo === 'subtotal_descuadra_conceptos')).toBe(true);
  });

  it('detecta que Total no cuadra con SubTotal + IVA - Descuento', () => {
    const r = validarCfdi(cfdiBase({ total: 2000 })); // debería ser 1160
    expect(r.issues.some((i) => i.codigo === 'total_incoherente')).toBe(true);
  });

  it('permite nota de crédito (tipo E) con total=0', () => {
    const r = validarCfdi(cfdiBase({
      tipo: 'E',
      total: 0,
      subtotal: 1000,
      iva: 160,
      descuento: 1160,
      conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    }));
    expect(r.issues.some((i) => i.codigo === 'total_incoherente')).toBe(false);
  });

  it('exige UsoCFDI, FormaPago, MetodoPago, TipoComprobante y RegimenFiscal', () => {
    const r = validarCfdi(cfdiBase({ usoCfdi: '', formaPago: '', metodoPago: '', regimenFiscalEmisor: '' }));
    const codigos = r.issues.map((i) => i.codigo);
    expect(codigos).toContain('uso_cfdi_faltante');
    expect(codigos).toContain('forma_pago_faltante');
    expect(codigos).toContain('metodo_pago_ausente');
    expect(codigos).toContain('regimen_fiscal_ausente');
  });

  it('rechaza un código de catálogo que no existe en el SAT', () => {
    const r = validarCfdi(cfdiBase({ usoCfdi: 'Z99' }));
    expect(r.issues.some((i) => i.codigo === 'uso_cfdi_invalido')).toBe(true);
  });

  it('exige sello, no certificado y folio fiscal (CFF art. 29-A)', () => {
    const r = validarCfdi(cfdiBase({ tieneSello: false, noCertificado: '', folioFiscal: '' }));
    const codigos = r.issues.map((i) => i.codigo);
    expect(codigos).toContain('sello_faltante');
    expect(codigos).toContain('no_certificado_faltante');
    expect(codigos).toContain('folio_fiscal_faltante');
  });

  it('rechaza RFCs mal formados', () => {
    const r = validarCfdi(cfdiBase({ rfcEmisor: 'MAL', rfcReceptor: 'TAMBIEN-MAL' }));
    expect(r.issues.some((i) => i.codigo === 'rfc_emisor_invalido')).toBe(true);
    expect(r.issues.some((i) => i.codigo === 'rfc_receptor_invalido')).toBe(true);
  });

  it('tolera redondeos de hasta 2 centavos sin marcar issue', () => {
    const r = validarCfdi(cfdiBase({ total: 1160.02 }));
    expect(r.issues.some((i) => i.codigo === 'total_incoherente')).toBe(false);
  });
});

describe('catálogos y RFC — puertos directos del repo de despachos', () => {
  it('RFC genérico de público en general es válido', () => {
    expect(esRfcValido('XAXX010101000')).toBe(true);
  });
  it('RFC vacío o corto es inválido', () => {
    expect(esRfcValido('')).toBe(false);
    expect(esRfcValido('ABC123')).toBe(false);
  });
  it('UsoCFDI G03 (gastos en general) existe en el catálogo; P01 (removido en 4.0) no', () => {
    expect(esUsoCfdiValido('G03')).toBe(true);
    expect(esUsoCfdiValido('P01')).toBe(false);
  });
  it('Régimen 601 (general de ley personas morales) existe en el catálogo', () => {
    expect(esRegimenValido('601')).toBe(true);
    expect(esRegimenValido('999')).toBe(false);
  });
});
