// @vitest-environment jsdom
//
// El tema y el diseno se resuelven igual en el script externo `public/theme-boot.js` (antes del primer pintado) y en el helper TS
// que usan ThemeSelector y ThemeBoot. Este spec corre el script REAL y compara contra el helper. El diseno nuevo (ds3) es el de
// todos; solo el interruptor de emergencia de build (<meta name="atiende-diseno-legado">, VITE_DISENO_LEGADO=1) deja <html> intacto.
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
    tema: document.documentElement.getAttribute("data-theme"),
  };
}

function legado() {
  document.head.insertAdjacentHTML("beforeend", '<meta name="atiende-diseno-legado" content="1">');
}

beforeEach(() => {
  document.head.innerHTML = `<meta name="theme-color" content="${META_BASE}">`;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-diseno");
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/theme-boot.js", () => {
  it("pesa 600 B o menos, JS plano sin datos del entorno", () => {
    expect(Buffer.byteLength(SCRIPT, "utf8")).toBeLessThanOrEqual(600);
    expect(SCRIPT).not.toMatch(/import\.meta|process\.env/);
  });

  it("por omision pone el diseno nuevo en <html> en cualquier ruta, sin parametros ni almacenamiento (script y helper coinciden)", () => {
    sistema(false);
    for (const ruta of ["/", "/restaurantes/pm", "/superadmin", "/restaurantes/login", "/privacidad", "/no-existe"]) {
      window.history.replaceState(null, "", ruta);
      document.documentElement.removeAttribute("data-diseno");
      correrScript();
      expect(estado().diseno, ruta).toBe("ds3");
      document.documentElement.removeAttribute("data-diseno");
      expect(aplicarBanderaDiseno(), ruta).toBe(true);
      expect(estado().diseno, ruta).toBe("ds3");
    }
  });

  it("los mecanismos retirados ya no apagan el diseno nuevo (?diseno=off, valores viejos de localStorage)", () => {
    sistema(false);
    window.localStorage.setItem("atiende-diseno", "off");
    window.localStorage.setItem("atiende-diseno-org", "otro");
    window.history.replaceState(null, "", "/restaurantes/pm?diseno=off");
    correrScript();
    expect(estado().diseno).toBe("ds3");
  });

  it("interruptor de emergencia (meta atiende-diseno-legado): no cambia nada, ni con tema oscuro guardado (script y helper coinciden)", () => {
    sistema(true);
    legado();
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(estado()).toEqual({ oscuro: false, color: META_BASE, diseno: null, tema: null });
    expect(aplicarBanderaDiseno()).toBe(false);
    expect(estado().diseno).toBeNull();
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
  it.each(casos)("tema guardado %s con sistema oscuro=%s: el script y aplicarTema coinciden (oscuro=%s)", (guardado, sisOscuro, esperado) => {
    sistema(sisOscuro);
    if (guardado) window.localStorage.setItem("atiende-tema", guardado);
    correrScript();
    const delScript = estado();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_BASE);
    aplicarTema(leerTema());
    expect(estado()).toEqual(delScript);
    expect(delScript.oscuro).toBe(esperado);
    expect(delScript.color).toBe(esperado ? "#0e0e10" : "#ffffff");
    expect(delScript.tema).toBe(esperado ? "dark" : "light");
  });

  it("aplicarTema no toca theme-color ni data-theme con el interruptor de emergencia (sin data-diseno)", () => {
    sistema(true);
    aplicarTema("oscuro");
    expect(estado()).toEqual({ oscuro: true, color: META_BASE, diseno: null, tema: null });
  });

  it("sin localStorage no revienta, pone el diseno nuevo y deja el tema claro", () => {
    sistema(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(() => correrScript()).not.toThrow();
    expect(estado().oscuro).toBe(false);
    expect(estado().diseno).toBe("ds3");
  });

  it("si matchMedia no existe, el script no revienta con tema «sistema»", () => {
    vi.stubGlobal("matchMedia", undefined);
    window.localStorage.setItem("atiende-tema", "sistema");
    expect(() => correrScript()).not.toThrow();
    expect(estado().oscuro).toBe(false);
  });

  it("en /<vertical>/login el tema es siempre claro: el script y aplicarTema coinciden", () => {
    sistema(true);
    window.localStorage.setItem("atiende-tema", "oscuro");
    for (const ruta of ["/restaurantes/login", "/citas/login/", "/hoteles/login?lang=en"]) {
      window.history.replaceState(null, "", ruta);
      document.documentElement.className = "";
      correrScript();
      const delScript = estado();
      expect(delScript.oscuro, ruta).toBe(false);
      expect(delScript.color, ruta).toBe("#ffffff");
      document.documentElement.classList.add("dark");
      aplicarTema(leerTema());
      expect(estado(), ruta).toEqual(delScript);
    }
    // Fuera del login el tema guardado sigue aplicando.
    window.history.replaceState(null, "", "/restaurantes/login-telefono");
    correrScript();
    expect(estado().oscuro).toBe(true);
  });

  it("puente data-theme: siempre con el diseno nuevo; con el interruptor de emergencia <html> nunca lo lleva", () => {
    sistema(true);
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-diseno");
    legado();
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
