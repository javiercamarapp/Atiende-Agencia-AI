import { describe, expect, it } from 'vitest';
import { cotizar, margenExcedentePct, margenPeorPunto, type CostosUnitarios, type TarifaPlanMedido } from '../src/index.ts';

// Espejo de la SEMILLA de packages/db/migrations/0105 (tabulador de referencia interna y costos unitarios). Si alguien cambia
// la semilla, este archivo debe cambiar igual; el mismo minimo se verifica contra la semilla real en
// scripts/verify-cobro-tabulador-consumo/ (escenario «margen >= 55 % en cada tramo»).
const COSTOS_SEMILLA: CostosUnitarios = { minutoVozMxn: 1.2, conversacionWaMxn: 0.35, fijoMensualSucursalMxn: 150, numeroVozMensualSucursalMxn: 116, fijoMensualOrganizacionMxn: 0 };
const MINIMO = 55;

const base = {
  nombre: 'Referencia',
  modeloCobro: 'medido' as const,
  cuotaFijaCentavos: null,
  precioSucursalCentavos: null,
  sucursalesIncluidas: 0,
  minutosVozIncluidos: 0,
  conversacionesWaIncluidas: 0,
  usoJustoPct: 150,
  cuotaAltaCentavos: null,
  tasaIvaBp: 1600,
  organizacionExclusivaId: null,
};

const ANUAL: TarifaPlanMedido = {
  ...base,
  planId: 'restaurantes-referencia-anual',
  minutosVozIncluidosPorSucursal: 1300,
  conversacionesWaIncluidasPorSucursal: 300,
  precioMinutoVozExcedenteCentavos: 290,
  precioConversacionWaExcedenteCentavos: 150,
  cuotaAltaPorSucursalCentavos: 179000,
  tramosSucursal: [
    { desde: 1, hasta: 2, precioCentavos: 479000, minutosVozIncluidosPorSucursal: 1450, conversacionesWaIncluidasPorSucursal: 300 },
    { desde: 3, hasta: 5, precioCentavos: 449000, minutosVozIncluidosPorSucursal: 1350, conversacionesWaIncluidasPorSucursal: 300 },
    { desde: 6, hasta: 9, precioCentavos: 429000, minutosVozIncluidosPorSucursal: 1250, conversacionesWaIncluidasPorSucursal: 300 },
    { desde: 10, hasta: 19, precioCentavos: 389000, minutosVozIncluidosPorSucursal: 1100, conversacionesWaIncluidasPorSucursal: 300 },
    { desde: 20, hasta: null, precioCentavos: 300000, minutosVozIncluidosPorSucursal: 800, conversacionesWaIncluidasPorSucursal: 300 },
  ],
};
const MENSUAL: TarifaPlanMedido = {
  ...ANUAL,
  planId: 'restaurantes-referencia-mensual',
  cuotaAltaPorSucursalCentavos: 249000,
  tramosSucursal: ANUAL.tramosSucursal!.map((t, i) => ({ ...t, precioCentavos: [549000, 519000, 499000, 459000, 370000][i]! })),
};
const WHATSAPP: TarifaPlanMedido = {
  ...base,
  planId: 'restaurantes-referencia-whatsapp',
  minutosVozIncluidosPorSucursal: 0,
  conversacionesWaIncluidasPorSucursal: 300,
  precioMinutoVozExcedenteCentavos: null,
  precioConversacionWaExcedenteCentavos: 150,
  cuotaAltaPorSucursalCentavos: 99000,
  tramosSucursal: [{ desde: 1, hasta: null, precioCentavos: 149000 }],
};

describe('tabulador de referencia: >= 55 % de margen bruto en el peor punto (bolsa llena, sin excedente)', () => {
  const casos: Array<[string, TarifaPlanMedido, number]> = [];
  for (const plan of [ANUAL, MENSUAL]) for (const n of [1, 2, 3, 5, 6, 9, 10, 19, 20, 40]) casos.push([plan.planId, plan, n]);
  for (const n of [1, 5, 20]) casos.push([WHATSAPP.planId, WHATSAPP, n]);

  it.each(casos)('%s con %i sucursales', (_id, plan, n) => {
    const r = margenPeorPunto(plan, n, COSTOS_SEMILLA);
    expect(r.margenPct).not.toBeNull();
    expect(r.margenPct!).toBeGreaterThanOrEqual(MINIMO);
  });

  it('el minuto y la conversacion excedentes tambien dejan >= 55 %', () => {
    expect(margenExcedentePct(ANUAL.precioMinutoVozExcedenteCentavos, COSTOS_SEMILLA.minutoVozMxn)!).toBeGreaterThanOrEqual(MINIMO);
    expect(margenExcedentePct(ANUAL.precioConversacionWaExcedenteCentavos, COSTOS_SEMILLA.conversacionWaMxn)!).toBeGreaterThanOrEqual(MINIMO);
  });

  it('la cuota de alta (anual y mensual) cubre su costo supuesto de 800 MXN por sucursal con >= 55 %', () => {
    for (const plan of [ANUAL, MENSUAL]) expect(((plan.cuotaAltaPorSucursalCentavos! / 100 - 800) / (plan.cuotaAltaPorSucursalCentavos! / 100)) * 100).toBeGreaterThanOrEqual(MINIMO);
  });
});

describe('cotizar: PM (7 sucursales, contrato anual)', () => {
  it('a bolsa llena (8,750 min de referencia): factura 30,030 + IVA', () => {
    const r = margenPeorPunto(ANUAL, 7, COSTOS_SEMILLA);
    expect(r.factura.subtotalCentavos).toBe(3_003_000);
    expect(r.factura.totalCentavos).toBe(3_483_480);
    expect(r.margenPct!).toBeGreaterThanOrEqual(MINIMO);
  });

  it('con 3.2 min por llamada (12,800 min) el excedente sostiene el margen', () => {
    const r = cotizar(ANUAL, { sucursales: 7, minutosVoz: 12_800, conversacionesWa: 1_100 }, COSTOS_SEMILLA);
    expect(r.factura.subtotalCentavos).toBe(3_003_000 + (12_800 - 8_750) * 290);
    expect(r.margenPct!).toBeGreaterThanOrEqual(MINIMO);
  });

  it('con tarjeta el margen baja por la comision', () => {
    const r = cotizar(ANUAL, { sucursales: 7, minutosVoz: 8_750, conversacionesWa: 2_100 }, COSTOS_SEMILLA, { porcentaje: 0.036, fijoMxn: 3, ivaSobreComisionPct: 0.16 });
    expect(r.margenConTarjetaPct!).toBeLessThan(r.margenPct!);
  });
});

// ---- Planes de LISTA de autoservicio (espejo de la semilla 0105) y pago por uso por bandas ----
const TARJETA = { porcentaje: 0.036, fijoMxn: 3, ivaSobreComisionPct: 0.16 };
const lista = (planId: string, precio: number, min: number, conv: number, margen: number): TarifaPlanMedido => ({
  ...base,
  planId,
  usoJustoPct: 150,
  minutosVozIncluidosPorSucursal: min,
  conversacionesWaIncluidasPorSucursal: conv,
  precioMinutoVozExcedenteCentavos: min > 0 ? 340 : null,
  precioConversacionWaExcedenteCentavos: 150,
  margenMinimoPct: margen,
  tramosSucursal: [{ desde: 1, hasta: 2, precioCentavos: precio }, { desde: 3, hasta: null, precioCentavos: null }],
});
const BASICO = lista('restaurantes-basico', 159000, 0, 500, 75);
const PLUS = lista('restaurantes-plus', 439000, 500, 1000, 65);
const PRO = lista('restaurantes-pro', 769000, 1500, 2000, 60);
// El plan Básico no tiene voz: el costo del número de Twilio no aplica (tieneVoz = false).
const COSTOS_SIN_VOZ: CostosUnitarios = COSTOS_SEMILLA;

describe('planes de lista (precios aprobados): objetivo del plan antes de comision y >= 55 % con tarjeta, a bolsa llena', () => {
  it.each([
    ['Básico', BASICO, COSTOS_SIN_VOZ],
    ['Plus', PLUS, COSTOS_SEMILLA],
    ['Pro', PRO, COSTOS_SEMILLA],
  ] as const)('%s con 1 y 2 sucursales', (_n, plan, costos) => {
    for (const n of [1, 2]) {
      const r = margenPeorPunto(plan, n, costos, TARJETA);
      expect(r.margenPct!).toBeGreaterThanOrEqual(plan.margenMinimoPct!);
      expect(r.margenConTarjetaPct!).toBeGreaterThanOrEqual(55);
    }
  });

  it('el minuto excedente (3.40) deja >= 60 % antes de comision y >= 55 % con tarjeta', () => {
    const precio = 3.4;
    const comision = precio * 1.16 * TARJETA.porcentaje * (1 + TARJETA.ivaSobreComisionPct);
    expect(((precio - COSTOS_SEMILLA.minutoVozMxn) / precio) * 100).toBeGreaterThanOrEqual(60);
    expect(((precio - COSTOS_SEMILLA.minutoVozMxn - comision) / precio) * 100).toBeGreaterThanOrEqual(55);
  });
});

const POR_USO: TarifaPlanMedido = {
  ...base,
  planId: 'restaurantes-por-uso',
  usoJustoPct: null,
  precioSucursalCentavos: 69000,
  minutosVozIncluidosPorSucursal: 0,
  conversacionesWaIncluidasPorSucursal: 0,
  precioMinutoVozExcedenteCentavos: null,
  precioConversacionWaExcedenteCentavos: null,
  margenMinimoPct: 55,
  bandasUso: [
    { metrica: 'minuto_voz', desde: 0, hasta: 10000, precioCentavos: 340, costoUnitarioMxn: 1.2 },
    { metrica: 'minuto_voz', desde: 10000, hasta: 50000, precioCentavos: 310, costoUnitarioMxn: 1.1 },
    { metrica: 'minuto_voz', desde: 50000, hasta: 150000, precioCentavos: 290, costoUnitarioMxn: 1.0 },
    { metrica: 'minuto_voz', desde: 150000, hasta: null, precioCentavos: null, costoUnitarioMxn: 1.0 },
    { metrica: 'conversacion_wa', desde: 0, hasta: 3000, precioCentavos: 150, costoUnitarioMxn: 0.35 },
    { metrica: 'conversacion_wa', desde: 3000, hasta: 15000, precioCentavos: 120, costoUnitarioMxn: 0.35 },
    { metrica: 'conversacion_wa', desde: 15000, hasta: null, precioCentavos: 99, costoUnitarioMxn: 0.35 },
  ],
};

describe('pago por uso por bandas: >= 55 % en toda la rejilla, despues de la comision de tarjeta', () => {
  const rejilla: Array<[number, number, number]> = [];
  for (const sucursales of [1, 3, 7, 10, 20]) for (const minutos of [0, 500, 1_150, 9_200, 12_800, 50_000, 100_000, 150_000]) rejilla.push([sucursales, minutos, Math.round(minutos / 4)]);
  it.each(rejilla)('%i sucursales, %i min, %i conversaciones', (sucursales, minutos, conv) => {
    const r = cotizar(POR_USO, { sucursales, minutosVoz: minutos, conversacionesWa: conv }, COSTOS_SEMILLA, TARJETA);
    expect(r.margenConTarjetaPct!).toBeGreaterThanOrEqual(55);
  });

  it('precio graduado: 12,000 min = 10,000 x 3.40 + 2,000 x 3.10', () => {
    const r = cotizar(POR_USO, { sucursales: 1, minutosVoz: 12_000, conversacionesWa: 0 }, COSTOS_SEMILLA);
    const voz = r.factura.renglones.filter((x) => x.concepto === 'excedente_minutos_voz');
    expect(voz.map((x) => [x.cantidad, x.precioUnitarioCentavos])).toEqual([[10_000, 340], [2_000, 310]]);
  });

  it('arriba de 150,000 min es volumen a cotizar: no se factura solo y se avisa', () => {
    const r = cotizar(POR_USO, { sucursales: 10, minutosVoz: 160_000, conversacionesWa: 0 }, COSTOS_SEMILLA);
    expect(r.factura.voz.excedenteCobrado).toBe(150_000);
    expect(r.factura.avisos.some((a) => a.includes('cotizar'))).toBe(true);
  });
});
