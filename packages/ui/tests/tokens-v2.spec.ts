// PR-1 de diseno-ux (Atiende DS v2): tokens bajo la bandera data-theme="v2".
// Afirma (1) contraste WCAG de la paleta con los valores REALES de index.css
// (no una tabla copiada a mano), (2) que sin la bandera la paleta de
// produccion no cambia, (3) que el preset de Tailwind expone los tokens nuevos
// y (4) la mecanica de la bandera.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import preset from "../src/tailwind-preset.ts";
import { contraste, parseHsl } from "../src/lib/contraste.ts";
import { cn } from "../src/lib/utils.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Variables de los bloques `selector { ... }`: todos (el ultimo gana) o solo el primero
 * (los selectores v2 repiten bloque dentro del @media de <md, que se prueba aparte). */
function tokens(selector: string, soloPrimero = selector.includes("data-theme")): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)\\s*${escapar(selector)}\\s*\\{([^}]*)\\}`, "g");
  const salida: Record<string, string> = {};
  for (const m of [...css.matchAll(re)].slice(0, soloPrimero ? 1 : undefined)) {
    for (const decl of (m[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      salida[decl[1]!] = decl[2]!.trim();
    }
  }
  return salida;
}

const legado = tokens(":root");
const legadoOscuro = tokens(".dark");
const v2 = { ...legado, ...tokens(':root[data-theme="v2"]') };
const v2Oscuro = { ...legado, ...legadoOscuro, ...tokens(':root[data-theme="v2"]'), ...tokens(':root[data-theme="v2"].dark') };

function ratio(t: Record<string, string>, fg: string, bg: string): number {
  return contraste(parseHsl(t[fg]!), parseHsl(t[bg]!));
}

describe("paleta v2 clara — contraste WCAG", () => {
  const pares: Array<[string, string, string, number]> = [
    ["texto sobre fondo", "--foreground", "--background", 7],
    ["texto sobre card", "--card-foreground", "--card", 7],
    ["primary-foreground sobre primary", "--primary-foreground", "--primary", 4.5],
    ["secondary-foreground sobre secondary", "--secondary-foreground", "--secondary", 4.5],
    ["muted-foreground sobre fondo", "--muted-foreground", "--background", 4.5],
    ["muted-foreground sobre muted", "--muted-foreground", "--muted", 4.5],
    ["accent-foreground sobre accent", "--accent-foreground", "--accent", 4.5],
    ["destructive-foreground sobre destructive", "--destructive-foreground", "--destructive", 4.5],
    ["destructive sobre su tinte", "--destructive", "--destructive-tint", 4.5],
    ["success sobre su tinte", "--success", "--success-tint", 4.5],
    ["warning sobre su tinte", "--warning", "--warning-tint", 4.5],
    ["info sobre su tinte", "--info", "--info-tint", 4.5],
    ["primary como texto sobre card", "--primary", "--card", 4.5],
    ["success como texto sobre card", "--success", "--card", 4.5],
    ["ring (no texto) sobre fondo", "--ring", "--background", 3],
    ["ring (no texto) sobre card", "--ring", "--card", 3],
    ["trazo de controles sobre fondo", "--control-off", "--background", 3],
    ["trazo de controles sobre card", "--control-off", "--card", 3],
  ];
  it.each(pares)("%s", (_nombre, fg, bg, minimo) => {
    expect(ratio(v2, fg, bg)).toBeGreaterThanOrEqual(minimo);
  });
});

describe("paleta v2 oscura — contraste WCAG", () => {
  const pares: Array<[string, string, string, number]> = [
    ["texto sobre fondo", "--foreground", "--background", 7],
    ["texto sobre card", "--card-foreground", "--card", 7],
    ["primary-foreground sobre primary", "--primary-foreground", "--primary", 4.5],
    ["primary como texto sobre card", "--primary", "--card", 4.5],
    ["muted-foreground sobre fondo", "--muted-foreground", "--background", 4.5],
    ["muted-foreground sobre muted", "--muted-foreground", "--muted", 4.5],
    ["muted-foreground sobre card", "--muted-foreground", "--card", 4.5],
    ["accent-foreground sobre accent", "--accent-foreground", "--accent", 4.5],
    ["destructive-foreground sobre destructive", "--destructive-foreground", "--destructive", 4.5],
    ["destructive sobre su tinte", "--destructive", "--destructive-tint", 4.5],
    ["destructive como texto sobre card", "--destructive", "--card", 4.5],
    ["success sobre su tinte", "--success", "--success-tint", 4.5],
    ["warning sobre su tinte", "--warning", "--warning-tint", 4.5],
    ["info sobre su tinte", "--info", "--info-tint", 4.5],
    ["success como texto sobre card", "--success", "--card", 4.5],
    ["warning como texto sobre card", "--warning", "--card", 4.5],
    ["ring (no texto) sobre fondo", "--ring", "--background", 3],
    ["trazo de controles sobre fondo", "--control-off", "--background", 3],
    ["trazo de controles sobre card", "--control-off", "--card", 3],
  ];
  it.each(pares)("%s", (_nombre, fg, bg, minimo) => {
    expect(ratio(v2Oscuro, fg, bg)).toBeGreaterThanOrEqual(minimo);
  });
});

describe("sin la bandera el aspecto de produccion no cambia", () => {
  it("la paleta base (:root y .dark) conserva los valores de siempre", () => {
    expect(legado["--primary"]).toBe("224 76% 48%");
    expect(legado["--secondary"]).toBe("224 76% 48%");
    expect(legado["--accent"]).toBe("224 76% 48%");
    expect(legado["--background"]).toBe("210 40% 98%");
    expect(legado["--ring"]).toBe("224 76% 48%");
    expect(legadoOscuro["--primary"]).toBe("213 82% 62%");
    expect(legadoOscuro["--secondary"]).toBe("199 89% 55%");
  });

  it("la escala tipografica y el alto de controles por defecto son los actuales", () => {
    expect(legado["--text-sm"]).toBe("0.875rem");
    expect(legado["--text-base"]).toBe("1rem");
    expect(legado["--text-xl"]).toBe("1.25rem");
    expect(legado["--control-md"]).toBe("2.75rem");
    expect(legado["--font-body"]).toBe('"Inter", sans-serif');
  });

  it("v2 define la escala 13/15/22/28 px y controles de 32/40/44 px", () => {
    expect(v2["--text-sm"]).toBe("0.8125rem");
    expect(v2["--text-base"]).toBe("0.9375rem");
    expect(v2["--text-xl"]).toBe("1.375rem");
    expect(v2["--text-2xl"]).toBe("1.75rem");
    expect(v2["--control-sm"]).toBe("2rem");
    expect(v2["--control-md"]).toBe("2.5rem");
    expect(v2["--control-lg"]).toBe("2.75rem");
    expect(v2["--primary"]).toBe("219 65% 41%");
    expect(v2["--secondary"]).not.toBe(v2["--primary"]);
    expect(v2["--accent"]).not.toBe(v2["--primary"]);
  });

  it("v2 sube todos los controles a 44 px en pantallas < md", () => {
    expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*:root\[data-theme="v2"\]\s*\{[^}]*--control-md: 2\.75rem/);
  });

  it("las familias v2 referencian las fuentes autoalojadas declaradas con @font-face", () => {
    for (const familia of ["AtiendeSans", "AtiendeSerif", "AtiendeMono"]) {
      expect(css).toContain(`@font-face { font-family: "${familia}"`);
      expect(v2["--font-body"] + v2["--font-serif"] + v2["--font-mono"]).toContain(familia);
    }
    expect(css).toContain('url("/fonts/sans-400.woff2")');
  });
});

describe("motion y legados", () => {
  it("conserva el bloque global prefers-reduced-motion que apaga animaciones y transiciones", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{[^}]*animation-duration: 0\.001ms !important;[^}]*transition-duration: 0\.001ms !important/);
  });

  it("el hover de elevacion y el press solo existen con movimiento permitido", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.interactive-lift \{/);
    expect(css).toMatch(/button:not\(:disabled\):active \{\s*transform: scale\(0\.97\);\s*transition: transform 80ms/);
  });

  it("el brillo del skeleton solo se activa con data-theme=v2", () => {
    expect(css).toMatch(/:root\[data-theme="v2"\] \.ds-skeleton \{\s*animation: ds-shimmer/);
    expect(css).not.toMatch(/\n\.ds-skeleton \{/);
  });

  it("se retiraron los tokens heredados del hotel (gold, terracotta, sand, olive, cream, gradientes, glow)", () => {
    for (const nombre of ["--gold", "--terracotta", "--sand", "--olive", "--cream", "--gradient-gold", "--gradient-warm", "--gradient-hero", "--shadow-glow", "text-gradient-gold"]) {
      expect(css).not.toContain(nombre);
    }
    const colores = (preset.theme as { extend: { colors: Record<string, unknown>; boxShadow: Record<string, unknown> } }).extend;
    for (const nombre of ["gold", "terracotta", "sand", "olive", "cream"]) expect(colores.colors).not.toHaveProperty(nombre);
    expect(colores.boxShadow).not.toHaveProperty("glow");
  });
});

describe("preset de Tailwind", () => {
  const extend = (preset.theme as { extend: Record<string, Record<string, unknown>> }).extend;

  it("expone la escala tipografica por variables (y 2xs / display)", () => {
    expect(extend.fontSize!.sm).toEqual(["var(--text-sm)", { lineHeight: "var(--text-sm-lh)" }]);
    expect(Object.keys(extend.fontSize!)).toEqual(expect.arrayContaining(["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "display"]));
  });

  it("expone radios con nombre, motion y semanticos", () => {
    expect(extend.borderRadius).toMatchObject({ control: "var(--radius-control)", field: "var(--radius-field)", card: "var(--radius-card)", shell: "var(--radius-shell)", dialog: "var(--radius-dialog)" });
    expect(extend.transitionDuration).toMatchObject({ fast: "var(--dur-fast)", base: "var(--dur-base)", slow: "var(--dur-slow)", instant: "var(--dur-instant)", enter: "var(--dur-enter)" });
    expect(extend.transitionTimingFunction).toMatchObject({ brand: "var(--ease-out)" });
    expect(extend.colors).toHaveProperty("success.tint");
    expect(extend.colors).toHaveProperty("warning.tint");
    expect(extend.colors).toHaveProperty("info.tint");
    expect(extend.colors).toHaveProperty("destructive.tint");
  });

  it("define los patrones de entrada de modal, sheet, popover, toast y pagina", () => {
    for (const nombre of ["overlay-in", "modal-in", "modal-out", "sheet-up", "sheet-down", "popover-in", "toast-in", "page-in"]) {
      expect(extend.keyframes).toHaveProperty(nombre);
      expect(extend.animation).toHaveProperty(nombre);
    }
    // ninguna animacion de UI operativa pasa de 400 ms (4.4): solo reveals de marca usan --dur-enter
    for (const [nombre, valor] of Object.entries(extend.animation!)) {
      if (["accordion-down", "accordion-up", "wiggle"].includes(nombre)) continue;
      expect(String(valor)).not.toContain("--dur-enter");
    }
  });

  it("los tokens de motion cumplen el limite de 400 ms de la UI operativa", () => {
    const ms = (t: string) => Number(/^(\d+)ms$/.exec(legado[t]!)?.[1]);
    expect(ms("--dur-instant")).toBe(80);
    expect(ms("--dur-fast")).toBe(150);
    expect(ms("--dur-base")).toBe(250);
    expect(ms("--dur-slow")).toBe(400);
    expect(ms("--dur-enter")).toBe(600);
    expect(legado["--ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
  });
});

describe("cn conoce los tokens v2", () => {
  it("text-display no se confunde con un color y gana el ultimo tamano", () => {
    expect(cn("text-display", "text-foreground")).toBe("text-display text-foreground");
    expect(cn("text-sm", "text-display")).toBe("text-display");
    expect(cn("text-2xs", "text-xs")).toBe("text-xs");
  });
  it("deduplica radios, duraciones y easing con nombre", () => {
    expect(cn("rounded-md", "rounded-field")).toBe("rounded-field");
    expect(cn("duration-200", "duration-fast")).toBe("duration-fast");
    expect(cn("ease-out", "ease-brand")).toBe("ease-brand");
  });
});
