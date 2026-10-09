// UNI-R0b: ambito RESTAURANTES (paleta, radios, alto de controles y movimiento del repo suelto) y sus garantias:
// (1) los valores son LOS DEL ORIGINAL (atiende-restaurantes index.css / tailwind.config.ts, tabla en
//     pm/paridad-visual/tokens-original-vs-monorepo.md), claro y oscuro; (2) contraste WCAG AA con los valores REALES de index.css;
// (3) el sidebar repone la paleta de Likida (igual a :root/.dark); (4) la variante `rest:` solo compila dentro del ambito
//     y NINGUNA clase `rest:` usa paleta cruda, hex ni text-[Npx]; (5) el CSS de toasts del ambito esta acotado al atributo.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import preset from "../src/tailwind-preset.ts";
import ambito, { VARIANTE_REST } from "../src/tailwind-ambito.ts";
import { contraste, parseHsl } from "../src/lib/contraste.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const src = join(aqui, "../src");
const css = readFileSync(join(src, "index.css"), "utf8");

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tokens(selector: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)\\s*${escapar(selector)}\\s*\\{([^}]*)\\}`, "g");
  const salida: Record<string, string> = {};
  for (const m of css.matchAll(re)) for (const d of (m[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) salida[d[1]!] = d[2]!.trim();
  return salida;
}

const RAIZ = tokens(":root");
const RAIZ_OSCURO = { ...RAIZ, ...tokens(".dark") };
const AMBITO_CLARO = tokens('html[data-ambito="restaurantes"]');
const AMBITO_OSCURO = tokens('html[data-ambito="restaurantes"].dark');
const BASE_CLARO = tokens("[data-ambito-base]");
const BASE_OSCURO = tokens(".dark [data-ambito-base]");
/** Lo que ve el contenido de restaurantes (fuera del sidebar): :root + ambito (+ .dark + ambito oscuro). */
const claro = { ...RAIZ, ...AMBITO_CLARO };
const oscuro = { ...RAIZ_OSCURO, ...AMBITO_CLARO, ...AMBITO_OSCURO };

const ratio = (t: Record<string, string>, fg: string, bg: string): number => contraste(parseHsl(t[fg]!), parseHsl(t[bg]!));

describe("paleta del repo suelto (valores del original, token a token)", () => {
  it("claro = :root de atiende-restaurantes/src/index.css", () => {
    const esperado: Record<string, string> = {
      "--background": "210 40% 98%",
      "--foreground": "216 50% 12%",
      "--card": "0 0% 100%",
      "--card-foreground": "216 50% 12%",
      "--popover": "0 0% 100%",
      "--popover-foreground": "216 50% 12%",
      "--primary": "224 76% 48%",
      "--primary-foreground": "0 0% 100%",
      "--secondary": "224 76% 48%",
      "--secondary-foreground": "0 0% 100%",
      "--muted": "210 30% 95%",
      "--muted-foreground": "215 18% 43%",
      "--accent": "224 76% 48%",
      "--accent-foreground": "0 0% 100%",
      "--destructive": "352 83% 41%",
      "--destructive-foreground": "0 0% 100%",
      "--border": "214 32% 91%",
      "--ring": "224 76% 48%",
    };
    for (const [k, v] of Object.entries(esperado)) expect(claro[k], k).toBe(v);
  });

  it("oscuro = .dark del original (azul marino, no neutro)", () => {
    const esperado: Record<string, string> = {
      "--background": "216 45% 9%",
      "--foreground": "210 30% 95%",
      "--card": "216 40% 13%",
      "--card-foreground": "210 30% 95%",
      "--popover": "216 40% 11%",
      "--popover-foreground": "210 30% 95%",
      "--primary": "213 82% 62%",
      "--primary-foreground": "216 45% 9%",
      "--secondary": "199 89% 55%",
      "--secondary-foreground": "216 45% 9%",
      "--muted": "216 30% 18%",
      "--muted-foreground": "215 18% 65%",
      "--accent": "199 89% 55%",
      "--accent-foreground": "216 45% 9%",
      "--border": "216 30% 20%",
      "--ring": "213 82% 62%",
    };
    for (const [k, v] of Object.entries(esperado)) expect(oscuro[k], k).toBe(v);
  });

  it("sombras, radios, alto de controles y movimiento del original", () => {
    expect(AMBITO_CLARO["--shadow-card"]).toBe("0 4px 24px -4px hsl(216 50% 12% / 0.08)");
    expect(AMBITO_CLARO["--shadow-elevated"]).toBe("0 12px 40px -8px hsl(216 50% 12% / 0.15)");
    expect(AMBITO_CLARO["--shadow-boton"]).toBe("0 10px 26px hsl(224 76% 48% / 0.26)");
    // Dialog rounded-lg = var(--radius) = 12 px; campo/menu rounded-md = 10 px; item de menu rounded-sm = 8 px.
    expect(AMBITO_CLARO["--radius-dialog"]).toBe("0.75rem");
    expect(AMBITO_CLARO["--radius-field"]).toBe("0.625rem");
    expect(AMBITO_CLARO["--radius-menu"]).toBe("0.625rem");
    expect(AMBITO_CLARO["--radius-item"]).toBe("0.5rem");
    // Boton y campo del original: h-10 (default), h-9 (sm), h-12 (lg).
    expect([AMBITO_CLARO["--control-sm"], AMBITO_CLARO["--control-md"], AMBITO_CLARO["--control-lg"]]).toEqual(["2.25rem", "2.5rem", "3rem"]);
    // transition-all duration-200 ease-out; Dialog duration-200.
    expect(AMBITO_CLARO["--dur-fast"]).toBe("200ms");
    expect(AMBITO_CLARO["--dur-base"]).toBe("200ms");
    expect(AMBITO_CLARO["--ease-out"]).toBe("cubic-bezier(0, 0, 0.2, 1)");
    // Velo del modal: bg-black/80 (sin desenfoque).
    expect(AMBITO_CLARO["--scrim"]).toBe("hsl(0 0% 0% / 0.8)");
  });

  it("el azul solido (terracotta del original) es el mismo azul de marca en claro y oscuro", () => {
    expect(claro["--solido"]).toBe("224 76% 48%");
    expect(oscuro["--solido"]).toBe("224 76% 48%");
    expect(claro["--solido-foreground"]).toBe("0 0% 100%");
  });

  it("todo color del ambito es un triplete HSL de token (sin hex, rgb ni nombres) y los demas valores no llevan color crudo", () => {
    for (const [nombre, bloque] of [["claro", AMBITO_CLARO], ["oscuro", AMBITO_OSCURO]] as const) {
      for (const [k, v] of Object.entries(bloque)) {
        expect(v, `${nombre} ${k}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(v, `${nombre} ${k}`).not.toMatch(/\brgba?\(/);
        if (/^--(shadow|radius|control|dur|ease|scrim)/.test(k)) continue;
        expect(() => parseHsl(v), `${nombre} ${k}`).not.toThrow();
      }
    }
  });
});

describe("contraste WCAG AA del ambito (valores reales de index.css)", () => {
  for (const [nombre, t] of [["claro", claro], ["oscuro", oscuro]] as const) {
    it(`${nombre}: texto sobre fondo, tarjeta, popover y chip >= 4.5:1`, () => {
      expect(ratio(t, "--foreground", "--background")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--card-foreground", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--popover-foreground", "--popover")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--background")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--card")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--muted-foreground", "--muted")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--faint", "--card")).toBeGreaterThanOrEqual(4.5);
    });

    it(`${nombre}: botones y superficies de color (primario, secundario, ghost/accent, destructivo, toast, menu)`, () => {
      expect(ratio(t, "--primary-foreground", "--primary")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--secondary-foreground", "--secondary")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--accent-foreground", "--accent")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--destructive-solido-foreground", "--destructive-solido")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--solido-foreground", "--solido")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--menu-activo-foreground", "--menu-activo")).toBeGreaterThanOrEqual(4.5);
      // El rojo de TEXTO/borde (--destructive) sobre la tarjeta.
      expect(ratio(t, "--destructive", "--card")).toBeGreaterThanOrEqual(4.5);
    });

    it(`${nombre}: el borde de campo (--input) y el anillo de foco llegan a 3:1 (1.4.11)`, () => {
      expect(ratio(t, "--input", "--card")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--input", "--background")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--ring", "--card")).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "--ring", "--background")).toBeGreaterThanOrEqual(3);
    });
  }

  it("el elemento resaltado del menu se distingue de la superficie del menu (el original: mismo azul, invisible)", () => {
    // Superficie = --primary (claro: azul; oscuro: azul claro); resaltado = --menu-activo.
    expect(ratio(claro, "--menu-activo", "--primary")).toBeGreaterThanOrEqual(1.5);
    expect(ratio(oscuro, "--menu-activo", "--primary")).toBeGreaterThanOrEqual(1.5);
  });

  it("desviaciones documentadas: borde de campo y rojo oscuro mas oscuros que el original por contraste", () => {
    // Original: --input 214 32% 91% (1.2:1) y destructive oscuro 352 75% 55% (blanco 4.30:1).
    expect(claro["--input"]).not.toBe("214 32% 91%");
    expect(oscuro["--destructive-solido"]).toBe("352 75% 50%");
    expect(ratio(oscuro, "--destructive-solido-foreground", "--destructive-solido")).toBeGreaterThanOrEqual(4.5);
    expect(contraste(parseHsl("0 0% 100%"), parseHsl("352 75% 55%"))).toBeLessThan(4.5);
  });
});

describe("el sidebar conserva la paleta de Likida", () => {
  const sobrescritos = [...new Set([...Object.keys(AMBITO_CLARO), ...Object.keys(AMBITO_OSCURO)])].sort();

  it("[data-ambito-base] repone TODO token que el ambito sobrescribe, y solo esos", () => {
    expect(Object.keys(BASE_CLARO).sort()).toEqual(sobrescritos);
    expect(Object.keys(BASE_OSCURO).sort()).toEqual(sobrescritos);
  });

  it("los valores repuestos son exactamente los de :root (claro) y .dark (oscuro)", () => {
    for (const k of sobrescritos) {
      expect(BASE_CLARO[k], `claro ${k}`).toBe(RAIZ[k]);
      expect(BASE_OSCURO[k], `oscuro ${k}`).toBe(RAIZ_OSCURO[k]);
    }
  });

  it("la paleta de Likida repuesta NO es la del repo suelto (el reset hace algo)", () => {
    expect(BASE_CLARO["--background"]).toBe("240 33% 98.8%");
    expect(BASE_OSCURO["--card"]).toBe("240 7% 8%");
    expect(BASE_CLARO["--secondary"]).toBe("240 4.8% 95.9%");
  });

  it("el <aside> del Sidebar lleva data-ambito-base", () => {
    const fuente = readFileSync(join(src, "components/Sidebar.tsx"), "utf8");
    expect(fuente).toMatch(/<aside[^>]*data-ambito-base=""/s);
  });
});

function clasesRest(): string[] {
  const salida = new Set<string>();
  const recorrer = (dir: string): void => {
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (/\.(tsx?)$/.test(nombre)) for (const m of readFileSync(ruta, "utf8").matchAll(/(?<![\w-])rest:[^\s"'`]+/g)) salida.add(m[0]);
    }
  };
  recorrer(src);
  return [...salida].sort();
}

const PALETA = "green|amber|red|yellow|blue|emerald|orange|slate|gray|zinc|sky|rose|stone|neutral|purple|indigo|teal|cyan|lime|pink|fuchsia|violet|white|black";
/** Razones por las que una clase `rest:` no es admisible (vacio = cumple). Misma vara que el guard de apps/web. */
export function motivosClaseRest(clase: string): string[] {
  const motivos: string[] = [];
  if (new RegExp(`(^|:|-)(bg|text|border|ring|from|to|via|divide|fill|stroke|outline|shadow)-(${PALETA})(-[0-9]+)?(/[0-9.]+)?$`).test(clase)) motivos.push("paleta cruda de Tailwind");
  if (/#[0-9a-fA-F]{3,8}\b/.test(clase)) motivos.push("hex literal");
  if (/\b(rgba?|hsla?)\(/.test(clase)) motivos.push("color funcional literal");
  if (/text-\[[0-9.]+px\]/.test(clase)) motivos.push("text-[Npx]");
  return motivos;
}

describe("variante rest: solo existe dentro del ambito", () => {
  const usadas = clasesRest();

  it("hay clases rest: en los primitivos y ninguna admite paleta cruda, hex ni text-[Npx]", () => {
    expect(usadas.length).toBeGreaterThan(30);
    for (const c of usadas) expect(motivosClaseRest(c), c).toEqual([]);
  });

  it("casos negativos del criterio (la vara muerde)", () => {
    expect(motivosClaseRest("rest:bg-blue-500")).toContain("paleta cruda de Tailwind");
    expect(motivosClaseRest("rest:hover:text-white")).toContain("paleta cruda de Tailwind");
    expect(motivosClaseRest("rest:bg-[#1d4ed8]")).toContain("hex literal");
    expect(motivosClaseRest("rest:bg-[rgb(29,78,216)]")).toContain("color funcional literal");
    expect(motivosClaseRest("rest:text-[13px]")).toContain("text-[Npx]");
    expect(motivosClaseRest("rest:bg-solido")).toEqual([]);
    expect(motivosClaseRest("rest:hover:bg-destructive-solido/90")).toEqual([]);
  });

  it("el plugin registra la variante con :where(html[data-ambito=\"restaurantes\"]) (especificidad 0)", () => {
    expect(VARIANTE_REST).toBe(':where(html[data-ambito="restaurantes"]) &');
    expect(typeof (ambito as { handler?: unknown }).handler).toBe("function");
  });

  it("compilada con Tailwind, TODA regla rest: lleva el prefijo del ambito y ninguna escapa", async () => {
    const resultado = await postcss([tailwindcss({ presets: [preset as never], plugins: [ambito], content: [{ raw: usadas.map((c) => `<i class="${c}"></i>`).join(""), extension: "html" }] })]).process("@tailwind utilities;", { from: undefined });
    const reglas = [...resultado.css.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s.includes("rest\\:"));
    expect(reglas.length).toBeGreaterThan(30);
    for (const sel of reglas) expect(sel, sel).toContain(':where(html[data-ambito="restaurantes"]) ');
    // Y al reves: sin ninguna clase rest:, no sale NINGUNA regla del ambito.
    const sinRest = await postcss([tailwindcss({ presets: [preset as never], plugins: [ambito], content: [{ raw: '<i class="rounded-md px-4"></i>', extension: "html" }] })]).process("@tailwind utilities;", { from: undefined });
    expect(sinRest.css).not.toContain("data-ambito");
  });
});

describe("toasts del ambito: CSS acotado al atributo", () => {
  const bloque = css.slice(css.indexOf("Toast del ambito restaurantes"), css.indexOf("Toaster (sonner) en movil"));
  it("todas las reglas empiezan por html[data-ambito=\"restaurantes\"] .toaster .toast", () => {
    const selectores = [...bloque.matchAll(/^\s*(html\[[^{]+?)\s*\{/gm)].map((m) => m[1]!);
    expect(selectores.length).toBeGreaterThanOrEqual(9);
    for (const s of selectores.join(",").split(",").map((x) => x.trim()).filter(Boolean)) expect(s, s).toMatch(/^html\[data-ambito="restaurantes"\] \.toaster \.toast/);
  });
  it("azul solido con blanco; error en rojo solido; color solo por tokens", () => {
    expect(bloque).toMatch(/\.toast \{\s*background: hsl\(var\(--solido\)\);[^}]*color: hsl\(var\(--solido-foreground\)\)/);
    expect(bloque).toMatch(/\.toast\[data-type="error"\] \{\s*background: hsl\(var\(--destructive-solido\)\)/);
    expect(bloque).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
