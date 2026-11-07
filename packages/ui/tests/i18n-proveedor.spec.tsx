// @vitest-environment jsdom
//
// i18n ES/EN: el proveedor cambia toda la UI en caliente. Se prueba: sin proveedor todo es espanol; `?lang=`/localStorage
// deciden el idioma inicial; el evento del selector del sidebar (`guardarIdioma`) y otra pestana (`storage`) cambian el
// texto sin recargar; `cambiarIdioma` guarda, anuncia y llama a `persistir`; `<html lang>` sigue al idioma.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma, useFormatos, useI18n, useT } from "../src/i18n/index";
import { CLAVE_IDIOMA, guardarIdioma } from "../src/lib/idioma";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let contenedor: HTMLElement | null = null;
let cambiar: ((i: "es" | "en") => void) | null = null;

function Muestra() {
  const { t, idioma, cambiarIdioma } = useI18n();
  const formatos = useFormatos();
  cambiar = cambiarIdioma;
  return createElement("p", { "data-idioma": idioma }, `${t("comun.reintentar")} · ${t("comun.resultados", { count: 2 })} · ${formatos.moneda(5)}`);
}

function SoloT() {
  return createElement("span", null, useT()("comun.cancelar"));
}

function montar(el: ReturnType<typeof createElement>) {
  contenedor = document.createElement("div");
  document.body.appendChild(contenedor);
  act(() => {
    root = createRoot(contenedor as HTMLElement);
    root.render(el);
  });
  return contenedor;
}

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.lang = "es";
});

afterEach(() => {
  act(() => root?.unmount());
  contenedor?.remove();
  root = null;
  contenedor = null;
  cambiar = null;
});

describe("IdiomaProvider", () => {
  it("sin proveedor, todo en espanol", () => {
    const c = montar(createElement(SoloT));
    expect(c.textContent).toBe("Cancelar");
  });

  it("por omision espanol y <html lang=es>", () => {
    const c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent).toBe("Reintentar · 2 resultados · $5.00");
    expect(document.documentElement.lang).toBe("es");
  });

  it("respeta la preferencia guardada y ?lang= gana sobre ella", () => {
    window.localStorage.setItem(CLAVE_IDIOMA, "en");
    let c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent).toBe("Try again · 2 results · $5.00");
    expect(document.documentElement.lang).toBe("en");
    act(() => root?.unmount());
    c.remove();

    window.history.replaceState(null, "", "/?lang=es");
    c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent?.startsWith("Reintentar")).toBe(true);
  });

  it("cambia en caliente cuando el selector del sidebar llama guardarIdioma", () => {
    const c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    act(() => guardarIdioma("en"));
    expect(c.textContent).toBe("Try again · 2 results · $5.00");
    expect(document.documentElement.lang).toBe("en");
  });

  it("cambia cuando otra pestana guarda la preferencia", () => {
    const c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CLAVE_IDIOMA, newValue: "en" }));
    });
    expect(c.querySelector("p")?.getAttribute("data-idioma")).toBe("en");
  });

  it("cambiarIdioma guarda en localStorage y llama a persistir; un fallo de persistir no revierte", async () => {
    const persistir = vi.fn().mockRejectedValue(new Error("sin red"));
    const c = montar(createElement(IdiomaProvider, { persistir }, createElement(Muestra)));
    await act(async () => {
      cambiar?.("en");
      await Promise.resolve();
    });
    expect(window.localStorage.getItem(CLAVE_IDIOMA)).toBe("en");
    expect(persistir).toHaveBeenCalledWith("en");
    expect(c.textContent?.startsWith("Try again")).toBe(true);
  });

  it("idiomaInicial fija el idioma sin leer la preferencia", () => {
    window.localStorage.setItem(CLAVE_IDIOMA, "es");
    const c = montar(createElement(IdiomaProvider, { idiomaInicial: "en" }, createElement(Muestra)));
    expect(c.textContent?.startsWith("Try again")).toBe(true);
  });
});
