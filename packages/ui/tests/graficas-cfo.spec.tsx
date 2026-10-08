// @vitest-environment jsdom
//
// CFO-07: gráficas del CFO. Se prueba lo que prometen: sin datos dicen la verdad (nunca una gráfica plana de relleno), celda/barra
// sin dato NO es 0, negativos con signo y etiqueta, atípicos con texto, aria-label con la cifra y tabla «Ver datos» accesible.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BarrasAgrupadas, Cascada, Heatmap, MAX_GRUPOS_BARRAS, RankingBarras, Semaforo, TablaDatosGrafica } from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return el;
}
afterEach(() => {
  for (const { root, el } of raices) {
    act(() => root.unmount());
    el.remove();
  }
  raices = [];
});

const pesos = (v: number) => `$${v}`;
void createElement;

describe("<Heatmap />", () => {
  it("sin celdas con dato dice la verdad y no dibuja una cuadrícula", () => {
    const el = montar(<Heatmap celdas={[]} />);
    expect(el.querySelector("[data-testid=grafica-sin-datos]")).not.toBeNull();
    expect(el.querySelector("svg")).toBeNull();
    const nulas = montar(<Heatmap celdas={[{ fila: 0, columna: 1, valor: null }]} />);
    expect(nulas.querySelector("svg")).toBeNull();
  });

  it("un dato: una celda con valor, 167 vacías (punteadas) y aria-label con la cifra máxima", () => {
    const el = montar(<Heatmap celdas={[{ fila: 4, columna: 20, valor: 125000 }]} formato={pesos} metrica="ventas" />);
    expect(el.querySelectorAll("[data-testid=heatmap-celda]").length).toBe(1);
    expect(el.querySelectorAll("[data-testid=heatmap-celda-vacia]").length).toBe(7 * 24 - 1);
    const label = el.querySelector("svg")!.getAttribute("aria-label")!;
    expect(label).toContain("$125000");
    expect(label).toContain("Vie");
    expect(label).toContain("20 h");
  });

  it("una celda con 0 explícito se pinta (tono mínimo) y NO cuenta como vacía", () => {
    const el = montar(
      <Heatmap
        celdas={[
          { fila: 0, columna: 0, valor: 0 },
          { fila: 0, columna: 1, valor: 10 },
        ]}
      />,
    );
    expect(el.querySelectorAll("[data-testid=heatmap-celda]").length).toBe(2);
    const cero = el.querySelector("[data-testid=heatmap-celda][data-valor='0']")!;
    expect(cero.getAttribute("fill-opacity")).toBe("0.12");
  });
});

describe("<Cascada />", () => {
  const pasos = [
    { etiqueta: "Ventas brutas", valor: 100000, tipo: "total" as const },
    { etiqueta: "Descuentos", valor: 10000, tipo: "resta" as const },
    { etiqueta: "Compensaciones", valor: 5000, tipo: "resta" as const },
    { etiqueta: "Ventas netas", valor: 85000, tipo: "total" as const },
    { etiqueta: "IVA estimado", valor: null, tipo: "resta" as const },
  ];

  it("sin ningún paso medible muestra el aviso", () => {
    const el = montar(<Cascada pasos={[{ etiqueta: "Ventas brutas", valor: null, tipo: "total" }]} />);
    expect(el.querySelector("[data-testid=grafica-sin-datos]")).not.toBeNull();
    expect(el.querySelector("[data-testid=cascada]")).toBeNull();
  });

  it("las restas llevan signo «−» y etiqueta, los totales no; un paso sin dato dice «—» y no dibuja barra", () => {
    const el = montar(<Cascada pasos={pasos} formato={pesos} />);
    const filas = [...el.querySelectorAll("[data-testid=cascada-paso]")];
    expect(filas).toHaveLength(5);
    expect(filas[1]!.textContent).toContain("Descuentos");
    expect(filas[1]!.textContent).toContain("−$10000");
    expect(filas[0]!.textContent).toContain("$100000");
    expect(filas[0]!.textContent).not.toContain("−");
    expect(filas[4]!.textContent).toContain("—");
    expect(filas[4]!.querySelector("[data-testid=cascada-barra]")).toBeNull();
  });

  it("las barras de resta flotan desde el total corriente (el descuento arranca donde termina lo que queda)", () => {
    const el = montar(<Cascada pasos={pasos} formato={pesos} />);
    const barras = [...el.querySelectorAll<HTMLElement>("[data-testid=cascada-barra]")];
    expect(barras[0]!.style.left).toBe("0%");
    expect(barras[0]!.style.width).toBe("100%");
    // 100000 -> descuento de 10000: flota de 90 % a 100 %.
    expect(barras[1]!.style.left).toBe("90%");
    expect(Number.parseFloat(barras[1]!.style.width)).toBeCloseTo(10, 5);
  });

  it("aria-label resume las cifras de cada paso", () => {
    const el = montar(<Cascada pasos={pasos} formato={pesos} />);
    const label = el.querySelector("[data-testid=cascada]")!.getAttribute("aria-label")!;
    expect(label).toContain("Ventas brutas: $100000");
    expect(label).toContain("Descuentos: menos $10000");
    expect(label).toContain("IVA estimado: sin dato");
  });
});

describe("<RankingBarras />", () => {
  it("sin filas: aviso", () => {
    const el = montar(<RankingBarras filas={[]} />);
    expect(el.querySelector("[data-testid=grafica-sin-datos]")).not.toBeNull();
  });

  it("posición, valor, participación y marca de atípico en texto; valor null = «—» sin barra", () => {
    const el = montar(
      <RankingBarras
        filas={[
          { id: "a", etiqueta: "Altabrisa", valor: 90000, participacionPct: 60, outlier: true },
          { id: "b", etiqueta: "Centro", valor: 60000, participacionPct: 40 },
          { id: "c", etiqueta: "Norte", valor: null },
        ]}
        formato={pesos}
      />,
    );
    const filas = [...el.querySelectorAll("[data-testid=ranking-fila]")];
    expect(filas).toHaveLength(3);
    expect(filas[0]!.textContent).toContain("1");
    expect(filas[0]!.textContent).toContain("$90000");
    expect(filas[0]!.textContent).toContain("60 %");
    expect(filas[0]!.textContent).toContain("Atípica");
    expect(filas[1]!.querySelector("[data-testid=ranking-outlier]")).toBeNull();
    expect(filas[2]!.textContent).toContain("—");
    expect(filas[2]!.querySelector("[data-testid=ranking-barra]")).toBeNull();
    expect(el.querySelector("ol")!.getAttribute("aria-label")).toContain("1. Altabrisa $90000");
  });
});

describe("<Semaforo />", () => {
  it("nunca comunica solo con color: siempre hay texto", () => {
    for (const [estado, texto] of [
      ["verde", "En orden"],
      ["ambar", "Atención"],
      ["rojo", "Crítico"],
      ["sin_dato", "Sin dato"],
    ] as const) {
      const el = montar(<Semaforo estado={estado} />);
      expect(el.textContent).toBe(texto);
      expect(el.querySelector("[data-estado]")!.getAttribute("data-estado")).toBe(estado);
    }
  });

  it("acepta un texto propio", () => {
    const el = montar(<Semaforo estado="rojo" texto="Cae 18 %" />);
    expect(el.textContent).toBe("Cae 18 %");
  });
});

describe("<BarrasAgrupadas />", () => {
  const series = [
    { id: "neta", etiqueta: "Ventas netas" },
    { id: "bruta", etiqueta: "Ventas brutas" },
  ];

  it("sin datos: aviso", () => {
    const el = montar(<BarrasAgrupadas series={series} grupos={[{ etiqueta: "A", valores: { neta: null } }]} />);
    expect(el.querySelector("[data-testid=grafica-sin-datos]")).not.toBeNull();
  });

  it("máximo 8 grupos y lo dice; un valor null es «—», no 0", () => {
    const grupos = Array.from({ length: 10 }, (_, i) => ({ etiqueta: `S${i + 1}`, valores: { neta: 100 + i, bruta: i === 0 ? null : 200 } }));
    const el = montar(<BarrasAgrupadas series={series} grupos={grupos} formato={pesos} />);
    expect(el.querySelectorAll("[data-testid=barras-grupo]").length).toBe(MAX_GRUPOS_BARRAS);
    expect(el.querySelector("[data-testid=barras-recortadas]")!.textContent).toContain("8 de 10");
    const primero = el.querySelector("[data-testid=barras-grupo]")!;
    expect(primero.textContent).toContain("—");
    expect(primero.querySelectorAll("[data-testid=barras-barra]").length).toBe(1);
    expect(el.querySelector("[data-testid=barras-agrupadas]")!.getAttribute("aria-label")).toContain("S1: Ventas netas $100, Ventas brutas sin dato");
  });
});

describe("<TablaDatosGrafica />", () => {
  it("es un <details> «Ver datos» con tabla accesible (caption, th scope) y null como «—»", () => {
    const el = montar(
      <TablaDatosGrafica
        titulo="Ventas por canal"
        encabezados={["Canal", "Pedidos"]}
        filas={[
          ["WhatsApp", 12],
          ["Voz", null],
        ]}
      />,
    );
    const det = el.querySelector("details")!;
    expect(det.querySelector("summary")!.textContent).toBe("Ver datos");
    expect(det.querySelector("caption")!.textContent).toBe("Ventas por canal");
    expect(det.querySelectorAll("th[scope=col]").length).toBe(2);
    expect(det.querySelectorAll("th[scope=row]").length).toBe(2);
    expect(det.textContent).toContain("—");
  });

  it("sin filas no pinta nada", () => {
    const el = montar(<TablaDatosGrafica titulo="x" encabezados={["a"]} filas={[]} />);
    expect(el.querySelector("details")).toBeNull();
  });
});
