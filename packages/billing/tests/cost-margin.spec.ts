import { describe, it, expect } from 'vitest';
import {
  calcularFilaCostoMargen,
  calcularIngresoEsperado,
  evaluarLimites,
  microUsdAMxn,
  resumirCostoMargen,
  type EntradaCostoMargen,
  type PlanPrecio,
} from '../src/index.ts';

const PLAN_REST: PlanPrecio = { id: 'restaurantes-estandar', nombre: 'Restaurantes', precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1 };

function entrada(parche: Partial<EntradaCostoMargen> = {}): EntradaCostoMargen {
  return {
    organizationId: 'org-1',
    nombre: 'Org 1',
    slug: 'org-1',
    vertical: 'restaurantes',
    orgStatus: 'active',
    plan: PLAN_REST,
    limites: [],
    billingStatus: null,
    billingSeats: null,
    sucursalesActivas: 3,
    costo: { llm: 2_000_000, voz: 1_000_000, whatsapp: 500_000, telefonia: 500_000, otros: 0 },
    eventosTotal: 10,
    eventosEstimados: 8,
    minutosVoz: 50,
    mensajes: 400,
    llmCapMicroUsd: 100_000_000,
    llmAlertPct: 80,
    ...parche,
  };
}

describe('microUsdAMxn', () => {
  it('convierte con el tipo de cambio dado y redondea a centavos', () => {
    expect(microUsdAMxn(4_000_000, 17.5)).toBe(70);
    expect(microUsdAMxn(1, 17.5)).toBe(0);
  });
  it('sin tipo de cambio devuelve null (nunca asume uno)', () => {
    expect(microUsdAMxn(4_000_000, null)).toBeNull();
  });
  it('rechaza un tipo de cambio no positivo', () => {
    expect(() => microUsdAMxn(1, 0)).toThrow();
    expect(() => microUsdAMxn(1, -2)).toThrow();
  });
});

describe('calcularIngresoEsperado', () => {
  it('sin plan: null con razon sin_plan', () => {
    expect(calcularIngresoEsperado(null, null, null, 3)).toEqual({ ingresoMxn: null, razon: 'sin_plan', asientosFacturables: 0, fuente: 'ninguna' });
  });
  it('plan sin precios: null con razon precio_no_configurado (no 0)', () => {
    const plan: PlanPrecio = { id: 'rentas-estandar', nombre: 'Rentas', precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0 };
    expect(calcularIngresoEsperado(plan, 'activa', 4, 4).razon).toBe('precio_no_configurado');
  });
  it('sin suscripcion usa sucursales activas menos incluidas', () => {
    // 3 sucursales - 1 incluida = 2 x $799
    const r = calcularIngresoEsperado(PLAN_REST, null, null, 3);
    expect(r.ingresoMxn).toBe(1598);
    expect(r.fuente).toBe('sucursales');
    expect(r.asientosFacturables).toBe(2);
  });
  it('con suscripcion activa usa los seats de billing tal cual (ya netos de incluidos)', () => {
    const r = calcularIngresoEsperado(PLAN_REST, 'activa', 4, 3);
    expect(r.ingresoMxn).toBe(4 * 799);
    expect(r.fuente).toBe('billing');
  });
  it('suscripcion no activa NO cuenta aunque tenga seats', () => {
    const r = calcularIngresoEsperado(PLAN_REST, 'cancelada', 9, 3);
    expect(r.fuente).toBe('sucursales');
    expect(r.ingresoMxn).toBe(1598);
  });
  it('suma el precio base', () => {
    const plan: PlanPrecio = { ...PLAN_REST, precioBaseCentavos: 590000 };
    expect(calcularIngresoEsperado(plan, null, null, 1).ingresoMxn).toBe(5900);
  });
  it('base null con precio por asiento: la base cuenta como 0', () => {
    const plan: PlanPrecio = { ...PLAN_REST, precioBaseCentavos: null, asientosIncluidos: 0 };
    expect(calcularIngresoEsperado(plan, null, null, 2).ingresoMxn).toBe(1598);
  });
  it('rechaza asientos o sucursales invalidos en vez de facturar una cifra sin sentido', () => {
    expect(() => calcularIngresoEsperado(PLAN_REST, null, null, -1)).toThrow();
    expect(() => calcularIngresoEsperado(PLAN_REST, 'activa', Number.NaN, 1)).toThrow();
  });
});

describe('evaluarLimites', () => {
  const ent = { costo: entrada().costo, minutosVoz: 90, mensajes: 400, sucursalesActivas: 3, billingSeats: null };
  it('clasifica ok / aviso / excedido y marca solo el tope LLM con pausar como aplicado por el sistema', () => {
    const r = evaluarLimites(
      [
        { metrica: 'minutos_voz_mes', limite: 100, accion: 'cobrar' },
        { metrica: 'mensajes_mes', limite: 1000, accion: 'avisar' },
        { metrica: 'sucursales', limite: 2, accion: 'pausar' },
        { metrica: 'llm_costo_micro_usd_mes', limite: 1_000_000, accion: 'pausar' },
        { metrica: 'asientos', limite: 5, accion: 'avisar' },
      ],
      ent,
    );
    expect(r.map((x) => x.estado)).toEqual(['aviso', 'ok', 'excedido', 'excedido', 'sin_dato']);
    expect(r.map((x) => x.aplicadoPorSistema)).toEqual([false, false, false, true, false]);
    expect(r[0]!.pct).toBe(90);
    expect(r[4]!.uso).toBeNull();
  });
  it('limite 0 con uso > 0 es excedido sin porcentaje finito', () => {
    const [x] = evaluarLimites([{ metrica: 'mensajes_mes', limite: 0, accion: 'avisar' }], ent);
    expect(x!.estado).toBe('excedido');
    expect(x!.pct).toBeNull();
  });
});

describe('calcularFilaCostoMargen', () => {
  it('margen sano: ingreso 1598, costo 4 USD x 17.5 = 70 MXN', () => {
    const f = calcularFilaCostoMargen(entrada(), { mxnPorUsd: 17.5 });
    expect(f.costoMicroUsd.total).toBe(4_000_000);
    expect(f.costoMxn).toBe(70);
    expect(f.ingresoMxn).toBe(1598);
    expect(f.margenMxn).toBe(1528);
    expect(f.margenPct).toBe(95.62);
    expect(f.riesgo).toBe('bajo');
    expect(f.alertas).toEqual([]);
    expect(f.costoMxnPorCategoria?.llm).toBe(35);
  });
  it('margen por debajo del umbral genera alerta media (umbral configurable)', () => {
    const f = calcularFilaCostoMargen(entrada({ costo: { llm: 60_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), { mxnPorUsd: 20, umbralMargenPct: 30 });
    // costo 1200 MXN sobre ingreso 1598 => margen 24.9%
    expect(f.margenPct).toBe(24.91);
    expect(f.alertas.map((a) => a.codigo)).toContain('margen_bajo');
    expect(f.riesgo).toBe('medio');
  });
  it('margen negativo es riesgo alto', () => {
    const f = calcularFilaCostoMargen(entrada({ costo: { llm: 90_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), { mxnPorUsd: 20 });
    expect(f.margenMxn).toBeLessThan(0);
    expect(f.alertas[0]!.codigo).toBe('margen_negativo');
    expect(f.riesgo).toBe('alto');
  });
  it('sin tipo de cambio: costo y margen son null (honesto), el costo USD si se muestra', () => {
    const f = calcularFilaCostoMargen(entrada(), { mxnPorUsd: null });
    expect(f.costoMxn).toBeNull();
    expect(f.margenMxn).toBeNull();
    expect(f.margenPct).toBeNull();
    expect(f.costoMxnPorCategoria).toBeNull();
    expect(f.costoUsd).toBe(4);
    expect(f.ingresoMxn).toBe(1598);
  });
  it('sin plan: ingreso null, riesgo desconocido si no hay otra alerta', () => {
    const f = calcularFilaCostoMargen(entrada({ plan: null }), { mxnPorUsd: 20 });
    expect(f.ingresoMxn).toBeNull();
    expect(f.ingresoRazon).toBe('sin_plan');
    expect(f.margenMxn).toBeNull();
    expect(f.riesgo).toBe('desconocido');
  });
  it('tope LLM: alerta al umbral y alerta alta al agotar', () => {
    const cerca = calcularFilaCostoMargen(entrada({ costo: { llm: 85_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), { mxnPorUsd: 1 });
    expect(cerca.alertas.map((a) => a.codigo)).toContain('tope_llm');
    const agotado = calcularFilaCostoMargen(entrada({ costo: { llm: 100_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), { mxnPorUsd: 1 });
    expect(agotado.alertas.map((a) => a.codigo)).toContain('tope_llm_agotado');
    expect(agotado.riesgo).toBe('alto');
  });
  it('plan que no cobra nada pero genera costo: alerta sin_ingreso_con_costo', () => {
    const f = calcularFilaCostoMargen(entrada({ sucursalesActivas: 1 }), { mxnPorUsd: 20 });
    expect(f.ingresoMxn).toBe(0);
    expect(f.margenPct).toBeNull();
    expect(f.alertas.map((a) => a.codigo)).toContain('sin_ingreso_con_costo');
  });
  it('limite excedido del plan: alerta alta que dice si el sistema lo corta o solo avisa', () => {
    const f = calcularFilaCostoMargen(entrada({ limites: [{ metrica: 'minutos_voz_mes', limite: 10, accion: 'cobrar' }] }), { mxnPorUsd: 20 });
    const a = f.alertas.find((x) => x.codigo === 'limite_excedido');
    expect(a?.severidad).toBe('alta');
    expect(a?.mensaje).toContain('solo se avisa');
  });
  it('rechaza costos negativos', () => {
    expect(() => calcularFilaCostoMargen(entrada({ costo: { llm: -1, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), { mxnPorUsd: 20 })).toThrow();
  });
});

describe('resumirCostoMargen', () => {
  it('suma solo lo comparable para el margen global y cuenta las sin ingreso', () => {
    const a = calcularFilaCostoMargen(entrada(), { mxnPorUsd: 17.5 });
    const b = calcularFilaCostoMargen(entrada({ organizationId: 'org-2', plan: null }), { mxnPorUsd: 17.5 });
    const r = resumirCostoMargen([a, b]);
    expect(r.organizaciones).toBe(2);
    expect(r.organizacionesSinIngreso).toBe(1);
    expect(r.ingresoMxn).toBe(1598);
    expect(r.costoMxn).toBe(140);
    expect(r.margenMxn).toBe(1528); // solo la fila con ingreso: 1598 - 70
    expect(r.costoUsd).toBe(8);
  });
  it('sin tipo de cambio el costo y margen globales son null', () => {
    const r = resumirCostoMargen([calcularFilaCostoMargen(entrada(), { mxnPorUsd: null })]);
    expect(r.costoMxn).toBeNull();
    expect(r.margenMxn).toBeNull();
    expect(r.margenPct).toBeNull();
  });
  it('lista vacia: ceros y sin margen', () => {
    const r = resumirCostoMargen([]);
    expect(r).toMatchObject({ organizaciones: 0, costoUsd: 0, costoMxn: 0, ingresoMxn: 0, margenMxn: null });
  });
});
