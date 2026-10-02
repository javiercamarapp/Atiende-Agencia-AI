// @vitest-environment jsdom
//
// SA-L-03: kit visual de la consola portado de Likida. Se prueba lo que el diff promete: las graficas pintan
// SOLO los datos que reciben (sin relleno), dicen la verdad cuando no hay datos, agrupan por semana sumando,
// y el filtro de rango 7/30/todo hace el viaje redondo URL -> rango.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Activity } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AreaChartSimple,
  BarChartSimple,
  ChartCard,
  Dona,
  GlobalFilter,
  HBars,
  KpiTile,
  Sparkline,
  Tendencia,
  UMBRAL_AGRUPAR_SEMANA,
  agruparPorSemana,
  pathRebanada,
  resolverFormato,
  resolverRango,
  urlDeRango,
} from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement, ruta = "/") {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(createElement(MemoryRouter, { initialEntries: [ruta] }, ui)));
  raices.push({ root, el });
  return el;
}
afterEach(() => {
  for (const r of raices) {
    act(() => r.root.unmount());
    r.el.remove();
  }
  raices = [];
});

function serie(n: number, valor = (i: number) => i + 1): Array<{ dia: string; valor: number }> {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({ dia: new Date(base + i * 86_400_000).toISOString().slice(0, 10), valor: valor(i) }));
}

describe("agruparPorSemana", () => {
  it("SUMA cubetas de 7 dias ancladas al final y rotula con el primer dia", () => {
    const datos = serie(10); // valores 1..10
    const g = agruparPorSemana(datos);
    // Ultima cubeta = dias 4..10 (completa, termina hoy); la primera, los 3 sobrantes.
    expect(g).toEqual([
      { dia: "2026-01-01", valor: 1 + 2 + 3 },
      { dia: "2026-01-04", valor: 4 + 5 + 6 + 7 + 8 + 9 + 10 },
    ]);
  });
  it("conserva el total (no promedia ni pierde dias)", () => {
    const datos = serie(100, (i) => (i * 7) % 13);
    const total = datos.reduce((s, d) => s + d.valor, 0);
    expect(agruparPorSemana(datos).reduce((s, d) => s + d.valor, 0)).toBe(total);
  });
});

describe("AreaChartSimple", () => {
  it("sin datos dice la verdad en vez de dibujar una linea plana", () => {
    const el = montar(<AreaChartSimple datos={[]} etiquetaValor={String} />);
    expect(el.querySelector('[data-testid="grafica-sin-datos"]')?.textContent).toBe("Sin datos en este periodo");
    expect(el.querySelector("svg")).toBeNull();
  });
  it("pinta un punto por dato con su etiqueta de valor y no avisa de agrupacion bajo el umbral", () => {
    const el = montar(<AreaChartSimple datos={serie(5)} etiquetaValor={(v) => `$${v}`} />);
    expect(el.querySelectorAll("svg g.group")).toHaveLength(5);
    expect(el.textContent).toContain("$5");
    expect(el.querySelector('[data-testid="area-agrupada"]')).toBeNull();
  });
  it("un solo punto no revienta", () => {
    const el = montar(<AreaChartSimple datos={serie(1)} etiquetaValor={String} />);
    expect(el.querySelectorAll("svg g.group")).toHaveLength(1);
  });
  it("por encima del trimestre agrupa por semana y lo DICE en el rotulo", () => {
    const n = UMBRAL_AGRUPAR_SEMANA + 1;
    const el = montar(<AreaChartSimple datos={serie(n)} etiquetaValor={String} />);
    const semanas = Math.ceil(n / 7);
    expect(el.querySelectorAll("svg g.group")).toHaveLength(semanas);
    expect(el.querySelector('[data-testid="area-agrupada"]')?.textContent).toContain(`${semanas} semanas`);
  });
  it("la comparativa solo se dibuja con serie real (>1 punto) y con su rotulo", () => {
    const sin = montar(<AreaChartSimple datos={serie(4)} etiquetaValor={String} comparativa={serie(1)} />);
    expect(sin.querySelectorAll("path[stroke-dasharray]")).toHaveLength(0);
    const con = montar(<AreaChartSimple datos={serie(4)} etiquetaValor={String} comparativa={serie(4)} etiquetaComparativa="mes anterior" />);
    expect(con.querySelectorAll("path[stroke-dasharray]")).toHaveLength(1);
    expect(con.textContent).toContain("mes anterior");
  });
});

describe("BarChartSimple", () => {
  it("sin datos: aviso honesto", () => {
    const el = montar(<BarChartSimple datos={[]} />);
    expect(el.querySelector('[data-testid="grafica-sin-datos"]')).not.toBeNull();
  });
  it("un dia en cero no dibuja barra; los demas si, proporcionales al maximo", () => {
    const datos = [
      { dia: "2026-01-01", valor: 0 },
      { dia: "2026-01-02", valor: 50 },
      { dia: "2026-01-03", valor: 100 },
    ];
    const el = montar(<BarChartSimple datos={datos} />);
    const barras = [...el.querySelectorAll<HTMLElement>('[data-testid="bar-chart-barra"]')];
    expect(barras.map((b) => b.style.height)).toEqual(["50%", "100%"]);
    expect(el.textContent).toContain("01");
  });
});

describe("Dona", () => {
  it("total 0 o sin segmentos: no hay nada que repartir", () => {
    expect(montar(<Dona segmentos={[]} />).querySelector('[data-testid="grafica-sin-datos"]')).not.toBeNull();
    expect(montar(<Dona segmentos={[{ etiqueta: "A", valor: 0 }]} />).querySelector('[data-testid="grafica-sin-datos"]')).not.toBeNull();
  });
  it("las leyendas suman los porcentajes reales y un segmento en 0 no dibuja rebanada", () => {
    const el = montar(
      <Dona
        segmentos={[
          { etiqueta: "WhatsApp", valor: 75 },
          { etiqueta: "Voz", valor: 25 },
          { etiqueta: "Web", valor: 0 },
        ]}
      />,
    );
    expect(el.textContent).toContain("75%");
    expect(el.textContent).toContain("25%");
    expect(el.textContent).toContain("0%");
    expect(el.querySelectorAll("svg path")).toHaveLength(2);
  });
  it("pathRebanada cierra la figura y usa arco grande solo pasados 180 grados", () => {
    expect(pathRebanada(0, 90)).toMatch(/^M .* Z$/);
    expect(pathRebanada(0, 90)).toContain("0 0 1");
    expect(pathRebanada(0, 270)).toContain("0 1 1");
  });
});

describe("HBars", () => {
  it("la barra mayor ocupa 100 % y las demas su proporcion real; el valor sale formateado", () => {
    const el = montar(
      <HBars
        formato="mxn"
        datos={[
          { etiqueta: "Restaurantes", valor: 1500 },
          { etiqueta: "Hoteles", valor: 750 },
        ]}
      />,
    );
    const barras = [...el.querySelectorAll<HTMLElement>('[data-testid="hbars-barra"]')];
    expect(barras.map((b) => b.style.width)).toEqual(["100%", "50%"]);
    expect(el.textContent).toContain("$1,500.00");
  });
  it("vacio: aviso, no pista vacia", () => {
    expect(montar(<HBars datos={[]} sinDatos="Nada aun" />).textContent).toBe("Nada aun");
  });
});

describe("Sparkline y Tendencia", () => {
  it("con menos de 2 puntos no se pinta (no se inventa una serie plana)", () => {
    expect(montar(<Sparkline valores={[3]} />).querySelector("svg")).toBeNull();
    expect(montar(<Sparkline valores={[1, 2, 3]} />).querySelector('[data-testid="sparkline"]')).not.toBeNull();
  });
  it("tendencia: null dice 'sin historia suficiente'; sube en verde y baja en rojo", () => {
    expect(montar(<Tendencia valor={null} />).textContent).toBe("sin historia suficiente");
    const sube = montar(<Tendencia valor={12} />);
    expect(sube.textContent).toContain("↑ 12%");
    expect(sube.querySelector("span")?.className).toContain("text-success");
    const baja = montar(<Tendencia valor={-4} />);
    expect(baja.textContent).toContain("↓ 4%");
    expect(baja.querySelector("span")?.className).toContain("text-destructive");
  });
});

describe("KpiTile", () => {
  it("valor null = no medible: guion y motivo, nunca un 0", () => {
    const el = montar(<KpiTile icono={<Activity />} etiqueta="MRR" valor={null} vacio="sin historia suficiente" />);
    expect(el.querySelector('[data-testid="kpi-tile-valor"]')?.textContent).toBe("—");
    expect(el.textContent).toContain("sin historia suficiente");
    expect(el.textContent).not.toMatch(/\b0\b/);
  });
  it("un cero REAL se muestra como 0", () => {
    const el = montar(<KpiTile icono={<Activity />} etiqueta="Incidentes" valor={0} />);
    expect(el.querySelector('[data-testid="kpi-tile-valor"]')?.textContent).toBe("0");
  });
  it("formatea con el preset y dibuja serie + tendencia solo si hay serie real", () => {
    const con = montar(<KpiTile icono={<Activity />} etiqueta="Costo" valor={12345.5} formato="mxn" sparkline={[1, 2, 3]} tendencia={8} />);
    expect(con.querySelector('[data-testid="kpi-tile-valor"]')?.textContent).toBe("$12,345.50");
    expect(con.querySelector('[data-testid="sparkline"]')).not.toBeNull();
    expect(con.textContent).toContain("↑ 8%");
    const sin = montar(<KpiTile icono={<Activity />} etiqueta="Costo" valor={5} sparkline={[1]} tendencia={8} />);
    expect(sin.querySelector('[data-testid="sparkline"]')).toBeNull();
    expect(sin.textContent).not.toContain("↑");
  });
  it("la nota fija se pinta siempre que se pasa", () => {
    expect(montar(<KpiTile icono={<Activity />} etiqueta="IVA" valor={1} nota="LIF 2026" />).textContent).toContain("LIF 2026");
  });
});

describe("ChartCard", () => {
  it("titulo, subtitulo, accion y alto minimo por tamano", () => {
    const el = montar(
      <ChartCard titulo="Costo por dia" subtitulo="USD" tamano="L" accion={<button type="button">act</button>}>
        <span>cuerpo</span>
      </ChartCard>,
    );
    expect(el.querySelector("h3")?.textContent).toBe("Costo por dia");
    expect(el.textContent).toContain("USD");
    expect(el.querySelector("button")?.textContent).toBe("act");
    expect((el.querySelector("h3")!.closest('[data-testid="chart-card"]')!.lastElementChild as HTMLElement).style.minHeight).toBe("280px");
  });
});

describe("rango 7d / 30d / Todo", () => {
  it("resolverRango: valida el parametro y decide la ventana", () => {
    expect(resolverRango(null, "7")).toMatchObject({ rango: "7", ventana: 7, ventanaDias: 7 });
    expect(resolverRango("30", "7")).toMatchObject({ rango: "30", ventana: 30 });
    expect(resolverRango("todo", "30")).toMatchObject({ rango: "todo", ventana: undefined, ventanaDias: 30 });
    expect(resolverRango("basura", "30")).toMatchObject({ rango: "30" });
  });
  it("VIAJE REDONDO: la URL de cada pildora vuelve a leerse como el rango que dice, con cualquier default", () => {
    for (const pordefecto of ["7", "30", "todo"] as const) {
      for (const rango of ["7", "30", "todo"] as const) {
        const url = urlDeRango("/superadmin/analitica", rango, pordefecto, { vertical: "citas" });
        const qs = new URL(url, "https://x.test").searchParams;
        expect(resolverRango(qs.get("rango"), pordefecto).rango, `${pordefecto}->${rango}`).toBe(rango);
        expect(qs.get("vertical")).toBe("citas");
      }
    }
    expect(urlDeRango("/x", "7", "7")).toBe("/x");
  });
  it("GlobalFilter pinta 7d / 30d / Todo con enlaces reales y marca el activo", () => {
    const el = montar(<GlobalFilter base="/superadmin/analitica" r={resolverRango("30", "7")} />, "/superadmin/analitica?rango=30");
    const enlaces = [...el.querySelectorAll("a")];
    expect(enlaces.map((a) => a.textContent)).toEqual(["7d", "30d", "Todo"]);
    expect(enlaces.map((a) => a.getAttribute("href"))).toEqual(["/superadmin/analitica", "/superadmin/analitica?rango=30", "/superadmin/analitica?rango=todo"]);
    expect(enlaces.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
  });
});

describe("resolverFormato", () => {
  it("presets con separador de miles es-MX", () => {
    expect(resolverFormato("entero")(42350.4)).toBe("42,350");
    expect(resolverFormato("porcentajeSigno")(22)).toBe("+22%");
    expect(resolverFormato("porcentajeSigno")(-8)).toBe("-8%");
    expect(resolverFormato("usd")(1234.5)).toBe("US$1,234.50");
  });
});
