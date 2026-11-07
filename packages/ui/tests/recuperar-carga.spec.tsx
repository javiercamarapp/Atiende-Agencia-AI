// @vitest-environment jsdom
//
// «Limpiar caché y recargar» (traido del repo suelto): cuando una pantalla no carga ni con el reintento ni con la recarga
// automatica, la persona puede vaciar CacheStorage y los service workers. Nunca toca localStorage (sesion, idioma, tema).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecuperarCarga } from "../src/components/RecuperarCarga";
import { RutaBoundary } from "../src/components/VerticalShell";
import { esErrorDeCarga, limpiarCacheYRecargar, type EntornoRecuperacion } from "../src/lib/recuperar-carga";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entornoFalso(opciones: { cachesFalla?: boolean } = {}) {
  const borradas: string[] = [];
  const bajas = { n: 0 };
  const quitadas: string[] = [];
  const recargar = vi.fn();
  const entorno: EntornoRecuperacion = {
    caches: {
      keys: opciones.cachesFalla ? () => Promise.reject(new Error("SecurityError")) : () => Promise.resolve(["vite-v1", "workbox-precache"]),
      delete: (c: string) => {
        borradas.push(c);
        return Promise.resolve(true);
      },
    },
    serviceWorker: {
      getRegistrations: () =>
        Promise.resolve([
          {
            unregister: () => {
              bajas.n += 1;
              return Promise.resolve(true);
            },
          } as unknown as ServiceWorkerRegistration,
        ]),
    },
    sessionStorage: { removeItem: (k: string) => void quitadas.push(k) },
    recargar,
  };
  return { entorno, borradas, bajas, quitadas, recargar };
}

describe("esErrorDeCarga", () => {
  it("reconoce el rechazo de un import dinamico en Chrome, Firefox y Safari", () => {
    expect(esErrorDeCarga(new TypeError("Failed to fetch dynamically imported module: https://x/assets/Pedidos-abc.js"))).toBe(true);
    expect(esErrorDeCarga(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(esErrorDeCarga(new TypeError("Importing a module script failed."))).toBe(true);
    expect(esErrorDeCarga(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
  });

  it("no confunde un error de la propia pantalla con un chunk roto", () => {
    expect(esErrorDeCarga(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(esErrorDeCarga("Failed to fetch dynamically imported module")).toBe(false);
    expect(esErrorDeCarga(null)).toBe(false);
  });
});

describe("limpiarCacheYRecargar", () => {
  it("borra cada cache, da de baja los service workers, quita la marca anti-bucle y recarga", async () => {
    const f = entornoFalso();
    await limpiarCacheYRecargar(f.entorno);
    expect(f.borradas).toEqual(["vite-v1", "workbox-precache"]);
    expect(f.bajas.n).toBe(1);
    expect(f.quitadas).toEqual(["atiende:recarga-por-chunk"]);
    expect(f.recargar).toHaveBeenCalledTimes(1);
  });

  it("si CacheStorage falla (modo privado, permiso) igual da de baja los service workers y recarga", async () => {
    const f = entornoFalso({ cachesFalla: true });
    await limpiarCacheYRecargar(f.entorno);
    expect(f.bajas.n).toBe(1);
    expect(f.recargar).toHaveBeenCalledTimes(1);
  });

  it("sin CacheStorage ni service workers solo recarga", async () => {
    const recargar = vi.fn();
    await limpiarCacheYRecargar({ recargar });
    expect(recargar).toHaveBeenCalledTimes(1);
  });

  it("no toca localStorage (sesion, idioma, tema)", async () => {
    window.localStorage.setItem("sb-auth", "token");
    await limpiarCacheYRecargar(entornoFalso().entorno);
    expect(window.localStorage.getItem("sb-auth")).toBe("token");
    window.localStorage.removeItem("sb-auth");
  });
});

let root: Root | null = null;
let contenedor: HTMLElement | null = null;

function montar(nodo: Parameters<Root["render"]>[0]) {
  contenedor = document.createElement("div");
  document.body.appendChild(contenedor);
  root = createRoot(contenedor);
  act(() => root!.render(nodo));
  return contenedor;
}

const botones = (c: HTMLElement) => [...c.querySelectorAll("button")];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  contenedor?.remove();
  root = null;
  contenedor = null;
  vi.restoreAllMocks();
});

describe("RecuperarCarga", () => {
  it("ofrece «Reintentar» (recarga) y «Limpiar caché y recargar»", async () => {
    const f = entornoFalso();
    const c = montar(createElement(RecuperarCarga, { entorno: f.entorno }));
    expect(c.textContent).toContain("No pudimos cargar esta pantalla");
    const reintentar = botones(c).find((b) => /reintentar/i.test(b.textContent ?? ""));
    act(() => reintentar!.click());
    expect(f.recargar).toHaveBeenCalledTimes(1);

    const limpiar = botones(c).find((b) => b.textContent === "Limpiar caché y recargar");
    expect(limpiar).toBeDefined();
    await act(async () => {
      limpiar!.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(f.recargar).toHaveBeenCalledTimes(2));
    expect(f.borradas).toEqual(["vite-v1", "workbox-precache"]);
    expect(c.textContent).toContain("Limpiando…");
  });
});

describe("RutaBoundary", () => {
  function Rompe({ error }: { error: Error }): null {
    throw error;
  }

  it("un chunk roto dentro de una ruta muestra la recuperacion con «Limpiar caché y recargar»", () => {
    const c = montar(createElement(RutaBoundary, { resetKey: "/pedidos" }, createElement(Rompe, { error: new TypeError("Failed to fetch dynamically imported module: /assets/Pedidos.js") })));
    expect(botones(c).some((b) => b.textContent === "Limpiar caché y recargar")).toBe(true);
  });

  it("un error de la pantalla (no de carga) conserva el aviso de siempre, sin limpiar cache", () => {
    const c = montar(createElement(RutaBoundary, { resetKey: "/pedidos" }, createElement(Rompe, { error: new Error("fallo de render") })));
    expect(c.textContent).toContain("Esta pantalla no pudo mostrarse");
    expect(botones(c).some((b) => b.textContent === "Limpiar caché y recargar")).toBe(false);
  });
});
