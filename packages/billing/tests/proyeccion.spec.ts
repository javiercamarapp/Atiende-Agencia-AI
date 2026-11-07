import { describe, expect, it } from 'vitest';
import { calcularFacturaPlanMedido, precioSucursalVigente, proyectarMes, SucursalesACotizar, umbralBolsa, type DiaDeUso, type TarifaPlanMedido } from '../src/index.ts';

// Cifras de PRUEBA (no son precios del producto).
const tabulador: TarifaPlanMedido = {
  planId: 'prueba-tabulador',
  nombre: 'Tabulador',
  modeloCobro: 'medido',
  cuotaFijaCentavos: null,
  precioSucursalCentavos: null,
  sucursalesIncluidas: 0,
  minutosVozIncluidos: 0,
  minutosVozIncluidosPorSucursal: 1_500,
  precioMinutoVozExcedenteCentavos: 290,
  conversacionesWaIncluidas: 0,
  conversacionesWaIncluidasPorSucursal: 300,
  precioConversacionWaExcedenteCentavos: 150,
  usoJustoPct: 150,
  cuotaAltaCentavos: null,
  cuotaAltaPorSucursalCentavos: 249_000,
  tasaIvaBp: 1600,
  organizacionExclusivaId: null,
  tramosSucursal: [
    { desde: 1, hasta: 2, precioCentavos: 479_000 },
    { desde: 3, hasta: 5, precioCentavos: 449_000 },
    { desde: 6, hasta: 9, precioCentavos: 429_000 },
    { desde: 10, hasta: 19, precioCentavos: 389_000 },
    { desde: 20, hasta: null, precioCentavos: null },
  ],
};

function mes(dias: number, segundosPorDia: (i: number) => number, convPorDia = 0): DiaDeUso[] {
  return Array.from({ length: dias }, (_, i) => ({ dia: `2026-11-${String(i + 1).padStart(2, '0')}`, segundosVoz: segundosPorDia(i), conversacionesWa: convPorDia }));
}

describe('tabulador por sucursal (escalón por volumen)', () => {
  it('el total de sucursales elige el tramo y TODAS pagan ese precio', () => {
    expect(precioSucursalVigente(tabulador, 1)).toBe(479_000);
    expect(precioSucursalVigente(tabulador, 5)).toBe(449_000);
    expect(precioSucursalVigente(tabulador, 7)).toBe(429_000);
    const f = calcularFacturaPlanMedido(tabulador, { sucursalesActivas: 7, minutosVoz: 0, conversacionesWa: 0 });
    expect(f.subtotalCentavos).toBe(7 * 429_000);
  });

  it('un tramo «a cotizar» no factura solo', () => {
    expect(() => precioSucursalVigente(tabulador, 25)).toThrow(SucursalesACotizar);
  });

  it('la bolsa es compartida: 7 sucursales x 1,500 min = 10,500 incluidos', () => {
    const f = calcularFacturaPlanMedido(tabulador, { sucursalesActivas: 7, minutosVoz: 12_800, conversacionesWa: 1_100 });
    expect(f.voz.incluido).toBe(10_500);
    expect(f.voz.excedenteCobrado).toBe(2_300);
    expect(f.subtotalCentavos).toBe(7 * 429_000 + 2_300 * 290);
  });

  it('la cuota de alta por sucursal entra solo en la primera factura', () => {
    const f = calcularFacturaPlanMedido(tabulador, { sucursalesActivas: 7, minutosVoz: 0, conversacionesWa: 0 }, { incluirCuotaAlta: true });
    expect(f.renglones.find((r) => r.concepto === 'cuota_alta')).toMatchObject({ cantidad: 7, importeCentavos: 7 * 249_000 });
  });
});

describe('proyectarMes', () => {
  it('ritmo constante: el central es lineal y el rango se cierra', () => {
    const dias = mes(30, (i) => (i < 10 ? 60 * 300 : 0));
    const p = proyectarMes(tabulador, 7, dias, { dia: '2026-11-11', fraccion: 0 });
    expect(p.diasCompletos).toBe(10);
    expect(p.minutosVoz.central).toBe(9_000);
    expect(p.minutosVoz.bajo).toBe(9_000);
    expect(p.minutosVoz.alto).toBe(9_000);
    expect(p.rangoConfiable).toBe(true);
    expect(p.factura?.central.subtotalCentavos).toBe(7 * 429_000);
  });

  it('ritmo variable: bajo <= central <= alto y la factura alta cobra excedente', () => {
    const dias = mes(30, (i) => (i < 10 ? 60 * (i % 2 === 0 ? 200 : 600) : 0));
    const p = proyectarMes(tabulador, 7, dias, { dia: '2026-11-11', fraccion: 0 });
    expect(p.minutosVoz.bajo).toBeLessThanOrEqual(p.minutosVoz.central);
    expect(p.minutosVoz.central).toBeLessThanOrEqual(p.minutosVoz.alto);
    expect(p.minutosVoz.alto).toBeGreaterThan(10_500);
    expect(p.factura!.alto.subtotalCentavos).toBeGreaterThan(p.factura!.bajo.subtotalCentavos);
  });

  it('con menos de 3 días completos no hay rango (bajo = central = alto)', () => {
    const dias = mes(30, (i) => (i < 2 ? 60 * 300 : 0));
    const p = proyectarMes(tabulador, 7, dias, { dia: '2026-11-02', fraccion: 0.5 });
    expect(p.rangoConfiable).toBe(false);
    expect(p.minutosVoz.bajo).toBe(p.minutosVoz.alto);
    expect(p.diasTranscurridos).toBe(1.5);
  });

  it('mes cerrado: la proyección es lo usado', () => {
    const dias = mes(30, () => 60);
    const p = proyectarMes(tabulador, 1, dias, { dia: '2026-12-05', fraccion: 0.2 });
    expect(p.minutosVoz).toEqual({ bajo: 30, central: 30, alto: 30 });
  });

  it('tarifa a cotizar: proyección de uso sin factura (null)', () => {
    const p = proyectarMes(tabulador, 25, mes(30, () => 60), { dia: '2026-11-10', fraccion: 0 });
    expect(p.factura).toBeNull();
    expect(p.minutosVoz.central).toBeGreaterThan(0);
  });
});

describe('umbralBolsa', () => {
  it('80, 100 y uso justo', () => {
    expect(umbralBolsa(79, 100, 150)).toBeNull();
    expect(umbralBolsa(80, 100, 150)).toBe(80);
    expect(umbralBolsa(100, 100, 150)).toBe(100);
    expect(umbralBolsa(151, 100, 150)).toBe(150);
    expect(umbralBolsa(151, 100, null)).toBe(100);
    expect(umbralBolsa(5, 0, 150)).toBeNull();
  });
});
