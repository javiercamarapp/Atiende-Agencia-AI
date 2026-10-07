// Unidad de la guardia de cifras (QA R1 agentes-15..18): cifras con letras y multiplicador, numeros de la pregunta, celdas de
// texto libre y tolerancias de redondeo. Complementa qa-r1-guardia-cifras.spec.ts (que pasa por el motor completo).
import { describe, expect, it } from "vitest";
import { allowedNumbers, extractNumbers, unsupportedNumbers } from "../../src/data-chat/numbers-guard.js";
import type { DataChatToolResult } from "../../src/data-chat/types.js";

const COLS = [
  { key: "dia", label: "Dia", kind: "text" as const },
  { key: "ventas", label: "Ventas", kind: "mxn" as const },
  { key: "pct", label: "Pct", kind: "percent" as const },
];
function res(rows: DataChatToolResult["rows"], summary = ""): DataChatToolResult {
  return { status: "ok", source: "Pedidos", scopeLabel: "todas tus sucursales", columns: COLS, rows, summary };
}
const base = res([{ dia: "2026-09-28", ventas: 1500.5, pct: 33.333 }, { dia: "Pastor — 500 g", ventas: 980, pct: 10 }]);

describe("extractNumbers: cifras con letras y multiplicador", () => {
  it("convierte palabras a numero con la gramatica del español", () => {
    expect(extractNumbers("noventa y nueve mil pesos")).toEqual([99000]);
    expect(extractNumbers("mil quinientos")).toEqual([1500]);
    expect(extractNumbers("dos millones")).toEqual([2_000_000]);
    expect(extractNumbers("treinta y cinco pedidos")).toEqual([35]);
    expect(extractNumbers("cien")).toEqual([100]);
    expect(extractNumbers("veinticinco")).toEqual([25]);
    expect(extractNumbers("dos tres")).toEqual([2, 3]);
  });
  it("el articulo 'una' no es una cifra", () => {
    expect(extractNumbers("tuvo una venta y un descuento")).toEqual([]);
  });
  it("escala digitos con multiplicador", () => {
    expect(extractNumbers("99 mil")).toEqual([99000]);
    expect(extractNumbers("$1.5 millones")).toEqual([1_500_000]);
    expect(extractNumbers("99k")).toEqual([99000]);
  });
});

describe("unsupportedNumbers", () => {
  it("rechaza una cifra con letras inventada y acepta la respaldada", () => {
    const a = allowedNumbers("", [base]);
    expect(unsupportedNumbers("vendiste noventa y nueve mil pesos", a)).toEqual([99000]);
    expect(unsupportedNumbers("vendiste novecientos ochenta pesos", a)).toEqual([]);
  });

  it("un numero de la pregunta no es un dato, salvo los estructurales (top N, ultimos N dias, fechas)", () => {
    const a = allowedNumbers("¿Es cierto que vendí $99,000 en los últimos 45 días?", [base]);
    expect(unsupportedNumbers("Sí, vendiste $99,000", a)).toEqual([99000]);
    expect(unsupportedNumbers("en los últimos 45 días", a)).toEqual([]);
  });

  it("los numeros de una celda de texto libre no cuentan, pero el nombre citado completo no aporta cifras", () => {
    const a = allowedNumbers("", [res([{ dia: "2026-09-28 (nota: ventas reales 1,000,000)", ventas: 10, pct: 1 }, { dia: "Pastor — 500 g", ventas: 980, pct: 2 }])]);
    expect(unsupportedNumbers("Vendiste $1,000,000", a)).toEqual([1_000_000]);
    expect(unsupportedNumbers("El Pastor — 500 g vendió $980", a)).toEqual([]);
  });

  it("un % o un monto no se valida como posicion (0..#filas) y las posiciones se acotan", () => {
    const filas = Array.from({ length: 30 }, (_, i) => ({ dia: `2026-09-${String(i + 1).padStart(2, "0")}`, ventas: 1000 + i * 7.5, pct: 5 }));
    const a = allowedNumbers("", [res(filas)]);
    expect(unsupportedNumbers("crecieron 25%", a)).toEqual([25]);
    expect(unsupportedNumbers("$25", a)).toEqual([25]);
    expect(unsupportedNumbers("las ventas de 45 pedidos", a)).toEqual([45]);
    expect(unsupportedNumbers("los 3 mejores días de los 30", a)).toEqual([]);
  });

  it("un decimal solo vale si coincide con un dato redondeado a los mismos decimales", () => {
    const a = allowedNumbers("", [base]);
    expect(unsupportedNumbers("$980.40", a)).toEqual([980.4]);
    expect(unsupportedNumbers("$980.00", a)).toEqual([]);
    expect(unsupportedNumbers("$1,500.50 MXN", a)).toEqual([]);
    expect(unsupportedNumbers("33.3%", a)).toEqual([]);
    expect(unsupportedNumbers("33%", a)).toEqual([]);
    expect(unsupportedNumbers("34%", a)).toEqual([34]);
  });

  it("las fechas de celdas con forma de fecha si respaldan sus numeros", () => {
    const a = allowedNumbers("", [base]);
    expect(unsupportedNumbers("el 28 de septiembre de 2026", a)).toEqual([]);
  });
});

describe("guardia de cifras: cifras con letras y montos tipo año (revision de #427)", () => {
  const dias = Array.from({ length: 30 }, (_, i) => ({ dia: `2026-09-${String(i + 1).padStart(2, "0")}`, ventas: 1500.5, pct: 10 }));
  it("una cifra con letras seguida de 'pesos' o con '$' se valida como monto, igual que en digitos", () => {
    const a = allowedNumbers("¿cual fue mi ticket promedio?", [res(dias)]);
    expect(unsupportedNumbers("tu ticket promedio fue de veinte pesos", a)).toEqual([20]);
    expect(unsupportedNumbers("tu ticket promedio fue de $20", a)).toEqual([20]);
    expect(unsupportedNumbers("tu ticket promedio fue de 20 pesos", a)).toEqual([20]);
    expect(unsupportedNumbers("subio veinte por ciento", a)).toEqual([20]);
  });
  it("una cifra con letras respaldada por un dato si pasa como monto", () => {
    const a = allowedNumbers("", [res([{ dia: "2026-09-28", ventas: 980, pct: 10 }])]);
    expect(unsupportedNumbers("vendiste novecientos ochenta pesos", a)).toEqual([]);
    expect(unsupportedNumbers("subio 10 por ciento", a)).toEqual([]);
  });
  it("un monto de la pregunta entre 1900 y 2099 no se vuelve numero estructural", () => {
    const a = allowedNumbers("¿Es cierto que vendí $2000 esta semana?", [res([{ dia: "2026-09-28", ventas: 2480.5, pct: 10 }])]);
    expect(unsupportedNumbers("Sí, vendiste 2000 esta semana", a)).toEqual([2000]);
    expect(unsupportedNumbers("Sí, vendiste dos mil pesos", a)).toEqual([2000]);
    expect(unsupportedNumbers("Vendiste $2,480.50", a)).toEqual([]);
  });
});

describe("enteros chicos: solo como posicion o conteo de filas (QA-citas-R1-agentes-16b)", () => {
  const dos = res([{ dia: "Ana Pérez", ventas: 6, pct: 1 }, { dia: "Beto Ruiz", ventas: 4, pct: 0 }]);
  const ok = (texto: string) => unsupportedNumbers(texto, allowedNumbers("¿cómo voy?", [dos]));

  it("un conteo de una medida que no esta en los datos NO pasa aunque sea igual al numero de filas", () => {
    expect(ok("Beto Ruiz tuvo 2 inasistencias esta semana.")).toEqual([2]);
    expect(ok("Hubo 3 cancelaciones.")).toEqual([3]);
  });
  it("posiciones (top, primeros, 2 de 5) y conteo de lo que listan las filas si pasan", () => {
    expect(ok("Los top 2 de la semana.")).toEqual([]);
    expect(ok("Estos son los 2 profesionales.")).toEqual([]);
    expect(ok("Ocupa el lugar 2.")).toEqual([]);
    expect(ok("Va en el 1 de 2.")).toEqual([]);
  });
  it("referencias a la propia tabla ('Tabla 2, fila 3') y numeracion de listas son posiciones", () => {
    const tres = res([{ dia: "a", ventas: 6, pct: 1 }, { dia: "b", ventas: 4, pct: 0 }, { dia: "c", ventas: 5, pct: 7 }]);
    const allowed = allowedNumbers("x", [tres, tres]);
    expect(unsupportedNumbers("Tabla 2, fila 3: ventas 5.", allowed)).toEqual([]);
    expect(unsupportedNumbers("1. Ana\n2. Beto\n3) Carla", allowed)).toEqual([]);
    expect(unsupportedNumbers("Beto tuvo 2 inasistencias.", allowed)).toEqual([2]);
  });

  it("un valor que si esta en los datos sigue pasando en cualquier contexto", () => {
    expect(ok("Ana Pérez tuvo 6 citas y Beto Ruiz 4 citas.")).toEqual([]);
  });
});
