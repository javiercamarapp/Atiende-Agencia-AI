import { describe, it, expect } from 'vitest';
import {
  armarPyl,
  celdaCsv,
  compararPyl,
  ingresoReconocidoFoto,
  ingresoReconocidoVivo,
  movimientoMrrPorVertical,
  pylACsv,
  repartirCentavos,
  calcularFilaCostoMargen,
  type EntradaCostoMargen,
  type EntradaPylOrg,
  type FilaCfo,
  type SnapshotConVertical,
} from '../src/index.ts';

const COSTO0 = { llm: 0, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 };

function org(id: string, vertical: string, ingresoMxn: number | null, costo: Partial<typeof COSTO0> = {}, razon: EntradaPylOrg['ingresoRazon'] = null): EntradaPylOrg {
  return { organizationId: id, nombre: `Org ${id}`, vertical, ingresoMxn, ingresoRazon: ingresoMxn === null ? (razon ?? 'sin_plan') : null, costo: { ...COSTO0, ...costo } };
}

describe('repartirCentavos', () => {
  it('suma EXACTAMENTE el total (resto mayor) y respeta la proporcion', () => {
    const r = repartirCentavos(100, [1, 1, 1]) as number[];
    expect(r.reduce((a, b) => a + b, 0)).toBe(100);
    expect(r).toEqual([34, 33, 33]);
    expect(repartirCentavos(1000, [3_000_000, 1_000_000])).toEqual([750, 250]);
  });
  it('sin base de reparto devuelve null; con pesos enormes no desborda', () => {
    expect(repartirCentavos(500, [0, 0])).toBeNull();
    const r = repartirCentavos(900_000_000, [5e12, 5e12]) as number[];
    expect(r).toEqual([450_000_000, 450_000_000]);
  });
  it('rechaza entradas invalidas', () => {
    expect(() => repartirCentavos(-1, [1])).toThrow();
    expect(() => repartirCentavos(1.5, [1])).toThrow();
    expect(() => repartirCentavos(10, [-1])).toThrow();
  });
});

describe('armarPyl', () => {
  // 20 MXN por USD. A: ingreso 1000, costo 10 USD (200 MXN). B: ingreso 500, costo 5 USD (100 MXN).
  const base = [org('a', 'restaurantes', 1000, { llm: 6_000_000, voz: 4_000_000 }), org('b', 'hoteles', 500, { telefonia: 5_000_000 })];

  it('calcula COGS por categoria, contribucion y margen bruto con infra prorrateada', () => {
    const p = armarPyl({ mes: '2026-09', orgs: base, mxnPorUsd: 20, infra: [{ concepto: 'Vercel + Supabase', montoMxnCentavos: 30_000 }] });
    const a = p.porCliente.find((f) => f.organizationId === 'a')!;
    expect(a.cogs).toEqual({ llm: 120, voz: 80, whatsapp: 0, telefonia: 0, otros: 0 });
    expect(a.cogsDirectoMxn).toBe(200);
    expect(a.contribucionMxn).toBe(800);
    expect(a.infraMxn).toBe(200); // 2/3 de 300
    expect(a.margenBrutoMxn).toBe(600);
    expect(a.margenBrutoPct).toBe(60);
    const b = p.porCliente.find((f) => f.organizationId === 'b')!;
    expect(b.infraMxn).toBe(100);
    expect(b.margenBrutoMxn).toBe(300);
    expect(p.total.ingresoMxn).toBe(1500);
    expect(p.total.cogsDirectoMxn).toBe(300);
    expect(p.total.infraMxn).toBe(300);
    expect(p.total.margenBrutoMxn).toBe(900);
    expect(p.total.contribucionMxn).toBe(1200);
    expect(p.porVertical.map((v) => v.clave)).toEqual(['restaurantes', 'hoteles']);
    expect(p.infra).toEqual({ disponible: true, totalMxn: 300, sinAsignarMxn: 0, conceptos: [{ concepto: 'Vercel + Supabase', montoMxn: 300 }] });
  });

  it('sin infra capturada: contribucion si, margen bruto e infra NULL (jamas 0)', () => {
    const p = armarPyl({ mes: '2026-09', orgs: base, mxnPorUsd: 20, infra: null });
    expect(p.infra).toEqual({ disponible: false, razon: 'sin_infra_capturada' });
    expect(p.total.contribucionMxn).toBe(1200);
    expect(p.total.infraMxn).toBeNull();
    expect(p.total.margenBrutoMxn).toBeNull();
    expect(p.porCliente[0]!.infraMxn).toBeNull();
    expect(p.porCliente[0]!.margenBrutoMxn).toBeNull();
  });

  it('sin tipo de cambio: costos y margenes NULL, el ingreso se conserva', () => {
    const p = armarPyl({ mes: '2026-09', orgs: base, mxnPorUsd: null, infra: [{ concepto: 'x', montoMxnCentavos: 100 }] });
    expect(p.total.ingresoMxn).toBe(1500);
    expect(p.total.cogs).toBeNull();
    expect(p.total.cogsDirectoMxn).toBeNull();
    expect(p.total.contribucionMxn).toBeNull();
    expect(p.total.margenBrutoMxn).toBeNull();
    expect(p.porCliente[0]!.cogs).toBeNull();
    // El reparto de infra usa micro-USD: no depende del tipo de cambio.
    expect(p.porCliente.map((f) => f.infraMxn)).toEqual([0.67, 0.33]);
  });

  it('organizaciones sin ingreso conocido no contaminan el margen: su costo va aparte', () => {
    const orgs = [...base, org('c', 'rentas', null, { llm: 1_000_000 }, 'precio_no_configurado')];
    const p = armarPyl({ mes: '2026-09', orgs, mxnPorUsd: 20, infra: null });
    const rentas = p.porVertical.find((v) => v.clave === 'rentas')!;
    expect(rentas.organizacionesSinIngreso).toBe(1);
    expect(rentas.ingresoMxn).toBe(0);
    expect(rentas.contribucionMxn).toBeNull(); // ninguna con ingreso conocido
    expect(rentas.cogsDirectoMxn).toBe(20);
    expect(rentas.costoSinIngresoMxn).toBe(20);
    expect(p.total.contribucionMxn).toBe(1200); // sin los 20 de C
    expect(p.total.costoSinIngresoMxn).toBe(20);
    expect(p.total.cogsDirectoMxn).toBe(320);
    const c = p.porCliente.find((f) => f.organizationId === 'c')!;
    expect(c.ingresoMxn).toBeNull();
    expect(c.contribucionMxn).toBeNull();
    expect(p.porCliente[p.porCliente.length - 1]!.organizationId).toBe('c'); // sin ingreso al final
  });

  it('infra sin base de reparto (COGS 0) queda sin asignar y no se pierde', () => {
    const p = armarPyl({ mes: '2026-09', orgs: [org('a', 'citas', 100)], mxnPorUsd: 20, infra: [{ concepto: 'x', montoMxnCentavos: 5000 }] });
    expect(p.infra).toMatchObject({ disponible: true, totalMxn: 50, sinAsignarMxn: 50 });
    expect(p.porCliente[0]!.infraMxn).toBe(0);
  });

  it('descarta organizaciones sin ingreso ni costo; conserva una activa sin precio', () => {
    const p = armarPyl({ mes: '2026-09', orgs: [org('x', 'citas', 0), org('y', 'citas', null, {}, 'sin_plan')], mxnPorUsd: 20, infra: null });
    expect(p.porCliente.map((f) => f.organizationId)).toEqual(['y']);
  });

  it('un costo sin ingreso (0) da contribucion negativa y pct null (no divide entre 0)', () => {
    const p = armarPyl({ mes: '2026-09', orgs: [org('a', 'citas', 0, { llm: 2_000_000 })], mxnPorUsd: 20, infra: null });
    expect(p.porCliente[0]!.contribucionMxn).toBe(-40);
    expect(p.porCliente[0]!.contribucionPct).toBeNull();
  });

  it('rechaza un tipo de cambio invalido', () => {
    expect(() => armarPyl({ mes: '2026-09', orgs: base, mxnPorUsd: 0, infra: null })).toThrow();
  });
});

describe('ingreso reconocido', () => {
  const planPrecio = { id: 'p', nombre: 'P', precioBaseCentavos: 0, precioAsientoCentavos: 10_000, asientosIncluidos: 0 };
  function fcfo(parche: Partial<EntradaCostoMargen>, billingStatus: string | null = null): FilaCfo {
    const e: EntradaCostoMargen = {
      organizationId: 'o', nombre: 'O', slug: 'o', vertical: 'citas', orgStatus: 'active', plan: planPrecio, limites: [], billingStatus, billingSeats: null,
      sucursalesActivas: 2, costo: COSTO0, eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 1, llmAlertPct: 80, ...parche,
    };
    return { fila: calcularFilaCostoMargen(e, { mxnPorUsd: 20 }), billingStatus, billingPeriodEndMs: null };
  }
  it('vivo: activa = ingreso del plan; inactiva o cancelada = 0 conocido; sin plan = null con razon', () => {
    expect(ingresoReconocidoVivo(fcfo({}))).toEqual({ ingresoMxn: 200, ingresoRazon: null });
    expect(ingresoReconocidoVivo(fcfo({ orgStatus: 'suspended' }))).toEqual({ ingresoMxn: 0, ingresoRazon: null });
    expect(ingresoReconocidoVivo(fcfo({}, 'cancelada'))).toEqual({ ingresoMxn: 0, ingresoRazon: null });
    expect(ingresoReconocidoVivo(fcfo({ plan: null }))).toEqual({ ingresoMxn: null, ingresoRazon: 'sin_plan' });
  });
  it('foto: sin foto = null con razon; foto sin precio conserva su razon; con precio = centavos/100', () => {
    expect(ingresoReconocidoFoto(undefined)).toEqual({ ingresoMxn: null, ingresoRazon: 'sin_foto_del_mes' });
    const f = { organizationId: 'o', orgStatus: 'active', billingStatus: null, mrrCentavos: null, mrrRazon: 'sin_plan' as const };
    expect(ingresoReconocidoFoto(f)).toEqual({ ingresoMxn: null, ingresoRazon: 'sin_plan' });
    expect(ingresoReconocidoFoto({ ...f, mrrCentavos: 159_800, mrrRazon: null })).toEqual({ ingresoMxn: 1598, ingresoRazon: null });
    expect(ingresoReconocidoFoto({ ...f, mrrCentavos: 159_800, mrrRazon: null, billingStatus: 'cancelada' })).toEqual({ ingresoMxn: 0, ingresoRazon: null });
  });
});

describe('compararPyl', () => {
  it('calcula delta y porcentaje; una vertical nueva tiene previo null, no 0', () => {
    const previo = armarPyl({ mes: '2026-08', orgs: [org('a', 'citas', 1000, { llm: 5_000_000 })], mxnPorUsd: 20, infra: null });
    const actual = armarPyl({ mes: '2026-09', orgs: [org('a', 'citas', 1200, { llm: 5_000_000 }), org('b', 'hoteles', 300)], mxnPorUsd: 20, infra: null });
    const c = compararPyl(actual, previo);
    expect(c.mesPrevio).toBe('2026-08');
    expect(c.total.ingreso).toEqual({ actual: 1500, previo: 1000, deltaMxn: 500, deltaPct: 50 });
    const citas = c.porVertical.find((v) => v.clave === 'citas')!;
    expect(citas.contribucion).toEqual({ actual: 1100, previo: 900, deltaMxn: 200, deltaPct: 22.22 });
    const hoteles = c.porVertical.find((v) => v.clave === 'hoteles')!;
    expect(hoteles.ingreso).toEqual({ actual: 300, previo: null, deltaMxn: null, deltaPct: null });
    expect(c.total.margenBruto.deltaMxn).toBeNull();
  });
  it('previo en 0 no produce porcentaje', () => {
    const previo = armarPyl({ mes: '2026-08', orgs: [org('a', 'citas', 0, { llm: 1_000_000 })], mxnPorUsd: 20, infra: null });
    const actual = armarPyl({ mes: '2026-09', orgs: [org('a', 'citas', 100)], mxnPorUsd: 20, infra: null });
    expect(compararPyl(actual, previo).total.ingreso).toEqual({ actual: 100, previo: 0, deltaMxn: 100, deltaPct: null });
  });
});

describe('movimientoMrrPorVertical', () => {
  const s = (id: string, vertical: string, mrr: number | null): SnapshotConVertical => ({ organizationId: id, vertical, orgStatus: 'active', billingStatus: null, mrrCentavos: mrr });
  it('separa expansion, contraccion y churn por vertical', () => {
    const previo = [s('a', 'citas', 100_00), s('b', 'citas', 200_00), s('c', 'hoteles', 50_00)];
    const actual = [s('a', 'citas', 150_00), s('b', 'citas', 0), s('c', 'hoteles', 40_00), s('d', 'hoteles', 10_00)];
    const m = movimientoMrrPorVertical(previo, actual);
    const citas = m.find((x) => x.vertical === 'citas')!.nrr;
    expect(citas).toMatchObject({ disponible: true, expansionMxn: 50, churnMxn: 200, contraccionMxn: 0 });
    const hoteles = m.find((x) => x.vertical === 'hoteles')!.nrr;
    expect(hoteles).toMatchObject({ disponible: true, contraccionMxn: 10, nuevoMxn: 10 });
  });
  it('sin foto previa: no disponible, nunca 0', () => {
    expect(movimientoMrrPorVertical(null, [s('a', 'citas', 100)])[0]!.nrr).toEqual({ disponible: false, razon: 'sin_foto_previa' });
  });
});

describe('CSV', () => {
  it('celdaCsv escapa comillas/comas y neutraliza formulas', () => {
    expect(celdaCsv('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(celdaCsv('+52 55')).toBe(`'+52 55`);
    expect(celdaCsv('Hola, mundo')).toBe('"Hola, mundo"');
    expect(celdaCsv(null)).toBe('');
    expect(celdaCsv(12.5)).toBe('12.50');
    expect(celdaCsv(-3)).toBe('-3.00'); // un numero negativo NO es formula
  });
  it('por cliente: una cifra sin fuente va vacia con su nota; nombre malicioso neutralizado', () => {
    const p = armarPyl({ mes: '2026-09', orgs: [{ ...org('a', 'citas', 100, { llm: 1_000_000 }), nombre: '=cmd|x' }, org('b', 'rentas', null, {}, 'precio_no_configurado')], mxnPorUsd: 20, infra: null });
    const csv = pylACsv(p, 'cliente');
    const lineas = csv.replace('﻿', '').trim().split('\r\n');
    expect(lineas[0]).toContain('ingreso_reconocido_mxn');
    expect(lineas[1]).toContain(`'=cmd|x`);
    expect(lineas[1]).toContain('sin infra capturada');
    expect(lineas[2]).toContain('plan sin precio configurado');
    expect(lineas[2]).toContain('2026-09,' + 'b,Org b,rentas,,'); // ingreso vacio, no 0
    expect(csv.startsWith('﻿')).toBe(true);
  });
  it('por vertical incluye la fila total', () => {
    const p = armarPyl({ mes: '2026-09', orgs: [org('a', 'citas', 100)], mxnPorUsd: null, infra: null });
    const lineas = pylACsv(p, 'vertical').replace('﻿', '').trim().split('\r\n');
    expect(lineas).toHaveLength(3);
    expect(lineas[2]!.startsWith('2026-09,total,1,100.00')).toBe(true);
    expect(lineas[2]).toContain('sin tipo de cambio');
  });
});
