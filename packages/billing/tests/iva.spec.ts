import { describe, it, expect } from 'vitest';
import { desglosarPrecio, desgloseCuadra, CriterioIvaFaltante } from '../src/index.ts';

describe('desglosarPrecio — de qué lado del precio está el IVA', () => {
  it('lanza CriterioIvaFaltante si el criterio no se declaró (null)', () => {
    expect(() => desglosarPrecio(10000, null)).toThrow(CriterioIvaFaltante);
  });

  it('IVA incluido: el total es el precio, el subtotal se deriva', () => {
    const d = desglosarPrecio(11600, true);
    expect(d.total).toBe(11600);
    expect(d.subtotal + d.iva).toBeCloseTo(11600, 2);
  });

  it('IVA aparte: el subtotal es el precio, el IVA se suma encima', () => {
    const d = desglosarPrecio(10000, false);
    expect(d.subtotal).toBe(10000);
    expect(d.iva).toBe(1600);
    expect(d.total).toBe(11600);
  });

  it('el invariante subtotal + iva === total se cumple por construcción en ambos criterios', () => {
    for (const criterio of [true, false]) {
      const d = desglosarPrecio(2547.37, criterio);
      expect(desgloseCuadra(d.total, d.subtotal, d.iva)).toBe(true);
    }
  });

  it('rechaza precios negativos o no finitos', () => {
    expect(() => desglosarPrecio(-5, true)).toThrow();
    expect(() => desglosarPrecio(NaN, false)).toThrow();
  });
});

describe('desgloseCuadra — tolerancia de un centavo más margen de punto flotante', () => {
  it('acepta un centavo exacto de diferencia por redondeo', () => {
    expect(desgloseCuadra(10000.01, 10000, 0.0)).toBe(true);
  });
  it('rechaza una diferencia mayor a un centavo', () => {
    expect(desgloseCuadra(10001, 10000, 0.5)).toBe(false);
  });
});
