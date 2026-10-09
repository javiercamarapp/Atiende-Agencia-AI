// @vitest-environment jsdom
//
// UNI-R0b: el hook que enciende el ambito y la receta de clases `rest:` de botones, campos y overlays (variantes y tamanos del
// original: pildora, destructivo solido, outline, ghost, secundario; titulo de modal 18 px; velo sin desenfoque; menu azul).
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

describe("Button del ambito restaurantes (variantes y tamanos del original)", () => {
  it("base: pildora, semibold, tracking .005em, transicion con sombra", () => {
    const c = clases(buttonVariants());
    for (const k of ["rest:rounded-full", "rest:font-semibold", "rest:tracking-[0.005em]", "rest:transition-[color,background-color,border-color,opacity,transform,box-shadow]"]) expect(c, k).toContain(k);
    // Y sigue siendo el boton de Likida fuera del ambito.
    expect(c).toContain("rounded-md");
    expect(c).toContain("font-medium");
  });

  it("default: azul con sombra de tarjeta, sube 1 px y gana sombra azul al hover (solo con movimiento permitido)", () => {
    const c = clases(buttonVariants({ variant: "default" }));
    for (const k of ["bg-primary", "rest:shadow-card", "rest:motion-safe:hover:-translate-y-px", "rest:motion-safe:hover:shadow-boton"]) expect(c, k).toContain(k);
  });

  it("destructive y danger: rojo SOLIDO con blanco (no tinte rosa) en restaurantes; el tinte sigue fuera", () => {
    for (const variant of ["destructive", "danger"] as const) {
      const c = clases(buttonVariants({ variant }));
      expect(c, variant).toContain("rest:bg-destructive-solido");
      expect(c, variant).toContain("rest:text-destructive-solido-foreground");
      expect(c, variant).toContain("rest:hover:bg-destructive-solido/90");
    }
    expect(clases(buttonVariants({ variant: "danger" }))).toContain("bg-destructive-tint");
    expect(clases(buttonVariants({ variant: "danger" }))).toContain("rest:hover:opacity-100");
  });

  it("outline: borde que se oscurece al hover (26 % de la tinta) y sube 1 px; secundario y ghost salen de los tokens", () => {
    const o = clases(buttonVariants({ variant: "outline" }));
    for (const k of ["border-border", "bg-card", "rest:hover:bg-card", "rest:hover:border-foreground/[0.26]", "rest:motion-safe:hover:-translate-y-px"]) expect(o, k).toContain(k);
    expect(clases(buttonVariants({ variant: "secondary" }))).toEqual(expect.arrayContaining(["bg-secondary", "text-secondary-foreground", "hover:bg-secondary/80"]));
    expect(clases(buttonVariants({ variant: "ghost" }))).toEqual(expect.arrayContaining(["hover:bg-accent", "hover:text-accent-foreground"]));
  });

  it("tamanos: alto por --control-* (40/36/48 en el ambito) y relleno px-5 / px-4 / px-8 del original", () => {
    expect(clases(buttonVariants({ size: "default" }))).toEqual(expect.arrayContaining(["h-[var(--control-md)]", "rest:px-5"]));
    expect(clases(buttonVariants({ size: "sm" }))).toEqual(expect.arrayContaining(["h-[var(--control-sm)]", "rest:px-4", "rest:text-sm"]));
    expect(clases(buttonVariants({ size: "lg" }))).toEqual(expect.arrayContaining(["h-[var(--control-lg)]", "rest:px-8", "rest:text-base"]));
    expect(clases(buttonVariants({ size: "icon" }))).toEqual(expect.arrayContaining(["h-[var(--control-md)]", "w-[var(--control-md)]"]));
  });

  it("estados: disabled opaco 50 % sin eventos, foco por el outline global, svg de 16 px", () => {
    const c = clases(buttonVariants());
    expect(c).toEqual(expect.arrayContaining(["disabled:pointer-events-none", "disabled:opacity-50", "[&_svg]:size-4"]));
    const el = montar(createElement(Button, { disabled: true }, "No"));
    expect(el.querySelector("button")!.disabled).toBe(true);
  });
});

describe("campos del ambito", () => {
  it("radio de campo (10 px), fondo --background, 16 px en movil y 14 px desde md, foco con anillo 2 px + offset 2", () => {
    const c = clases(campoBase);
    for (const k of ["rest:rounded-field", "rest:bg-background", "rest:text-base", "rest:md:text-sm", "rest:focus-visible:ring-2", "rest:focus-visible:ring-ring", "rest:focus-visible:ring-offset-2", "rest:focus-visible:border-input"]) expect(c, k).toContain(k);
    // El estado invalido sigue ganando en restaurantes.
    expect(c).toContain("rest:aria-[invalid=true]:focus-visible:ring-destructive");
    const el = montar(createElement(Input, { "aria-label": "Nombre" }));
    expect(el.querySelector("input")!.className).toContain("rest:rounded-field");
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
