// Lote 1.1 del rediseno ds3: tokens PRE-DECLARADOS con el valor del diseno ACTUAL (cero cambio visual).
// Afirma (1) que cada token nuevo existe en :root y en .dark con un triplete HSL legible (salvo los de
// longitud/sombra), (2) que los alias del diseno actual siguen siendo identicos a su origen, (3) contrastes
// de los pares nuevos, (4) que cada entrada del preset apunta a una variable definida y (5) que cn() conoce
// los nombres nuevos. No toca specs existentes.
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
function tokens(selector: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)\\s*${escapar(selector)}\\s*\\{([^}]*)\\}`, "g");
  const salida: Record<string, string> = {};
  for (const m of css.matchAll(re)) {
    for (const decl of (m[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) salida[decl[1]!] = decl[2]!.trim();
  }
  return salida;
}
const claro = tokens(":root");
const oscuro = { ...claro, ...tokens(".dark") };

const SERIES = [1, 2, 3, 4, 5, 6, 7, 8];
const COLORES = [
  "--soft", "--border-strong", "--action", "--action-foreground", "--action-hover",
  "--primary-soft", "--primary-soft-hover", "--primary-ink",
  "--success-ink", "--warning-ink", "--danger-tint", "--danger-ink", "--info-ink",
  ...SERIES.flatMap((n) => [`--chart-${n}`, `--chart-soft-${n}`, `--on-chart-${n}`]),
];
const OTROS_CLARO = [
  "--control-xs", "--pad-card", "--gap-bloque", "--header-h", "--sidebar-w", "--sidebar-w-rail",
  "--bottomnav-h", "--nav-total", "--shadow-pop", "--carga-panel-h",
];

describe("tokens nuevos del lote 1.1", () => {
  it.each(COLORES)("%s es un triplete HSL en claro y en oscuro", (token) => {
    expect(() => parseHsl(tokens(":root")[token]!), `${token} en :root`).not.toThrow();
    expect(() => parseHsl(tokens(".dark")[token]!), `${token} en .dark`).not.toThrow();
  });

  it.each(OTROS_CLARO)("%s esta definido en :root", (token) => {
    expect(tokens(":root")[token], token).toBeTruthy();
  });

  it("--shadow-pop tambien en oscuro", () => {
    expect(tokens(".dark")["--shadow-pop"]).toBeTruthy();
  });

  it("los tokens que YA existian no se redefinieron en este lote (una sola declaracion por bloque)", () => {
    for (const nombre of ["--sunken", "--font-sans", "--font-mono", "--dur-fast", "--dur-base", "--dur-slow", "--chart-1", "--chart-5"]) {
      const enRoot = [...(css.match(new RegExp(`\\n\\s*${escapar(nombre)}\\s*:`, "g")) ?? [])].length;
      // :root + .dark + bloques de ambito ya existentes; lo importante es que el valor de :root sea el de produccion.
      expect(enRoot, nombre).toBeGreaterThanOrEqual(1);
    }
    expect(claro["--font-mono"]).toBe('"IBM Plex Mono", ui-monospace, monospace');
    expect(claro["--font-sans"]).toBe('"Inter", system-ui, sans-serif');
    expect(claro["--dur-fast"]).toBe("150ms");
    expect(claro["--dur-base"]).toBe("250ms");
    expect(claro["--dur-slow"]).toBe("400ms");
    expect(claro["--sunken"]).toBe("240 4.8% 95.9%");
    expect(oscuro["--sunken"]).toBe("240 7% 11.4%");
  });
});

describe("alias del diseno actual (mismo valor que su origen)", () => {
  const alias: Array<[string, string]> = [
    ["--soft", "--muted"],
    ["--border-strong", "--line2"],
    ["--action-foreground", "--primary-foreground"],
    ["--success-ink", "--success"],
    ["--warning-ink", "--warning"],
    ["--danger-tint", "--destructive-tint"],
    ["--danger-ink", "--destructive"],
    ["--info-ink", "--info"],
  ];
  it.each(alias)("%s = %s en claro y oscuro", (nuevo, origen) => {
    expect(claro[nuevo]).toBe(claro[origen]);
    expect(oscuro[nuevo]).toBe(oscuro[origen]);
  });
  it("--action = --primary y --shadow-pop = --shadow-elevated", () => {
    expect(claro["--action"]).toBe(claro["--primary"]);
    expect(oscuro["--action"]).toBe(oscuro["--primary"]);
    expect(claro["--shadow-pop"]).toBe(claro["--shadow-elevated"]);
    expect(oscuro["--shadow-pop"]).toBe(oscuro["--shadow-elevated"]);
  });
  it("--chart-soft-n = --muted", () => {
    for (const n of SERIES) {
      expect(claro[`--chart-soft-${n}`]).toBe(claro["--muted"]);
      expect(oscuro[`--chart-soft-${n}`]).toBe(oscuro["--muted"]);
    }
  });
});

function ratio(t: Record<string, string>, fg: string, bg: string): number {
  return contraste(parseHsl(t[fg]!), parseHsl(t[bg]!));
}

describe("contraste de los pares nuevos", () => {
  const pares: Array<[string, string, string, number]> = [
    ["texto de accion sobre accion", "--action-foreground", "--action", 4.5],
    ["texto de accion sobre su hover", "--action-foreground", "--action-hover", 4.5],
    ["tinta de primary sobre su tinte", "--primary-ink", "--primary-soft", 4.5],
    ["tinta de primary sobre su hover", "--primary-ink", "--primary-soft-hover", 4.5],
    ["tinta de exito sobre su tinte", "--success-ink", "--success-tint", 4.5],
    ["tinta de aviso sobre su tinte", "--warning-ink", "--warning-tint", 4.5],
    ["tinta de peligro sobre su tinte", "--danger-ink", "--danger-tint", 4.5],
    ["tinta de info sobre su tinte", "--info-ink", "--info-tint", 4.5],
    ["tinta de primary sobre card", "--primary-ink", "--card", 4.5],
  ];
  it.each(pares)("claro: %s", (_n, fg, bg, min) => expect(ratio(claro, fg, bg)).toBeGreaterThanOrEqual(min));
  it.each(pares)("oscuro: %s", (_n, fg, bg, min) => expect(ratio(oscuro, fg, bg)).toBeGreaterThanOrEqual(min));

  // --on-chart-n debe ser el de MAYOR contraste entre tinta y blanco/card; si ninguno llega a 4.5 la serie no lleva texto encima.
  // Candidatos: la tinta (--foreground) o el fondo de tarjeta (blanco en claro, casi negro en oscuro).
  const candidatos = (t: Record<string, string>): string[] => [t["--foreground"]!, t["--card"]!];
  it.each(SERIES)("--on-chart-%i es el mejor candidato sobre su serie (claro y oscuro)", (n) => {
    for (const t of [claro, oscuro]) {
      const fondo = parseHsl(t[`--chart-${n}`]!);
      const elegido = contraste(parseHsl(t[`--on-chart-${n}`]!), fondo);
      const mejor = Math.max(...candidatos(t).map((c) => contraste(parseHsl(c), fondo)));
      expect(elegido).toBeCloseTo(mejor, 1);
    }
  });
});

describe("preset: cada entrada nueva apunta a una variable definida", () => {
  const colores = (preset.theme?.extend?.colors ?? {}) as Record<string, unknown>;
  const planos: Record<string, string> = {};
  (function aplanar(obj: Record<string, unknown>, prefijo: string) {
    for (const [k, v] of Object.entries(obj)) {
      const clave = k === "DEFAULT" ? prefijo : prefijo ? `${prefijo}-${k}` : k;
      if (typeof v === "string") planos[clave] = v;
      else aplanar(v as Record<string, unknown>, clave);
    }
  })(colores, "");

  const nuevos: Record<string, string> = {
    soft: "--soft",
    "border-strong": "--border-strong",
    action: "--action",
    "action-foreground": "--action-foreground",
    "action-hover": "--action-hover",
    "primary-soft": "--primary-soft",
    "primary-soft-hover": "--primary-soft-hover",
    "primary-ink": "--primary-ink",
    "success-ink": "--success-ink",
    "warning-ink": "--warning-ink",
    "danger-tint": "--danger-tint",
    "danger-ink": "--danger-ink",
    "info-ink": "--info-ink",
    "chart-6": "--chart-6",
    "chart-7": "--chart-7",
    "chart-8": "--chart-8",
    ...Object.fromEntries(SERIES.map((n) => [`chart-soft-${n}`, `--chart-soft-${n}`])),
    ...Object.fromEntries(SERIES.map((n) => [`on-chart-${n}`, `--on-chart-${n}`])),
  };
  it.each(Object.entries(nuevos))("color %s -> hsl(var(%s))", (clave, variable) => {
    expect(planos[clave]).toBe(`hsl(var(${variable}))`);
  });

  it("sombra pop y familias/duraciones ya existentes siguen apuntando a sus variables", () => {
    const ext = preset.theme?.extend as Record<string, Record<string, unknown>>;
    expect(ext.boxShadow!.pop).toBe("var(--shadow-pop)");
    expect(ext.boxShadow!.card).toBe("var(--shadow-card)");
    expect(ext.transitionDuration).toMatchObject({ fast: "var(--dur-fast)", base: "var(--dur-base)", slow: "var(--dur-slow)" });
    expect(ext.fontFamily).toMatchObject({ sans: ["var(--font-sans)"], mono: ["var(--font-mono)"] });
  });

  it("no se renombro ni se quito ningun color existente", () => {
    for (const clave of ["border", "input", "ring", "background", "foreground", "primary", "primary-foreground", "destructive", "destructive-tint", "success", "success-tint", "warning", "info", "sunken", "canvas", "chart-1", "chart-5", "chart-ventas", "card", "muted-foreground"]) {
      expect(planos[clave], clave).toBeTruthy();
    }
  });
});

describe("cn() conoce los nombres nuevos (tailwind-merge)", () => {
  it("shadow-pop se deduplica contra shadow-md en ambos ordenes", () => {
    expect(cn("shadow-md", "shadow-pop")).toBe("shadow-pop");
    expect(cn("shadow-pop", "shadow-md")).toBe("shadow-md");
  });
  it("shadow-pop convive con un color de sombra", () => {
    expect(cn("shadow-pop", "shadow-primary")).toBe("shadow-pop shadow-primary");
  });
  it.each([
    ["bg-soft", "bg-primary-soft"],
    ["bg-action", "bg-soft"],
    ["border-border-strong", "border-border"],
    ["text-primary-ink", "text-foreground"],
    ["text-on-chart-3", "text-success-ink"],
    ["bg-chart-soft-2", "bg-chart-7"],
    ["bg-danger-tint", "bg-success-tint"],
  ])("%s y %s son del mismo grupo: gana el ultimo", (a, b) => {
    expect(cn(a, b)).toBe(b);
  });
  it("un color nuevo no descarta el tamano ni el ancho de borde", () => {
    expect(cn("text-ui", "text-primary-ink")).toBe("text-ui text-primary-ink");
    expect(cn("text-primary-ink", "text-ui")).toBe("text-primary-ink text-ui");
    expect(cn("border", "border-border-strong")).toBe("border border-border-strong");
    expect(cn("border-border-strong", "border-2")).toBe("border-border-strong border-2");
  });
  it("las clases de otros grupos no se pisan", () => {
    expect(cn("bg-action", "text-action-foreground", "hover:bg-action-hover")).toBe("bg-action text-action-foreground hover:bg-action-hover");
  });
});
