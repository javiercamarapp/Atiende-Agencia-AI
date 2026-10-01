// @vitest-environment jsdom
//
// UNI-4: contrato de pagina. La barra superior (BarraPagina) pinta el ICONO y el NOMBRE de la
// pagina activa (derivados de la etiqueta del item del Sidebar), el Resumen conserva el titulo de
// la consola, una pagina puede sobrescribirlo (useTituloBarra) y el nombre nunca es un <h1>.
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Building2, LayoutDashboard, ListChecks } from "lucide-react";
import { BarraPagina, VerticalShell, useTituloBarra, type SidebarSection } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  {
    title: "Plataforma",
    siempreAbierto: true,
    items: [
      { to: "/c", label: "Organizaciones", icon: Building2, end: true },
      { to: "/c/acciones", label: "Acciones", icon: ListChecks },
      { to: "/c/panel", label: "Panel", icon: LayoutDashboard },
    ],
  },
];

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function Ficha({ nombre }: { nombre: string }) {
  useTituloBarra(nombre);
  return <h1>{nombre}</h1>;
}

function renderShell(ruta: string, hijo: React.ReactNode = <h1>Pagina</h1>, resumenTo: string | null = "/c"): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[{ to: "/c/acciones", label: "Acciones", icon: ListChecks }]}
        user={null}
        onLogout={() => {}}
        header={{ icon: <span data-testid="icono-raiz" />, title: "Consola de Demo", fecha: "1 oct 2026", resumenTo: resumenTo ?? undefined }}
        notificationBell={<button type="button" aria-label="campana" />}
      >
        {hijo}
      </VerticalShell>
    </MemoryRouter>,
  );
}

const titulo = (r: RenderedComponent) => r.container.querySelector('[data-testid="barra-pagina-titulo"]')!.textContent;

describe("BarraPagina", () => {
  it("44 px, icono + nombre en un <p> (no h1), campana y chip de fecha con icono a la derecha", () => {
    rendered = renderComponent(<BarraPagina icon={<span data-testid="i" />} title="Acciones" fecha="1 oct 2026" notificationBell={<button type="button" aria-label="campana" />} chatButton={<button type="button">Chat</button>} />);
    const barra = rendered.container.querySelector("header")!;
    expect(barra.className).toContain("h-11");
    expect(barra.querySelector("h1")).toBeNull();
    const p = barra.querySelector("p")!;
    expect(p.textContent).toBe("Acciones");
    expect(p.className).toContain("truncate");
    const botones = [...barra.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label"));
    expect(botones).toEqual(["Chat", "campana"]);
    const chip = [...barra.querySelectorAll("span")].find((s) => s.textContent === "1 oct 2026")!;
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.className).toContain("rounded-lg");
  });
});

describe("VerticalShell — nombre de la pagina en la barra", () => {
  it("cada ruta pinta la etiqueta y el icono de su item activo, no el titulo de la consola", () => {
    rendered = renderShell("/c/acciones");
    expect(titulo(rendered)).toBe("Acciones");
    const barra = rendered.container.querySelector('[data-testid="barra-pagina"]')!;
    expect(barra.querySelector('[data-testid="icono-raiz"]')).toBeNull();
    expect(barra.querySelector("svg.lucide-list-checks")).not.toBeNull();
    rendered.unmount();
    rendered = renderShell("/c/panel");
    expect(titulo(rendered)).toBe("Panel");
  });

  it("una subruta toma el item de prefijo mas largo", () => {
    rendered = renderShell("/c/acciones/123");
    expect(titulo(rendered)).toBe("Acciones");
  });

  it("el Resumen conserva el titulo y el icono de la consola", () => {
    rendered = renderShell("/c");
    expect(titulo(rendered)).toBe("Consola de Demo");
    expect(rendered.container.querySelector('[data-testid="barra-pagina"] [data-testid="icono-raiz"]')).not.toBeNull();
  });

  it("una ruta sin item (404) cae al titulo de la consola", () => {
    rendered = renderShell("/x/nada");
    expect(titulo(rendered)).toBe("Consola de Demo");
  });

  it("sin resumenTo no se fuerza ningun Resumen: la ruta raiz muestra su propia etiqueta", () => {
    rendered = renderShell("/c", <h1>Pagina</h1>, null);
    expect(titulo(rendered)).toBe("Organizaciones");
  });

  it("la pagina puede sobrescribir el nombre con useTituloBarra", () => {
    rendered = renderShell("/c/acciones/9", <Ficha nombre="Acción 9" />);
    expect(titulo(rendered)).toBe("Acción 9");
  });

  it("un solo h1 por pantalla: la barra no pinta h1, solo la pagina", () => {
    rendered = renderShell("/c/panel");
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Pagina");
    expect(rendered.container.querySelector('[data-testid="barra-pagina-titulo"]')!.hasAttribute("role")).toBe(false);
  });

  it("una pagina sin h1 propio no deja la pantalla sin encabezado: la barra hace de nivel 1 y cede cuando aparece el de la pagina", async () => {
    let mostrar: (v: boolean) => void = () => {};
    function Tardia() {
      const [ya, setYa] = useState(false);
      mostrar = setYa;
      return ya ? <h1>Pagina</h1> : <p>cargando</p>;
    }
    rendered = renderShell("/c/panel", <Tardia />);
    const barra = () => rendered!.container.querySelector('[data-testid="barra-pagina-titulo"]')!;
    await act(async () => {});
    expect(barra().getAttribute("role")).toBe("heading");
    expect(barra().getAttribute("aria-level")).toBe("1");
    await act(async () => {
      mostrar(true);
    });
    expect(barra().hasAttribute("role")).toBe(false);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("marco de Likida: columna gris tenue con hairline y esquinas redondeadas; sin max-w ni doble animacion", () => {
    rendered = renderShell("/c/panel");
    const main = rendered.container.querySelector("main")!;
    const marco = main.parentElement!;
    expect(marco.className).toContain("bg-sunken");
    expect(marco.className).toContain("md:rounded-2xl");
    expect(marco.className).toContain("md:border-border");
    expect(main.querySelector('[class*="max-w-"]')).toBeNull();
    expect(main.querySelectorAll(".motion-safe\\:animate-page-in")).toHaveLength(1);
  });
});
