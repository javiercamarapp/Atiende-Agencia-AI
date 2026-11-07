// @vitest-environment jsdom
//
// ds3 / lote 5 (carga): la UNICA capa de carga a pantalla completa. Se prueba el gobierno (`gobernarArranque`) con timers falsos:
// suelta tras 600 ms estables, no se suelta mientras haya carga pendiente, en navegacion solo aparece si la carga pasa de 250 ms y dura
// >= 400 ms, no aparece en /login, y tiene tope de 45 s. Ademas: `CapaArranque` no toca <html> si la capa no se pinta (diseno actual),
// la capa existe en index.html con `hidden`, y la hoja la anima con los valores de referencia. Solo AÑADE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapaArranque } from "../src/components/CapaArranque";
import {
  ARRANQUE_ESTABLE_MS,
  ARRANQUE_MINIMO_MS,
  ARRANQUE_RETARDO_MS,
  ARRANQUE_TOPE_MS,
  gobernarArranque,
  hayCargaPendiente,
} from "../src/lib/arranque";
import { keyframes, valorCss } from "./ds3-shell-css-utils";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = document.documentElement;
let ruta = "/restaurantes/demo";
let limpiar: (() => void) | undefined;

function montarRoot(contenido: string): HTMLElement {
  document.body.innerHTML = `<div id="arranque" hidden></div><div id="root">${contenido}</div>`;
  return document.getElementById("root")!;
}

/** Avanza el reloj y vacia las microtareas (el observador evalua en una microtarea). */
async function avanzar(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  delete raiz.dataset.arranque;
  ruta = "/restaurantes/demo";
});
afterEach(() => {
  limpiar?.();
  limpiar = undefined;
  vi.useRealTimers();
  delete raiz.dataset.arranque;
  document.body.innerHTML = "";
});

const iniciar = () => {
  limpiar = gobernarArranque({ raiz, documento: document, ruta: () => ruta });
};

describe("ds3 — capa de arranque: carga inicial", () => {
  it("con la pantalla lista se suelta a los 600 ms estables (no antes)", async () => {
    montarRoot("<main><p>listo</p></main>");
    iniciar();
    await avanzar(ARRANQUE_ESTABLE_MS - 10);
    expect(raiz.dataset.arranque).toBeUndefined();
    await avanzar(20);
    expect(raiz.dataset.arranque).toBe("suelto");
  });

  it("no se suelta mientras haya un cargador de pantalla o un aria-busy en <main>; la ventana estable empieza al terminar", async () => {
    const root = montarRoot('<main><div role="status" aria-busy="true" data-carga-tamano="panel"></div></main>');
    iniciar();
    await avanzar(5_000);
    expect(raiz.dataset.arranque).toBeUndefined();
    root.querySelector("[aria-busy]")!.setAttribute("aria-busy", "false");
    await avanzar(ARRANQUE_ESTABLE_MS - 10);
    expect(raiz.dataset.arranque).toBeUndefined();
    await avanzar(20);
    expect(raiz.dataset.arranque).toBe("suelto");
  });

  it("un #root todavia vacio cuenta como carga pendiente", () => {
    montarRoot("");
    expect(hayCargaPendiente(document, true)).toBe(true);
    expect(hayCargaPendiente(document, false)).toBe(false);
  });

  it("seguro: a los 45 s se suelta aunque la carga siga", async () => {
    montarRoot('<div data-carga-tamano="pantalla"></div>');
    iniciar();
    await avanzar(ARRANQUE_TOPE_MS - 100);
    expect(raiz.dataset.arranque).toBeUndefined();
    await avanzar(200);
    expect(raiz.dataset.arranque).toBe("suelto");
  });
});

describe("ds3 — capa de arranque: navegacion interna", () => {
  async function arrancarSuelto(): Promise<HTMLElement> {
    const root = montarRoot("<main><p>listo</p></main>");
    iniciar();
    await avanzar(ARRANQUE_ESTABLE_MS + 10);
    expect(raiz.dataset.arranque).toBe("suelto");
    return root;
  }

  it("una carga de pantalla de menos de 250 ms nunca muestra la capa", async () => {
    const root = await arrancarSuelto();
    root.insertAdjacentHTML("beforeend", '<div id="c" data-carga-tamano="pantalla"></div>');
    await avanzar(ARRANQUE_RETARDO_MS - 50);
    root.querySelector("#c")!.remove();
    await avanzar(1_000);
    expect(raiz.dataset.arranque).toBe("suelto");
  });

  it("si pasa de 250 ms la capa vuelve (activo) y, al terminar, dura al menos 400 ms visible", async () => {
    const root = await arrancarSuelto();
    root.insertAdjacentHTML("beforeend", '<div id="c" data-atiende-carga-ruta></div>');
    await avanzar(ARRANQUE_RETARDO_MS + 10);
    expect(raiz.dataset.arranque).toBe("activo");
    root.querySelector("#c")!.remove();
    await avanzar(ARRANQUE_MINIMO_MS - 50);
    expect(raiz.dataset.arranque).toBe("activo");
    await avanzar(100);
    expect(raiz.dataset.arranque).toBe("suelto");
  });

  it("en /login no se activa en navegacion", async () => {
    const root = await arrancarSuelto();
    ruta = "/restaurantes/login";
    root.insertAdjacentHTML("beforeend", '<div data-carga-tamano="pantalla"></div>');
    await avanzar(2_000);
    expect(raiz.dataset.arranque).toBe("suelto");
  });
});

describe("ds3 — CapaArranque (componente)", () => {
  it("si la capa no se pinta (diseno actual: hidden sin la hoja ds3) no toca <html>", async () => {
    montarRoot("");
    const contenedor = document.createElement("div");
    document.body.appendChild(contenedor);
    const r = createRoot(contenedor);
    act(() => r.render(createElement(CapaArranque)));
    await avanzar(ARRANQUE_TOPE_MS + 1_000);
    expect(raiz.dataset.arranque).toBeUndefined();
    act(() => r.unmount());
  });

  it("si la capa se pinta, la gobierna y la suelta cuando la pantalla esta lista", async () => {
    montarRoot("<main><p>listo</p></main>");
    const estilo = document.createElement("style");
    estilo.textContent = "#arranque[hidden]{display:flex}";
    document.head.appendChild(estilo);
    const contenedor = document.createElement("div");
    document.body.appendChild(contenedor);
    const r = createRoot(contenedor);
    act(() => r.render(createElement(CapaArranque)));
    await avanzar(ARRANQUE_ESTABLE_MS + 50);
    expect(raiz.dataset.arranque).toBe("suelto");
    act(() => r.unmount());
    estilo.remove();
  });
});

describe("ds3 — capa de arranque: marcado y hoja", () => {
  it("index.html trae #arranque con hidden (fuera sin la bandera), aria-hidden y el logo antes de #root", () => {
    const html = readFileSync(join(aqui, "../../../apps/web/index.html"), "utf8");
    const capa = html.match(/<div id="arranque"[^>]*>/)?.[0] ?? "";
    expect(capa).toContain("hidden");
    expect(capa).toContain('aria-hidden="true"');
    expect(capa).toContain('class="ds3-arranque"');
    expect(html.indexOf('id="arranque"')).toBeLessThan(html.indexOf('id="root"'));
    expect(html).not.toMatch(/<div id="arranque"[\s\S]*?#[0-9a-fA-F]{3,8}[\s\S]*?<div id="root"/);
  });

  it("respira: opacidad .35 -> 1 y escala .985 -> 1 en 1,6 s con el easing unico; estatica al 60 % con movimiento reducido", () => {
    const kf = keyframes("ds3-respira") ?? "";
    expect(kf).toContain("opacity: 0.35");
    expect(kf).toContain("scale(0.985)");
    expect(kf).toContain("opacity: 1");
    expect(valorCss(".ds3-arranque-logo.ds3-arranque-logo", "animation")).toBe("ds3-respira 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite");
    expect(valorCss(".ds3-arranque-logo.ds3-arranque-logo", "opacity", "prefers-reduced-motion: reduce")).toBe("0.6");
  });

  it("se desvanece en 170 ms al soltarse, tiene seguro CSS de 45 s y oculta cualquier otro logo animado mientras se ve", () => {
    expect(valorCss("#arranque.ds3-arranque[hidden]", "transition")).toContain("opacity 170ms");
    expect(valorCss(':not([data-arranque="suelto"]) #arranque.ds3-arranque[hidden]', "animation")).toBe("ds3-arranque-tope 1ms linear 45s forwards");
    expect(valorCss(':not([data-arranque="suelto"]) .carga-logo', "visibility")).toBe("hidden");
  });
});
