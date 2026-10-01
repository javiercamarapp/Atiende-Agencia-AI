// UNI-0 del plan de diseno (Atiende = Likida): tokens de Likida en :root y .dark, sin bandera.
// Afirma (1) contraste WCAG de la paleta con los valores REALES de index.css (no una tabla copiada a
// mano), (2) los hex literales de Likida y que el azul de marca de Atiende NO cambio, (3) tipografia,
// radios, foco, sombras y tokens del odometro, (4) el preset de Tailwind y (5) que la bandera
// data-theme="v2" y sus fuentes se retiraron.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import preset from "../src/tailwind-preset.ts";
import { contraste, parseHsl, type Hsl } from "../src/lib/contraste.ts";
import { cn } from "../src/lib/utils.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");
const presetFuente = readFileSync(join(aqui, "../src/tailwind-preset.ts"), "utf8");

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Variables de los bloques `selector { ... }` (el ultimo gana). */
function tokens(selector: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)\\s*${escapar(selector)}\\s*\\{([^}]*)\\}`, "g");
  const salida: Record<string, string> = {};
  for (const m of css.matchAll(re)) {
    for (const decl of (m[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      salida[decl[1]!] = decl[2]!.trim();
    }
  }
  return salida;
}

const claro = tokens(":root");
const oscuro = { ...claro, ...tokens(".dark") };

function ratio(t: Record<string, string>, fg: string, bg: string): number {
  return contraste(parseHsl(t[fg]!), parseHsl(t[bg]!));
}

/** [h, s, l] -> [r, g, b] (0-255, redondeado). */
function aRgb([h, s, l]: Hsl): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((ln - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255);
  };
  return [f(0), f(8), f(4)];
}
function hexARgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
/** El token (HSL con 1 decimal) reproduce el hex de Likida con diferencia <= 1 por canal. */
function afirmarHex(t: Record<string, string>, token: string, hex: string): void {
  const rgb = aRgb(parseHsl(t[token]!));
  const esperado = hexARgb(hex);
  for (let i = 0; i < 3; i++) expect(Math.abs(rgb[i]! - esperado[i]!), `${token} ${t[token]} vs ${hex}`).toBeLessThanOrEqual(1);
}

describe("paleta clara — contraste WCAG", () => {
  const pares: Array<[string, string, string, number]> = [
    ["texto sobre fondo", "--foreground", "--background", 7],
    ["texto sobre card", "--card-foreground", "--card", 7],
    ["texto sobre gris sumido", "--foreground", "--sunken", 7],
    ["texto secundario sobre card", "--foreground-2", "--card", 7],
    ["primary-foreground sobre primary", "--primary-foreground", "--primary", 4.5],
    ["secondary-foreground sobre secondary", "--secondary-foreground", "--secondary", 4.5],
    ["muted-foreground sobre fondo", "--muted-foreground", "--background", 4.5],
    ["muted-foreground sobre muted", "--muted-foreground", "--muted", 4.5],
    ["muted-foreground sobre gris sumido", "--muted-foreground", "--sunken", 4.5],
    ["muted-foreground sobre canvas", "--muted-foreground", "--canvas", 4.5],
    ["faint sobre gris sumido", "--faint", "--sunken", 4.5],
    ["faint sobre card", "--faint", "--card", 4.5],
    ["accent-foreground sobre accent", "--accent-foreground", "--accent", 4.5],
    ["destructive-foreground sobre destructive", "--destructive-foreground", "--destructive", 4.5],
    ["destructive sobre su tinte", "--destructive", "--destructive-tint", 4.5],
    ["success sobre su tinte", "--success", "--success-tint", 4.5],
    ["warning sobre su tinte", "--warning", "--warning-tint", 4.5],
    ["info sobre su tinte", "--info", "--info-tint", 4.5],
    ["primary como texto sobre card", "--primary", "--card", 4.5],
    ["primary como texto sobre gris sumido", "--primary", "--sunken", 4.5],
    ["success como texto sobre card", "--success", "--card", 4.5],
    ["ring (no texto) sobre fondo", "--ring", "--background", 3],
    ["ring (no texto) sobre card", "--ring", "--card", 3],
    ["borde de campo (--input) sobre card (WCAG 1.4.11)", "--input", "--card", 3],
    ["borde de campo (--input) sobre fondo", "--input", "--background", 3],
    ["trazo de controles sobre fondo", "--control-off", "--background", 3],
    ["trazo de controles sobre card", "--control-off", "--card", 3],
  ];
  it.each(pares)("%s", (_nombre, fg, bg, minimo) => {
    expect(ratio(claro, fg, bg)).toBeGreaterThanOrEqual(minimo);
  });
});

describe("paleta oscura — contraste WCAG", () => {
  const pares: Array<[string, string, string, number]> = [
    ["texto sobre fondo", "--foreground", "--background", 7],
    ["texto sobre card", "--card-foreground", "--card", 7],
    ["texto sobre gris sumido", "--foreground", "--sunken", 7],
    ["texto secundario sobre card", "--foreground-2", "--card", 7],
    ["primary-foreground sobre primary", "--primary-foreground", "--primary", 4.5],
    ["primary como texto sobre card", "--primary", "--card", 4.5],
    ["primary como texto sobre gris sumido", "--primary", "--sunken", 4.5],
    ["muted-foreground sobre fondo", "--muted-foreground", "--background", 4.5],
    ["muted-foreground sobre muted", "--muted-foreground", "--muted", 4.5],
    ["muted-foreground sobre card", "--muted-foreground", "--card", 4.5],
    ["muted-foreground sobre gris sumido", "--muted-foreground", "--sunken", 4.5],
    ["faint sobre gris sumido", "--faint", "--sunken", 4.5],
    ["faint sobre card", "--faint", "--card", 4.5],
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
    ["borde de campo (--input) sobre card (WCAG 1.4.11)", "--input", "--card", 3],
    ["borde de campo (--input) sobre fondo", "--input", "--background", 3],
    ["trazo de controles sobre fondo", "--control-off", "--background", 3],
    ["trazo de controles sobre card", "--control-off", "--card", 3],
  ];
  it.each(pares)("%s", (_nombre, fg, bg, minimo) => {
    expect(ratio(oscuro, fg, bg)).toBeGreaterThanOrEqual(minimo);
  });
});

describe("tokens literales de Likida", () => {
  it.each([
    ["--background", "#fbfbfd"],
    ["--sunken", "#f4f4f5"],
    ["--canvas", "#f9f9fa"],
    ["--card", "#ffffff"],
    ["--popover", "#ffffff"],
    ["--sidebar-background", "#ffffff"],
    ["--border", "#ececef"],
    ["--sidebar-border", "#ececef"],
    ["--line2", "#e4e4e7"],
    ["--foreground", "#17100d"],
    ["--foreground-2", "#3f3f46"],
    ["--muted-foreground", "#616876"],
    ["--faint", "#6a6a73"],
    ["--muted", "#f4f4f5"],
    ["--secondary", "#f4f4f5"],
    ["--accent", "#f9f9fa"],
    ["--control-off", "#71717a"],
  ])("claro %s = %s", (token, hex) => afirmarHex(claro, token, hex));

  it.each([
    ["--background", "#09090b"],
    ["--sunken", "#1b1b1f"],
    ["--canvas", "#0e0e11"],
    ["--card", "#131316"],
    ["--popover", "#131316"],
    ["--sidebar-background", "#131316"],
    ["--border", "#232328"],
    ["--line2", "#29292e"],
    ["--foreground", "#f4f4f5"],
    ["--foreground-2", "#d4d4d8"],
    ["--muted-foreground", "#a6a6ae"],
    ["--faint", "#98989f"],
    ["--muted", "#1b1b1f"],
  ])("oscuro %s = %s", (token, hex) => afirmarHex(oscuro, token, hex));

  it("el borde de campo es #8a8a93 (3.42:1 sobre blanco), unica desviacion de contraste; el hairline sigue siendo --border", () => {
    afirmarHex(claro, "--input", "#8a8a93");
    expect(ratio(claro, "--input", "--card")).toBeGreaterThanOrEqual(3.4);
    expect(claro["--input"]).not.toBe(claro["--border"]);
    expect(oscuro["--input"]).not.toBe(oscuro["--border"]);
  });

  it("sombras de Likida", () => {
    expect(claro["--shadow-card"]).toBe("0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px -12px rgba(0, 0, 0, 0.12)");
    expect(claro["--shadow-elevated"]).toBe("0 1px 2px rgba(0, 0, 0, 0.05), 0 12px 32px -8px rgba(0, 0, 0, 0.18)");
    expect(oscuro["--shadow-card"]).toBe("0 0 0 1px rgba(255, 255, 255, 0.02)");
    expect(oscuro["--shadow-elevated"]).toBe("0 0 0 1px rgba(255, 255, 255, 0.03)");
  });

  it("rampa de graficas y odometro", () => {
    for (const [i, hex] of ["#f4f4f5", "#e4e4e7", "#a1a1aa", "#3f3f46", "#18181b"].entries()) afirmarHex(claro, `--chart-${i + 1}`, hex);
    for (const [i, hex] of ["#1b1b1f", "#2a2a30", "#707078", "#d4d4d8", "#f4f4f5"].entries()) afirmarHex(oscuro, `--chart-${i + 1}`, hex);
    expect(claro["--odometro-a"]).toBe("#262626");
    expect(claro["--odometro-b"]).toBe("#141414");
    expect(claro["--odometro-raya"]).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("el azul de marca de Atiende no cambia", () => {
  it("boton primario, foco, pestana/pildora activa y logo siguen azules (claro)", () => {
    for (const t of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring", "--marca-atiende"]) expect(claro[t]).toBe("224 76% 48%");
  });
  it("y en oscuro", () => {
    for (const t of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring", "--marca-atiende"]) expect(oscuro[t]).toBe("213 82% 62%");
  });
  it("las paletas de estado son las de Atiende (el rojo oscuro se aclara solo para llegar a AA)", () => {
    expect(claro["--success"]).toBe("142 71% 25%");
    expect(claro["--warning"]).toBe("28 90% 26%");
    expect(claro["--info"]).toBe("219 65% 36%");
    expect(claro["--destructive"]).toBe("352 83% 41%");
    expect(oscuro["--success"]).toBe("142 60% 65%");
    expect(oscuro["--info"]).toBe("218 75% 68%");
    expect(oscuro["--destructive"]).toBe("352 85% 70%");
  });
});

describe("tipografia, radios, foco y controles", () => {
  it("familias de Likida: Inter / Inter Tight / IBM Plex Mono", () => {
    expect(claro["--font-sans"]).toBe('"Inter", system-ui, sans-serif');
    expect(claro["--font-body"]).toBe('"Inter", system-ui, sans-serif');
    expect(claro["--font-display"]).toBe('"Inter Tight", "Inter", sans-serif');
    expect(claro["--font-mono"]).toBe('"IBM Plex Mono", ui-monospace, monospace');
    expect(css).toContain("family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500");
  });

  it("escala de Likida (Tailwind v4) y tamanos con nombre con interlineado 1.5", () => {
    const esperado: Record<string, string> = {
      "--text-2xs": "0.625rem",
      "--text-eyebrow": "0.6875rem",
      "--text-pill": "0.78125rem",
      "--text-ui": "0.8125rem",
      "--text-widget": "1.0625rem",
      "--text-xs": "0.75rem",
      "--text-sm": "0.875rem",
      "--text-base": "1rem",
      "--text-lg": "1.125rem",
      "--text-xl": "1.25rem",
      "--text-2xl": "1.5rem",
    };
    for (const [t, v] of Object.entries(esperado)) expect(claro[t]).toBe(v);
    for (const n of ["2xs", "eyebrow", "pill", "ui", "widget"]) expect(claro[`--text-${n}-lh`]).toBe("1.5");
    // 10 / 11 / 12.5 / 13 / 17 px
    expect([0.625, 0.6875, 0.78125, 0.8125, 1.0625].map((r) => r * 16)).toEqual([10, 11, 12.5, 13, 17]);
    expect([claro["--text-xs-lh"], claro["--text-sm-lh"], claro["--text-base-lh"], claro["--text-lg-lh"], claro["--text-xl-lh"], claro["--text-2xl-lh"]]).toEqual(["1rem", "1.25rem", "1.5rem", "1.75rem", "1.75rem", "2rem"]);
  });

  it("html/body: Inter, antialiased y letter-spacing -0.011em; utilidades tipograficas de Likida", () => {
    expect(css).toMatch(/html,\s*body \{\s*font-family: var\(--font-sans\);\s*-webkit-font-smoothing: antialiased;\s*letter-spacing: -0\.011em;/);
    expect(css).toMatch(/\.font-display \{\s*letter-spacing: -0\.02em;/);
    expect(css).toMatch(/\.etiqueta-mono \{\s*font-family: var\(--font-mono\);\s*letter-spacing: 0\.08em;/);
    expect(css).toMatch(/\.cifra-mono \{\s*font-family: var\(--font-mono\);\s*font-variant-numeric: tabular-nums;/);
    expect(css).toMatch(/\.tabular \{\s*font-variant-numeric: tabular-nums;/);
  });

  it("radios de Likida: rounded-sm 4, md 12, lg 16 px; con nombre 16 px (control = pildora)", () => {
    expect(claro["--radius"]).toBe("1rem");
    expect(claro["--radius-card"]).toBe("1rem");
    expect(claro["--radius-field"]).toBe("1rem");
    expect(claro["--radius-dialog"]).toBe("1rem");
    expect(claro["--radius-shell"]).toBe("1rem");
    expect(claro["--radius-control"]).toBe("9999px");
    const radios = (preset.theme as { extend: { borderRadius: Record<string, string> } }).extend.borderRadius;
    expect(radios).toMatchObject({ sm: "0.25rem", md: "0.75rem", lg: "1rem" });
  });

  it("foco de 3 px (tambien en el label del RadioSegmentado) y controles de 32/36/40 px", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 3px solid hsl\(var\(--ring\)\);\s*outline-offset: 2px;/);
    expect(css).toMatch(/label:has\(> input\.sr-only:focus-visible\) \{\s*outline: 3px solid hsl\(var\(--ring\)\);\s*outline-offset: 2px;/);
    expect(claro["--control-sm"]).toBe("2rem");
    expect(claro["--control-md"]).toBe("2.25rem");
    expect(claro["--control-lg"]).toBe("2.5rem");
    // Likida no agranda los controles en movil: no hay @media que los suba a 44 px.
    expect(css).not.toMatch(/--control-md: 2\.75rem/);
  });

  it("filas punteadas dentro de una tarjeta y toaster por encima de la barra movil", () => {
    expect(css).toMatch(/\.card table tbody tr \{\s*border-bottom-style: dashed;/);
    expect(css).toMatch(/\.card table thead tr \{\s*border-bottom-style: solid;/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\[data-sonner-toaster\]\[data-y-position="bottom"\] \{\s*bottom: calc\(79px \+ env\(safe-area-inset-bottom, 0px\)\) !important;/);
  });
});

describe("la bandera data-theme=v2 y sus fuentes se retiraron", () => {
  it("index.css no tiene bloques data-theme, @font-face ni referencias a Manrope/Lora/AtiendeSans/Serif", () => {
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("@font-face");
    for (const nombre of ["AtiendeSans", "AtiendeSerif", "AtiendeMono", "Manrope", "Lora", "--tracking-serif", "--font-serif"]) expect(css).not.toContain(nombre);
  });

  it("el preset ya no define la variante v2: ni la familia serif", () => {
    expect(presetFuente).not.toContain("addVariant");
    expect(presetFuente).not.toContain("data-theme");
    const plugins = (preset as { plugins?: unknown[] }).plugins ?? [];
    expect(plugins).toHaveLength(1);
    expect((preset.theme as { extend: Record<string, unknown> }).extend).not.toHaveProperty("letterSpacing");
    expect((preset.theme as { extend: { fontFamily: Record<string, unknown> } }).extend.fontFamily).not.toHaveProperty("serif");
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

  it("el barrido de brillo del skeleton es el de Likida y no depende de ninguna bandera", () => {
    expect(css).toMatch(/\n\s*\.ds-skeleton \{\s*animation: ds-shimmer 1\.4s ease infinite !important;/);
    expect(css).toMatch(/hsl\(var\(--canvas\)\) 25%,\s*hsl\(var\(--line2\)\) 37%,\s*hsl\(var\(--canvas\)\) 63%/);
    expect(css).toMatch(/background-size: 300% 100%/);
    expect(css).toMatch(/@keyframes ds-shimmer \{\s*from \{ background-position: 100% 0; \}\s*to\s*\{ background-position: -100% 0; \}/);
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

  it("expone la escala tipografica por variables (y 2xs / eyebrow / pill / ui / widget / display)", () => {
    expect(extend.fontSize!.ui).toEqual(["var(--text-ui)", { lineHeight: "var(--text-ui-lh)" }]);
    expect(extend.fontSize!.sm).toEqual(["var(--text-sm)", { lineHeight: "var(--text-sm-lh)" }]);
    expect(Object.keys(extend.fontSize!)).toEqual(expect.arrayContaining(["2xs", "eyebrow", "pill", "ui", "widget", "xs", "sm", "base", "lg", "xl", "2xl", "display"]));
  });

  it("expone radios con nombre, motion y semanticos", () => {
    expect(extend.colors).toHaveProperty("sunken");
    expect(extend.colors).toHaveProperty("canvas");
    expect(extend.colors).toHaveProperty("line2");
    expect(extend.colors).toHaveProperty("faint");
    expect(extend.colors).toHaveProperty("foreground-2");
    expect(extend.colors).toHaveProperty("chart.1");
    expect(extend.colors).toHaveProperty("marca-atiende");
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
    const ms = (t: string) => Number(/^(\d+)ms$/.exec(claro[t]!)?.[1]);
    expect(ms("--dur-instant")).toBe(80);
    expect(ms("--dur-fast")).toBe(150);
    expect(ms("--dur-base")).toBe(250);
    expect(ms("--dur-slow")).toBe(400);
    expect(ms("--dur-enter")).toBe(600);
    expect(claro["--ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
  });
});

describe("cn conoce los tokens del preset", () => {
  it("text-display no se confunde con un color y gana el ultimo tamano", () => {
    expect(cn("text-display", "text-foreground")).toBe("text-display text-foreground");
    expect(cn("text-sm", "text-display")).toBe("text-display");
    expect(cn("text-2xs", "text-xs")).toBe("text-xs");
    for (const tam of ["eyebrow", "pill", "ui", "widget"]) {
      expect(cn(`text-${tam}`, "text-foreground")).toBe(`text-${tam} text-foreground`);
      expect(cn("text-sm", `text-${tam}`)).toBe(`text-${tam}`);
    }
  });
  it("deduplica radios, duraciones y easing con nombre", () => {
    expect(cn("rounded-md", "rounded-field")).toBe("rounded-field");
    expect(cn("duration-200", "duration-fast")).toBe("duration-fast");
    expect(cn("ease-out", "ease-brand")).toBe("ease-brand");
  });
});
