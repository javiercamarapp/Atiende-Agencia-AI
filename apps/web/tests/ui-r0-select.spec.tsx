// @vitest-environment jsdom
//
// UNI-R0: Select (lista desplegable unica, Radix como el repo suelto) y Selector (forma "de una linea"
// compatible con <select>/<option>). Teclado, ARIA, valor vacio, grupos, deshabilitadas y movimiento.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Selector } from "@atiende/ui";
import preset from "../../../packages/ui/src/tailwind-preset.ts";
import { click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

// jsdom no implementa estas APIs de puntero/scroll que Radix Select usa al abrir la lista.
beforeAll(() => {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p.hasPointerCapture ??= () => false;
  p.setPointerCapture ??= () => {};
  p.releasePointerCapture ??= () => {};
  p.scrollIntoView ??= () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const combo = () => document.body.querySelector<HTMLElement>('[role="combobox"]')!;
const lista = () => document.body.querySelector<HTMLElement>('[role="listbox"]');
const opciones = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const abrir = async () => {
  combo().focus();
  keydown(combo(), "Enter");
  await act(async () => flushMicrotasks());
};

describe("Selector", () => {
  it("es un combobox con nombre accesible y muestra la etiqueta de la opcion elegida", () => {
    rendered = renderComponent(
      <Selector aria-label="Estado" value="b" onValueChange={() => {}}>
        <option value="a">Alfa</option>
        <option value="b">Beta</option>
      </Selector>,
    );
    expect(combo().getAttribute("aria-label")).toBe("Estado");
    expect(combo().textContent).toContain("Beta");
  });

  it("abre con Enter, muestra las opciones con check en la elegida y elige con teclado + Enter", async () => {
    const onChange = vi.fn();
    const onValueChange = vi.fn();
    rendered = renderComponent(
      <Selector aria-label="Estado" name="estado" value="a" onChange={onChange} onValueChange={onValueChange}>
        <option value="a">Alfa</option>
        <option value="b">Beta</option>
        <option value="c" disabled>
          Gamma
        </option>
      </Selector>,
    );
    await abrir();
    expect(lista()).not.toBeNull();
    expect(opciones().map((o) => o.textContent)).toEqual(["Alfa", "Beta", "Gamma"]);
    expect(opciones()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(opciones()[2]!.getAttribute("aria-disabled")).toBe("true");
    // en jsdom el foco inicial tarda un cuadro: se enfoca la opcion y se confirma con Enter (como el teclado real)
    opciones()[1]!.focus();
    keydown(opciones()[1]!, "Enter");
    await act(async () => flushMicrotasks());
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(onChange).toHaveBeenCalledWith({ target: { value: "b", name: "estado" }, currentTarget: { value: "b", name: "estado" } });
    expect(lista()).toBeNull();
  });

  it("Escape cierra sin cambiar y devuelve el foco al disparador", async () => {
    const onValueChange = vi.fn();
    rendered = renderComponent(
      <Selector aria-label="Estado" value="a" onValueChange={onValueChange}>
        <option value="a">Alfa</option>
        <option value="b">Beta</option>
      </Selector>,
    );
    await abrir();
    keydown(document.activeElement ?? document.body, "Escape");
    // Radix devuelve el foco al disparador en un temporizador propio
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(lista()).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(combo());
  });

  it('la opcion de valor "" (Todos) se elige y se informa como cadena vacia', async () => {
    const onValueChange = vi.fn();
    rendered = renderComponent(
      <Selector aria-label="Filtro" value="x" onValueChange={onValueChange}>
        <option value="">Todos</option>
        <option value="x">Equis</option>
      </Selector>,
    );
    await abrir();
    const todos = opciones().find((o) => o.textContent === "Todos")!;
    click(todos);
    keydown(todos, "Enter");
    await act(async () => flushMicrotasks());
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it('con value="" muestra la etiqueta de la opcion vacia', () => {
    rendered = renderComponent(
      <Selector aria-label="Filtro" value="" onValueChange={() => {}}>
        <option value="">Todos</option>
        <option value="x">Equis</option>
      </Selector>,
    );
    expect(combo().textContent).toContain("Todos");
  });

  it("optgroup se vuelve grupo con etiqueta", async () => {
    rendered = renderComponent(
      <Selector aria-label="Zona" value="a" onValueChange={() => {}}>
        <optgroup label="Norte">
          <option value="a">Uno</option>
        </optgroup>
        <optgroup label="Sur">
          <option value="b">Dos</option>
        </optgroup>
      </Selector>,
    );
    await abrir();
    const grupos = [...document.body.querySelectorAll('[role="group"]')];
    expect(grupos.map((g) => g.textContent)).toEqual(["NorteUno", "SurDos"]);
  });

  it("sin opcion vacia, value=\"\" muestra el marcador (placeholder)", () => {
    rendered = renderComponent(
      <Selector aria-label="Zona" value="" placeholder="Selecciona una zona" onValueChange={() => {}}>
        <option value="a">Uno</option>
      </Selector>,
    );
    expect(combo().textContent).toContain("Selecciona una zona");
    expect(combo().hasAttribute("data-placeholder")).toBe(true);
  });

  it("deshabilitado no abre; aria-invalid y descripcion se propagan al disparador", () => {
    rendered = renderComponent(
      <Selector aria-label="Estado" disabled aria-invalid="true" aria-describedby="ayuda" value="a" onValueChange={() => {}}>
        <option value="a">Alfa</option>
      </Selector>,
    );
    expect(combo().hasAttribute("disabled")).toBe(true);
    expect(combo().getAttribute("aria-invalid")).toBe("true");
    expect(combo().getAttribute("aria-describedby")).toBe("ayuda");
  });
});

describe("Select compuesto", () => {
  it("lista flotante con la receta unica: hairline, popover, sombra elevada y movimiento apagable", async () => {
    rendered = renderComponent(
      <Select value="a" onValueChange={() => {}}>
        <SelectTrigger aria-label="Letra">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alfa</SelectItem>
        </SelectContent>
      </Select>,
    );
    await abrir();
    const c = lista()!.closest<HTMLElement>("[data-radix-popper-content-wrapper] > *") ?? lista()!.parentElement!;
    const clases = (document.body.querySelector<HTMLElement>('[role="listbox"]')!.closest("[data-side]") as HTMLElement).className;
    for (const k of ["border-border", "bg-popover", "shadow-elevated", "rounded-lg", "motion-reduce:animate-none"]) expect(clases, k).toContain(k);
    expect(c).toBeTruthy();
    // la opcion elegida lleva el azul de marca y la palomita
    expect(opciones()[0]!.className).toContain("data-[state=checked]:text-primary");
  });

  it("el preset conserva los tokens de movimiento que usan los modales (no hay un segundo sistema)", () => {
    const keyframes = (preset.theme!.extend as { keyframes: Record<string, unknown> }).keyframes;
    for (const k of ["modal-in", "sheet-up", "popover-in", "overlay-in"]) expect(keyframes[k]).toBeDefined();
  });
});
