// @vitest-environment jsdom
//
// Graficas inline: el plan (que se dibuja y con que datos), el SVG real con aria-label, "Ver como tabla", el
// respaldo a tabla cuando los datos no alcanzan, sparklines por fila y KPI. Los datos de prueba viven solo aqui.
import { afterEach, describe, expect, it } from "vitest";
import { CopilotoMensajeVista } from "../src/components/copiloto/CopilotoMensaje";
import { agruparPorSemana, lunesDe, opacidadSegmento, planGrafica, resumenAria, trazoAnillo, valorCompacto } from "../src/components/copiloto/CopilotoGraficas";
import type { CopilotoBloque, CopilotoMensaje } from "../src/components/copiloto/tipos";
import { limpiarDom, montar, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const COLS = [
  { key: "dia", label: "Día", kind: "text" as const },
  { key: "ventas", label: "Ventas", kind: "mxn" as const },
];

function bloque(over: Partial<CopilotoBloque> = {}): CopilotoBloque {
  return {
    tool: "ventas_por_dia",
    title: "Ventas por día",
    columns: COLS,
    rows: [
      { dia: "2026-09-28", ventas: 1500.5 },
      { dia: "2026-09-29", ventas: 980 },
      { dia: "2026-09-30", ventas: 1200 },
    ],
    chart: { kind: "bar", x: "dia", y: "ventas" },
    truncated: false,
    ...over,
  };
}

function vista(b: CopilotoBloque) {
  const mensaje: CopilotoMensaje = { id: "m1", role: "assistant", text: "Vendiste $3,680.50 MXN.", status: "ok", blocks: [b] };
  const { t } = transporteFalso();
  montado = montar(
    <CopilotoMensajeVista mensaje={mensaje} esUltima conversacionId="c1" transporte={t} rutasFuente={undefined} sugerenciasAlternas={[]} ocupado={false} onRegenerar={() => undefined} onPreguntar={() => undefined} />,
  );
  return montado.container;
}

describe("planGrafica", () => {
  it("sin chart o sin filas no dibuja nada (se queda la tabla)", () => {
    expect(planGrafica(bloque({ chart: undefined }))).toBeNull();
    expect(planGrafica(bloque({ rows: [] }))).toBeNull();
  });

  it("no dibuja si la columna pedida no existe o no es numerica", () => {
    expect(planGrafica(bloque({ chart: { kind: "bar", x: "dia", y: "nada" } }))).toBeNull();
    expect(planGrafica(bloque({ chart: { kind: "bar", x: "dia", y: "dia" } }))).toBeNull();
  });

  it("barras: omite filas sin valor (no inventa ceros), tope de 12 y horizontal con etiquetas largas", () => {
    const filas = Array.from({ length: 15 }, (_, i) => ({ dia: `D${i}`, ventas: i + 1 }));
    const p = planGrafica(bloque({ rows: [...filas, { dia: "sin dato", ventas: null }] }));
    expect(p).toMatchObject({ tipo: "bar", horizontal: false, omitidos: 3 });
    expect(p?.tipo === "bar" && p.puntos).toHaveLength(12);
    const largo = planGrafica(bloque({ rows: [{ dia: "Sucursal Centro Histórico", ventas: 5 }, { dia: "Norte", ventas: 3 }] }));
    expect(largo).toMatchObject({ tipo: "bar", horizontal: true });
  });

  it("linea: necesita al menos 2 observaciones", () => {
    const uno = planGrafica(bloque({ chart: { kind: "line", x: "dia", y: "ventas" }, rows: [{ dia: "2026-09-28", ventas: 5 }] }));
    expect(uno).toBeNull();
    expect(planGrafica(bloque({ chart: { kind: "line", x: "dia", y: "ventas" } }))).toMatchObject({ tipo: "line", agrupadoPorSemana: false });
  });

  it("linea con mas de 90 dias agrupa por semana (suma lo aditivo, promedia porcentajes)", () => {
    const filas = Array.from({ length: 100 }, (_, i) => ({ dia: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), ventas: 10 }));
    const p = planGrafica(bloque({ chart: { kind: "line", x: "dia", y: "ventas" }, rows: filas }));
    expect(p).toMatchObject({ tipo: "line", agrupadoPorSemana: true });
    expect(p?.tipo === "line" && p.puntos.length).toBeLessThan(20);
    expect(p?.tipo === "line" && p.puntos[1]!.valor).toBe(70);
    expect(agruparPorSemana([{ x: "2026-09-28", y: 10 }, { x: "2026-09-29", y: 20 }], "percent")).toEqual([{ etiqueta: "Sem. 2026-09-28", valor: 15 }]);
    expect(agruparPorSemana([{ x: "no-fecha", y: 1 }], "mxn")).toBeNull();
  });

  it("lunesDe devuelve el lunes de la semana (domingo pertenece a la semana anterior)", () => {
    expect(lunesDe("2026-09-28")).toBe("2026-09-28");
    expect(lunesDe("2026-10-04")).toBe("2026-09-28");
    expect(lunesDe("basura")).toBeNull();
  });

  it("dona: solo positivos, ordenados, maximo 6 segmentos con Otros, porcentajes que suman 100", () => {
    const filas = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k, i) => ({ dia: k, ventas: i + 1 }));
    const p = planGrafica(bloque({ chart: { kind: "donut", x: "dia", y: "ventas" }, rows: [...filas, { dia: "cero", ventas: 0 }, { dia: "neg", ventas: -4 }] }));
    expect(p?.tipo).toBe("donut");
    if (p?.tipo !== "donut") return;
    expect(p.segmentos).toHaveLength(6);
    expect(p.segmentos[5]!.etiqueta).toBe("Otros");
    expect(p.segmentos[0]!.etiqueta).toBe("h");
    expect(p.segmentos.reduce((a, s) => a + s.porcentaje, 0)).toBeCloseTo(100, 6);
    expect(planGrafica(bloque({ chart: { kind: "donut", x: "dia", y: "ventas" }, rows: [{ dia: "x", ventas: 0 }] }))).toBeNull();
  });

  it("kpi: una fila, columnas numericas finitas, maximo 4", () => {
    const cols = [
      { key: "a", label: "A", kind: "mxn" as const },
      { key: "b", label: "B", kind: "integer" as const },
      { key: "c", label: "C", kind: "text" as const },
      { key: "d", label: "D", kind: "percent" as const },
      { key: "e", label: "E", kind: "integer" as const },
      { key: "f", label: "F", kind: "integer" as const },
      { key: "g", label: "G", kind: "integer" as const },
    ];
    const fila = { a: 1500, b: 12, c: "x", d: 12.5, e: null, f: 1, g: 2 };
    const p = planGrafica({ tool: "t", title: "T", columns: cols, rows: [fila], chart: { kind: "kpi", x: "a", y: "a" }, truncated: false });
    expect(p?.tipo === "kpi" && p.items.map((i) => i.etiqueta)).toEqual(["A", "B", "D", "F"]);
    expect(planGrafica({ tool: "t", title: "T", columns: cols, rows: [fila, fila], chart: { kind: "kpi", x: "a", y: "a" }, truncated: false })).toBeNull();
  });
});

describe("utilidades de dibujo", () => {
  it("valorCompacto y opacidad de la rampa (1 -> 0.35)", () => {
    expect(valorCompacto("mxn", 1500)).toMatch(/^\$1[,.]5/);
    expect(valorCompacto("percent", 12)).toBe("12 %");
    expect(opacidadSegmento(0, 5)).toBe(1);
    expect(opacidadSegmento(4, 5)).toBeCloseTo(0.35, 6);
    expect(opacidadSegmento(0, 1)).toBe(1);
  });

  it("trazoAnillo cierra el segmento y usa el arco grande solo pasados 180 grados", () => {
    expect(trazoAnillo(96, 96, 90, 66, 0, 90)).toMatch(/^M.*A90 90 0 0 1.*A66 66 0 0 0.*Z$/);
    expect(trazoAnillo(96, 96, 90, 66, 0, 270)).toContain("A90 90 0 1 1");
  });

  it("resumenAria lista los valores si son pocos y resume extremos si son muchos", () => {
    const p = planGrafica(bloque());
    expect(p && resumenAria("Ventas por día", p)).toContain("2026-09-28");
    const filas = Array.from({ length: 12 }, (_, i) => ({ dia: `D${i}`, ventas: i }));
    const g = planGrafica(bloque({ rows: filas }));
    expect(g && resumenAria("X", g)).toMatch(/12 valores.*máximo D11.*mínimo D0/);
  });
});

describe("render dentro del mensaje", () => {
  it("barras: svg con role=img y aria-label con los valores, mas 'Ver como tabla' con la tabla real", () => {
    const c = vista(bloque());
    const svg = c.querySelector('[data-testid="copiloto-grafica"] svg[role="img"]');
    expect(svg?.getAttribute("aria-label")).toMatch(/Ventas por día, barras: .*2026-09-28/);
    expect(c.querySelectorAll("svg rect").length).toBeGreaterThanOrEqual(3);
    const detalle = c.querySelector("details");
    expect(detalle?.querySelector("summary")?.textContent).toBe("Ver como tabla");
    expect(detalle?.querySelectorAll("ul[aria-label] li")).toHaveLength(3);
  });

  it("linea y dona se dibujan; la dona incluye leyenda con porcentajes", () => {
    let c = vista(bloque({ chart: { kind: "line", x: "dia", y: "ventas" } }));
    expect(c.querySelector('[data-tipo="line"] path[stroke-width="2"]')).not.toBeNull();
    expect(c.querySelectorAll('[data-tipo="line"] circle')).toHaveLength(3);
    montado?.unmount();
    limpiarDom();
    c = vista(bloque({ chart: { kind: "donut", x: "dia", y: "ventas" } }));
    expect(c.querySelectorAll('[data-tipo="donut"] svg path')).toHaveLength(3);
    expect(c.textContent).toMatch(/\d+[.,]\d %/);
  });

  it("KPI muestra la cifra formateada con la tipografia de cifra", () => {
    const c = vista({ tool: "t", title: "Ticket", columns: [{ key: "t", label: "Ticket medio", kind: "mxn" }], rows: [{ t: 245.5 }], chart: { kind: "kpi", x: "t", y: "t" }, truncated: false });
    const dd = c.querySelector('[data-testid="copiloto-kpi"] dd');
    expect(dd?.textContent).toContain("245.50");
    expect(dd?.className).toContain("tabular-nums");
  });

  it("si los datos no alcanzan para la grafica, muestra la tabla (sin svg de grafica ni 'Ver como tabla')", () => {
    const c = vista(bloque({ chart: { kind: "line", x: "dia", y: "ventas" }, rows: [{ dia: "2026-09-28", ventas: 5 }] }));
    expect(c.querySelector('[data-testid="copiloto-grafica"]')).toBeNull();
    expect(c.querySelector("details")).toBeNull();
    expect(c.querySelector("table, ul[aria-label]")).not.toBeNull();
  });

  it("sin chart el bloque sigue siendo la tabla de siempre", () => {
    const c = vista(bloque({ chart: undefined }));
    expect(c.querySelector('[data-testid="copiloto-grafica"]')).toBeNull();
    expect(c.querySelector("ul[aria-label='Ventas por día']")).not.toBeNull();
  });

  it("sparkline por fila: columna extra con svg de 64x16 y etiqueta; una serie corta se muestra honesta", () => {
    const c = vista(
      bloque({
        chart: undefined,
        sparkline: { label: "Tendencia", series: [[1, 3, 2], [5], [4, 4, 4]] },
      }),
    );
    expect(Array.from(c.querySelectorAll("th")).map((t) => t.textContent)).toContain("Tendencia");
    const sparks = c.querySelectorAll('tbody svg[viewBox="0 0 64 16"]');
    expect(sparks).toHaveLength(2);
    expect(sparks[0]?.getAttribute("aria-label")).toContain("Tendencia de 2026-09-28");
    expect(c.querySelector('tbody [aria-label*="sin datos suficientes"]')).not.toBeNull();
  });

  it("el texto del bloque se escapa (no se interpreta HTML de las etiquetas)", () => {
    const c = vista(bloque({ rows: [{ dia: "<img src=x onerror=alert(1)>", ventas: 5 }, { dia: "b", ventas: 3 }] }));
    expect(c.querySelector("img")).toBeNull();
  });
});
