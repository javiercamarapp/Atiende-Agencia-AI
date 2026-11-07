import { describe, expect, it } from 'vitest';
import { calcularFacturaPlanMedido, ivaCentavos, TarifaInvalida, tarifaDesdeJson, type TarifaPlanMedido } from '../src/index.ts';

// Cifras de PRUEBA con la forma de un plan a la medida (cuota fija + incluidos) y de uno de lista (por sucursal).
// No son precios del producto: los precios viven en core.plan y los captura el superadmin.
const aLaMedida: TarifaPlanMedido = {
  planId: 'prueba-a-la-medida',
  nombre: 'A la medida',
  modeloCobro: 'medido',
  cuotaFijaCentavos: 3_000_000,
  precioSucursalCentavos: null,
  sucursalesIncluidas: 7,
  minutosVozIncluidos: 9_200,
  minutosVozIncluidosPorSucursal: 0,
  precioMinutoVozExcedenteCentavos: 250,
  conversacionesWaIncluidas: 1_100,
  conversacionesWaIncluidasPorSucursal: 0,
  precioConversacionWaExcedenteCentavos: 150,
  usoJustoPct: 150,
  cuotaAltaCentavos: null,
  tasaIvaBp: 1600,
  organizacionExclusivaId: '00000000-0000-0000-0000-000000000001',
};

const porSucursal: TarifaPlanMedido = {
  ...aLaMedida,
  planId: 'prueba-por-sucursal',
  nombre: 'Por sucursal',
  cuotaFijaCentavos: null,
  precioSucursalCentavos: 429_000,
  sucursalesIncluidas: 0,
  minutosVozIncluidos: 0,
  minutosVozIncluidosPorSucursal: 1_300,
  conversacionesWaIncluidas: 0,
  conversacionesWaIncluidasPorSucursal: 160,
  cuotaAltaCentavos: 500_000,
  organizacionExclusivaId: null,
};

describe('calcularFacturaPlanMedido: cuota fija con uso incluido', () => {
  it('dentro de lo incluido solo cobra la cuota fija, con IVA del 16 % encima', () => {
    const f = calcularFacturaPlanMedido(aLaMedida, { sucursalesActivas: 7, minutosVoz: 9_200, conversacionesWa: 1_100 });
    expect(f.renglones.map((r) => r.concepto)).toEqual(['cuota_fija']);
    expect(f.subtotalCentavos).toBe(3_000_000);
    expect(f.ivaCentavos).toBe(480_000);
    expect(f.totalCentavos).toBe(3_480_000);
    expect(f.voz.excedente).toBe(0);
  });

  it('cobra el excedente de minutos y de conversaciones a su precio unitario', () => {
    const f = calcularFacturaPlanMedido(aLaMedida, { sucursalesActivas: 7, minutosVoz: 12_800, conversacionesWa: 1_200 });
    const voz = f.renglones.find((r) => r.concepto === 'excedente_minutos_voz');
    const wa = f.renglones.find((r) => r.concepto === 'excedente_conversaciones_wa');
    expect(voz?.cantidad).toBe(3_600);
    expect(voz?.importeCentavos).toBe(900_000);
    expect(wa?.cantidad).toBe(100);
    expect(wa?.importeCentavos).toBe(15_000);
    expect(f.subtotalCentavos).toBe(3_915_000);
    expect(f.totalCentavos).toBe(f.subtotalCentavos + f.ivaCentavos);
  });

  it('topa el excedente cobrable en el uso justo y lo marca para renegociar', () => {
    const f = calcularFacturaPlanMedido(aLaMedida, { sucursalesActivas: 7, minutosVoz: 16_000, conversacionesWa: 0 });
    expect(f.voz.topeUsoJusto).toBe(13_800);
    expect(f.voz.excedente).toBe(6_800);
    expect(f.voz.excedenteCobrado).toBe(4_600);
    expect(f.voz.usoJustoExcedido).toBe(true);
    expect(f.avisos.some((a) => a.includes('uso justo'))).toBe(true);
  });

  it('sin precio de excedente no cobra el excedente, pero avisa', () => {
    const f = calcularFacturaPlanMedido({ ...aLaMedida, precioMinutoVozExcedenteCentavos: null }, { sucursalesActivas: 7, minutosVoz: 10_000, conversacionesWa: 0 });
    expect(f.renglones.some((r) => r.concepto === 'excedente_minutos_voz')).toBe(false);
    expect(f.avisos.some((a) => a.includes('sin precio de excedente'))).toBe(true);
  });

  it('redondea los minutos hacia arriba (un minuto parcial cuenta)', () => {
    const f = calcularFacturaPlanMedido(aLaMedida, { sucursalesActivas: 7, minutosVoz: 9_200.2, conversacionesWa: 0 });
    expect(f.voz.excedenteCobrado).toBe(1);
  });
});

describe('calcularFacturaPlanMedido: precio por sucursal', () => {
  it('cobra cada sucursal activa e incluye minutos y conversaciones por sucursal', () => {
    const f = calcularFacturaPlanMedido(porSucursal, { sucursalesActivas: 2, minutosVoz: 2_600, conversacionesWa: 320 });
    expect(f.renglones).toHaveLength(1);
    expect(f.renglones[0]).toMatchObject({ concepto: 'sucursales', cantidad: 2, importeCentavos: 858_000 });
    expect(f.voz.incluido).toBe(2_600);
    expect(f.whatsapp.incluido).toBe(320);
  });

  it('la cuota de alta solo entra cuando se pide (primera factura)', () => {
    const sin = calcularFacturaPlanMedido(porSucursal, { sucursalesActivas: 1, minutosVoz: 0, conversacionesWa: 0 });
    const con = calcularFacturaPlanMedido(porSucursal, { sucursalesActivas: 1, minutosVoz: 0, conversacionesWa: 0 }, { incluirCuotaAlta: true });
    expect(sin.renglones.some((r) => r.concepto === 'cuota_alta')).toBe(false);
    expect(con.renglones.find((r) => r.concepto === 'cuota_alta')?.importeCentavos).toBe(500_000);
  });

  it('con sucursales incluidas solo cobra las de más', () => {
    const f = calcularFacturaPlanMedido({ ...porSucursal, sucursalesIncluidas: 3 }, { sucursalesActivas: 5, minutosVoz: 0, conversacionesWa: 0 });
    expect(f.renglones[0]).toMatchObject({ concepto: 'sucursales', cantidad: 2 });
  });
});

describe('validaciones', () => {
  it('un plan por asiento no se factura con este motor', () => {
    expect(() => calcularFacturaPlanMedido({ ...aLaMedida, modeloCobro: 'por_asiento' }, { sucursalesActivas: 1, minutosVoz: 0, conversacionesWa: 0 })).toThrow(TarifaInvalida);
  });

  it('un plan sin cuota fija ni precio por sucursal no se factura (no inventa un cobro de 0)', () => {
    expect(() => calcularFacturaPlanMedido({ ...aLaMedida, cuotaFijaCentavos: null }, { sucursalesActivas: 1, minutosVoz: 0, conversacionesWa: 0 })).toThrow(TarifaInvalida);
  });

  it('un precio con decimales (no centavos enteros) lanza', () => {
    expect(() => calcularFacturaPlanMedido({ ...aLaMedida, precioMinutoVozExcedenteCentavos: 2.5 }, { sucursalesActivas: 1, minutosVoz: 0, conversacionesWa: 0 })).toThrow(TarifaInvalida);
  });

  it('un uso negativo lanza', () => {
    expect(() => calcularFacturaPlanMedido(aLaMedida, { sucursalesActivas: 1, minutosVoz: -1, conversacionesWa: 0 })).toThrow();
  });

  it('IVA: redondeo al centavo y total = subtotal + IVA', () => {
    expect(ivaCentavos(1, 1600)).toBe(0);
    expect(ivaCentavos(4, 1600)).toBe(1);
    expect(ivaCentavos(3_000_000, 1600)).toBe(480_000);
  });

  it('tarifaDesdeJson lee la forma de core.plan_tarifa_json (bigint como texto incluido)', () => {
    const t = tarifaDesdeJson({ planId: 'x-y-z', nombre: 'X', modeloCobro: 'medido', cuotaFijaCentavos: '3000000', tasaIvaBp: 1600, sucursalesIncluidas: 7 });
    expect(t.cuotaFijaCentavos).toBe(3_000_000);
    expect(t.precioMinutoVozExcedenteCentavos).toBeNull();
    expect(() => tarifaDesdeJson({ planId: 'x', nombre: 'X', modeloCobro: 'gratis' })).toThrow(TarifaInvalida);
  });
});
