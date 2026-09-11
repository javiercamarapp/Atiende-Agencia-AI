import { describe, it, expect, vi } from 'vitest';
import {
  timbrarFactura,
  cancelarCfdiDeFactura,
  type PacClient,
  type FacturaParaTimbrar,
  type DatosFiscalesReceptor,
} from '../src/index.ts';

const receptor: DatosFiscalesReceptor = {
  rfc: 'FUS850101AB1',
  razonSocial: 'Cliente de prueba SA de CV',
  regimenFiscal: '601',
  codigoPostal: '06000',
  usoCfdi: 'G03',
};

function pacQueDevuelve(total: number): PacClient {
  return {
    timbrar: vi.fn(async () => ({
      id: 'pac_1', uuid: 'uuid-real-del-sat', urlPdf: null, urlXml: null, urlVerificacion: null, total,
    })),
    cancelar: vi.fn(async () => ({ estado: 'cancelada' })),
  };
}

describe('timbrarFactura — nunca timbra a ciegas', () => {
  it('rechaza timbrar sin desglose de IVA guardado', async () => {
    const factura: FacturaParaTimbrar = { id: 'f1', total: 1160, subtotal: null, iva: null, descripcion: 'x' };
    await expect(timbrarFactura(pacQueDevuelve(1160), factura, receptor)).rejects.toThrow(/desglose/);
  });

  it('rechaza timbrar si el desglose no cuadra con el total cobrado', async () => {
    const factura: FacturaParaTimbrar = { id: 'f1', total: 1160, subtotal: 1000, iva: 999, descripcion: 'x' };
    await expect(timbrarFactura(pacQueDevuelve(1160), factura, receptor)).rejects.toThrow();
  });

  it('rechaza timbrar una factura de $0', async () => {
    const factura: FacturaParaTimbrar = { id: 'f1', total: 0, subtotal: 0, iva: 0, descripcion: 'x' };
    await expect(timbrarFactura(pacQueDevuelve(0), factura, receptor)).rejects.toThrow(/\$0/);
  });

  it('timbra cuando el desglose cuadra y devuelve el UUID del SAT', async () => {
    const factura: FacturaParaTimbrar = { id: 'f1', total: 1160, subtotal: 1000, iva: 160, descripcion: 'Periodo 2026-09' };
    const pac = pacQueDevuelve(1160);
    const cfdi = await timbrarFactura(pac, factura, receptor);
    expect(cfdi.uuid).toBe('uuid-real-del-sat');
    expect(pac.timbrar).toHaveBeenCalledWith(expect.objectContaining({ subtotal: 1000 })); // LA BASE, no el total
  });

  it('marca la discrepancia si el PAC devuelve un total distinto al cobrado, sin ocultarla', async () => {
    const factura: FacturaParaTimbrar = { id: 'f1', total: 1160, subtotal: 1000, iva: 160, descripcion: 'x' };
    const pac = pacQueDevuelve(2000); // el PAC devolvió otro total
    const cfdi = await timbrarFactura(pac, factura, receptor);
    expect((cfdi as unknown as Record<string, unknown>).totalNoCuadraConCobro).toBe(true);
  });
});

describe('cancelarCfdiDeFactura', () => {
  it('delega al PAC con el motivo por defecto de operación no realizada', async () => {
    const pac = pacQueDevuelve(0);
    const r = await cancelarCfdiDeFactura(pac, 'pac_1');
    expect(r.estado).toBe('cancelada');
    expect(pac.cancelar).toHaveBeenCalledWith('pac_1', '02');
  });
});
