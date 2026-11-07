// @vitest-environment jsdom
//
// Paridad Rovaq del Resumen bajo ds3 (PARIDAD-ATIENDE-ROVAQ #5, #6, #18): eyebrow «RESUMEN», H1 20/600/-0.5, frase con las cifras en
// negritas que sustituye al subtitulo y al odometro, tira de KPI en UNA tarjeta con celdas, borde superior de 3 px del color de la
// metrica, valor 26/700/-0.52 y sello «● Observado · fuente». La bandera vive en CSS: aqui se prueba el marcado (ganchos data-parte,
// sin cambiar las clases de Likida) y que cifra.css trae las reglas, todas bajo html[data-diseno="ds3"].
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Activity } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ResumenLayout, StatCard } from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/cifra.css"), "utf8");

let root: Root | null = null;
let host: HTMLElement | null = null;
function montar(ui: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

/** Bloque de reglas de un selector (texto entre llaves) en cifra.css. */
function regla(selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `falta la regla ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
}

describe("ResumenLayout bajo ds3 (marcado)", () => {
  it("pinta eyebrow y frase ocultos por omision; la frase lleva las cifras en <strong>", () => {
    const el = montar(
      <ResumenLayout
        saludo="Buenas noches"
        nombre="Owner"
        subtitulo="taqueria · 7 dias"
        frase={
          <>
            Ventas netas: <strong>$45,231.00</strong>.
          </>
        }
        destacado={<span data-testid="odometro">X</span>}
      />,
    );
    const raiz = el.querySelector(".ds3-resumen")!;
    expect(raiz.hasAttribute("data-con-frase")).toBe(true);
    const eyebrow = el.querySelector('[data-parte="eyebrow"]')!;
    expect(eyebrow.textContent).toBe("Resumen");
    expect(eyebrow.className).toBe("hidden");
    const frase = el.querySelector('[data-testid="resumen-frase"]')!;
    expect(frase.className).toBe("hidden");
    expect(frase.querySelector("strong")!.textContent).toBe("$45,231.00");
    // Un solo h1 y conserva el saludo (las pruebas de Likida siguen valiendo con la bandera apagada).
    expect(el.querySelectorAll("h1")).toHaveLength(1);
    expect(el.querySelector("h1")!.textContent).toBe("Buenas noches, Owner");
    expect(el.querySelector('[data-parte="destacado"] [data-testid="odometro"]')).not.toBeNull();
  });

  it("sin frase no marca data-con-frase (el subtitulo y el destacado siguen bajo ds3)", () => {
    const el = montar(<ResumenLayout saludo="Hola" nombre="Ana" subtitulo="x" />);
    expect(el.querySelector(".ds3-resumen")!.hasAttribute("data-con-frase")).toBe(false);
    expect(el.querySelector('[data-testid="resumen-frase"]')).toBeNull();
  });

  it("eyebrow configurable y la rejilla de KPI expone data-parte=kpis", () => {
    const el = montar(<ResumenLayout saludo="Hola" nombre="Ana" eyebrow="Operación" kpis={[<div key="a">a</div>]} />);
    expect(el.querySelector('[data-parte="eyebrow"]')!.textContent).toBe("Operación");
    expect(el.querySelector('[data-parte="kpis"]')!.textContent).toBe("a");
  });
});

describe("StatCard: sello de clase", () => {
  it("«Observado · fuente · cuando» solo si la pagina lo trae; nunca en carga ni sin dato", () => {
    const el = montar(<StatCard icon={Activity} label="Ventas" value="$10" sello={{ clase: "observado", fuente: "pedidos de Atiende", cuando: "hace 5 min" }} />);
    const s = el.querySelector('[data-testid="stat-card-sello"]')!;
    expect(s.textContent).toBe("Observado · pedidos de Atiende · hace 5 min");
    expect(s.getAttribute("data-clase")).toBe("observado");
    expect(s.className).toContain("hidden");
    act(() => root?.unmount());
    expect(montar(<StatCard icon={Activity} label="V" value="$10" />).querySelector('[data-testid="stat-card-sello"]')).toBeNull();
    act(() => root?.unmount());
    expect(montar(<StatCard icon={Activity} label="V" value="$10" sinDato="sin fuente" sello={{ clase: "estimado", fuente: "x" }} />).querySelector('[data-testid="stat-card-sello"]')).toBeNull();
  });
});

describe("cifra.css: reglas de paridad, todas bajo la bandera", () => {
  it("eyebrow 12/600 MAYUSCULAS tracking 0.72 px y H1 20/600/-0.5 en px de Rovaq", () => {
    const e = regla('html[data-diseno="ds3"] .ds3-resumen [data-parte="eyebrow"]');
    expect(e).toMatch(/font-size: 12px;/);
    expect(e).toMatch(/font-weight: 600;/);
    expect(e).toMatch(/letter-spacing: 0\.72px;/);
    expect(e).toMatch(/text-transform: uppercase;/);
    const h = regla('html[data-diseno="ds3"] .ds3-resumen [data-parte="titulo"]');
    expect(h).toMatch(/font-size: 20px;/);
    expect(h).toMatch(/font-weight: 600;/);
    expect(h).toMatch(/letter-spacing: -0\.5px;/);
  });

  it("con frase se ocultan el subtitulo, el odometro y la linea movil duplicada", () => {
    expect(css).toMatch(/\.ds3-resumen\[data-con-frase\] \[data-parte="subtitulo"\],\s*html\[data-diseno="ds3"\] \.ds3-resumen\[data-con-frase\] \[data-parte="destacado"\] \[data-testid="odometro"\],\s*html\[data-diseno="ds3"\] \.ds3-resumen\[data-con-frase\] \[data-parte="destacado"\] \.ds3-resumen-movil \{\s*display: none;/);
  });

  it("tira de KPI: una tarjeta radio 12, filetes de 1 px, borde superior de 3 px del color de la metrica y punto en la etiqueta", () => {
    const t = regla('html[data-diseno="ds3"] .ds3-resumen [data-parte="kpis"] {');
    expect(t).toMatch(/border-radius: 12px;/);
    expect(t).toMatch(/overflow: hidden;/);
    const c = regla('html[data-diseno="ds3"] .ds3-resumen [data-parte="kpis"] > * {');
    expect(c).toMatch(/box-shadow: inset 0 3px 0 hsl\(var\(--kpi-color\)\);/);
    expect(css).toMatch(/:nth-child\(4n \+ 2\) \{ --kpi-color: var\(--chart-2\); \}/);
    expect(regla('html[data-diseno="ds3"] .ds3-resumen [data-parte="kpis"] :is(.ds3-stat-label, .ds3-kpi-label)::before')).toMatch(/background-color: hsl\(var\(--kpi-color\)\);/);
  });

  it("valor KPI 26/700 tracking -0.52 px; se ajusta al ancho de la tarjeta y nunca se corta con «…»", () => {
    const v = regla('html[data-diseno="ds3"] :is(.ds3-stat-valor, .ds3-kpi-valor) {');
    expect(v).toMatch(/font-size: min\(26px, 10cqi\);/);
    expect(v).toMatch(/text-overflow: clip;/);
    expect(regla('html[data-diseno="ds3"] .cifra {')).not.toMatch(/ellipsis/);
    expect(css).toMatch(/\.cifra\[data-abrev\]::after \{ content: attr\(data-abrev\); content: attr\(data-abrev\) \/ ""; \}/);
    expect(v).toMatch(/font-weight: 700;/);
    expect(v).toMatch(/letter-spacing: -0\.52px;/);
  });

  it("toda regla con selector de la hoja (fuera de la escala de tamanos y los @keyframes) esta bajo html[data-diseno=\"ds3\"]", () => {
    const selectores = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim());
    const libres = selectores.filter((s) => !s.startsWith("html[data-diseno=\"ds3\"]") && !s.startsWith(".cifra[data-tamano=") && !/^(from|to)$/.test(s));
    expect(libres).toEqual([]);
  });
});
