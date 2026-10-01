import { describe, it, expect } from 'vitest';
import {
  ContratoInvalidoError,
  diasDelMes,
  divRedondeada,
  estimarFacturacionMes,
  recurrenteMensual,
  validarTerminos,
  vigenciasSeTraslapan,
  type VersionContrato,
} from '../src/index.ts';

// Caso de referencia (cifras de ejemplo del modelo "base + por sucursal + bolsa + excedente"; NO son un contrato real).
function version(parche: Partial<VersionContrato> = {}): VersionContrato {
  return {
    contractId: 'c1',
    version: 1,
    vigenteDesde: '2026-01-01',
    vigenteHasta: null,
    baseCentavos: 590_000,
    porSucursalCentavos: 400_000,
    sucursalesIncluidas: 1,
    bolsaMinutos: 10_000,
    excedenteCentavosMinuto: 300,
    instalacionCentavos: 4_500_000,
    descuentoBp: 0,
    descuentoFijoCentavos: 0,
    ...parche,
  };
}

describe('aritmetica base', () => {
  it('dias del mes, incluido bisiesto', () => {
    expect(diasDelMes('2026-09')).toBe(30);
    expect(diasDelMes('2026-10')).toBe(31);
    expect(diasDelMes('2026-02')).toBe(28);
    expect(diasDelMes('2028-02')).toBe(29);
    expect(() => diasDelMes('2026-13')).toThrow(ContratoInvalidoError);
  });

  it('division entera mitad hacia arriba, sin flotantes', () => {
    expect(divRedondeada(1, 2)).toBe(1);
    expect(divRedondeada(1, 3)).toBe(0);
    expect(divRedondeada(2, 3)).toBe(1);
    expect(divRedondeada(5, 10)).toBe(1);
    expect(divRedondeada(4, 10)).toBe(0);
    expect(() => divRedondeada(-1, 2)).toThrow(ContratoInvalidoError);
    expect(() => divRedondeada(1, 0)).toThrow(ContratoInvalidoError);
  });
});

describe('recurrenteMensual', () => {
  it('base + sucursales por encima de las incluidas', () => {
    const r = recurrenteMensual(version(), 3);
    expect(r.sucursalesExtra).toBe(2);
    expect(r.brutoMensualCentavos).toBe(590_000 + 2 * 400_000);
    expect(r.mensualCentavos).toBe(1_390_000);
  });

  it('con menos sucursales que las incluidas no resta ni cobra extra', () => {
    expect(recurrenteMensual(version({ sucursalesIncluidas: 5 }), 3).mensualCentavos).toBe(590_000);
    expect(recurrenteMensual(version(), 0).sucursalesExtra).toBe(0);
  });

  it('descuento porcentual y luego fijo, con redondeo entero', () => {
    const r = recurrenteMensual(version({ descuentoBp: 1_000, descuentoFijoCentavos: 5_000 }), 3);
    expect(r.descuentoPorcentualCentavos).toBe(139_000);
    expect(r.descuentoFijoCentavos).toBe(5_000);
    expect(r.mensualCentavos).toBe(1_390_000 - 139_000 - 5_000);
    // 333 bp sobre 1,390,000 = 46,287 exactos? 1,390,000 * 333 / 10,000 = 46,287
    expect(recurrenteMensual(version({ descuentoBp: 333 }), 3).descuentoPorcentualCentavos).toBe(46_287);
  });

  it('el descuento nunca deja el recurrente por debajo de cero', () => {
    expect(recurrenteMensual(version({ descuentoBp: 10_000 }), 3).mensualCentavos).toBe(0);
    const grande = recurrenteMensual(version({ descuentoBp: 5_000, descuentoFijoCentavos: 99_000_000 }), 3);
    expect(grande.mensualCentavos).toBe(0);
    expect(grande.descuentoFijoCentavos).toBe(1_390_000 - 695_000);
  });

  it('rechaza sucursales no enteras', () => {
    expect(() => recurrenteMensual(version(), 1.5)).toThrow(ContratoInvalidoError);
  });
});

describe('validarTerminos', () => {
  const ok = { ...version() } as Partial<VersionContrato>;
  const terminos = () => {
    const { contractId: _c, version: _v, ...t } = { ...version(), ...ok };
    return t;
  };

  it('acepta un contrato coherente', () => {
    expect(() => validarTerminos(terminos())).not.toThrow();
  });

  it('rechaza flotantes, negativos, bp fuera de rango y fechas imposibles', () => {
    expect(() => validarTerminos({ ...terminos(), baseCentavos: 10.5 })).toThrow(ContratoInvalidoError);
    expect(() => validarTerminos({ ...terminos(), baseCentavos: -1 })).toThrow(ContratoInvalidoError);
    expect(() => validarTerminos({ ...terminos(), descuentoBp: 10_001 })).toThrow(ContratoInvalidoError);
    expect(() => validarTerminos({ ...terminos(), vigenteDesde: '2026-02-30' })).toThrow(ContratoInvalidoError);
    expect(() => validarTerminos({ ...terminos(), vigenteDesde: '2026-05-10', vigenteHasta: '2026-05-09' })).toThrow(ContratoInvalidoError);
  });
});

describe('vigenciasSeTraslapan', () => {
  it('rangos inclusivos: contiguos NO se traslapan, un dia en comun SI', () => {
    expect(vigenciasSeTraslapan({ desde: '2026-01-01', hasta: '2026-06-30' }, { desde: '2026-07-01', hasta: null })).toBe(false);
    expect(vigenciasSeTraslapan({ desde: '2026-01-01', hasta: '2026-07-01' }, { desde: '2026-07-01', hasta: null })).toBe(true);
  });

  it('un contrato sin fin choca con cualquiera posterior y con uno anterior que lo alcance', () => {
    expect(vigenciasSeTraslapan({ desde: '2026-01-01', hasta: null }, { desde: '2030-01-01', hasta: '2030-02-01' })).toBe(true);
    expect(vigenciasSeTraslapan({ desde: '2026-03-01', hasta: null }, { desde: '2025-01-01', hasta: '2026-02-28' })).toBe(false);
  });

  it('un rango contenido en otro se traslapa', () => {
    expect(vigenciasSeTraslapan({ desde: '2026-01-01', hasta: '2026-12-31' }, { desde: '2026-05-01', hasta: '2026-05-02' })).toBe(true);
  });
});

describe('estimarFacturacionMes -- mes completo', () => {
  it('recurrente + excedente de minutos sobre la bolsa', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version()], sucursalesActivas: 3, minutosVoz: 10_500 });
    expect(e.estado).toBe('estimado');
    expect(e.recurrenteCentavos).toBe(1_390_000);
    expect(e.bolsaMinutos).toBe(10_000);
    expect(e.minutosExcedentes).toBe(500);
    expect(e.excedenteCentavos).toBe(150_000);
    expect(e.totalCentavos).toBe(1_540_000);
    expect(e.razonTotal).toBeNull();
    expect(e.segmentos).toHaveLength(1);
    expect(e.segmentos[0]?.dias).toBe(30);
    expect(Number.isInteger(e.totalCentavos)).toBe(true);
  });

  it('dentro de la bolsa no hay excedente', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version()], sucursalesActivas: 3, minutosVoz: 9_999 });
    expect(e.minutosExcedentes).toBe(0);
    expect(e.excedenteCentavos).toBe(0);
    expect(e.totalCentavos).toBe(1_390_000);
  });

  it('sin minutos medidos el total es null con su razon (no inventa un cero)', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version()], sucursalesActivas: 3, minutosVoz: null });
    expect(e.recurrenteCentavos).toBe(1_390_000);
    expect(e.excedenteCentavos).toBeNull();
    expect(e.totalCentavos).toBeNull();
    expect(e.razonTotal).toMatch(/minutos/);
  });

  it('con descuentos el total los refleja', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version({ descuentoBp: 1_000 })], sucursalesActivas: 3, minutosVoz: 0 });
    expect(e.recurrenteCentavos).toBe(1_251_000);
    expect(e.totalCentavos).toBe(1_251_000);
  });
});

describe('estimarFacturacionMes -- sin contrato / vigencias', () => {
  it('sin versiones: sin_contrato y todo null', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [], sucursalesActivas: 3, minutosVoz: 100 });
    expect(e.estado).toBe('sin_contrato');
    expect(e.recurrenteCentavos).toBeNull();
    expect(e.totalCentavos).toBeNull();
    expect(e.segmentos).toEqual([]);
  });

  it('contrato que empieza despues del mes o termino antes: sin_contrato', () => {
    expect(estimarFacturacionMes({ mes: '2026-09', versiones: [version({ vigenteDesde: '2026-10-01' })], sucursalesActivas: 1, minutosVoz: 0 }).estado).toBe('sin_contrato');
    expect(estimarFacturacionMes({ mes: '2026-09', versiones: [version({ vigenteHasta: '2026-08-31' })], sucursalesActivas: 1, minutosVoz: 0 }).estado).toBe('sin_contrato');
  });

  it('alta a mitad de mes: solo se factura la parte vigente (21 de 30 dias -> 10 dias)', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version({ vigenteDesde: '2026-09-21', baseCentavos: 300_000, porSucursalCentavos: 0 })], sucursalesActivas: 1, minutosVoz: 0 });
    expect(e.segmentos[0]).toMatchObject({ desde: '2026-09-21', hasta: '2026-09-30', dias: 10, mensualCentavos: 300_000, proporcionalCentavos: 100_000 });
    expect(e.recurrenteCentavos).toBe(100_000);
  });

  it('baja a mitad de mes (vigenteHasta inclusivo)', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version({ vigenteHasta: '2026-09-10', baseCentavos: 300_000, porSucursalCentavos: 0 })], sucursalesActivas: 1, minutosVoz: 0 });
    expect(e.segmentos[0]).toMatchObject({ desde: '2026-09-01', hasta: '2026-09-10', dias: 10 });
    expect(e.recurrenteCentavos).toBe(100_000);
  });

  it('dos contratos consecutivos sin hueco ni traslape suman el mes completo', () => {
    const a = version({ contractId: 'a', vigenteHasta: '2026-09-15', baseCentavos: 300_000, porSucursalCentavos: 0 });
    const b = version({ contractId: 'b', vigenteDesde: '2026-09-16', baseCentavos: 600_000, porSucursalCentavos: 0 });
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [b, a], sucursalesActivas: 1, minutosVoz: 0 });
    expect(e.segmentos.map((s) => s.dias)).toEqual([15, 15]);
    expect(e.recurrenteCentavos).toBe(150_000 + 300_000);
  });

  it('dos contratos traslapados dentro del mes se rechazan (nunca se cobra doble)', () => {
    const a = version({ contractId: 'a', vigenteHasta: '2026-09-16', baseCentavos: 300_000 });
    const b = version({ contractId: 'b', vigenteDesde: '2026-09-16', baseCentavos: 600_000 });
    expect(() => estimarFacturacionMes({ mes: '2026-09', versiones: [a, b], sucursalesActivas: 1, minutosVoz: 0 })).toThrow(/traslapadas/);
  });

  it('un traslape fuera del mes consultado no afecta ese mes', () => {
    const a = version({ contractId: 'a', vigenteHasta: '2026-12-31' });
    const b = version({ contractId: 'b', vigenteDesde: '2026-12-01' });
    expect(() => estimarFacturacionMes({ mes: '2026-09', versiones: [a, b], sucursalesActivas: 1, minutosVoz: 0 })).not.toThrow();
    expect(() => estimarFacturacionMes({ mes: '2026-12', versiones: [a, b], sucursalesActivas: 1, minutosVoz: 0 })).toThrow(/traslapadas/);
  });

  it('versiones de un mismo contrato con vigenteDesde no creciente se rechazan', () => {
    const v1 = version({ version: 1, vigenteDesde: '2026-09-10' });
    const v2 = version({ version: 2, vigenteDesde: '2026-09-10' });
    expect(() => estimarFacturacionMes({ mes: '2026-09', versiones: [v1, v2], sucursalesActivas: 1, minutosVoz: 0 })).toThrow(/estrictamente creciente/);
  });
});

describe('estimarFacturacionMes -- cambio a mitad de mes', () => {
  const v1 = version({ version: 1, baseCentavos: 100_000, porSucursalCentavos: 0, bolsaMinutos: 3_000, excedenteCentavosMinuto: 200 });
  const v2 = version({ version: 2, vigenteDesde: '2026-09-16', baseCentavos: 200_000, porSucursalCentavos: 0, bolsaMinutos: 6_000, excedenteCentavosMinuto: 500 });

  it('prorratea cada version por sus dias vigentes (15 + 15 de 30)', () => {
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [v2, v1], sucursalesActivas: 1, minutosVoz: 4_600 });
    expect(e.segmentos.map((s) => [s.version, s.desde, s.hasta, s.dias, s.proporcionalCentavos])).toEqual([
      [1, '2026-09-01', '2026-09-15', 15, 50_000],
      [2, '2026-09-16', '2026-09-30', 15, 100_000],
    ]);
    expect(e.recurrenteCentavos).toBe(150_000);
    // Bolsa prorrateada: (3000*15 + 6000*15) / 30 = 4500; excedente a la tarifa de la ULTIMA version (500).
    expect(e.bolsaMinutos).toBe(4_500);
    expect(e.minutosExcedentes).toBe(100);
    expect(e.tarifaExcedenteCentavosMinuto).toBe(500);
    expect(e.excedenteCentavos).toBe(50_000);
    expect(e.totalCentavos).toBe(200_000);
  });

  it('el cambio el ultimo dia del mes solo pesa 1 dia', () => {
    const tarde = version({ version: 2, vigenteDesde: '2026-09-30', baseCentavos: 300_000, porSucursalCentavos: 0 });
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [v1, tarde], sucursalesActivas: 1, minutosVoz: 0 });
    expect(e.segmentos.map((s) => s.dias)).toEqual([29, 1]);
    expect(e.recurrenteCentavos).toBe(Math.round((100_000 * 29 + 300_000 * 1) / 30));
  });

  it('el cambio el dia 1 deja la version anterior fuera del mes', () => {
    const primero = version({ version: 2, vigenteDesde: '2026-09-01', baseCentavos: 200_000, porSucursalCentavos: 0 });
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [version({ version: 1, vigenteDesde: '2026-01-01', baseCentavos: 100_000, porSucursalCentavos: 0 }), primero], sucursalesActivas: 1, minutosVoz: 0 });
    expect(e.segmentos).toHaveLength(1);
    expect(e.segmentos[0]?.version).toBe(2);
    expect(e.recurrenteCentavos).toBe(200_000);
  });

  it('invariante: la suma de las partes es exactamente el total y se desvia del exacto menos de 1 centavo', () => {
    for (const mes of ['2026-02', '2026-09', '2026-10', '2028-02']) {
      for (const corte of ['01', '05', '11', '17', '28']) {
        for (const base2 of [100_001, 333_333, 999_999]) {
          const a = version({ version: 1, vigenteDesde: '2026-01-01', baseCentavos: 100_003, porSucursalCentavos: 0 });
          const b = version({ version: 2, vigenteDesde: `${mes}-${corte}`, baseCentavos: base2, porSucursalCentavos: 0 });
          const e = estimarFacturacionMes({ mes, versiones: [a, b], sucursalesActivas: 1, minutosVoz: 0 });
          const suma = e.segmentos.reduce((s, x) => s + x.proporcionalCentavos, 0);
          expect(suma).toBe(e.recurrenteCentavos);
          const exactoNum = e.segmentos.reduce((s, x) => s + x.mensualCentavos * x.dias, 0);
          expect(Math.abs((e.recurrenteCentavos as number) * e.diasDelMes - exactoNum)).toBeLessThanOrEqual(e.diasDelMes / 2);
          for (const x of e.segmentos) expect(Number.isInteger(x.proporcionalCentavos)).toBe(true);
        }
      }
    }
  });

  it('el cambio de sucursales incluidas a mitad de mes aplica a cada tramo con la cuenta de hoy', () => {
    const a = version({ version: 1, baseCentavos: 0, porSucursalCentavos: 100_000, sucursalesIncluidas: 0 });
    const b = version({ version: 2, vigenteDesde: '2026-09-16', baseCentavos: 0, porSucursalCentavos: 100_000, sucursalesIncluidas: 2 });
    const e = estimarFacturacionMes({ mes: '2026-09', versiones: [a, b], sucursalesActivas: 3, minutosVoz: 0 });
    expect(e.segmentos.map((s) => s.mensualCentavos)).toEqual([300_000, 100_000]);
    expect(e.recurrenteCentavos).toBe(200_000);
  });
});

describe('estimarFacturacionMes -- entradas invalidas', () => {
  it('mes mal formado y minutos no enteros', () => {
    expect(() => estimarFacturacionMes({ mes: '2026-9', versiones: [], sucursalesActivas: 1, minutosVoz: 0 })).toThrow(ContratoInvalidoError);
    expect(() => estimarFacturacionMes({ mes: '2026-09', versiones: [version()], sucursalesActivas: 1, minutosVoz: 1.5 })).toThrow(ContratoInvalidoError);
  });

  it('el resultado nunca contiene un flotante en dinero', () => {
    const e = estimarFacturacionMes({ mes: '2026-10', versiones: [version({ baseCentavos: 333_333, descuentoBp: 777 }), version({ version: 2, vigenteDesde: '2026-10-13', baseCentavos: 777_777 })], sucursalesActivas: 4, minutosVoz: 12_345 });
    for (const n of [e.recurrenteCentavos, e.excedenteCentavos, e.totalCentavos, ...e.segmentos.flatMap((s) => [s.brutoMensualCentavos, s.mensualCentavos, s.proporcionalCentavos])]) {
      expect(Number.isSafeInteger(n)).toBe(true);
    }
  });
});
