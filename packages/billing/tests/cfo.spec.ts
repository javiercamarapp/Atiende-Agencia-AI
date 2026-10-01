import { describe, it, expect } from 'vitest';
import {
  aportaMrr,
  armarDashboardCfo,
  calcularFilaCostoMargen,
  calcularIngresos,
  calcularNrr,
  evaluarAlertasCfo,
  snapshotDesdeFila,
  type EntradaCostoMargen,
  type FilaCfo,
  type PlanPrecio,
  type SnapshotMrr,
} from '../src/index.ts';

const AHORA = Date.parse('2026-09-30T12:00:00Z');
const PLAN_REST: PlanPrecio = { id: 'restaurantes-estandar', nombre: 'Restaurantes', precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1 };
const PLAN_HOTEL: PlanPrecio = { id: 'hoteles-estandar', nombre: 'Hoteles', precioBaseCentavos: 0, precioAsientoCentavos: 8900, asientosIncluidos: 5 };
const PLAN_SIN_PRECIO: PlanPrecio = { id: 'rentas-estandar', nombre: 'Rentas', precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0 };

function entrada(id: string, parche: Partial<EntradaCostoMargen> = {}): EntradaCostoMargen {
  return {
    organizationId: id,
    nombre: `Org ${id}`,
    slug: `org-${id}`,
    vertical: 'restaurantes',
    orgStatus: 'active',
    plan: PLAN_REST, // 3 sucursales - 1 incluida = 2 x 799 = 1,598 MXN
    limites: [],
    billingStatus: null,
    billingSeats: null,
    sucursalesActivas: 3,
    costo: { llm: 4_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 }, // 4 USD x 20 = 80 MXN
    eventosTotal: 0,
    eventosEstimados: 0,
    minutosVoz: 0,
    mensajes: 0,
    llmCapMicroUsd: 100_000_000,
    llmAlertPct: 80,
    ...parche,
  };
}

function fila(id: string, parche: Partial<EntradaCostoMargen> = {}, mxnPorUsd: number | null = 20, extra: { billingStatus?: string | null; periodEndMs?: number | null } = {}): FilaCfo {
  const e = entrada(id, { billingStatus: extra.billingStatus ?? null, ...parche });
  return { fila: calcularFilaCostoMargen(e, { mxnPorUsd }), billingStatus: extra.billingStatus ?? null, billingPeriodEndMs: extra.periodEndMs ?? null };
}

describe('aportaMrr', () => {
  it('exige organizacion activa, suscripcion no cancelada e ingreso conocido y positivo', () => {
    expect(aportaMrr('active', 'activa', 100)).toBe(true);
    expect(aportaMrr('trial', null, 100)).toBe(false);
    expect(aportaMrr('suspended', null, 100)).toBe(false);
    expect(aportaMrr('active', 'cancelada', 100)).toBe(false);
    expect(aportaMrr('active', null, null)).toBe(false);
    expect(aportaMrr('active', null, 0)).toBe(false);
  });
});

describe('calcularIngresos', () => {
  const filas = [
    fila('a', {}), // 1,598
    fila('b', { vertical: 'hoteles', plan: PLAN_HOTEL, sucursalesActivas: 15 }), // (15-5) x 89 = 890
    fila('c', { vertical: 'rentas', plan: PLAN_SIN_PRECIO }), // sin precio
    fila('d', { vertical: 'citas', plan: null }), // sin plan
    fila('e', { orgStatus: 'trial' }), // prueba: no cuenta
    fila('f', { orgStatus: 'suspended' }), // suspendida: no cuenta
    fila('g', {}, 20, { billingStatus: 'cancelada' }), // suscripcion cancelada: no cuenta
  ];
  const r = calcularIngresos(filas);

  it('MRR suma solo organizaciones activas con ingreso conocido y suscripcion no cancelada; ARR = MRR x 12', () => {
    expect(r.mrrMxn).toBe(2488);
    expect(r.arrMxn).toBe(29856);
    expect(r.clientesConIngreso).toBe(2);
  });
  it('las organizaciones activas sin precio o sin plan se cuentan aparte, nunca como 0 dentro del MRR', () => {
    expect(r.clientesSinPrecio).toBe(2);
    const rentas = r.porVertical.find((v) => v.vertical === 'rentas');
    expect(rentas).toEqual({ vertical: 'rentas', mrrMxn: 0, clientes: 0, sinPrecio: 1 });
  });
  it('desglosa por vertical (mayor primero) y por cliente con su participacion', () => {
    expect(r.porVertical.map((v) => [v.vertical, v.mrrMxn])).toEqual([['restaurantes', 1598], ['hoteles', 890], ['citas', 0], ['rentas', 0]]);
    expect(r.topClientes.map((c) => [c.nombre, c.mrrMxn, c.participacionPct])).toEqual([['Org a', 1598, 64.23], ['Org b', 890, 35.77]]);
    expect(r.concentracionTopPct).toBe(64.23);
  });
  it('sin organizaciones: ceros honestos y concentracion null', () => {
    const v = calcularIngresos([]);
    expect(v).toMatchObject({ mrrMxn: 0, arrMxn: 0, clientesConIngreso: 0, concentracionTopPct: null, topClientes: [] });
  });
});

describe('calcularNrr', () => {
  const s = (organizationId: string, mrrCentavos: number | null, parche: Partial<SnapshotMrr> = {}): SnapshotMrr => ({ organizationId, orgStatus: 'active', billingStatus: null, mrrCentavos, ...parche });

  it('sin foto del mes anterior: no disponible (no inventa 100 %)', () => {
    expect(calcularNrr(null, [s('a', 100)])).toEqual({ disponible: false, razon: 'sin_foto_previa' });
    expect(calcularNrr([], [s('a', 100)])).toEqual({ disponible: false, razon: 'sin_foto_previa' });
  });

  it('clasifica expansion, contraccion, churn y nuevo negocio', () => {
    const previo = [s('exp', 100_00), s('con', 200_00), s('chu', 300_00), s('igual', 400_00)];
    const actual = [s('exp', 150_00), s('con', 120_00), s('igual', 400_00), s('nuevo', 500_00)];
    // inicial 1,000; +50; -80; -300; final 670 => NRR 67 %, GRR 62 %
    const r = calcularNrr(previo, actual);
    expect(r).toEqual({
      disponible: true,
      mrrInicialMxn: 1000,
      expansionMxn: 50,
      contraccionMxn: 80,
      churnMxn: 300,
      nuevoMxn: 500,
      mrrFinalMxn: 1170,
      nrrPct: 67,
      grrPct: 62,
      excluidasSinDato: 0,
    });
  });

  it('suscripcion cancelada o suspension el mes actual cuenta como churn; una organizacion que ya no esta tambien', () => {
    const previo = [s('a', 100_00), s('b', 100_00), s('c', 100_00)];
    const actual = [s('a', 100_00, { billingStatus: 'cancelada' }), s('b', 100_00, { orgStatus: 'suspended' })];
    const r = calcularNrr(previo, actual);
    expect(r.disponible && r.churnMxn).toBe(300);
    expect(r.disponible && r.nrrPct).toBe(0);
  });

  it('si el ingreso actual de un cliente ya no se conoce (plan sin precio) se excluye: ni churn ni contraccion', () => {
    const r = calcularNrr([s('a', 100_00), s('b', 100_00)], [s('a', null), s('b', 100_00)]);
    expect(r).toMatchObject({ disponible: true, mrrInicialMxn: 100, churnMxn: 0, contraccionMxn: 0, nrrPct: 100, excluidasSinDato: 1 });
  });

  it('el mes anterior sin ningun cliente con MRR: porcentajes null, no division entre cero', () => {
    const r = calcularNrr([s('a', null)], [s('a', 100_00)]);
    expect(r).toMatchObject({ disponible: true, mrrInicialMxn: 0, nrrPct: null, grrPct: null, nuevoMxn: 100 });
  });
});

describe('evaluarAlertasCfo', () => {
  const pend = (dias: number) => AHORA - dias * 86_400_000;

  it('margen bajo el umbral: alerta con el dato; margen sano: ninguna', () => {
    // costo 70 USD x 20 = 1,400 MXN contra 1,598 => margen 12.4 %
    const bajo = fila('bajo', { costo: { llm: 70_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } });
    const sano = fila('sano', {});
    const a = evaluarAlertasCfo([bajo, sano], { ahoraMs: AHORA });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ codigo: 'margen_bajo', severidad: 'alta' });
    expect(a[0]!.organizaciones).toEqual([{ organizationId: 'bajo', nombre: 'Org bajo', dato: 'margen 12.4 % (umbral 30 %)' }]);
  });

  it('el umbral es configurable y exactamente en el umbral no alerta', () => {
    const f = fila('x', { costo: { llm: 70_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } });
    expect(evaluarAlertasCfo([f], { ahoraMs: AHORA, umbralMargenPct: 10 })).toEqual([]);
    expect(evaluarAlertasCfo([f], { ahoraMs: AHORA, umbralMargenPct: 15 })).toHaveLength(1);
  });

  it('margen negativo (cuesta mas de lo que cobra) tambien alerta, con su monto', () => {
    const neg = fila('neg', { costo: { llm: 100_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 }, llmCapMicroUsd: 900_000_000 }); // 2,000 MXN > 1,598
    const a = evaluarAlertasCfo([neg], { ahoraMs: AHORA });
    expect(a[0]!.codigo).toBe('margen_bajo');
    expect(a[0]!.organizaciones[0]!.dato).toBe('margen -25.2 % (umbral 30 %)');
  });

  it('sin tipo de cambio no hay margen calculable, asi que no se inventa una alerta de margen', () => {
    const f = fila('sin-fx', { costo: { llm: 900_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }, null);
    expect(evaluarAlertasCfo([f], { ahoraMs: AHORA })).toEqual([]);
  });

  it('voz sobre tope del plan: solo cuando EXCEDE el limite de minutos_voz_mes', () => {
    const limites = [{ metrica: 'minutos_voz_mes' as const, limite: 100, accion: 'avisar' as const }];
    const excede = fila('excede', { limites, minutosVoz: 130 });
    const aviso = fila('aviso', { limites, minutosVoz: 90 });
    const sinLimite = fila('sin-limite', { minutosVoz: 9999 });
    const a = evaluarAlertasCfo([excede, aviso, sinLimite], { ahoraMs: AHORA });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ codigo: 'voz_sobre_tope', severidad: 'media' });
    expect(a[0]!.organizaciones).toEqual([{ organizationId: 'excede', nombre: 'Org excede', dato: '130 min de voz sobre un tope de 100 min/mes' }]);
  });

  it('cobranza vencida: pago pendiente, con los dias de atraso si se conoce el fin de periodo', () => {
    const a = evaluarAlertasCfo([fila('p1', {}, 20, { billingStatus: 'pago_pendiente', periodEndMs: pend(9) }), fila('p2', { nombre: 'Zeta' }, 20, { billingStatus: 'pago_pendiente' }), fila('ok', {}, 20, { billingStatus: 'activa' })], { ahoraMs: AHORA });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ codigo: 'cobranza_vencida', severidad: 'alta' });
    expect(a[0]!.organizaciones.map((o) => o.dato)).toEqual(['pago pendiente, periodo vencido hace 9 dias', 'pago pendiente']);
  });

  it('cliente en riesgo: dos o mas senales; una sola senal no basta', () => {
    const dosSenales = fila('dos', { costo: { llm: 70_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }, 20, { billingStatus: 'pago_pendiente' });
    const una = fila('una', {}, 20, { billingStatus: 'pago_pendiente' });
    const a = evaluarAlertasCfo([dosSenales, una], { ahoraMs: AHORA });
    const riesgo = a.find((x) => x.codigo === 'cliente_en_riesgo');
    expect(riesgo?.severidad).toBe('critica');
    expect(riesgo?.organizaciones.map((o) => o.organizationId)).toEqual(['dos']);
    expect(riesgo?.organizaciones[0]!.dato).toBe('margen bajo + cobranza vencida');
    expect(a[0]!.codigo).toBe('cliente_en_riesgo'); // la mas grave primero
  });

  it('solo evalua organizaciones activas (prueba y suspendida no generan alertas)', () => {
    const malas = { costo: { llm: 100_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } };
    expect(evaluarAlertasCfo([fila('t', { orgStatus: 'trial', ...malas }, 20, { billingStatus: 'pago_pendiente' }), fila('s', { orgStatus: 'suspended', ...malas })], { ahoraMs: AHORA })).toEqual([]);
  });
});

describe('armarDashboardCfo', () => {
  const filas = [
    fila('a', {}), // margen 94.99 %
    fila('b', { vertical: 'hoteles', plan: PLAN_HOTEL, sucursalesActivas: 15 }),
    fila('c', { costo: { llm: 70_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }, 20, { billingStatus: 'pago_pendiente' }),
    fila('d', { vertical: 'rentas', plan: PLAN_SIN_PRECIO }),
  ];

  it('compone ingresos, margen, cobranza, caja sin datos y alertas', () => {
    const d = armarDashboardCfo({ mes: '2026-09', filas, mxnPorUsd: 20, snapshotsPrevios: null, snapshotsActuales: filas.map(snapshotDesdeFila), ahoraMs: AHORA });
    expect(d.ingresos.mrrMxn).toBe(1598 + 890 + 1598);
    expect(d.ingresos.clientesSinPrecio).toBe(1);
    expect(d.nrr).toEqual({ disponible: false, razon: 'sin_foto_previa' });
    expect(d.caja.disponible).toBe(false);
    expect(d.cobranza).toEqual({ pagoPendiente: 1, mrrEnRiesgoMxn: 1598 });
    expect(d.alertas.map((a) => a.codigo)).toEqual(['cliente_en_riesgo', 'margen_bajo', 'cobranza_vencida']);
    if (!d.margen.disponible) throw new Error('el margen debia estar disponible');
    expect(d.margen.clientesConMargen).toBe(3);
    expect(d.margen.clientesBajoUmbral).toBe(1);
    expect(d.margen.mejores.map((c) => c.organizationId)).toEqual(['a', 'b']);
    expect(d.margen.peores.map((c) => c.organizationId)).toEqual(['c']);
  });

  it('mejores y peores no se solapan, ni siquiera con pocas organizaciones', () => {
    const d = armarDashboardCfo({ mes: '2026-09', filas: filas.slice(0, 2), mxnPorUsd: 20, snapshotsPrevios: null, snapshotsActuales: [], ahoraMs: AHORA });
    if (!d.margen.disponible) throw new Error('margen');
    const ids = [...d.margen.mejores, ...d.margen.peores].map((c) => c.organizationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sin tipo de cambio el margen es no disponible (no se calcula con una constante)', () => {
    const sinFx = [fila('a', {}, null)];
    const d = armarDashboardCfo({ mes: '2026-09', filas: sinFx, mxnPorUsd: null, snapshotsPrevios: null, snapshotsActuales: [], ahoraMs: AHORA });
    expect(d.margen).toEqual({ disponible: false, razon: 'sin_tipo_de_cambio' });
    expect(d.ingresos.mrrMxn).toBe(1598); // el ingreso no depende del tipo de cambio
  });

  it('sin ninguna organizacion con ingreso conocido: margen no disponible por esa razon', () => {
    const d = armarDashboardCfo({ mes: '2026-09', filas: [filas[3]!], mxnPorUsd: 20, snapshotsPrevios: null, snapshotsActuales: [], ahoraMs: AHORA });
    expect(d.margen).toEqual({ disponible: false, razon: 'sin_ingreso_conocido' });
  });

  it('con foto del mes anterior calcula el NRR', () => {
    const previo: SnapshotMrr[] = [{ organizationId: 'a', orgStatus: 'active', billingStatus: null, mrrCentavos: 100_000 }];
    const d = armarDashboardCfo({ mes: '2026-09', filas: [filas[0]!], mxnPorUsd: 20, snapshotsPrevios: previo, snapshotsActuales: [snapshotDesdeFila(filas[0]!)], ahoraMs: AHORA });
    expect(d.nrr).toMatchObject({ disponible: true, mrrInicialMxn: 1000, expansionMxn: 598, nrrPct: 159.8 });
  });
});
