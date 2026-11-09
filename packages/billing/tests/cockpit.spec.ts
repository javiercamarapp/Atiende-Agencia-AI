import { describe, expect, it } from 'vitest';
import { calcularFilaCostoMargen, cockpit, type EntradaCostoMargen, type FilaCfo } from '../src/index.ts';

const { resolverSupuestos, unitarioDe, calcularEconomia, excedenteCentavos, porVertical, porPlan, compararClientes, variacion, serieMrr, cohortes, calcularMetricasSaas, evaluarAlertasCockpit } = cockpit;
type UsoMes = cockpit.UsoMes;
type FotosDelMes = cockpit.FotosDelMes;

const FX = 18.6297;

function filaCfo(id: string, parche: Partial<EntradaCostoMargen> = {}, billingStatus: string | null = 'activa'): FilaCfo {
  const entrada: EntradaCostoMargen = {
    organizationId: id,
    nombre: `Org ${id}`,
    slug: `org-${id}`,
    vertical: 'restaurantes',
    orgStatus: 'active',
    plan: { id: 'rest', nombre: 'Restaurantes', precioBaseCentavos: 300000, precioAsientoCentavos: null, asientosIncluidos: 0 },
    limites: [],
    billingStatus,
    billingSeats: null,
    sucursalesActivas: 1,
    costo: { llm: 0, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 },
    eventosTotal: 0,
    eventosEstimados: 0,
    minutosVoz: 0,
    mensajes: 0,
    llmCapMicroUsd: 100_000_000,
    llmAlertPct: 80,
    ...parche,
  };
  return { fila: calcularFilaCostoMargen(entrada, { mxnPorUsd: FX }), billingStatus, billingPeriodEndMs: null };
}

function uso(id: string, parche: Partial<UsoMes> = {}): UsoMes {
  return {
    organizationId: id,
    mes: '2026-11-01',
    vertical: 'restaurantes',
    llmMicroUsd: 0,
    eventosMicroUsd: 0,
    llamadas: 0,
    segundosVoz: 0,
    segundosPorProveedor: {},
    pedidos: 0,
    pedidosVoz: 0,
    pedidosWhatsapp: 0,
    conversacionesWa: 0,
    minutosFacturables: null,
    plan: null,
    ...parche,
  };
}

const S = resolverSupuestos([]);
const base = { supuestos: S, mxnPorUsd: FX, infraCentavos: null, diasTranscurridos: 30, diasDelMes: 30, diasMesPrevio: 31, usoPrevio: [] as UsoMes[], sucursalesPorOrg: new Map<string, number>() };

describe('supuestos', () => {
  it('trae los valores medidos y lo capturado los sobrescribe por proveedor', () => {
    expect(unitarioDe(S.vozUsdMinuto, 'elevenlabs-agents')).toMatchObject({ valor: 0.045, origen: 'medido' });
    expect(unitarioDe(S.vozUsdMinuto, 'gpt-live-1')).toBeNull();
    expect(S.llmUsdConversacionWa).toMatchObject({ valor: 0.0192, origen: 'medido' });
    expect(S.whatsappUsdConversacion).toBeNull();
    const s2 = resolverSupuestos([
      { clave: 'voz_usd_minuto', proveedor: '*', valor: 0.06, fuente: 'factura' },
      { clave: 'umbral_margen_pct', proveedor: '*', valor: 45, fuente: 'dueño' },
    ]);
    expect(unitarioDe(s2.vozUsdMinuto, 'gpt-live-1')).toMatchObject({ valor: 0.06, origen: 'capturado' });
    expect(unitarioDe(s2.vozUsdMinuto, 'elevenlabs-agents')?.valor).toBe(0.045);
    expect(s2.umbralMargenPct.valor).toBe(45);
  });
});

describe('economia por cliente', () => {
  it('modela la voz por proveedor cuando no hay costo medido y calcula la duracion promedio', () => {
    const [f] = calcularEconomia({ ...base, filas: [filaCfo('a')], uso: [uso('a', { llamadas: 2, segundosVoz: 360, segundosPorProveedor: { 'elevenlabs-agents': 360 } })] });
    expect(f!.costo.voz).toEqual({ usd: 0.27, fuente: 'modelado' }); // 6 min x 0.045
    expect(f!.uso).toMatchObject({ llamadas: 2, minutosVoz: 6, duracionPromedioMin: 3 });
    expect(f!.costoDirectoMxn).toBe(5.03); // 0.27 x 18.6297
    expect(f!.ingresoMxn).toBe(3000);
    expect(f!.contribucionMxn).toBe(2994.97);
    expect(f!.margenBrutoMxn).toBeNull(); // sin infraestructura capturada
  });

  it('un proveedor de voz sin costo unitario deja el costo SIN DATO (nunca 0)', () => {
    const [f] = calcularEconomia({ ...base, filas: [filaCfo('a')], uso: [uso('a', { llamadas: 1, segundosVoz: 60, segundosPorProveedor: { 'gpt-live-1': 60 } })] });
    expect(f!.costo.voz).toEqual({ usd: null, fuente: 'sin_dato' });
    expect(f!.costoDirectoMxn).toBeNull();
    expect(f!.contribucionMxn).toBeNull();
    expect(f!.avisos.join(' ')).toMatch(/sin costo por minuto/);
  });

  it('el costo medido gana al modelado; LLM se modela por conversacion; Meta sin tarifa cuenta 0 con aviso', () => {
    const [f] = calcularEconomia({
      ...base,
      filas: [filaCfo('a', { costo: { llm: 0, voz: 500_000, whatsapp: 0, telefonia: 0, otros: 0 } })],
      uso: [uso('a', { segundosPorProveedor: { 'elevenlabs-agents': 6000 }, conversacionesWa: 100 })],
    });
    expect(f!.costo.voz).toEqual({ usd: 0.5, fuente: 'medido' });
    expect(f!.costo.llm).toEqual({ usd: 1.92, fuente: 'modelado' });
    expect(f!.costo.whatsapp.fuente).toBe('no_configurado');
    expect(f!.avisos.join(' ')).toMatch(/Meta/);
  });

  it('reparte la infraestructura en proporcion al costo directo y calcula margen bruto', () => {
    const filas = calcularEconomia({
      ...base,
      infraCentavos: 111800,
      filas: [filaCfo('a', { costo: { llm: 3_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), filaCfo('b', { costo: { llm: 1_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } })],
      uso: [uso('a'), uso('b')],
    });
    expect(filas.map((f) => f.infraMxn)).toEqual([838.5, 279.5]);
    expect(filas[0]!.margenBrutoMxn).toBe(round(3000 - 3 * FX - 838.5));
  });

  it('plan medido: MRR por sucursal, pool, excedente con tope de uso justo y proyeccion al cierre', () => {
    const plan = {
      modelo_cobro: 'medido',
      precio_base_mxn_centavos: 100000,
      precio_sucursal_mxn_centavos: 150000,
      sucursales_incluidas: 1,
      minutos_voz_incluidos: 0,
      minutos_voz_incluidos_por_sucursal: 500,
      precio_minuto_voz_excedente_mxn_centavos: 300,
      conversaciones_wa_incluidas: 1000,
      conversaciones_wa_incluidas_por_sucursal: 0,
      precio_conversacion_wa_excedente_mxn_centavos: null,
      uso_justo_pct: 150,
    };
    const [f] = calcularEconomia({
      ...base,
      diasTranscurridos: 15,
      sucursalesPorOrg: new Map([['a', 2]]),
      filas: [filaCfo('a')],
      uso: [uso('a', { plan, minutosFacturables: 900, conversacionesWa: 600, segundosPorProveedor: { 'elevenlabs-agents': 54000 }, segundosVoz: 54000, llamadas: 300 })],
    });
    expect(f!.modeloCobro).toBe('medido');
    expect(f!.mrrMxn).toBe(2500); // 1,000 + (2-1) x 1,500
    expect(f!.excedenteMxn).toBe(0); // 900 de 1,000 minutos incluidos
    expect(f!.poolVoz).toEqual({ incluido: 1000, usado: 900, pct: 90, pctProyectado: 180 });
    expect(f!.poolWa).toMatchObject({ pct: 60, pctProyectado: 120 });
    // Proyectado: 1,800 min -> excedente topado en 1,500 (uso justo 150 %) -> 500 x 3 MXN = 1,500
    expect(f!.proyeccion.ingresoMxn).toBe(4000);
    expect(f!.banderas).toContain('cerca_del_tope');
    expect(excedenteCentavos(2000, 1000, 300, null)).toBe(300000);
    expect(excedenteCentavos(2000, 1000, null, null)).toBe(0);
  });

  it('banderas: no rentable, pago fallido, pico de costo y anomalia de uso; una prueba no aporta ingreso', () => {
    const filas = calcularEconomia({
      ...base,
      diasTranscurridos: 10,
      filas: [
        filaCfo('caro', { costo: { llm: 200_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }, 'pago_pendiente'),
        filaCfo('prueba', { orgStatus: 'trial' }),
      ],
      uso: [uso('caro', { llmMicroUsd: 200_000_000, llamadas: 100 }), uso('prueba')],
      usoPrevio: [uso('caro', { llmMicroUsd: 31_000_000, llamadas: 31 })],
    });
    expect(filas[0]!.banderas).toEqual(expect.arrayContaining(['no_rentable', 'pago_fallido', 'pico_costo', 'anomalia_uso']));
    expect(filas[1]!.ingresoMxn).toBe(0);
    expect(filas[1]!.aportaMrr).toBe(false);
  });
});

describe('comparativos', () => {
  it('agrega por vertical y por plan solo con clientes comparables; cliente contra cliente respeta el orden', () => {
    const filas = calcularEconomia({
      ...base,
      filas: [filaCfo('a'), filaCfo('b', { vertical: 'hoteles' }), filaCfo('c', { plan: null })],
      uso: [uso('a', { llamadas: 4, segundosVoz: 720, segundosPorProveedor: { 'elevenlabs-agents': 720 } }), uso('b', { vertical: 'hoteles', llamadas: null, segundosVoz: null, segundosPorProveedor: null }), uso('c')],
    });
    const v = porVertical(filas);
    expect(v.find((x) => x.clave === 'restaurantes')).toMatchObject({ clientes: 2, clientesConMargen: 1, llamadas: 4, duracionPromedioMin: 3 });
    expect(porPlan(filas).map((p) => p.clave).sort()).toEqual(['Restaurantes', 'sin plan']);
    expect(compararClientes(filas, ['c', 'x', 'a']).map((f) => f.organizationId)).toEqual(['c', 'a']);
    expect(variacion(120, 100)).toEqual({ actual: 120, previo: 100, delta: 20, deltaPct: 20 });
    expect(variacion(null, 100).delta).toBeNull();
  });
});

function foto(id: string, mrr: number | null, orgStatus = 'active', vertical = 'restaurantes') {
  return { organizationId: id, orgStatus, billingStatus: 'activa', mrrCentavos: mrr, vertical, planId: 'p' };
}

const HISTORIA: FotosDelMes[] = [
  { mes: '2026-08', fotos: [foto('a', 100000), foto('b', 100000)] },
  { mes: '2026-09', fotos: [foto('a', 150000), foto('b', 100000), foto('c', 50000)] },
  { mes: '2026-10', fotos: [foto('a', 150000), foto('b', null, 'suspended'), foto('c', 40000)] },
];

describe('metricas SaaS', () => {
  it('puente de MRR, NRR/GRR y churn de logos', () => {
    const s = serieMrr(HISTORIA);
    expect(s[0]).toMatchObject({ mrrMxn: 2000, clientes: 2, nrrPct: null });
    expect(s[1]).toMatchObject({ mrrMxn: 3000, nuevoMxn: 500, expansionMxn: 500, nrrPct: 125, clientesNuevos: 1, churnLogosPct: 0 });
    expect(s[2]).toMatchObject({ mrrMxn: 1900, churnMxn: 1000, contraccionMxn: 100, clientesPerdidos: 1, arpaMxn: 950 });
    expect(s[2]!.churnLogosPct).toBe(33.33);
  });

  it('cohortes por mes de alta con retencion de logos y de MRR', () => {
    const c = cohortes(HISTORIA);
    expect(c[0]).toMatchObject({ cohorte: '2026-08', clientesIniciales: 2, mrrInicialMxn: 2000 });
    expect(c[0]!.meses.map((m) => m.logosPct)).toEqual([100, 100, 50]);
    expect(c[0]!.meses[1]!.mrrPct).toBe(125);
    expect(c[1]).toMatchObject({ cohorte: '2026-09', clientesIniciales: 1 });
  });

  it('LTV con churn medido, CAC/payback con marketing capturado, burn, runway, FX y presupuesto', () => {
    const economia = calcularEconomia({
      ...base,
      infraCentavos: 0,
      filas: [filaCfo('a', { costo: { llm: 10_000_000, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 } }), filaCfo('c', { plan: { id: 'x', nombre: 'X', precioBaseCentavos: 40000, precioAsientoCentavos: null, asientosIncluidos: 0 } })],
      uso: [uso('a'), uso('c')],
    });
    const m = calcularMetricasSaas({
      mes: '2026-10',
      historia: HISTORIA,
      economia,
      capturas: [
        { mes: '2026-09-01', tipo: 'marketing', montoMxnCentavos: 300000 },
        { mes: '2026-10-01', tipo: 'gasto_fijo', montoMxnCentavos: 5000000 },
        { mes: '2026-10-01', tipo: 'saldo_caja', montoMxnCentavos: 20000000 },
        { mes: '2026-10-01', tipo: 'presupuesto_ingreso', montoMxnCentavos: 250000 },
      ],
      ltvMesesTope: 36,
      enCurso: false,
      fx: { mxnPorUsd: FX, fecha: '2026-11-06', fuente: 'Banxico FIX' },
      fxHace30d: 18,
      costoRealPorMes: new Map([['2026-10', 186.3]]),
    });
    expect(m).toMatchObject({ mrrMxn: 1900, arrMxn: 22800, clientes: 2 });
    expect(m.ltv).toMatchObject({ disponible: true, churnMensualPct: 16.67, vidaTopada: false, vidaMeses: 6 });
    expect(m.cac).toMatchObject({ disponible: true, marketingMxn: 3000, clientesNuevos: 1, cacMxn: 3000 });
    expect(m.burn).toMatchObject({ disponible: true, gastoFijoMxn: 50000, saldoCajaMxn: 200000, saldoCajaMes: '2026-10' });
    if (m.burn.disponible) expect(m.burn.runwayMeses).toBe(round(200000 / m.burn.burnNetoMxn));
    expect(m.fx).toMatchObject({ disponible: true, costoUsd: 10, costoUsdEnMxn: 186.3, movimiento30dPct: 3.5, sensibilidad10PctMxn: 18.63 });
    expect(m.concentracion.top1Pct).toBe(88.24);
    expect(m.presupuesto).toEqual([{ mes: '2026-10', ingresoPresupuestoMxn: 2500, ingresoRealMxn: 1900, costoPresupuestoMxn: null, costoRealMxn: 186.3 }]);
  });

  it('sin marketing capturado el CAC no esta disponible; sin tipo de cambio no hay burn ni FX', () => {
    const economia = calcularEconomia({ ...base, mxnPorUsd: null, filas: [filaCfo('a')], uso: [uso('a')] });
    const m = calcularMetricasSaas({ mes: '2026-10', historia: HISTORIA, economia, capturas: [], ltvMesesTope: 36, enCurso: true, fx: null, fxHace30d: null, costoRealPorMes: new Map() });
    expect(m.cac.disponible).toBe(false);
    expect(m.burn.disponible).toBe(false);
    expect(m.fx.disponible).toBe(false);
  });
});

describe('alertas del cockpit', () => {
  it('pool excedido, pico de costo y movimiento del dolar; nada si no se cruza el umbral', () => {
    const plan = { modelo_cobro: 'medido', precio_base_mxn_centavos: 100000, minutos_voz_incluidos: 100, precio_minuto_voz_excedente_mxn_centavos: 300 };
    const economia = calcularEconomia({ ...base, filas: [filaCfo('a')], uso: [uso('a', { plan, minutosFacturables: 150 })] });
    const alertas = evaluarAlertasCockpit({ economia, movimientoFxPct: 4.2, umbralFxPct: 3, umbralPicoCostoPct: 50 });
    expect(alertas.map((a) => a.codigo)).toEqual(['pool_excedido', 'movimiento_fx']);
    expect(alertas[0]!.organizaciones[0]!.dato).toMatch(/voz 150 % de 100 min/);
    expect(evaluarAlertasCockpit({ economia: [], movimientoFxPct: 1, umbralFxPct: 3, umbralPicoCostoPct: 50 })).toEqual([]);
  });
});

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
