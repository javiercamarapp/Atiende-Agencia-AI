// @vitest-environment jsdom
//
// UNI-R0b: el hook que enciende el ambito y la receta de clases `rest:` de botones, campos y overlays (variantes y tamanos del
// original: pildora, destructivo solido, outline, ghost, secundario; titulo de modal 18 px; velo sin desenfoque; menu azul).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  useAmbitoVertical,
} from "../src/index";
import { buttonVariants } from "../src/components/ui/button";
import { campoBase } from "../src/components/ui/field-styles";
import { BOTON_CIERRE_MODAL, CAJA_MODAL, OVERLAY_MODAL, SUPERFICIE_FLOTANTE } from "../src/components/ui/superficies";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let raices: Array<{ root: Root; el: HTMLElement }> = [];
function montar(ui: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  raices.push({ root, el });
  return el;
}
afterEach(() => {
  for (const { root, el } of raices) {
    act(() => root.unmount());
    el.remove();
  }
  raices = [];
  document.documentElement.removeAttribute("data-ambito");
});

function Ambito({ vertical }: { vertical: string }) {
  useAmbitoVertical(vertical);
  return null;
}

describe("useAmbitoVertical", () => {
  it("pone data-ambito en <html> mientras esta montado y lo quita al desmontar", () => {
    expect(document.documentElement.getAttribute("data-ambito")).toBeNull();
    const el = montar(createElement(Ambito, { vertical: "restaurantes" }));
    expect(document.documentElement.getAttribute("data-ambito")).toBe("restaurantes");
    const r = raices.find((x) => x.el === el)!;
    act(() => r.root.unmount());
    expect(document.documentElement.hasAttribute("data-ambito")).toBe(false);
  });

  it("si otra vertical cambia el ambito entretanto, al desmontar NO lo pisa", () => {
    const el = montar(createElement(Ambito, { vertical: "restaurantes" }));
    document.documentElement.setAttribute("data-ambito", "hoteles");
    const r = raices.find((x) => x.el === el)!;
    act(() => r.root.unmount());
    expect(document.documentElement.getAttribute("data-ambito")).toBe("hoteles");
  });

  it("una vertical que no llama al hook no deja rastro en <html> (las demas verticales no cambian)", () => {
    montar(createElement(Button, null, "Guardar"));
    expect(document.documentElement.hasAttribute("data-ambito")).toBe(false);
  });
});

const clases = (s: string): string[] => s.split(/\s+/);

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");
const AMB = 'html[data-ambito="restaurantes"]';
/** Cuerpo de la regla cuyo selector es exactamente `selector` (la primera). */
function regla(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no existe la regla ${selector}`);
  return css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
}

describe("Button del ambito restaurantes (variantes y tamanos del original)", () => {
  it("las clases del ambito viajan en el Button y solo hacen algo bajo html[data-ambito=restaurantes]", () => {
    const base = clases(buttonVariants());
    expect(base).toContain("ambito-boton");
    // Y sigue siendo el boton de Likida fuera del ambito (utilidades originales intactas).
    expect(base).toEqual(expect.arrayContaining(["rounded-md", "font-medium", "text-sm"]));
    const reglas = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*([^\n{}@/*][^{}]*?)\s*\{/gm)].map((m) => m[1]!).filter((sel) => sel.includes(".ambito-"));
    expect(reglas.length).toBeGreaterThanOrEqual(15);
    for (const sel of reglas) expect(sel, sel).toMatch(/^html\[data-ambito="restaurantes"\] \.ambito-/);
  });

  it("base: pildora (radio de control), semibold, tracking .005em, transicion que incluye la sombra", () => {
    const r = regla(`${AMB} .ambito-boton`);
    expect(r).toMatch(/border-radius: var\(--radius-control\);/);
    expect(r).toMatch(/font-weight: 600;/);
    expect(r).toMatch(/letter-spacing: 0\.005em;/);
    expect(r).toMatch(/transition-property: color, background-color, border-color, opacity, transform, box-shadow;/);
    expect(css).toMatch(/--radius-control: 9999px;/);
  });

  it("default: azul con sombra de tarjeta; sube 1 px y gana la sombra azul al hover SOLO con movimiento permitido; el press escala .97", () => {
    expect(clases(buttonVariants({ variant: "default" }))).toEqual(expect.arrayContaining(["ambito-boton-primario", "bg-primary", "text-primary-foreground"]));
    expect(regla(`${AMB} .ambito-boton-primario`)).toMatch(/box-shadow: var\(--shadow-card\);/);
    const movimiento = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {\n    html[data-ambito=\"restaurantes\"] .ambito-boton-primario:hover"));
    expect(movimiento).toMatch(/\.ambito-boton-primario:hover:not\(:disabled\) \{\s*transform: translateY\(-1px\);\s*box-shadow: var\(--shadow-boton\);/);
    expect(movimiento).toMatch(/\.ambito-boton:active:not\(:disabled\) \{ transform: scale\(0\.97\); \}/);
    // La sombra azul del original: 0 10px 26px primary al 26 %.
    expect(css).toMatch(/--shadow-boton: 0 10px 26px hsl\(224 76% 48% \/ 0\.26\);/);
  });

  it("destructive y danger: rojo SOLIDO con blanco (no tinte rosa) en restaurantes, hover al 90 %; el tinte sigue fuera del ambito", () => {
    for (const variant of ["destructive", "danger"] as const) expect(clases(buttonVariants({ variant })), variant).toContain("ambito-boton-peligro");
    expect(clases(buttonVariants({ variant: "danger" }))).toContain("bg-destructive-tint");
    const r = regla(`${AMB} .ambito-boton-peligro`);
    expect(r).toMatch(/background-color: hsl\(var\(--destructive-solido\)\);/);
    expect(r).toMatch(/color: hsl\(var\(--destructive-solido-foreground\)\);/);
    const h = regla(`${AMB} .ambito-boton-peligro:hover:not(:disabled)`);
    expect(h).toMatch(/background-color: hsl\(var\(--destructive-solido\) \/ 0\.9\);/);
    expect(h).toMatch(/opacity: 1;/);
  });

  it("outline: borde que se oscurece al hover (26 % de la tinta) y sube 1 px; secundario y ghost salen de los tokens", () => {
    expect(clases(buttonVariants({ variant: "outline" }))).toEqual(expect.arrayContaining(["ambito-boton-borde", "border-border", "bg-card"]));
    const h = regla(`${AMB} .ambito-boton-borde:hover:not(:disabled)`);
    expect(h).toMatch(/background-color: hsl\(var\(--card\)\);/);
    expect(h).toMatch(/border-color: hsl\(var\(--foreground\) \/ 0\.26\);/);
    expect(css).toMatch(/\.ambito-boton-borde:hover:not\(:disabled\) \{ transform: translateY\(-1px\); \}/);
    expect(clases(buttonVariants({ variant: "secondary" }))).toEqual(expect.arrayContaining(["bg-secondary", "text-secondary-foreground", "hover:bg-secondary/80"]));
    expect(clases(buttonVariants({ variant: "ghost" }))).toEqual(expect.arrayContaining(["hover:bg-accent", "hover:text-accent-foreground"]));
  });

  it("tamanos: alto por --control-* (40/36/48 en el ambito) y relleno 20 / 16 / 32 px del original (px-5 / px-4 / px-8)", () => {
    expect(clases(buttonVariants({ size: "default" }))).toEqual(expect.arrayContaining(["ambito-boton-md", "h-[var(--control-md)]"]));
    expect(clases(buttonVariants({ size: "sm" }))).toEqual(expect.arrayContaining(["ambito-boton-sm", "h-[var(--control-sm)]"]));
    expect(clases(buttonVariants({ size: "lg" }))).toEqual(expect.arrayContaining(["ambito-boton-lg", "h-[var(--control-lg)]"]));
    expect(clases(buttonVariants({ size: "icon" }))).toEqual(expect.arrayContaining(["h-[var(--control-md)]", "w-[var(--control-md)]"]));
    expect(regla(`${AMB} .ambito-boton-md`)).toMatch(/padding-inline: 1\.25rem;/);
    expect(regla(`${AMB} .ambito-boton-sm`)).toMatch(/padding-inline: 1rem;\s*font-size: 0\.875rem;/);
    expect(regla(`${AMB} .ambito-boton-lg`)).toMatch(/padding-inline: 2rem;\s*font-size: 1rem;/);
  });

  it("estados: disabled opaco 50 % sin eventos, foco por el outline global, svg de 16 px", () => {
    expect(clases(buttonVariants())).toEqual(expect.arrayContaining(["disabled:pointer-events-none", "disabled:opacity-50", "[&_svg]:size-4"]));
    const el = montar(createElement(Button, { disabled: true }, "No"));
    expect(el.querySelector("button")!.disabled).toBe(true);
    // El hover/active de elevacion no aplica a un boton deshabilitado.
    expect(css).not.toMatch(/\.ambito-boton[\w-]*:(hover|active)\s*\{/);
  });

  it("ninguna regla ambito-* usa color crudo: todo por token", () => {
    const trozo = css.slice(css.indexOf("Boton y campo del ambito restaurantes"), css.indexOf("Toaster (sonner) en movil"));
    expect(trozo.length).toBeGreaterThan(500);
    expect(trozo).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
    const todas = trozo.match(/hsl\(/g)?.length ?? 0;
    const portoken = trozo.match(/hsl\(var\(--[\w-]+\)(?: \/ [0-9.]+)?\)/g)?.length ?? 0;
    expect(todas).toBeGreaterThan(8);
    expect(portoken).toBe(todas);
  });
});

describe("campos del ambito", () => {
  it("campoBase lleva ambito-campo y conserva el campo de Likida; el ambito da radio de campo (10 px), fondo --background, 16 px en movil y 14 px desde md", () => {
    const c = clases(campoBase);
    expect(c).toEqual(expect.arrayContaining(["ambito-campo", "rounded-lg", "bg-card", "text-ui", "border-input"]));
    const r = regla(`${AMB} .ambito-campo`);
    expect(r).toMatch(/border-radius: var\(--radius-field\);/);
    expect(r).toMatch(/background-color: hsl\(var\(--background\)\);/);
    expect(r).toMatch(/font-size: 1rem;/);
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*html\[data-ambito="restaurantes"\] \.ambito-campo \{ font-size: 0\.875rem; line-height: 1\.25rem; \}/);
    const el = montar(createElement(Input, { "aria-label": "Nombre" }));
    expect(el.querySelector("input")!.className).toContain("ambito-campo");
  });

  it("foco con anillo de 2 px y offset 2 sobre --background; invalido con anillo de peligro", () => {
    expect(regla(`${AMB} .ambito-campo:focus-visible`)).toMatch(/border-color: hsl\(var\(--input\)\);\s*box-shadow: 0 0 0 2px hsl\(var\(--background\)\), 0 0 0 4px hsl\(var\(--ring\)\);/);
    expect(regla(`${AMB} .ambito-campo[aria-invalid="true"]:focus-visible`)).toMatch(/box-shadow: 0 0 0 2px hsl\(var\(--background\)\), 0 0 0 4px hsl\(var\(--destructive\)\);/);
  });
});

describe("overlays del ambito", () => {
  it("velo: negro al 80 % SIN desenfoque (el original no desenfoca y oscurece mas)", () => {
    expect(clases(OVERLAY_MODAL)).toEqual(expect.arrayContaining(["rest:bg-scrim", "rest:backdrop-blur-none"]));
  });

  it("caja del modal: radio 12 px desde md (la hoja movil conserva el suyo), relleno 24 px", () => {
    const c = clases(CAJA_MODAL);
    expect(c).toContain("rest:md:rounded-dialog");
    expect(c).toContain("rest:p-6");
    expect(c.some((k) => /^rest:rounded-dialog$/.test(k))).toBe(false);
  });

  it("cierre del modal con anillo azul de foco (2 px, offset 2) y menus/popover con radio de menu", () => {
    expect(clases(BOTON_CIERRE_MODAL)).toEqual(expect.arrayContaining(["rest:focus-visible:ring-2", "rest:focus-visible:ring-ring", "rest:focus-visible:ring-offset-2", "rest:ring-offset-card"]));
    expect(clases(SUPERFICIE_FLOTANTE)).toContain("rest:rounded-menu");
  });

  it("Dialog: titulo de 18 px y descripcion de 14 px en restaurantes; 16/13 px fuera", () => {
    montar(
      createElement(Dialog, { open: true }, createElement(DialogContent, null, createElement(DialogTitle, null, "Editar"), createElement(DialogDescription, null, "Detalle"))),
    );
    const t = document.body.querySelector("[role=dialog] h2")!;
    expect(clases(t.className)).toEqual(expect.arrayContaining(["text-base", "rest:text-lg", "rest:leading-none", "rest:tracking-tight"]));
    const d = document.body.querySelector("[role=dialog] p")!;
    expect(clases(d.className)).toEqual(expect.arrayContaining(["text-ui", "rest:text-sm"]));
    const overlay = document.body.querySelector("[data-state=open][class*=bg-foreground]")!;
    expect(clases(overlay.className)).toContain("rest:bg-scrim");
    const cierre = document.body.querySelector("[role=dialog] button")!;
    expect(cierre.getAttribute("class")).toContain("rest:focus-visible:ring-2");
  });

  it("AlertDialog: mismo titulo de 18 px y velo", () => {
    montar(
      createElement(AlertDialog, { open: true }, createElement(AlertDialogContent, null, createElement(AlertDialogTitle, null, "¿Cancelar?"), createElement(AlertDialogDescription, null, "Sin vuelta"))),
    );
    const t = document.body.querySelector("[role=alertdialog] h2")!;
    expect(clases(t.className)).toContain("rest:text-lg");
  });
});
