// @vitest-environment jsdom
//
// i18n ES/EN: el proveedor cambia toda la UI en caliente. Se prueba: sin proveedor todo es espanol; `?lang=`/localStorage
// deciden el idioma inicial; el evento del selector del sidebar (`guardarIdioma`) y otra pestana (`storage`) cambian el
// texto sin recargar; `cambiarIdioma` guarda, anuncia y llama a `persistir`; `<html lang>` sigue al idioma.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma, useI18n, useT } from "../src/i18n/index";
import { useFormatos } from "../src/i18n/useFormatos.ts";
import { comun } from "../src/i18n/mensajes/comun.ts";
import { registrarModuloEs } from "../src/i18n/mensajes/index.ts";

registrarModuloEs(comun);
import { CLAVE_IDIOMA, guardarIdioma } from "../src/lib/idioma";
import { idiomaActivo } from "../src/i18n/activo.ts";
import { formatMoney } from "../src/lib/formatMoney.ts";

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
  // El idioma solo cambia con el diseno ds3 (el unico con selector ES/EN).
  document.documentElement.dataset.diseno = "ds3";
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
    expect(document.documentElement.lang).toBe("es-MX");
  });

  it("respeta la preferencia guardada y ?lang= gana sobre ella", () => {
    window.localStorage.setItem(CLAVE_IDIOMA, "en");
    let c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent).toBe("Try again · 2 results · $5.00");
    expect(document.documentElement.lang).toBe("en-US");
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
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("fija el idioma activo de los formateadores sin hook (formatMoney, fechas de lib/)", () => {
    montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(idiomaActivo()).toBe("es");
    act(() => guardarIdioma("en"));
    expect(idiomaActivo()).toBe("en");
    expect(formatMoney(1234.5)).toBe("1,234.50");
    act(() => guardarIdioma("es"));
    expect(idiomaActivo()).toBe("es");
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

  it("sin ds3 todo queda en espanol aunque haya EN guardado; al encender ds3 cambia en caliente", async () => {
    delete document.documentElement.dataset.diseno;
    window.localStorage.setItem(CLAVE_IDIOMA, "en");
    const c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent?.startsWith("Reintentar")).toBe(true);
    expect(document.documentElement.lang).toBe("es-MX");
    await act(async () => {
      document.documentElement.dataset.diseno = "ds3";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(c.textContent?.startsWith("Try again")).toBe(true);
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("?lang= vale para la carga pero no se guarda sin un clic", () => {
    window.history.replaceState(null, "", "/?lang=en");
    const c = montar(createElement(IdiomaProvider, null, createElement(Muestra)));
    expect(c.textContent?.startsWith("Try again")).toBe(true);
    expect(window.localStorage.getItem(CLAVE_IDIOMA)).toBeNull();
  });

  it("idiomaInicial fija el idioma sin leer la preferencia", () => {
    window.localStorage.setItem(CLAVE_IDIOMA, "es");
    const c = montar(createElement(IdiomaProvider, { idiomaInicial: "en" }, createElement(Muestra)));
    expect(c.textContent?.startsWith("Try again")).toBe(true);
  });
});
