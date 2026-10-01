// @vitest-environment jsdom
//
// UNI-3a (Atiende = Likida): primitivos de accion. Afirma la forma de Likida (clases
// y tokens reales), el texto unificado de guardado, el select sin recorte, las pestanas
// desplazables y la accesibilidad basica (foco visible, nombres accesibles, teclado).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, buttonVariants, Checkbox, FormField, Input, NativeSelect, Switch, Tabs, TabsContent, TabsList, TabsTrigger, TEXTO_GUARDANDO, Textarea } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});
const q = <T extends Element>(sel: string): T => {
  const el = rendered!.container.querySelector<T>(sel);
  if (!el) throw new Error(`no existe ${sel}`);
  return el;
};
// vitest corre desde la raiz del repo (mismo criterio que los demas specs que leen fuentes).
const fuente = (ruta: string) => readFileSync(join(process.cwd(), "packages/ui/src", ruta), "utf8");

describe("Button como Likida", () => {
  it("default: h-9 px-4 rounded-md text-sm font-medium con el azul de marca, sin sombra ni elevacion", () => {
    const c = buttonVariants({});
    for (const k of ["h-[var(--control-md)]", "px-4", "rounded-md", "text-sm", "font-medium", "bg-primary", "text-primary-foreground"]) expect(c).toContain(k);
    expect(c).not.toMatch(/rounded-full|font-semibold|tracking|shadow|translate/);
  });

  it("sm = CTA de cabecera (h-8 px-3 rounded-lg text-ui) y xs = boton de toolbar (h-7 px-2.5 rounded-lg text-xs)", () => {
    const sm = buttonVariants({ size: "sm" });
    for (const k of ["h-[var(--control-sm)]", "px-3", "rounded-lg", "text-ui"]) expect(sm).toContain(k);
    const xs = buttonVariants({ size: "xs" });
    for (const k of ["h-7", "px-2.5", "rounded-lg", "text-xs"]) expect(xs).toContain(k);
  });

  it("outline = borde hairline sobre tarjeta con hover canvas; danger = tinte; danger-outline = borde de peligro", () => {
    expect(buttonVariants({ variant: "outline" })).toMatch(/border-border.*bg-card.*hover:bg-canvas/);
    expect(buttonVariants({ variant: "danger" })).toMatch(/bg-destructive-tint.*text-destructive/);
    const d = buttonVariants({ variant: "danger-outline" });
    expect(d).toContain("border-destructive/40");
    expect(d).toContain("text-destructive");
  });

  it("los alias previos (destructive, secondary, ghost, link, icon, icon-sm, lg, md) siguen existiendo", () => {
    for (const variant of ["destructive", "secondary", "ghost", "link"] as const) expect(buttonVariants({ variant })).toBeTruthy();
    expect(buttonVariants({ size: "lg" })).toContain("h-[var(--control-lg)]");
    expect(buttonVariants({ size: "icon" })).toContain("w-[var(--control-md)]");
    expect(buttonVariants({ size: "icon-sm" })).toContain("w-[var(--control-sm)]");
  });

  it("loadingText={true} muestra 'Guardando...' mientras carga y vuelve al texto al terminar; sin loadingText conserva el texto", () => {
    expect(TEXTO_GUARDANDO).toBe("Guardando...");
    rendered = renderComponent(
      <Button loading loadingText>
        Guardar
      </Button>,
    );
    expect(q<HTMLButtonElement>("button").textContent).toBe("Guardando...");
    expect(q<HTMLButtonElement>("button").getAttribute("aria-busy")).toBe("true");
    rendered.rerender(
      <Button loadingText>
        Guardar
      </Button>,
    );
    expect(q<HTMLButtonElement>("button").textContent).toBe("Guardar");
    rendered.rerender(<Button loading>Guardar</Button>);
    expect(q<HTMLButtonElement>("button").textContent).toBe("Guardar");
    rendered.rerender(
      <Button loading loadingText="Enviando...">
        Enviar
      </Button>,
    );
    expect(q<HTMLButtonElement>("button").textContent).toBe("Enviando...");
  });

  it("a11y: el nombre accesible es el texto; un boton solo-icono con aria-label lo conserva", () => {
    rendered = renderComponent(
      <Button size="icon" aria-label="Cerrar">
        <svg aria-hidden="true" />
      </Button>,
    );
    expect(q<HTMLButtonElement>("button").getAttribute("aria-label")).toBe("Cerrar");
  });
});

describe("campos como Likida", () => {
  it("Input / Textarea / NativeSelect comparten: rounded-lg, bg-card, text-ui, borde --input y foco por borde", () => {
    rendered = renderComponent(
      <>
        <Input aria-label="a" />
        <Textarea aria-label="b" />
        <NativeSelect aria-label="c">
          <option>x</option>
        </NativeSelect>
      </>,
    );
    for (const el of [q("input"), q("textarea"), q("select")]) {
      for (const k of ["rounded-lg", "bg-card", "text-ui", "border-input", "px-3", "focus-visible:border-muted-foreground"]) expect(el.className, k).toContain(k);
      expect(el.className).not.toMatch(/ring-offset|md:text-sm|rounded-field/);
    }
  });

  it("el foco con teclado sigue siendo visible: ring-1 del mismo color y nunca outline anulado sin reemplazo", () => {
    rendered = renderComponent(<Input aria-label="a" />);
    expect(q("input").className).toContain("focus-visible:ring-1");
    expect(q("input").className).toContain("focus-visible:ring-muted-foreground");
  });

  it("Input y NativeSelect de 36 px no llevan padding vertical que recorte el texto (13 px / 19.5 px + borde 2 px)", () => {
    rendered = renderComponent(
      <>
        <Input aria-label="a" />
        <NativeSelect aria-label="c">
          <option>x</option>
        </NativeSelect>
        <NativeSelect aria-label="d" size="sm">
          <option>x</option>
        </NativeSelect>
      </>,
    );
    const alto = (e: Element) => e.className;
    expect(alto(q("input"))).toContain("h-[var(--control-md)]");
    expect(alto(q("input"))).toContain("py-0");
    const selects = rendered.container.querySelectorAll("select");
    expect(selects[0]!.className).toContain("h-[var(--control-md)]");
    expect(selects[0]!.className).toContain("py-0");
    expect(selects[0]!.className).not.toMatch(/\bpy-[1-9]/);
    expect(selects[1]!.className).toContain("h-[var(--control-sm)]");
    expect(selects[1]!.className).not.toMatch(/\bpy-[1-9]/);
  });

  it("aria-invalid pinta el borde y el foco de peligro; FormField enlaza etiqueta y error", () => {
    rendered = renderComponent(
      <FormField label="Nombre" error="Obligatorio">
        <Input />
      </FormField>,
    );
    const i = q<HTMLInputElement>("input");
    expect(i.getAttribute("aria-invalid")).toBe("true");
    expect(i.className).toContain("aria-[invalid=true]:border-destructive");
    expect(i.labels?.[0]?.textContent).toContain("Nombre");
  });

  it("el borde de campo es #8a8a93 en claro (--input) y el global de foco existe en index.css", () => {
    const css = fuente("index.css");
    expect(css).toMatch(/--input:\s*240 4% 55\.9%;/);
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*3px solid hsl\(var\(--ring\)\)/);
  });
});

describe("Checkbox y Switch", () => {
  it("el foco lo da el outline global (no se anula) y el texto de la etiqueta es text-ui", () => {
    rendered = renderComponent(
      <>
        <Checkbox label="Acepto" />
        <Switch aria-label="Activo" />
      </>,
    );
    expect(q<HTMLInputElement>("input[type=checkbox]").className).not.toContain("outline-none");
    expect(q<HTMLButtonElement>("button[role=switch]").className).not.toContain("outline-none");
    expect(q("label").className).toContain("text-ui");
    expect(q<HTMLInputElement>("input[type=checkbox]").labels?.[0]?.textContent).toContain("Acepto");
  });

  it("siguen operables: clic alterna ambos", () => {
    const onChange = vi.fn();
    rendered = renderComponent(
      <>
        <Checkbox aria-label="c" onChange={onChange} />
        <Switch aria-label="s" />
      </>,
    );
    click(q("input[type=checkbox]"));
    expect(onChange).toHaveBeenCalledTimes(1);
    click(q("button[role=switch]"));
    expect(q("button[role=switch]").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Tabs", () => {
  it("TabsList se desplaza en horizontal sin barra, no se comprime y las pestanas no se encogen", () => {
    rendered = renderComponent(
      <Tabs defaultValue="a">
        <TabsList aria-label="Secciones">
          {["a", "b", "c", "d", "e"].map((v) => (
            <TabsTrigger key={v} value={v}>
              Pestana {v}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </Tabs>,
    );
    const lista = q("[role=tablist]");
    for (const k of ["overflow-x-auto", "max-w-full", "[scrollbar-width:none]"]) expect(lista.className, k).toContain(k);
    expect(lista.getAttribute("aria-label")).toBe("Secciones");
    const tabs = rendered.container.querySelectorAll("[role=tab]");
    expect(tabs).toHaveLength(5);
    for (const t of tabs) expect(t.className).toContain("shrink-0");
  });

  it("la pestana activa va en azul de marca y la inactiva no", () => {
    rendered = renderComponent(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Uno</TabsTrigger>
          <TabsTrigger value="b">Dos</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const [a, b] = Array.from(rendered.container.querySelectorAll<HTMLElement>("[role=tab]"));
    expect(a!.getAttribute("data-state")).toBe("active");
    expect(b!.getAttribute("data-state")).toBe("inactive");
    expect(a!.className).toContain("data-[state=active]:bg-primary");
    expect(a!.className).toContain("data-[state=active]:text-primary-foreground");
    expect(a!.className).not.toContain("outline-none");
  });

  it("className del TabsList (grid de pantallas existentes) sigue ganando sobre inline-flex", () => {
    rendered = renderComponent(
      <Tabs defaultValue="a">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="a">Uno</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const c = q("[role=tablist]").className;
    expect(c).toContain("grid");
    expect(c).not.toContain("inline-flex");
    expect(c).toContain("overflow-x-auto");
  });

  it("className flex-wrap de pantallas existentes envuelve en filas (h-auto, overflow visible) en vez de recortar", () => {
    rendered = renderComponent(
      <Tabs defaultValue="a">
        <TabsList className="flex-wrap">
          <TabsTrigger value="a">Uno</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const c = q("[role=tablist]").className;
    expect(c).toContain("flex-wrap");
    expect(c).toContain("[&.flex-wrap]:h-auto");
    expect(c).toContain("[&.flex-wrap]:overflow-visible");
  });

  it("TabsContent no pinta un segundo indicador de foco (usa el outline global)", () => {
    rendered = renderComponent(
      <Tabs defaultValue="a">
        <TabsList><TabsTrigger value="a">Uno</TabsTrigger></TabsList>
        <TabsContent value="a">A</TabsContent>
      </Tabs>,
    );
    const c = q("[role=tabpanel]").className;
    expect(c).not.toContain("ring-");
    expect(c).not.toContain("outline-none");
  });
});
