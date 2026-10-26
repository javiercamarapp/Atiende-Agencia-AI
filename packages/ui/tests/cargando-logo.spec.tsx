// @vitest-environment jsdom
//
// ds3 / 2.1: CargandoLogo + coordinador (R15, E20, E23). Timers falsos: los 120 ms, la permanencia y la fase son deterministas.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CargandoLogo } from "../src/components/CargandoLogo";
import {
  CARGA_CICLO_MS,
  CARGA_PERMANENCIA_MS,
  CARGA_RETARDO_MS,
  faseCarga,
  registrarCarga,
  reiniciarCoordinadorCarga,
  useCargaRetenida,
} from "../src/lib/carga-coordinador";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return { root, el };
}
const avanzar = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const visibles = () => Array.from(document.querySelectorAll('[data-carga-visible="true"]'));

beforeEach(() => {
  vi.useFakeTimers();
  reiniciarCoordinadorCarga();
});
afterEach(() => {
  act(() => raices.forEach((r) => r.root.unmount()));
  raices.forEach((r) => r.el.remove());
  raices = [];
  reiniciarCoordinadorCarga();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CargandoLogo: ARIA", () => {
  it("role=status, aria-busy, aria-live, aria-label y texto sr-only (etiqueta por defecto y contextual)", () => {
    const { el } = montar(createElement(CargandoLogo));
    const nodo = el.querySelector('[role="status"]')!;
    expect(nodo.getAttribute("aria-busy")).toBe("true");
    expect(nodo.getAttribute("aria-live")).toBe("polite");
    expect(nodo.getAttribute("aria-label")).toBe("Cargando…");
    const oculto = nodo.querySelector(".sr-only")!;
    expect(oculto.textContent).toBe("Cargando…");
    expect(nodo.querySelector('[aria-hidden="true"]')).not.toBeNull();

    const otro = montar(createElement(CargandoLogo, { etiqueta: "Cargando notificaciones", "data-atiende-carga-ruta": "" } as never));
    const n2 = otro.el.querySelector('[role="status"]')!;
    expect(n2.getAttribute("aria-label")).toBe("Cargando notificaciones");
    expect(n2.querySelector(".sr-only")!.textContent).toBe("Cargando notificaciones");
    expect(n2.hasAttribute("data-atiende-carga-ruta")).toBe(true);
  });

  it("no pinta texto visible: lo unico legible fuera de sr-only/aria-hidden no existe", () => {
    const { el } = montar(createElement(CargandoLogo, { tamano: "pantalla" }));
    const nodo = el.querySelector('[role="status"]')!;
    const dibujo = nodo.querySelector('[aria-hidden="true"]')!;
    const clon = nodo.cloneNode(true) as HTMLElement;
    clon.querySelectorAll(".sr-only").forEach((n) => n.remove());
    clon.querySelector('[aria-hidden="true"]')!.remove();
    expect(clon.textContent).toBe("");
    expect(dibujo.querySelector("svg")).not.toBeNull();
  });

  it("conserva las clases que pase quien llama (min-height de la region)", () => {
    const { el } = montar(createElement(CargandoLogo, { tamano: "panel", className: "min-h-[240px]" }));
    expect(el.querySelector('[role="status"]')!.className).toContain("min-h-[240px]");
  });
});

describe("CargandoLogo: retardo de 120 ms (R15)", () => {
  it("no se ve antes de 120 ms y si despues", () => {
    montar(createElement(CargandoLogo));
    expect(visibles()).toHaveLength(0);
    avanzar(CARGA_RETARDO_MS - 1);
    expect(visibles()).toHaveLength(0);
    avanzar(1);
    expect(visibles()).toHaveLength(1);
  });

  it("si se desmonta antes de 120 ms nunca se llego a ver", () => {
    const { root } = montar(createElement(CargandoLogo));
    avanzar(100);
    act(() => root.unmount());
    avanzar(500);
    expect(visibles()).toHaveLength(0);
  });

  it("antes de aparecer el dibujo esta oculto pero el nodo sigue siendo role=status", () => {
    const { el } = montar(createElement(CargandoLogo));
    const dibujo = el.querySelector(".carga-logo")!;
    expect(dibujo.className).toContain("invisible");
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    avanzar(CARGA_RETARDO_MS);
    expect(dibujo.className).not.toContain("invisible");
  });
});

describe("coordinador: un solo dibujo visible", () => {
  it("con varias cargas solo una dibuja; gana pantalla > panel > linea y las demas siguen con role=status", () => {
    const { el } = montar(
      createElement("div", null,
        createElement(CargandoLogo, { tamano: "linea", etiqueta: "A" }),
        createElement(CargandoLogo, { tamano: "panel", etiqueta: "B" }),
        createElement(CargandoLogo, { tamano: "panel", etiqueta: "C" }),
      ),
    );
    avanzar(CARGA_RETARDO_MS);
    expect(visibles()).toHaveLength(1);
    expect(visibles()[0]!.getAttribute("aria-label")).toBe("B");
    expect(el.querySelectorAll('[role="status"][aria-busy="true"]')).toHaveLength(3);
    expect(el.querySelectorAll(".sr-only")).toHaveLength(3);
    expect(el.querySelectorAll(".carga-logo.invisible")).toHaveLength(2);

    const pantalla = montar(createElement(CargandoLogo, { tamano: "pantalla", etiqueta: "P" }));
    avanzar(CARGA_RETARDO_MS);
    expect(visibles()).toHaveLength(1);
    expect(visibles()[0]!.getAttribute("aria-label")).toBe("P");

    act(() => pantalla.root.unmount());
    expect(visibles()).toHaveLength(1);
    expect(visibles()[0]!.getAttribute("aria-label")).toBe("B");
  });

  it("registrarCarga: soltar es idempotente y libera el turno", () => {
    const a = registrarCarga("panel");
    const b = registrarCarga("panel");
    avanzar(CARGA_RETARDO_MS);
    a.soltar();
    a.soltar();
    b.soltar();
    expect(() => avanzar(1000)).not.toThrow();
  });
});

describe("permanencia minima (R15)", () => {
  function Sonda({ cargando, tamano }: { cargando: boolean; tamano: "pantalla" | "panel" | "linea" }) {
    return createElement("span", { "data-retenida": String(useCargaRetenida(cargando, tamano)) });
  }
  const leer = () => document.querySelector("[data-retenida]")!.getAttribute("data-retenida");

  it("panel: si la carga acaba antes de 120 ms no se retiene", () => {
    const { root } = montar(createElement(Sonda, { cargando: true, tamano: "panel" }));
    avanzar(100);
    act(() => root.render(createElement(Sonda, { cargando: false, tamano: "panel" })));
    expect(leer()).toBe("false");
  });

  it("panel: tras aparecer (120 ms) se retiene 400 ms desde la aparicion", () => {
    const { root } = montar(createElement(Sonda, { cargando: true, tamano: "panel" }));
    avanzar(CARGA_RETARDO_MS + 10);
    act(() => root.render(createElement(Sonda, { cargando: false, tamano: "panel" })));
    expect(leer()).toBe("true");
    avanzar(CARGA_PERMANENCIA_MS.panel - 11);
    expect(leer()).toBe("true");
    avanzar(1);
    expect(leer()).toBe("false");
  });

  it("pantalla: 600 ms estables desde la aparicion; carga larga no retiene nada", () => {
    const { root } = montar(createElement(Sonda, { cargando: true, tamano: "pantalla" }));
    avanzar(CARGA_RETARDO_MS + 200);
    act(() => root.render(createElement(Sonda, { cargando: false, tamano: "pantalla" })));
    expect(leer()).toBe("true");
    avanzar(CARGA_PERMANENCIA_MS.pantalla - 200 - 1);
    expect(leer()).toBe("true");
    avanzar(1);
    expect(leer()).toBe("false");

    act(() => root.render(createElement(Sonda, { cargando: true, tamano: "linea" })));
    avanzar(5000);
    act(() => root.render(createElement(Sonda, { cargando: false, tamano: "linea" })));
    expect(leer()).toBe("false");
  });
});

describe("remonte sin reinicio de fase", () => {
  it("faseCarga deriva del reloj global (modulo del ciclo, negativo)", () => {
    expect(faseCarga(0)).toBe("-0ms");
    expect(faseCarga(1000)).toBe("-1000ms");
    expect(faseCarga(CARGA_CICLO_MS + 250)).toBe("-250ms");
  });

  it("un logo remontado a otro instante recibe la fase del reloj global, no 0", () => {
    const ahora = vi.spyOn(performance, "now");
    ahora.mockReturnValue(1000);
    const a = montar(createElement(CargandoLogo));
    avanzar(CARGA_RETARDO_MS);
    expect(a.el.querySelector<HTMLElement>(".carga-logo")!.style.getPropertyValue("--carga-fase")).toBe("-1000ms");

    act(() => a.root.unmount());
    ahora.mockReturnValue(1000 + CARGA_CICLO_MS + 300);
    const b = montar(createElement(CargandoLogo));
    avanzar(CARGA_RETARDO_MS);
    expect(b.el.querySelector<HTMLElement>(".carga-logo")!.style.getPropertyValue("--carga-fase")).toBe("-1300ms");
  });
});

describe("reduced-motion (E20) y keyframes", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");

  it("la animacion usa atiende-respira, solo opacity y transform", () => {
    const kf = /@keyframes atiende-respira\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(kf).toMatch(/opacity/);
    expect(kf).toMatch(/transform:\s*scale/);
    expect(kf.replace(/opacity|transform|scale|[\d.%,\s:;(){}-]/g, "")).toBe("");
    expect(css).toMatch(/\.carga-logo\s*\{[^}]*animation:\s*atiende-respira[^}]*infinite/);
  });

  it("con prefers-reduced-motion el logo queda estatico (sin animacion, opacity .6)", () => {
    const bloque = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.carga-logo\s*\{([^}]*)\}/.exec(css);
    expect(bloque).not.toBeNull();
    expect(bloque![1]).toMatch(/animation:\s*none/);
    expect(bloque![1]).toMatch(/opacity:\s*0?\.6/);
  });
});
