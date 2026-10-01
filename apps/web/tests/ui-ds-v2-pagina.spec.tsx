// @vitest-environment jsdom
//
// PR-3 de diseno-ux (4.5/4.7): PageHeader (un unico h1, migas, atras, acciones)
// y PageContainer (ancho por size, padding, entrada page-in solo con movimiento).
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PageContainer, PageHeader } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("PageHeader", () => {
  it("renderiza un unico h1 con descripcion, meta y acciones", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="Reservas" descripcion="Todas las reservas del mes" meta={<span>12 activas</span>} acciones={<button type="button">Nueva reserva</button>} />
      </MemoryRouter>,
    );
    const c = rendered.container;
    expect(c.querySelectorAll("h1")).toHaveLength(1);
    expect(c.querySelector("h1")!.textContent).toBe("Reservas");
    expect(c.textContent).toContain("Todas las reservas del mes");
    expect(c.textContent).toContain("12 activas");
    expect(c.querySelector("header button")!.textContent).toBe("Nueva reserva");
  });

  it("migas: nav con nombre, enlaces reales salvo la ultima que lleva aria-current=page", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="Folio 42" migas={[{ etiqueta: "Hotel", to: "/h" }, { etiqueta: "Reservas", to: "/h/reservas" }, { etiqueta: "Folio 42" }]} />
      </MemoryRouter>,
    );
    const nav = rendered.container.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Migas de pan");
    const enlaces = [...nav.querySelectorAll("a")];
    expect(enlaces.map((a) => a.getAttribute("href"))).toEqual(["/h", "/h/reservas"]);
    const actual = nav.querySelector('[aria-current="page"]')!;
    expect(actual.textContent).toBe("Folio 42");
    expect(actual.tagName).toBe("SPAN");
  });

  it("una miga con `to` que es la ultima no se vuelve enlace", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="X" migas={[{ etiqueta: "Inicio", to: "/" }, { etiqueta: "Actual", to: "/actual" }]} />
      </MemoryRouter>,
    );
    expect(rendered.container.querySelectorAll("nav a")).toHaveLength(1);
  });

  it("atras: enlace con etiqueta por defecto Volver", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="Detalle" atras={{ to: "/lista" }} />
      </MemoryRouter>,
    );
    const a = rendered.container.querySelector<HTMLAnchorElement>("header > a")!;
    expect(a.getAttribute("href")).toBe("/lista");
    expect(a.textContent).toBe("Volver");
  });

  it("sin migas, atras ni acciones no pinta nav ni contenedores vacios", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <PageHeader titulo="Solo titulo" />
      </MemoryRouter>,
    );
    expect(rendered.container.querySelector("nav")).toBeNull();
    expect(rendered.container.querySelector("header a")).toBeNull();
    expect(rendered.container.querySelectorAll("header p")).toHaveLength(0);
  });
});

describe("PageContainer", () => {
  it("ancho por size (lg por defecto), padding y entrada page-in solo con movimiento permitido", () => {
    rendered = renderComponent(<PageContainer>contenido</PageContainer>);
    const el = rendered.container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("max-w-6xl");
    expect(el.className).toContain("p-4");
    expect(el.className).toContain("motion-safe:animate-page-in");
    expect(el.className).not.toContain("stagger");
  });

  it("size sm/md/xl, padding none, as=section y className propio", () => {
    rendered = renderComponent(
      <PageContainer size="sm" padding="none" as="section" className="extra" aria-label="Pagina">
        x
      </PageContainer>,
    );
    const el = rendered.container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toContain("max-w-2xl");
    expect(el.className).not.toContain("p-4");
    expect(el.className).toContain("extra");
    expect(el.getAttribute("aria-label")).toBe("Pagina");
    rendered.rerender(<PageContainer size="md">x</PageContainer>);
    expect((rendered.container.firstElementChild as HTMLElement).className).toContain("max-w-4xl");
    rendered.rerender(<PageContainer size="xl">x</PageContainer>);
    expect((rendered.container.firstElementChild as HTMLElement).className).toContain("max-w-[88rem]");
  });
});
