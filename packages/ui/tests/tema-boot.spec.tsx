// @vitest-environment jsdom
//
// ds3 / 0.1: el tema y la bandera de diseno se resuelven igual en el script externo `public/theme-boot.js` (antes del primer
// pintado) y en el helper TS que usan ThemeSelector y ThemeBoot. Este spec corre el script REAL y compara contra el helper.
// Con la bandera apagada el script no toca nada (produccion intacta).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarBanderaDiseno, aplicarTema, leerTema, suscribirTemaSistema } from "../src/lib/tema";

// Ruta relativa a este archivo (funciona corriendo vitest desde la raiz o desde packages/ui).
const RUTA_SCRIPT = join(__dirname, "../../../apps/web/public/theme-boot.js");
const SCRIPT = readFileSync(RUTA_SCRIPT, "utf8");
const META_BASE = "#1D4ED8";

function sistema(oscuro: boolean) {
  const escuchas = new Set<() => void>();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: oscuro && q.includes("dark"),
    media: q,
    addEventListener: (_: string, f: () => void) => escuchas.add(f),
    removeEventListener: (_: string, f: () => void) => escuchas.delete(f),
  }));
  return escuchas;
}

function correrScript() {
  new Function(SCRIPT)();
}

function estado() {
  return {
    oscuro: document.documentElement.classList.contains("dark"),
    color: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    diseno: document.documentElement.dataset.diseno ?? null,
  };
}

function encender() {
  window.localStorage.setItem("atiende-diseno", "ds3");
}

beforeEach(() => {
  document.head.innerHTML = `<meta name="theme-color" content="${META_BASE}">`;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-diseno");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/theme-boot.js", () => {
  it("pesa 600 B o menos, es JS plano sin defer ni datos del entorno", () => {
    expect(Buffer.byteLength(SCRIPT, "utf8")).toBeLessThanOrEqual(600);
    expect(SCRIPT).not.toMatch(/data-theme|dataset\.theme/);
  });

  it("con la bandera apagada no cambia nada, ni con tema oscuro guardado", () => {
    sistema(true);
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(estado()).toEqual({ oscuro: false, color: META_BASE, diseno: null });
  });

  const casos: Array<[string | null, boolean, boolean]> = [
    [null, false, false],
    [null, true, false],
    ["claro", true, false],
    ["oscuro", false, true],
    ["sistema", true, true],
    ["sistema", false, false],
    ["basura", true, false],
  ];
  it.each(casos)("bandera ds3, tema guardado %s con sistema oscuro=%s: el script y aplicarTema coinciden (oscuro=%s)", (guardado, sisOscuro, esperado) => {
    sistema(sisOscuro);
    encender();
    if (guardado) window.localStorage.setItem("atiende-tema", guardado);
    correrScript();
    const delScript = estado();
    document.documentElement.className = "";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_BASE);
    aplicarTema(leerTema());
    expect(estado()).toEqual(delScript);
    expect(delScript.oscuro).toBe(esperado);
    expect(delScript.color).toBe(esperado ? "#0e0e10" : "#ffffff");
  });

  it("aplicarTema no toca theme-color con la bandera apagada", () => {
    sistema(true);
    aplicarTema("oscuro");
    expect(estado()).toEqual({ oscuro: true, color: META_BASE, diseno: null });
  });

  it("sin localStorage no revienta y deja el tema claro", () => {
    sistema(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(() => correrScript()).not.toThrow();
    expect(estado().oscuro).toBe(false);
  });

  it("?diseno=ds3 guarda la bandera y la pone en <html>; sin parametro se lee de localStorage; ?diseno=off la borra", () => {
    sistema(false);
    window.history.replaceState(null, "", "/?diseno=ds3");
    correrScript();
    expect(window.localStorage.getItem("atiende-diseno")).toBe("ds3");
    expect(estado().diseno).toBe("ds3");

    document.documentElement.removeAttribute("data-diseno");
    window.history.replaceState(null, "", "/");
    correrScript();
    expect(estado().diseno).toBe("ds3");

    document.documentElement.removeAttribute("data-diseno");
    window.history.replaceState(null, "", "/?diseno=off");
    correrScript();
    expect(window.localStorage.getItem("atiende-diseno")).toBeNull();
    expect(estado().diseno).toBeNull();
  });

  it("si setItem lanza con ?diseno=ds3, la bandera se enciende igual (script y helper coinciden)", () => {
    sistema(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota");
    });
    window.history.replaceState(null, "", "/?diseno=ds3");
    expect(() => correrScript()).not.toThrow();
    const delScript = estado();
    expect(delScript.diseno).toBe("ds3");
    document.documentElement.removeAttribute("data-diseno");
    expect(aplicarBanderaDiseno("?diseno=ds3")).toBe(true);
    expect(estado().diseno).toBe(delScript.diseno);
  });

  it("si matchMedia no existe, el script no revienta con tema «sistema»", () => {
    vi.stubGlobal("matchMedia", undefined);
    encender();
    window.localStorage.setItem("atiende-tema", "sistema");
    expect(() => correrScript()).not.toThrow();
    expect(estado().oscuro).toBe(false);
  });

  it("un valor distinto de ds3 no enciende la bandera y el script coincide con aplicarBanderaDiseno", () => {
    sistema(false);
    window.history.replaceState(null, "", "/?diseno=otro");
    correrScript();
    expect(estado().diseno).toBeNull();
    expect(aplicarBanderaDiseno("?diseno=otro")).toBe(false);
    expect(aplicarBanderaDiseno("?diseno=ds3")).toBe(true);
    expect(estado().diseno).toBe("ds3");
  });

  it("no usa data-theme en ningun caso", () => {
    sistema(true);
    encender();
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("suscribirTemaSistema", () => {
  it("reaplica solo si la persona eligio «sistema» y se desuscribe", () => {
    const escuchas = sistema(false);
    window.localStorage.setItem("atiende-tema", "sistema");
    const baja = suscribirTemaSistema();
    expect(escuchas.size).toBe(1);
    sistema(true);
    // El helper reevalua matchMedia en cada cambio: se simula el evento con el stub nuevo.
    escuchas.forEach((f) => f());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // Con «claro» elegido el cambio del sistema ya no reaplica: <html> conserva lo que tenia.
    window.localStorage.setItem("atiende-tema", "claro");
    escuchas.forEach((f) => f());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    baja();
    expect(escuchas.size).toBe(0);
  });
});
