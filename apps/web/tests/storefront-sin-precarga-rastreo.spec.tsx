// @vitest-environment jsdom
//
// R-37: abrir la confirmación del pedido NO debe lanzar la precarga del chunk de rastreo. El helper de precarga de Vite
// emite `vite:preloadError` aunque el import tenga .catch propio, y el manejador global (main.tsx) recarga la página:
// con el diálogo abierto se perdería el formulario. Aquí un `vite:preloadError` solo puede venir de esa precarga.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cargas = vi.hoisted(() => ({ rastreo: 0 }));
vi.mock("../src/verticals/restaurantes/storefront/RastreoPage.tsx", () => {
  cargas.rastreo += 1;
  return { RastreoPage: () => null, textoPago: () => "" };
});

import { App } from "../src/App.tsx";
import { instalarManejadorPreloadError } from "../src/lib/carga-perezosa.tsx";
import { esperarRutaCargada, changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let desinstalar: (() => void) | undefined;

const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const SOL = { id: "sol", name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false };
const MENU = { sucursal: { slug: "centro", name: "Centro", address: "Calle 1 #100", phone: null, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, zonasReparto: [] }, categorias: [{ id: "c1", name: "Bebidas", items: [SOL] }] };
const COTIZACION = { quote: { lines: [{ product_id: "sol", name: "Sol", price: 66, quantity: 1, tortilla: null, line_total: 66 }], total: 66, contains_alcohol: false }, quote_hash: "a".repeat(32), promo: null };

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  await esperarRutaCargada(document.body);
}

beforeEach(() => {
  cargas.rastreo = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).endsWith("/menu") ? json(MENU) : json(COTIZACION))));
  globalThis.sessionStorage.clear();
});
afterEach(() => {
  desinstalar?.();
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("confirmación del pedido sin precarga de rastreo", () => {
  it("con el diálogo abierto no se carga el chunk de rastreo ni se recarga la página", async () => {
    desinstalar = instalarManejadorPreloadError();
    const alRecargar = vi.fn();
    window.addEventListener("vite:preloadError", alRecargar);
    window.history.pushState({}, "", "/pedir/demo/centro");
    rendered = renderComponent(<App />);
    await esperarRutaCargada(rendered.container);
    await esperar();
    act(() => click(rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Agregar Sol al carrito"]')!));
    act(() => click(rendered!.container.querySelector<HTMLInputElement>('input[name="pago"][value="efectivo"]')!));
    const aside = rendered.container.querySelector<HTMLElement>("aside")!;
    const campo = (label: string) => aside.querySelector<HTMLInputElement>(`#${(Array.from(aside.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement).htmlFor}`)!;
    act(() => changeValue(campo("Nombre"), "Ana Pérez"));
    act(() => changeValue(campo("Teléfono"), "999 123 4567"));
    // El aviso de privacidad es el ULTIMO checkbox (la casilla opcional de promociones va antes y no se marca).
    const casillas = aside.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    act(() => click(casillas[casillas.length - 1]!));
    await act(async () => submitForm(aside.querySelector("form")!));
    await esperar();
    expect(document.body.textContent).toContain("Confirma tu pedido");
    expect(cargas.rastreo).toBe(0);
    expect(alRecargar).not.toHaveBeenCalled();
    expect(globalThis.sessionStorage.getItem("atiende:recarga-por-chunk")).toBeNull();
    window.removeEventListener("vite:preloadError", alRecargar);
  });
});
