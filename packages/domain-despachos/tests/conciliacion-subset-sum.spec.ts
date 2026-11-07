// D-P3-10 / D-P3-11 -- nivel 3 (N-a-1) en centavos enteros, todas las combinaciones, ambigüedad, techo, presupuesto y dirección. Referencia del
// origen: S/tests/services/test_subset_sum_*.py y tests/adversarial/test_pass_group_{ambiguedad_nunca_autoaplica,nunca_inventa_match}.py.
import { describe, expect, it } from "vitest";
import { conciliarMovimientos } from "../src/conciliacion/matching-engine.ts";
import { aCentavos, buscarSubconjuntos, MITM_UMBRAL } from "../src/conciliacion/subset-sum.ts";
import { calcularPropuestas } from "../src/conciliacion/persistida/reglas.ts";
import type { MovimientoGuardado } from "../src/conciliacion/persistida/types.ts";
import type { MovimientoBancario, RegistroConciliable } from "../src/conciliacion/types.ts";

const mov = (monto: number, fecha = "2025-03-10", descripcion = "DEPOSITO"): MovimientoBancario => ({
  fecha,
  descripcion,
  referencia: null,
  cargo: monto < 0 ? -monto : null,
  abono: monto > 0 ? monto : null,
  saldo: null,
  monto,
  banco: "generic",
  formato: "csv",
});
const reg = (id: string, total: number, extra: Partial<RegistroConciliable> = {}): RegistroConciliable => ({ id, fecha: "2025-03-10", total, descripcion: `cfdi ${id}`, ...extra });
const items = (...centavos: number[]) => centavos.map((c, i) => ({ id: i, centavos: c }));

describe("aCentavos", () => {
  it("no arrastra el error binario del flotante", () => {
    expect(aCentavos(19.99)).toBe(1999);
    expect(aCentavos(0.1 + 0.2)).toBe(30);
    expect(aCentavos(1234.5)).toBe(123450);
    expect(aCentavos(1.005)).toBe(101);
  });
});

describe("buscarSubconjuntos", () => {
  it("encuentra la combinación exacta", () => {
    const r = buscarSubconjuntos(items(10000, 20000, 30000, 50000), 60000, 60000);
    expect(r).toEqual({ estado: "ok", combinaciones: [[0, 3], [0, 1, 2]], truncado: false });
  });

  it("devuelve TODAS las combinaciones cuando hay ambigüedad (100+200 y 150+150)", () => {
    const r = buscarSubconjuntos(items(10000, 20000, 15000, 15000), 30000, 30000);
    expect(r.estado).toBe("ok");
    if (r.estado !== "ok") return;
    expect(r.combinaciones).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("nunca inventa: sin combinación devuelve vacío", () => {
    const r = buscarSubconjuntos(items(10000, 20000, 30000), 12345, 12345);
    expect(r).toEqual({ estado: "ok", combinaciones: [], truncado: false });
  });

  it("respeta la tolerancia en centavos y el tamaño mínimo 2", () => {
    expect(buscarSubconjuntos(items(10000, 20001), 30000, 30000)).toEqual({ estado: "ok", combinaciones: [], truncado: false });
    expect(buscarSubconjuntos(items(10000, 20001), 29999, 30001)).toEqual({ estado: "ok", combinaciones: [[0, 1]], truncado: false });
    // un solo registro que iguala el monto NO es un N-a-1 (eso ya lo cubre el cruce 1 a 1)
    expect(buscarSubconjuntos(items(30000, 5), 30000, 30000)).toEqual({ estado: "ok", combinaciones: [], truncado: false });
  });

  it("tamaño máximo 15: una combinación de 16 no se propone", () => {
    const dieciseis = items(...new Array<number>(16).fill(1000));
    expect(buscarSubconjuntos(dieciseis, 16000, 16000).estado).toBe("ok");
    expect((buscarSubconjuntos(dieciseis, 16000, 16000) as unknown as { combinaciones: unknown[] }).combinaciones).toHaveLength(0);
    const quince = buscarSubconjuntos(dieciseis, 15000, 15000, { maxCombinaciones: 5 });
    expect(quince.estado).toBe("ok");
    if (quince.estado === "ok") expect(quince.truncado).toBe(true);
  });

  it("presupuesto agotado: devuelve la señal, nunca una combinación parcial", () => {
    const muchos = items(...new Array<number>(30).fill(1000));
    const r = buscarSubconjuntos(muchos, 15000, 15000, { maxNodos: 500, maxCombinaciones: 1e9 });
    expect(r.estado).toBe("presupuesto_agotado");
  });

  it("MITM (más de 40 candidatos) encuentra lo mismo que la fuerza bruta", () => {
    const base = Array.from({ length: MITM_UMBRAL + 10 }, (_, i) => 10000 + i * 137);
    const objetivo = base[3]! + base[27]! + base[41]!;
    const r = buscarSubconjuntos(items(...base), objetivo, objetivo, { maxNodos: 5_000_000 });
    expect(r.estado).toBe("ok");
    if (r.estado !== "ok") return;
    expect(r.combinaciones).toContainEqual([3, 27, 41]);
    const chicas = items(...base.slice(0, 30));
    const objetivoChico = base[3]! + base[10]! + base[25]!;
    const bruta = buscarSubconjuntos(chicas, objetivoChico, objetivoChico);
    const mitm = buscarSubconjuntos([...chicas, ...items(...base.slice(30, 50)).map((x) => ({ id: x.id + 30, centavos: x.centavos }))], objetivoChico, objetivoChico, { maxNodos: 5_000_000 });
    expect(mitm.estado).toBe("ok");
    if (bruta.estado === "ok" && mitm.estado === "ok") for (const c of bruta.combinaciones) expect(mitm.combinaciones).toContainEqual(c);
  });
});

describe("conciliarMovimientos nivel 3 (D-P3-10)", () => {
  it("una sola combinación exacta se propone como multi_linea", () => {
    const r = conciliarMovimientos([mov(600)], [reg("a", 100), reg("b", 200), reg("c", 300), reg("d", 450)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.level).toBe("multi_linea");
    expect([...r.matched[0]!.registroIndices!].sort()).toEqual([0, 1, 2]);
    expect(r.ambiguos).toHaveLength(0);
  });

  it("2 combinaciones exactas: ambiguo, sin match ni registros consumidos", () => {
    // Antes (primera combinación hallada) se proponía una de las dos con puntaje alto.
    const r = conciliarMovimientos([mov(300)], [reg("a", 100), reg("b", 200), reg("c", 150), reg("d", 150)]);
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguos).toHaveLength(1);
    expect(r.ambiguos[0]!.combinaciones).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(r.ambiguos[0]!.exactas).toBe(true);
    expect(r.unmatchedBank).toHaveLength(1);
    expect(r.unmatchedBooks).toHaveLength(4);
    expect(r.sinConciliar[0]!.motivo).toBe("ambiguo");
  });

  it("una exacta y otra solo cercana (dentro del 1 %): gana la exacta, sin ambigüedad", () => {
    const r = conciliarMovimientos([mov(1000)], [reg("a", 400), reg("b", 600), reg("c", 405), reg("d", 600.5)]);
    expect(r.ambiguos).toHaveLength(0);
    expect([...r.matched[0]!.registroIndices!].sort()).toEqual([0, 1]);
  });

  it("sin combinación: sin_conciliar con los 5 registros más cercanos y nunca un match inventado", () => {
    const registros = Array.from({ length: 8 }, (_, i) => reg(`r${i}`, 150 + i * 10));
    const r = conciliarMovimientos([mov(4000)], registros);
    expect(r.matched).toHaveLength(0);
    expect(r.sinConciliar).toHaveLength(1);
    expect(r.sinConciliar[0]!.motivo).toBe("sin_combinacion");
    expect(r.sinConciliar[0]!.cercanos).toHaveLength(5);
    // más cercanos primero: el de monto 220 está más cerca de 4000 que el de 150
    expect(r.sinConciliar[0]!.cercanos[0]!.registroIdx).toBe(7);
  });

  it("centavos enteros: 3 facturas de 33.33 no cuadran con 100.00 y 33.34 + 33.33 + 33.33 sí", () => {
    // en flotante 33.33*3 = 99.99 y la tolerancia del 1 % lo aceptaba como exacto: ahora la exacta (centavos) es la única
    const r = conciliarMovimientos([mov(100)], [], { subsetSum: { toleranciaPct: 0 } });
    expect(r.matched).toHaveLength(0);
    const exacto = conciliarMovimientos([mov(100)], [reg("a", 33.34), reg("b", 33.33), reg("c", 33.33)], { subsetSum: { toleranciaPct: 0 } });
    expect(exacto.matched).toHaveLength(1);
    const casi = conciliarMovimientos([mov(100)], [reg("a", 33.33), reg("b", 33.33), reg("c", 33.33)], { subsetSum: { toleranciaPct: 0 } });
    expect(casi.matched).toHaveLength(0);
    expect(casi.sinConciliar[0]!.motivo).toBe("sin_combinacion");
  });

  it("tolerancia en centavos configurable", () => {
    const registros = [reg("a", 33.33), reg("b", 33.33), reg("c", 33.33)];
    const r = conciliarMovimientos([mov(100)], registros, { subsetSum: { toleranciaPct: 0, toleranciaCentavos: 1 } });
    expect(r.matched).toHaveLength(1);
  });

  it("techo de 60 candidatos: con más, se abstiene con motivo (no recorta en silencio)", () => {
    const registros = Array.from({ length: 61 }, (_, i) => reg(`r${i}`, 100 + i));
    const r = conciliarMovimientos([mov(300)], registros);
    expect(r.matched).toHaveLength(0);
    expect(r.sinConciliar[0]!.motivo).toBe("demasiados_candidatos");
  });

  it("presupuesto agotado -> sin_conciliar con motivo, nunca combinación parcial", () => {
    const registros = Array.from({ length: 30 }, (_, i) => reg(`r${i}`, 100));
    const r = conciliarMovimientos([mov(1500)], registros, { subsetSum: { maxNodos: 1000, maxCombinaciones: 1e9 } });
    expect(r.matched).toHaveLength(0);
    expect(r.sinConciliar[0]!.motivo).toBe("presupuesto_agotado");
  });

  it("la ventana de fechas filtra candidatos", () => {
    const r = conciliarMovimientos([mov(300)], [reg("a", 100), reg("b", 200, { fecha: "2025-04-30" })]);
    expect(r.matched).toHaveLength(0);
    expect(r.sinConciliar[0]!.motivo).toBe("pocos_candidatos");
  });
});

describe("dirección del movimiento vs. CFDI (D-P3-11): los cuatro cruces", () => {
  const abono = mov(1000, "2025-03-10", "COBRO CLIENTE");
  const cargo = mov(-1000, "2025-03-10", "PAGO PROVEEDOR");
  const emitido = reg("e", 1000, { direccion: "emitido", descripcion: "COBRO CLIENTE" });
  const recibido = reg("r", 1000, { direccion: "recibido", descripcion: "PAGO PROVEEDOR" });

  it("abono + CFDI emitido: se concilia", () => {
    expect(conciliarMovimientos([abono], [emitido]).matched).toHaveLength(1);
  });
  it("abono + CFDI recibido: NO se propone", () => {
    const r = conciliarMovimientos([abono], [{ ...recibido, descripcion: "COBRO CLIENTE" }]);
    expect(r.matched).toHaveLength(0);
    expect(r.sinConciliar[0]!.cercanos).toHaveLength(0);
  });
  it("cargo + CFDI recibido: se concilia", () => {
    expect(conciliarMovimientos([cargo], [recibido]).matched).toHaveLength(1);
  });
  it("cargo + CFDI emitido: NO se propone (antes comparaba Math.abs y sí lo proponía)", () => {
    const r = conciliarMovimientos([cargo], [{ ...emitido, descripcion: "PAGO PROVEEDOR" }]);
    expect(r.matched).toHaveLength(0);
  });
  it("indeterminado: se propone pero requiere revisión; sin dato (heredado) no filtra", () => {
    const ind = conciliarMovimientos([abono], [{ ...emitido, direccion: "indeterminado" }]);
    expect(ind.matched[0]!.requiereRevision).toBe(true);
    const sinDato = conciliarMovimientos([abono], [reg("x", 1000, { descripcion: "COBRO CLIENTE" })]);
    expect(sinDato.matched).toHaveLength(1);
    expect(sinDato.matched[0]!.requiereRevision).toBeUndefined();
  });
  it("el nivel 3 también filtra por dirección", () => {
    const r = conciliarMovimientos([abono], [reg("a", 400, { direccion: "emitido" }), reg("b", 600, { direccion: "recibido" })]);
    expect(r.matched).toHaveLength(0);
  });
});

describe("calcularPropuestas expone ambiguas y sin conciliar con ids", () => {
  it("mapea índices a ids", () => {
    const m = (id: string, monto: number): MovimientoGuardado => ({ ...mov(monto), id, hash: id, cuenta: null });
    const r = calcularPropuestas([m("m1", 300)], [reg("a", 100), reg("b", 200), reg("c", 150), reg("d", 150)]);
    expect(r.propuestas).toHaveLength(0);
    expect(r.ambiguas).toEqual([{ movimientoId: "m1", combinaciones: [["a", "b"], ["c", "d"]], truncado: false, exactas: true }]);
    expect(r.sinConciliar[0]!.motivo).toBe("ambiguo");
  });
});

describe("rendimiento (D-P3-10)", () => {
  it("60 candidatos y 500 facturas en menos de 2 s", () => {
    const registros: RegistroConciliable[] = [];
    // 500 facturas: 60 dentro de la ventana de fechas del movimiento, 440 fuera
    for (let i = 0; i < 500; i++) {
      registros.push(reg(`r${i}`, 100 + ((i * 37) % 900) + (i % 7) / 100, { fecha: i < 60 ? "2025-03-10" : "2025-01-02" }));
    }
    const inicio = performance.now();
    const r = conciliarMovimientos([mov(1234.56), mov(2200), mov(987.65)], registros);
    const ms = performance.now() - inicio;
    expect(ms).toBeLessThan(2000);
    // sea cual sea el resultado, nunca devuelve algo que no suma el monto del movimiento
    for (const c of r.matched) expect(Math.abs(c.montoRegistro - Math.abs(c.montoBanco)) / Math.abs(c.montoBanco)).toBeLessThanOrEqual(0.05);
  });
});
