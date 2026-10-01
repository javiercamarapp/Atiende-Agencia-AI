// @vitest-environment jsdom
// Campana identica a la de Likida: enlace a la pagina, punto rojo SIN numero cuando hay sin leer.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { NotificationBell } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function pintar(hayNoLeidas: boolean, className?: string) {
  rendered = renderComponent(
    <MemoryRouter>
      <NotificationBell href="/restaurantes/mi-org/notificaciones" hayNoLeidas={hayNoLeidas} className={className} />
    </MemoryRouter>,
  );
  return rendered.container.querySelector("a")!;
}

describe("NotificationBell", () => {
  it("lleva a la pagina de notificaciones (no abre un dropdown)", () => {
    const a = pintar(false);
    expect(a.getAttribute("href")).toBe("/restaurantes/mi-org/notificaciones");
    expect(rendered!.container.querySelector("button")).toBeNull();
    expect(a.getAttribute("aria-label")).toBe("Notificaciones");
  });

  it("sin pendientes no pinta punto; con pendientes pinta el punto rojo sin ningun numero", () => {
    let a = pintar(false);
    expect(a.querySelector('[data-testid="campana-punto"]')).toBeNull();
    expect(a.getAttribute("data-no-leidas")).toBe("false");
    rendered!.unmount();

    a = pintar(true);
    const punto = a.querySelector('[data-testid="campana-punto"]')!;
    expect(punto).not.toBeNull();
    expect(punto.textContent).toBe("");
    expect(a.textContent).toBe("");
    expect(a.getAttribute("aria-label")).toBe("Notificaciones: hay avisos sin leer");
    expect(a.getAttribute("data-no-leidas")).toBe("true");
  });

  it("mide lo que el boton de barra de Likida: h-8 w-8 rounded-lg hairline, Bell de 14 px y punto de 6 px en destructive, sin pulso", () => {
    const a = pintar(true);
    for (const c of ["h-8", "w-8", "rounded-lg", "border", "border-border", "bg-card"]) expect(a.className.split(/\s+/), c).toContain(c);
    const punto = a.querySelector('[data-testid="campana-punto"]')!;
    for (const c of ["size-1.5", "rounded-full", "bg-destructive", "top-1", "right-1"]) expect(punto.className.split(/\s+/), c).toContain(c);
    expect(punto.className).not.toContain("animate-pulse");
    expect(a.querySelector("svg")!.getAttribute("class")).toContain("size-3.5");
  });

  it("acepta el tamano de movil (w-10 h-10) sin dejar el h-8 w-8 base", () => {
    const a = pintar(false, "w-10 h-10");
    expect(a.className.split(/\s+/)).toEqual(expect.arrayContaining(["w-10", "h-10"]));
    expect(a.className.split(/\s+/)).not.toContain("w-8");
    expect(a.className.split(/\s+/)).not.toContain("h-8");
  });
});
