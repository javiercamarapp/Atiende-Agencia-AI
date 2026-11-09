import { describe, expect, it } from 'vitest';
import { anclaPrimerDiaMesSiguiente, armarLineItemsSuscripcion, EmisorCfdiSinPac, motivoPrecioInvalido, PreciosStripeIncompletos, type PrecioPlanStripe } from '../src/index.ts';

const PRECIOS: PrecioPlanStripe[] = [
  { componente: 'sucursal', priceId: 'price_SUCURSAL01', meterEventName: null },
  { componente: 'minuto_voz_excedente', priceId: 'price_MINUTO0001', meterEventName: 'atiende_minutos_voz' },
  { componente: 'conversacion_wa_excedente', priceId: 'price_CONVERSA01', meterEventName: 'atiende_conversaciones_wa' },
  { componente: 'alta', priceId: 'price_ALTA000001', meterEventName: null },
];

describe('armarLineItemsSuscripcion', () => {
  it('sucursal por cantidad, medidos sin cantidad y alta solo si se pide', () => {
    expect(armarLineItemsSuscripcion(PRECIOS, 7, { incluirAlta: false })).toEqual([
      { price: 'price_SUCURSAL01', quantity: 7 },
      { price: 'price_MINUTO0001' },
      { price: 'price_CONVERSA01' },
    ]);
    expect(armarLineItemsSuscripcion(PRECIOS, 2, { incluirAlta: true }).at(-1)).toEqual({ price: 'price_ALTA000001', quantity: 2, unico: true });
  });
  it('sin precio base no se cobra', () => {
    expect(() => armarLineItemsSuscripcion(PRECIOS.slice(1), 1, { incluirAlta: false })).toThrow(PreciosStripeIncompletos);
  });
  it('sin sucursales activas no hay a cuantas cobrar', () => {
    expect(() => armarLineItemsSuscripcion(PRECIOS, 0, { incluirAlta: false })).toThrow(PreciosStripeIncompletos);
  });
});

describe('motivoPrecioInvalido', () => {
  const base = { id: 'price_X', activo: true, moneda: 'mxn', montoUnitarioCentavos: 769000, tipo: 'recurring' as const, usoMedido: false, meterId: null };
  it('acepta un precio fijo recurrente en MXN y rechaza USD, archivado, $0 y medido', () => {
    expect(motivoPrecioInvalido('sucursal', base)).toBeNull();
    expect(motivoPrecioInvalido('sucursal', { ...base, moneda: 'usd' })).toMatch(/MXN/);
    expect(motivoPrecioInvalido('sucursal', { ...base, activo: false })).toMatch(/archivado/);
    expect(motivoPrecioInvalido('sucursal', { ...base, montoUnitarioCentavos: 0 })).toMatch(/\$0/);
    expect(motivoPrecioInvalido('sucursal', { ...base, usoMedido: true, meterId: 'mtr_1' })).toMatch(/medido/);
  });
  it('el excedente exige precio medido con meter; el alta, pago unico', () => {
    expect(motivoPrecioInvalido('minuto_voz_excedente', base)).toMatch(/meter/);
    expect(motivoPrecioInvalido('minuto_voz_excedente', { ...base, usoMedido: true, meterId: 'mtr_1', montoUnitarioCentavos: null })).toBeNull();
    expect(motivoPrecioInvalido('alta', base)).toMatch(/pago único/);
    expect(motivoPrecioInvalido('alta', { ...base, tipo: 'one_time' })).toBeNull();
  });
});

describe('anclaPrimerDiaMesSiguiente', () => {
  it('es la medianoche del dia 1 siguiente en Merida (UTC-6)', () => {
    expect(new Date(anclaPrimerDiaMesSiguiente('America/Merida', new Date('2026-11-07T18:00:00Z')) * 1000).toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(new Date(anclaPrimerDiaMesSiguiente('America/Merida', new Date('2026-12-20T18:00:00Z')) * 1000).toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });
});

describe('CFDI', () => {
  it('sin PAC no se timbra nada', async () => {
    expect(await new EmisorCfdiSinPac().emitir()).toMatchObject({ estado: 'sin_pac' });
  });
});
