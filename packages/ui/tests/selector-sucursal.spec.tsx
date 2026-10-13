// @vitest-environment jsdom
//
// Selector de sucursal activa (componente comun de las verticales): mismo `<select>` nativo, `<label for>` e `id` de siempre,
// con el estilo "hundido" del conmutador de tema (gris suave, sin borde duro, pildora) y, con una sola opcion, solo lectura.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectorSucursal } from "../src/components/SelectorSucursal";
import { limpiarDom, montar, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const DOS = [
  { valor: "p1", etiqueta: "Prolongación Montejo" },
  { valor: "p2", etiqueta: "Sucursal Norte con un nombre larguísimo que no cabe en la columna del Sidebar" },
];

describe("SelectorSucursal", () => {
  it("con varias opciones: select nativo con su etiqueta, valor y titulo; el cambio llega al callback", () => {
    const onCambia = vi.fn();
    montado = montar(<SelectorSucursal id="sel-1" etiqueta="Sucursal activa" opciones={DOS} valor="p1" onCambia={onCambia} />);
    const select = montado.container.querySelector<HTMLSelectElement>("select#sel-1")!;
    expect(select.value).toBe("p1");
    expect(select.title).toBe("Prolongación Montejo");
    expect(montado.container.querySelector('label[for="sel-1"]')?.textContent).toBe("Sucursal activa");
    expect([...select.options].map((o) => o.value)).toEqual(["p1", "p2"]);
    select.value = "p2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onCambia).toHaveBeenCalledWith("p2");
  });

  it("estilo hundido de la familia del conmutador de tema: gris suave, pildora, sombra interior, sin borde duro, foco con anillo", () => {
    montado = montar(<SelectorSucursal id="sel-2" etiqueta="Sucursal activa" opciones={DOS} valor="p1" onCambia={() => undefined} />);
    const clases = montado.container.querySelector("select")!.className;
    for (const c of ["bg-muted", "rounded-full", "ring-1", "ring-inset", "ring-border", "text-ui", "text-foreground", "truncate", "appearance-none", "focus-visible:ring-2", "focus-visible:ring-ring"]) {
      expect(clases, c).toContain(c);
    }
    expect(clases).toContain("shadow-[inset_");
    expect(clases).toContain("hover:bg-muted-foreground/10");
    expect(clases).not.toMatch(/(^|\s)border(\s|$)/);
    // El chevron es decorativo, pequeno y en muted-foreground.
    const chevron = montado.container.querySelector("svg")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(chevron.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("con una sola opcion: solo lectura con la misma forma, sin select ni chevron, con titulo para el texto largo", () => {
    montado = montar(<SelectorSucursal id="sel-3" etiqueta="Sucursal activa" opciones={[DOS[0]!]} valor="p1" onCambia={() => undefined} />);
    expect(montado.container.querySelector("select")).toBeNull();
    expect(montado.container.querySelector("svg")).toBeNull();
    const fijo = montado.container.querySelector<HTMLElement>('[data-testid="selector-sucursal-unica"]')!;
    expect(fijo.textContent).toBe("Prolongación Montejo");
    expect(fijo.title).toBe("Prolongación Montejo");
    expect(fijo.className).toContain("bg-muted");
    expect(fijo.className).toContain("rounded-full");
  });
});
