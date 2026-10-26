// @vitest-environment jsdom
//
// ds3 / 3.1: Button (§3.1, §2.3). jsdom no resuelve var() ni las utilidades de Tailwind, asi que el spec lee index.css con postcss, evalua
// los @media con un window.matchMedia simulado (puntero grueso / ancho) y resuelve los --control-* igual que lo haria el navegador.
// Con la bandera apagada las clases `ds3-btn*` no coinciden con ninguna regla (todas cuelgan de html[data-diseno="ds3"]).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Button } from "../src/components/ui/button";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const aqui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aqui, "../src/index.css"), "utf8");
const BANDERA = 'html[data-diseno="ds3"]';

// ---- matchMedia simulado ---------------------------------------------------------------------------------------------------------------
type Entorno = { gruesso: boolean; ancho: number };
let entorno: Entorno = { gruesso: false, ancho: 1280 };

function evaluar(consulta: string): boolean {
  return consulta.split(",").some((alt) => {
    const partes = alt.match(/\(([^)]+)\)/g) ?? [];
    return (
      partes.length > 0 &&
      partes.every((p) => {
        const [k, v] = p.slice(1, -1).split(":").map((x) => x.trim());
        if (k === "pointer") return (v === "coarse") === entorno.gruesso;
        if (k === "max-width") return entorno.ancho <= parseFloat(v!);
        if (k === "min-width") return entorno.ancho >= parseFloat(v!);
        return false; // prefers-reduced-motion etc.: no aplican a las alturas
      })
    );
  });
}

function instalarMatchMedia(): void {
  window.matchMedia = ((q: string) =>
    ({ matches: evaluar(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

// ---- lectura del CSS --------------------------------------------------------------------------------------------------------------------
const raiz = postcss.parse(css);

/** Reglas cuyo selector coincide con `selector` y cuyos @media ancestros estan activos segun matchMedia. En orden de aparicion. */
function reglas(selector: string): Rule[] {
  const salida: Rule[] = [];
  raiz.walkRules((r) => {
    if (!r.selectors.some((s) => s.replace(/\s+/g, " ").trim() === selector)) return;
    for (let p: Container | undefined = r.parent; p && p.type !== "root"; p = p.parent as Container | undefined) {
      if (p.type === "atrule" && (p as AtRule).name === "media" && !window.matchMedia((p as AtRule).params).matches) return;
    }
    salida.push(r);
  });
  return salida;
}

/** Valor final de la propiedad (la ultima declaracion activa gana). */
function declarada(selector: string, prop: string): string | undefined {
  let v: string | undefined;
  for (const r of reglas(selector)) r.walkDecls(prop, (d) => void (v = d.value.trim()));
  return v;
}

/** Variable resuelta como en <html data-diseno="ds3">: el bloque ds3 y, encima, el bloque tactil. */
function variable(nombre: string): string | undefined {
  const v = declarada(BANDERA, nombre);
  return v;
}

function px(valor: string | undefined): number {
  if (!valor) return Number.NaN;
  const m = valor.match(/^(-?[\d.]+)(px|rem)$/);
  if (!m) return Number.NaN;
  return m[2] === "rem" ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
}

/** Alto (px) que daria el navegador a un boton con esa clase de tamano. */
function altoDe(claseTamano: string): number {
  const alto = declarada(`${BANDERA} .ds3-btn.${claseTamano}`, "height");
  const m = alto?.match(/^var\((--control-[a-z]+)\)$/);
  if (!m) return Number.NaN;
  return px(variable(m[1]!));
}

// ---- montaje ----------------------------------------------------------------------------------------------------------------------------
let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: React.ReactElement): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return el;
}

beforeEach(() => {
  entorno = { gruesso: false, ancho: 1280 };
  instalarMatchMedia();
});
afterEach(() => {
  for (const { root, el } of raices) {
    act(() => root.unmount());
    el.remove();
  }
  raices = [];
});

const TAMANOS: Array<[string, string, number, number]> = [
  // [prop size, clase, escritorio, tactil]
  ["xs", "ds3-btn-xs", 24, 32],
  ["sm", "ds3-btn-sm", 28, 36],
  ["md", "ds3-btn-md", 32, 44],
  ["default", "ds3-btn-md", 32, 44],
  ["lg", "ds3-btn-lg", 36, 44],
  ["icon-xs", "ds3-btn-icon-xs", 24, 32],
  ["icon-sm", "ds3-btn-icon-sm", 28, 36],
  ["icon", "ds3-btn-icon", 32, 44],
];

describe("Button ds3: alturas por --control-* (±1 px)", () => {
  for (const [size, clase, escritorio, tactil] of TAMANOS) {
    it(`${size}: ${escritorio} px en escritorio y ${tactil} px en tactil`, () => {
      const el = montar(createElement(Button, { size: size as never, "aria-label": "x" }, "x"));
      const boton = el.querySelector("button")!;
      expect(boton.classList.contains("ds3-btn")).toBe(true);
      expect(boton.classList.contains(clase)).toBe(true);

      entorno = { gruesso: false, ancho: 1280 };
      expect(Math.abs(altoDe(clase) - escritorio)).toBeLessThanOrEqual(1);

      entorno = { gruesso: true, ancho: 1280 }; // pointer: coarse
      expect(Math.abs(altoDe(clase) - tactil)).toBeLessThanOrEqual(1);

      entorno = { gruesso: false, ancho: 390 }; // movil por ancho (<768)
      expect(Math.abs(altoDe(clase) - tactil)).toBeLessThanOrEqual(1);
    });
  }

  it("los iconos solos son cuadrados del alto y sin relleno", () => {
    for (const [clase, token] of [["ds3-btn-icon", "--control-md"], ["ds3-btn-icon-sm", "--control-sm"], ["ds3-btn-icon-xs", "--control-xs"]] as const) {
      const sel = `${BANDERA} .ds3-btn.${clase}`;
      expect(declarada(sel, "width")).toBe(`var(${token})`);
      expect(declarada(sel, "height")).toBe(`var(${token})`);
      expect(declarada(sel, "padding")).toBe("0");
    }
  });

  it("padding-x 8/10/12/14, gap 6, fuente 12/500, radio 8 por token", () => {
    const x = (c: string) => px(declarada(`${BANDERA} .ds3-btn.ds3-btn-${c}:not([class~="ambito-ov-px"])`, "padding-inline"));
    expect([x("xs"), x("sm"), x("md"), x("lg")]).toEqual([8, 10, 12, 14]);
    const base = `${BANDERA} .ds3-btn.ds3-btn`;
    expect(px(declarada(base, "gap"))).toBe(6);
    expect(px(declarada(`${base}:not([class~="ambito-ov-texto"])`, "font-size"))).toBe(12);
    expect(declarada(`${base}:not([class~="ambito-ov-peso"])`, "font-weight")).toBe("500");
    expect(declarada(`${base}:not([class~="ambito-ov-radio"])`, "border-radius")).toBe("var(--radius-control)");
    expect(declarada(base, "text-transform")).toBe("none");
  });

  it("xs y sm tactiles ganan area de toque de 44 (--target-min) sin cambiar el alto", () => {
    entorno = { gruesso: true, ancho: 390 };
    const sel = `${BANDERA} .ds3-btn.ds3-btn:is(.ds3-btn-xs, .ds3-btn-sm, .ds3-btn-icon-xs, .ds3-btn-icon-sm)::after`;
    expect(declarada(sel, "min-width")).toBe("var(--target-min)");
    expect(declarada(sel, "min-height")).toBe("var(--target-min)");
    expect(px(variable("--target-min"))).toBeGreaterThanOrEqual(44);
    entorno = { gruesso: false, ancho: 1280 };
    expect(declarada(sel, "min-width")).toBeUndefined();
  });
});

describe("Button ds3: variantes", () => {
  const nombres: Array<[string, string]> = [
    ["default", "ds3-btn-v-default"],
    ["solid", "ds3-btn-v-solid"],
    ["secondary", "ds3-btn-v-secondary"],
    ["outline", "ds3-btn-v-outline"],
    ["ghost", "ds3-btn-v-ghost"],
    ["danger", "ds3-btn-v-danger"],
    ["destructive", "ds3-btn-v-danger"],
    ["danger-outline", "ds3-btn-v-danger"],
    ["link", "ds3-btn-v-link"],
  ];
  for (const [variant, clase] of nombres) {
    it(`${variant} -> ${clase}`, () => {
      const el = montar(createElement(Button, { variant: variant as never }, "Accion"));
      expect(el.querySelector("button")!.classList.contains(clase)).toBe(true);
    });
  }

  const v = (c: string, p: string) => declarada(`${BANDERA} .ds3-btn.ds3-btn-v-${c}`, p);
  const h = (c: string, p: string) => declarada(`${BANDERA} .ds3-btn.ds3-btn-v-${c}:hover:not(:disabled, [aria-disabled="true"])`, p);

  it("default es suave: primary-soft / primary-ink / borde primary al 30 %", () => {
    expect(v("default", "background-color")).toBe("hsl(var(--primary-soft))");
    expect(v("default", "color")).toBe("hsl(var(--primary-ink))");
    expect(v("default", "border-color")).toBe("hsl(var(--primary) / 0.3)");
    expect(h("default", "background-color")).toBe("hsl(var(--primary-soft-hover))");
  });
  it("solid usa la tinta de accion", () => {
    expect(v("solid", "background-color")).toBe("hsl(var(--action))");
    expect(v("solid", "color")).toBe("hsl(var(--action-foreground))");
    expect(h("solid", "background-color")).toBe("hsl(var(--action-hover))");
  });
  it("secondary / outline / ghost", () => {
    expect(v("secondary", "background-color")).toBe("hsl(var(--card))");
    expect(v("secondary", "border-color")).toBe("hsl(var(--border-strong))");
    expect(v("outline", "background-color")).toBe("transparent");
    expect(v("outline", "border-color")).toBe("hsl(var(--border-strong))");
    expect(v("ghost", "background-color")).toBe("transparent");
    expect(h("ghost", "background-color")).toBe("hsl(var(--soft))");
  });
  it("danger (y sus alias) = tinte danger + borde danger-ink/30 + texto danger-ink", () => {
    expect(v("danger", "background-color")).toBe("hsl(var(--danger-tint))");
    expect(v("danger", "color")).toBe("hsl(var(--danger-ink))");
    expect(v("danger", "border-color")).toBe("hsl(var(--danger-ink) / 0.3)");
  });
  it("link subraya 1 px y 2 px en hover", () => {
    expect(v("link", "text-decoration-line")).toBe("underline");
    expect(v("link", "text-decoration-thickness")).toBe("1px");
    expect(h("link", "text-decoration-thickness")).toBe("2px");
  });
  it("las clases de produccion se conservan y className del consumidor sigue ganando en cn()", () => {
    const el = montar(createElement(Button, { variant: "default", size: "sm", className: "h-9 w-full rounded-full" }, "Ok"));
    const c = el.querySelector("button")!.classList;
    expect(c.contains("bg-primary")).toBe(true);
    expect(c.contains("h-9")).toBe(true);
    expect(c.contains("h-[var(--control-sm)]")).toBe(false); // cn() fusiona
    expect(c.contains("ambito-ov-radio")).toBe(true); // el radio del consumidor se respeta tambien bajo ds3
  });
  it("sin la bandera ninguna regla ds3-btn existe fuera de html[data-diseno=ds3] (produccion intacta)", () => {
    let fuera = 0;
    raiz.walkRules((r) => {
      if (r.selector.includes("ds3-btn") && !r.selectors.every((s) => s.trim().startsWith(BANDERA))) fuera++;
    });
    expect(fuera).toBe(0);
  });
});

describe("Button ds3: estados", () => {
  it("sin press global ni elevacion: transform none en :active y :hover", () => {
    expect(declarada(`${BANDERA} button:not(:disabled):active`, "transform")).toBe("none");
    expect(declarada(`${BANDERA} .ds3-btn.ds3-btn:active:not(:disabled)`, "transform")).toBe("none");
    expect(declarada(`${BANDERA} .ds3-btn.ds3-btn:hover:not(:disabled)`, "transform")).toBe("none");
  });
  it("el press global de produccion sigue existiendo (no se borra, solo se anula bajo ds3)", () => {
    expect(css).toMatch(/\n\s{4}button:not\(:disabled\):active \{\s*transform: scale\(0\.97\);/);
  });
  it("focus-visible: el anillo de 2 px de ds3 aplica y ninguna regla del boton quita el outline", () => {
    expect(declarada(`${BANDERA} :focus-visible`, "outline")).toBe("2px solid hsl(var(--ring))");
    expect(declarada(`${BANDERA} :focus-visible`, "outline-offset")).toBe("2px");
    raiz.walkRules((r) => {
      if (!r.selector.includes("ds3-btn")) return;
      r.walkDecls((d) => {
        expect(d.prop === "outline" || d.prop === "outline-style" || d.prop === "outline-width").toBe(false);
      });
    });
    const el = montar(createElement(Button, null, "Foco"));
    const b = el.querySelector("button")!;
    act(() => b.focus());
    expect(document.activeElement).toBe(b);
  });
  it("loading conserva el nombre accesible, bloquea y marca aria-busy", () => {
    const el = montar(createElement(Button, { loading: true }, "Guardar cambios"));
    const b = el.querySelector("button")!;
    expect(b.textContent).toContain("Guardar cambios");
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(b.classList.contains("ds3-btn")).toBe(true);
    const aria = Array.from(b.querySelectorAll("svg")).every((s) => s.getAttribute("aria-hidden") === "true");
    expect(aria).toBe(true);
  });
  it("loading con loadingText true usa el texto unificado como nombre", () => {
    const el = montar(createElement(Button, { loading: true, loadingText: true }, "Guardar"));
    expect(el.querySelector("button")!.textContent).toContain("Guardando...");
  });
  it("icon sigue pidiendo su aria-label al consumidor (no se cambia ningun rol)", () => {
    const el = montar(createElement(Button, { size: "icon", "aria-label": "Cerrar" }, "x"));
    expect(el.querySelector("button")!.getAttribute("aria-label")).toBe("Cerrar");
  });
});
