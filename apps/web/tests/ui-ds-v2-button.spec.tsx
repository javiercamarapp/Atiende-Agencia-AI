// @vitest-environment jsdom
//
// PR-2 de diseno-ux (Atiende DS v2): Button con tamanos por token, `loading`,
// iconos y variantes limpias. Afirma comportamiento (clics, aria, bloqueo
// durante la carga), no snapshots.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Plus } from "lucide-react";
import { Button, buttonVariants } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function boton(): HTMLButtonElement {
  const el = rendered!.container.querySelector("button");
  if (!el) throw new Error("sin <button>");
  return el;
}

describe("Button", () => {
  it("dispara onClick y es un <button> nativo alcanzable con Tab", () => {
    const onClick = vi.fn();
    rendered = renderComponent(<Button onClick={onClick}>Guardar</Button>);
    expect(boton().tagName).toBe("BUTTON");
    expect(boton().tabIndex).toBe(0);
    click(boton());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("el alto sale de los tokens de control (no de h-11 / h-12 fijos)", () => {
    expect(buttonVariants({ size: "default" })).toContain("h-[var(--control-md)]");
    expect(buttonVariants({ size: "md" })).toContain("h-[var(--control-md)]");
    expect(buttonVariants({ size: "sm" })).toContain("h-[var(--control-sm)]");
    expect(buttonVariants({ size: "lg" })).toContain("h-[var(--control-lg)]");
    expect(buttonVariants({ size: "icon" })).toContain("w-[var(--control-md)]");
    expect(buttonVariants({ size: "icon-sm" })).toContain("w-[var(--control-sm)]");
    // sm ya no es igual al tamano por defecto (antes ambos eran h-11)
    expect(buttonVariants({ size: "sm" })).not.toBe(buttonVariants({ size: "default" }));
  });

  it("un h-* pasado por className gana sobre el del tamano (las 32 sobreescrituras actuales siguen funcionando)", () => {
    rendered = renderComponent(<Button className="h-9">Compacto</Button>);
    expect(boton().className).toContain("h-9");
    expect(boton().className).not.toContain("h-[var(--control-md)]");
  });

  it("el foco lo pinta el outline global de index.css (no se anula) y las transiciones son enumeradas, sin transition-all", () => {
    rendered = renderComponent(<Button>Ok</Button>);
    expect(boton().className).not.toContain("outline-none");
    expect(boton().className).not.toContain("focus-visible:ring");
    expect(boton().className).not.toContain("transition-all");
    expect(boton().className).toContain("duration-fast");
  });

  it("las variantes sin uso (hero, terracotta, gold) y el tamano xl ya no generan clases", () => {
    const html = [
      buttonVariants({ variant: "hero" as never }),
      buttonVariants({ variant: "terracotta" as never }),
      buttonVariants({ variant: "gold" as never }),
      buttonVariants({ size: "xl" as never }),
    ].join(" ");
    expect(html).not.toMatch(/terracotta|gold|gradient|glow|h-14/);
  });

  it("secondary y ghost usan los tokens semanticos (neutro / acento suave)", () => {
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-accent");
  });

  it("loading: spinner, aria-busy, bloqueado y un doble clic no duplica el envio", () => {
    const onClick = vi.fn();
    rendered = renderComponent(
      <Button loading onClick={onClick}>
        Guardando
      </Button>,
    );
    const b = boton();
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.querySelector("svg.animate-spin")).not.toBeNull();
    expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(b.textContent).toBe("Guardando");
    click(b);
    click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("sin loading no hay aria-busy ni spinner, y al terminar la carga vuelve a responder", () => {
    const onClick = vi.fn();
    rendered = renderComponent(
      <Button loading onClick={onClick}>
        Enviar
      </Button>,
    );
    rendered.rerender(<Button onClick={onClick}>Enviar</Button>);
    expect(boton().hasAttribute("aria-busy")).toBe(false);
    expect(boton().querySelector("svg")).toBeNull();
    click(boton());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("loading reemplaza a iconLeft pero conserva iconRight; sin loading ambos se dibujan", () => {
    rendered = renderComponent(
      <Button iconLeft={<Plus data-testid="izq" />} iconRight={<Plus data-testid="der" />}>
        Nuevo
      </Button>,
    );
    expect(rendered.container.querySelector('[data-testid="izq"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="der"]')).not.toBeNull();
    rendered.rerender(
      <Button loading iconLeft={<Plus data-testid="izq" />} iconRight={<Plus data-testid="der" />}>
        Nuevo
      </Button>,
    );
    expect(rendered.container.querySelector('[data-testid="izq"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="der"]')).not.toBeNull();
  });

  it("disabled explicito bloquea el clic", () => {
    const onClick = vi.fn();
    rendered = renderComponent(
      <Button disabled onClick={onClick}>
        No
      </Button>,
    );
    click(boton());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("asChild aplica el estilo al hijo (enlace) sin envolverlo en <button>", () => {
    rendered = renderComponent(
      <Button asChild>
        <a href="/x">Ir</a>
      </Button>,
    );
    expect(rendered.container.querySelector("button")).toBeNull();
    const a = rendered.container.querySelector("a")!;
    expect(a.className).toContain("rounded-md");
    expect(a.className).not.toContain("rounded-full");
    expect(a.getAttribute("href")).toBe("/x");
  });

  it("asChild deshabilitado: aria-disabled, fuera del orden de tab y sin eventos de puntero por clase", () => {
    rendered = renderComponent(
      <Button asChild disabled>
        <a href="/x">Ir</a>
      </Button>,
    );
    const a = rendered.container.querySelector("a")!;
    expect(a.getAttribute("aria-disabled")).toBe("true");
    expect(a.getAttribute("tabindex")).toBe("-1");
    expect(a.className).toContain("aria-disabled:pointer-events-none");
  });
});
