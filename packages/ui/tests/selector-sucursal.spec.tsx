// @vitest-environment jsdom
//
// Selector de sucursal activa (componente comun de las verticales): "hundido gris" como la zona inferior del Sidebar, con la lista del
// sistema (Radix Select de `ui/select`). Mantiene el contrato de siempre: `id` en el disparador (combobox) con su `<label for>`, el cambio llega
// a `onCambia`, y con una sola opcion queda de solo lectura con la misma forma.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SelectorSucursal } from "../src/components/SelectorSucursal";
import { limpiarDom, montar, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;

beforeAll(() => {
  // jsdom no trae las APIs de puntero/medida que Radix usa al abrir la lista.
  const p = Element.prototype as unknown as Record<string, unknown>;
  p["hasPointerCapture"] ??= () => false;
  p["setPointerCapture"] ??= () => {};
  p["releasePointerCapture"] ??= () => {};
  p["scrollIntoView"] ??= () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const DOS = [
  { valor: "p1", etiqueta: "Prolongación Montejo" },
  { valor: "p2", etiqueta: "Sucursal Norte con un nombre larguísimo que no cabe en la columna del Sidebar" },
];

function teclear(el: Element, key: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function abrir(disparador: HTMLElement) {
  await act(async () => {
    disparador.focus();
    teclear(disparador, "Enter");
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("SelectorSucursal", () => {
  it("con varias opciones: combobox con su etiqueta, nombre mostrado y titulo; elegir otra llega al callback", async () => {
    const onCambia = vi.fn();
    montado = montar(<SelectorSucursal id="sel-1" etiqueta="Sucursal activa" opciones={DOS} valor="p1" onCambia={onCambia} />);
    const disparador = montado.container.querySelector<HTMLElement>("button#sel-1")!;
    expect(disparador.getAttribute("role")).toBe("combobox");
    expect(disparador.title).toBe("Prolongación Montejo");
    expect(disparador.textContent).toContain("Prolongación Montejo");
    expect(montado.container.querySelector('label[for="sel-1"]')?.textContent).toBe("Sucursal activa");

    await abrir(disparador);
    const opciones = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(opciones.map((o) => o.dataset["valor"])).toEqual(["p1", "p2"]);
    expect(opciones[0]!.getAttribute("data-state")).toBe("checked");
    const segunda = opciones[1]!;
    await act(async () => {
      segunda.focus();
      teclear(segunda, "Enter");
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onCambia).toHaveBeenCalledWith("p2");
  });

  it("estilo hundido gris del pie del Sidebar: bg-canvas, sombra interior, hairline, radio, icono y chevron discretos, nombre truncado", () => {
    montado = montar(<SelectorSucursal id="sel-2" etiqueta="Sucursal activa" opciones={DOS} valor="p2" onCambia={() => undefined} />);
    const disparador = montado.container.querySelector<HTMLElement>("button#sel-2")!;
    const clases = disparador.className;
    for (const c of ["bg-canvas", "border-border", "rounded-xl", "text-ui", "font-medium", "text-foreground", "hover:bg-muted", "data-[state=open]:bg-muted", "focus-visible:ring-2", "focus-visible:ring-ring"]) {
      expect(clases, c).toContain(c);
    }
    expect(clases).toContain("shadow-hundido");
    expect(clases).toContain("data-[state=open]:shadow-hundido-abierto");
    expect(clases).toContain("motion-reduce:transition-none");
    // El nombre largo se trunca en una sola linea (el titulo conserva el texto completo).
    const nombre = disparador.querySelector('[data-slot="valor"]')!;
    expect(nombre.className).toContain("truncate");
    expect(disparador.title).toContain("larguísimo");
    // Icono de tienda y chevron: decorativos, pequenos, en muted-foreground.
    // (el icono de tienda se oculta en movil: ahi el espacio es para el nombre)
    const svgs = [...disparador.querySelectorAll("svg")];
    expect(svgs).toHaveLength(2);
    for (const s of svgs) expect(s.getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0]!.getAttribute("class")).toContain("text-muted-foreground");
    expect(clases).toContain("[&>svg:last-child]:size-3.5");
  });

  it("con una sola opcion: solo lectura con la misma forma, sin combobox ni chevron, con titulo para el texto largo", () => {
    montado = montar(<SelectorSucursal id="sel-3" etiqueta="Sucursal activa" opciones={[DOS[0]!]} valor="p1" onCambia={() => undefined} />);
    expect(montado.container.querySelector('[role="combobox"]')).toBeNull();
    const fijo = montado.container.querySelector<HTMLElement>('[data-testid="selector-sucursal-unica"]')!;
    expect(fijo.textContent).toBe("Prolongación Montejo");
    expect(fijo.title).toBe("Prolongación Montejo");
    expect(fijo.className).toContain("bg-canvas");
    expect(fijo.className).toContain("rounded-xl");
    // Solo el icono de tienda: sin flecha, no hay nada que elegir.
    expect(fijo.querySelectorAll("svg")).toHaveLength(1);
    expect(montado.container.textContent).toContain("Sucursal activa");
  });
});
