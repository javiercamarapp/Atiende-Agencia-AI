// @vitest-environment jsdom
//
// ds3 / 0.1: el tema y la bandera de diseno se resuelven igual en el script externo `public/theme-boot.js` (antes del primer
// pintado) y en el helper TS que usan ThemeSelector y ThemeBoot. Este spec corre el script REAL y compara contra el helper.
// Con la bandera apagada el script no toca nada (produccion intacta).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarBanderaDiseno, aplicarTema, leerTema, rutaPreOrgConDiseno, sincronizarDisenoOrganizacion, suscribirTemaSistema } from "../src/lib/tema";

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

function encender() {
  window.localStorage.setItem("atiende-diseno", "ds3");
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
  it("pesa 900 B o menos (600 + bandera por organizacion, interruptor del login y puente data-theme), JS plano sin datos del entorno", () => {
    expect(Buffer.byteLength(SCRIPT, "utf8")).toBeLessThanOrEqual(900);
    expect(SCRIPT).not.toMatch(/import\.meta|process\.env/);
  });

  it("con la bandera apagada no cambia nada, ni con tema oscuro guardado", () => {
    sistema(true);
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(estado()).toEqual({ oscuro: false, color: META_BASE, diseno: null, tema: null });
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
    document.documentElement.removeAttribute("data-theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_BASE);
    aplicarTema(leerTema());
    expect(estado()).toEqual(delScript);
    expect(delScript.oscuro).toBe(esperado);
    expect(delScript.color).toBe(esperado ? "#0e0e10" : "#ffffff");
    expect(delScript.tema).toBe(esperado ? "dark" : "light");
  });

  it("aplicarTema no toca theme-color con la bandera apagada", () => {
    sistema(true);
    aplicarTema("oscuro");
    expect(estado()).toEqual({ oscuro: true, color: META_BASE, diseno: null, tema: null });
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

  it("puente data-theme: solo con ds3 (sin la bandera <html> nunca lo lleva)", () => {
    sistema(true);
    window.localStorage.setItem("atiende-tema", "oscuro");
    correrScript();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    encender();
    correrScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("diseno de la organizacion (atiende-diseno-org) enciende la bandera; la manual y ?diseno=off mandan sobre ella", () => {
    sistema(false);
    window.localStorage.setItem("atiende-diseno-org", "ds3");
    correrScript();
    expect(estado().diseno).toBe("ds3");
    document.documentElement.removeAttribute("data-diseno");
    expect(aplicarBanderaDiseno("", "/restaurantes/pm")).toBe(true);

    document.documentElement.removeAttribute("data-diseno");
    window.history.replaceState(null, "", "/restaurantes/pm?diseno=off");
    correrScript();
    expect(estado().diseno).toBeNull();
    expect(aplicarBanderaDiseno("?diseno=off", "/restaurantes/pm")).toBe(false);
    expect(window.localStorage.getItem("atiende-diseno-org")).toBe("ds3");
  });

  const rutasLogin: Array<[string, string, boolean]> = [
    ["/restaurantes/login", "restaurantes", true],
    ["/restaurantes/restablecer-contrasena", "restaurantes,citas", true],
    ["/citas/login", "restaurantes", false],
    ["/citas/login", "*", true],
    ["/rentas/registro", "*", true],
    ["/restaurantes/pm", "*", false],
    ["/restaurantes/pm/login", "*", false],
    ["/restaurantes/login", "", false],
    ["/restaurantes/login", "%VITE_DISENO_LOGIN%", false],
  ];
  it.each(rutasLogin)("interruptor del login: %s con lista «%s» -> %s (script y helper coinciden)", (ruta, lista, esperado) => {
    sistema(false);
    document.head.insertAdjacentHTML("beforeend", `<meta name="atiende-diseno-login" content="${lista}">`);
    window.history.replaceState(null, "", ruta);
    correrScript();
    expect(estado().diseno !== null).toBe(esperado);
    expect(rutaPreOrgConDiseno(ruta, lista)).toBe(esperado);
    document.documentElement.removeAttribute("data-diseno");
    expect(aplicarBanderaDiseno("", ruta)).toBe(esperado);
  });

  it("?diseno=off apaga tambien el interruptor del login", () => {
    sistema(false);
    document.head.insertAdjacentHTML("beforeend", '<meta name="atiende-diseno-login" content="*">');
    window.history.replaceState(null, "", "/restaurantes/login?diseno=off");
    correrScript();
    expect(estado().diseno).toBeNull();
    expect(aplicarBanderaDiseno("?diseno=off", "/restaurantes/login")).toBe(false);
  });
});

describe("sincronizarDisenoOrganizacion", () => {
  it("undefined (sesion vieja) no toca nada ni pide recarga", () => {
    window.localStorage.setItem("atiende-diseno-org", "ds3");
    expect(sincronizarDisenoOrganizacion(undefined)).toBe(false);
    expect(window.localStorage.getItem("atiende-diseno-org")).toBe("ds3");
  });

  it("ds3 con lo pintado en actual: guarda el valor y pide recarga; ya pintado en ds3: no", () => {
    expect(sincronizarDisenoOrganizacion("ds3")).toBe(true);
    expect(window.localStorage.getItem("atiende-diseno-org")).toBe("ds3");
    document.documentElement.dataset.diseno = "ds3";
    expect(sincronizarDisenoOrganizacion("ds3")).toBe(false);
  });

  it("null borra el valor de organizacion y pide recarga si estaba pintado ds3 (salvo la vista previa manual)", () => {
    window.localStorage.setItem("atiende-diseno-org", "ds3");
    document.documentElement.dataset.diseno = "ds3";
    expect(sincronizarDisenoOrganizacion(null)).toBe(true);
    expect(window.localStorage.getItem("atiende-diseno-org")).toBeNull();
    window.localStorage.setItem("atiende-diseno", "ds3");
    expect(sincronizarDisenoOrganizacion(null)).toBe(false);
  });

  it("con VITE_DISENO_DEFAULT=ds3 nunca pide recarga (ya se pinta ds3 siempre)", () => {
    expect(sincronizarDisenoOrganizacion(null, "ds3")).toBe(false);
    expect(sincronizarDisenoOrganizacion("ds3", "ds3")).toBe(false);
  });

  it("sin almacenamiento no pide recarga (evita el bucle)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(sincronizarDisenoOrganizacion("ds3")).toBe(false);
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
