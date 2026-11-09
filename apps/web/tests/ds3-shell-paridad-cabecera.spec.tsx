// @vitest-environment jsdom
//
// ds3 / paridad del encabezado: (1) el PageHeader toma como antetitulo el grupo del menu de la pantalla activa (oculto sin la bandera y
// pintado por CSS: el texto del menu no se duplica en el DOM); (2) en el Resumen el encabezado lleva el nombre de la pagina (no el de la
// consola) solo con ds3; (3) la pantalla de chat (useBarraDeConsola) marca la zona sin encabezado y el marco como pantalla de chat.
// Solo AÑADE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck, Settings, Sparkles } from "lucide-react";
import { PageHeader, VerticalShell, useBarraDeConsola, type SidebarSection } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  {
    title: "Resumen",
    siempreAbierto: true,
    items: [
      { to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true },
      { to: "/v/demo/copiloto", label: "Copiloto", icon: Sparkles },
    ],
  },
  { title: "Configuración", items: [{ to: "/v/demo/staff", label: "Staff", icon: Settings }] },
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

function Chat() {
  useBarraDeConsola();
  return <p>chat</p>;
}

const render = (ruta: string, hijo: React.ReactNode) =>
  renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[]}
        user={{ email: "a@b.mx" }}
        onLogout={() => {}}
        header={{ icon: <span />, title: "Demo · acme", resumenTo: "/v/demo" }}
      >
        {hijo}
      </VerticalShell>
    </MemoryRouter>,
  );

const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);

describe("ds3 — antetitulo derivado del grupo del menu", () => {
  it("en /staff el PageHeader trae el grupo «Configuración» oculto, con el texto real (nunca un <p> vacio)", () => {
    rendered = render("/v/demo/staff", <PageHeader titulo="Staff" />);
    const eb = q('[data-testid="encabezado-eyebrow-derivado"]')!;
    expect(eb.hidden).toBe(true);
    expect(eb.getAttribute("data-eyebrow")).toBe("Configuración");
    expect(eb.textContent).toBe("Configuración");
  });

  it("un eyebrow propio gana al derivado", () => {
    rendered = render("/v/demo/staff", <PageHeader titulo="Staff" eyebrow="Equipo" />);
    expect(q('[data-testid="encabezado-eyebrow-derivado"]')).toBeNull();
    expect(q(".ds3-encabezado-eyebrow")!.textContent).toBe("Equipo");
  });
});

describe("ds3 — nombre de la pagina en el encabezado", () => {
  it("en el Resumen la barra de siempre conserva el titulo de la consola y la ds3 trae «Resumen» (oculta sin bandera)", () => {
    rendered = render("/v/demo", <p>hola</p>);
    expect(q('[data-testid="barra-pagina-titulo"]')!.textContent).toBe("Demo · acme");
    const ds3 = q(".ds3-cabecera-titulo-ds3")!;
    expect(ds3.hidden).toBe(true);
    expect(ds3.getAttribute("data-titulo")).toBe("Resumen");
  });

  it("en una pagina del menu con su <h1> no hay titulo ds3 aparte (ya es el nombre de la pagina)", () => {
    rendered = render("/v/demo/staff", <h1>Staff</h1>);
    expect(q('[data-testid="barra-pagina-titulo"]')!.textContent).toBe("Staff");
    expect(q(".ds3-cabecera-titulo-ds3")).toBeNull();
  });

  // Cambio intencional (auditoria R2 #5): sin <h1> de la pagina, bajo ds3 el nivel 1 es el encabezado de respaldo del contenido; la barra
  // pinta el nombre con su pieza ds3, que no es encabezado, y la del diseno actual (que si lo es) queda apagada por ds3-no.
  it("en una pagina sin <h1> la barra ds3 lleva el nombre sin ser encabezado y el nivel 1 ds3 va en el contenido", () => {
    rendered = render("/v/demo/staff", <p>hola</p>);
    const legado = q('[data-testid="barra-pagina-titulo"]')!;
    expect(legado.getAttribute("role")).toBe("heading");
    expect(legado.classList.contains("ds3-no")).toBe(true);
    const ds3 = q(".ds3-cabecera-titulo-ds3")!;
    expect(ds3.getAttribute("data-titulo")).toBe("Staff");
    expect(ds3.getAttribute("role")).toBeNull();
    const enc = q('[data-testid="encabezado-shell"]')!;
    expect(enc.hidden).toBe(true);
    expect(enc.querySelector('[role="heading"][aria-level="1"]')!.textContent).toBe("Staff");
  });
});

describe("ds3 — pantalla de chat", () => {
  it("con useBarraDeConsola la zona del encabezado se marca sin encabezado y el marco como chat", () => {
    rendered = render("/v/demo/copiloto", <Chat />);
    expect(q(".ds3-cabecera-zona")!.hasAttribute("data-sin-cabecera")).toBe(true);
    expect(q(".ds3-shell-marco")!.getAttribute("data-pantalla")).toBe("chat");
  });

  it("en otra pantalla no", () => {
    rendered = render("/v/demo/staff", <p>hola</p>);
    expect(q(".ds3-cabecera-zona")!.hasAttribute("data-sin-cabecera")).toBe(false);
    expect(q(".ds3-shell-marco")!.hasAttribute("data-pantalla")).toBe(false);
  });
});
