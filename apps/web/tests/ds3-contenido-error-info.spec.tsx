// @vitest-environment jsdom
//
// ds3 / componentes de contenido, parte 3 (PARIDAD-ATIENDE-ROVAQ §R1 #7 y #10):
//  (1) EstadoError: un texto tecnico se pliega bajo ds3 (explicacion humana + «Ver detalle técnico») sin duplicarse en el DOM, y siempre
//      hay «Reintentar» (el del handler, o uno que recarga la pantalla; nunca si falta configurar credenciales);
//  (2) (i) «Cómo se calculó»: boton de 32 px que abre el Drawer con solo las secciones que traen dato;
//  (3) reglas de ds3/contenido.css. Sin la bandera nada cambia (los ds3-solo llevan `hidden`). Solo AÑADE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConInfoCalculo, EstadoError, InfoCalculo, pareceErrorTecnico, StatCard } from "@atiende/ui";
import { Activity } from "lucide-react";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ui/src/ds3/contenido.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function regla(fragmento: string): string {
  const i = CSS.indexOf(fragmento);
  expect(i, `falta la regla ${fragmento}`).toBeGreaterThanOrEqual(0);
  const abre = CSS.indexOf("{", i);
  return CSS.slice(abre + 1, CSS.indexOf("}", abre));
}

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});
const q = <T extends HTMLElement = HTMLElement>(sel: string) => rendered!.container.querySelector<T>(sel);
const click = (el: Element) => act(() => (el as HTMLElement).click());

describe("pareceErrorTecnico", () => {
  it.each([
    ["HTTP 500 Internal Server Error", true],
    ["TypeError: Failed to fetch", true],
    ['{"error":"boom"}', true],
    ["relation organization_settings does not exist", true],
    ["GET /v1/restaurantes/x/admin/kpis/sales", true],
    ["No se pudieron cargar los KPIs.", false],
    ["Ocurrió un problema al abrir esta sección. Inténtalo de nuevo.", false],
  ])("%s -> %s", (texto, esperado) => {
    expect(pareceErrorTecnico(texto)).toBe(esperado);
  });
});

describe("EstadoError bajo ds3", () => {
  it("texto tecnico: explicacion humana (oculta sin bandera), el tecnico UNA sola vez y plegado con «Ver detalle técnico»", () => {
    rendered = renderComponent(<EstadoError mensaje="HTTP 500 Internal Server Error" onReintentar={() => {}} />);
    const humano = q(".ds3-error-humano")!;
    expect(humano.hidden).toBe(true);
    expect(humano.textContent).toBe("No está disponible ahora. Vuelve a intentarlo en un momento.");
    const tecnicos = [...rendered.container.querySelectorAll("p")].filter((p) => p.textContent === "HTTP 500 Internal Server Error");
    expect(tecnicos).toHaveLength(1);
    expect(tecnicos[0]!.classList.contains("ds3-no")).toBe(true);
    const ver = q<HTMLButtonElement>(".ds3-error-ver")!;
    expect(ver.hidden).toBe(true);
    expect(ver.getAttribute("aria-expanded")).toBe("false");
    click(ver);
    expect(ver.getAttribute("aria-expanded")).toBe("true");
    expect(ver.textContent).toBe("Ocultar detalle técnico");
    expect(tecnicos[0]!.classList.contains("ds3-no")).toBe(false);
    // El primer boton sigue siendo «Reintentar» del handler (las pruebas existentes hacen querySelector("button")).
    expect(rendered.container.querySelector("button")!.textContent).toBe("Reintentar");
  });

  it("mensaje humano: se muestra tal cual, sin pliegue", () => {
    rendered = renderComponent(<EstadoError mensaje="No se pudieron cargar los KPIs." />);
    expect(q(".ds3-error-humano")).toBeNull();
    expect(q(".ds3-error-ver")).toBeNull();
    expect([...rendered.container.querySelectorAll("p")].some((p) => p.textContent === "No se pudieron cargar los KPIs." && !p.classList.contains("ds3-no"))).toBe(true);
  });

  it("sin handler hay «Reintentar» ds3 (oculto sin bandera) que recarga; con credenciales pendientes no", () => {
    const recargar = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload: recargar } });
    try {
      rendered = renderComponent(<EstadoError />);
      const b = q<HTMLButtonElement>("button.ds3-reintentar")!;
      expect(b.hidden).toBe(true);
      expect(b.classList.contains("ds3-solo")).toBe(true);
      expect(b.textContent).toBe("Reintentar");
      click(b);
      expect(recargar).toHaveBeenCalledTimes(1);
      rendered.rerender(<EstadoError integracion="PMS" pendienteCredenciales />);
      expect(rendered.container.querySelector("button")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("con handler: un solo «Reintentar» (el del handler, con gancho ds3)", () => {
    const fn = vi.fn();
    rendered = renderComponent(<EstadoError onReintentar={fn} />);
    const botones = [...rendered.container.querySelectorAll("button")];
    expect(botones).toHaveLength(1);
    expect(botones[0]!.classList.contains("ds3-reintentar")).toBe(true);
    click(botones[0]!);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("(i) «Cómo se calculó»", () => {
  it("boton oculto sin bandera con nombre accesible; abre el Drawer solo con las secciones que traen dato", () => {
    rendered = renderComponent(<InfoCalculo datos={{ titulo: "Ventas", como: "Suma de pedidos.", fuente: "Pedidos de Atiende", clase: "observado" }} />);
    const b = q<HTMLButtonElement>('[data-testid="info-calculo"]')!;
    expect(b.hidden).toBe(true);
    expect(b.getAttribute("aria-label")).toBe("Cómo se calculó: Ventas");
    click(b);
    const panel = document.querySelector('[data-testid="info-calculo-panel"]')!;
    expect(panel).not.toBeNull();
    const dialogo = document.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("Cómo se calculó: Ventas");
    expect(panel.textContent).toContain("Cómo se calcula");
    expect(panel.textContent).toContain("Suma de pedidos.");
    expect([...panel.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["De dónde sale"]);
    expect(panel.textContent).not.toContain("Periodo");
    expect(panel.textContent).not.toContain("Qué no sabemos");
    expect(dialogo.textContent).toContain("Clase de dato");
  });

  it("ConInfoCalculo envuelve la tarjeta sin cambiarla y pone el (i) flotante", () => {
    rendered = renderComponent(
      <ConInfoCalculo datos={{ titulo: "Órdenes", periodo: "7 días", queNoSabemos: ["Ventas fuera de Atiende."] }}>
        <StatCard icon={Activity} label="Órdenes" value="96" />
      </ConInfoCalculo>,
    );
    const env = q(".ds3-con-info")!;
    expect(env.className).toContain("relative");
    expect(env.querySelector(".ds3-stat")).not.toBeNull();
    expect(env.querySelector('[data-testid="info-calculo"]')!.classList.contains("ds3-info-flotante")).toBe(true);
  });
});

describe("ds3/contenido.css: error e (i)", () => {
  it("Reintentar en primario suave de 30 px radio 8; (i) de 32 px radio 8 y 1 px, flotante a 14 px", () => {
    const r = regla('html[data-diseno="ds3"] .ds3-reintentar.ds3-reintentar {');
    expect(r).toMatch(/height: 30px;/);
    expect(r).toMatch(/border-radius: 8px;/);
    expect(r).toMatch(/background-color: hsl\(var\(--primary-soft\)\);/);
    expect(regla('html[data-diseno="ds3"] .ds3-reintentar.ds3-reintentar::before {')).toMatch(/content: "↻" \/ "";/);
    const i = regla('html[data-diseno="ds3"] .ds3-info-calculo.ds3-solo {');
    expect(i).toMatch(/width: 32px;/);
    expect(i).toMatch(/height: 32px;/);
    expect(i).toMatch(/border-radius: 8px;/);
    expect(i).toMatch(/border: 1px solid hsl\(var\(--border\)\);/);
    expect(regla('html[data-diseno="ds3"] .ds3-info-flotante.ds3-info-flotante {')).toMatch(/top: 14px; right: 14px;|position: absolute; top: 14px; right: 14px;/);
  });
});
