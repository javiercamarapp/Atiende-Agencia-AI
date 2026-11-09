// @vitest-environment jsdom
//
// ds3 / componentes de contenido, parte 1 (PARIDAD-ATIENDE-ROVAQ §R1 #4, #5 y P2 del doble activo):
//  (1) ResumenLayout: bajo ds3 el nivel 1 es el nombre de la pagina («Resumen»), el saludo queda como h1 del diseno actual (ds3-no);
//      franja de estado de los datos y «Requiere tu atención (n)» solo con lo que la pagina sabe;
//  (2) antetitulo = grupo del menu, con texto real: el shell lo pinta en toda pantalla y el PageHeader en la suya;
//  (3) en /copiloto un solo item activo (el del menu), no tambien la pildora «Pregúntale a tus datos» del pie;
//  (4) ds3/contenido.css: todo bajo la bandera y sin colores literales.
// La bandera vive en CSS: aqui se prueba el marcado. Solo AÑADE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck, MessageCircle, Settings, Sparkles } from "lucide-react";
import { AvisoPagina, PageHeader, ResumenLayout, VerticalShell, type SidebarSection } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ui/src/ds3/contenido.css"), "utf8");

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

const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...rendered!.container.querySelectorAll<HTMLElement>(sel)];

const shell = (ruta: string, hijo: React.ReactNode) =>
  renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={[]}
        user={{ email: "a@b.mx" }}
        onLogout={() => {}}
        header={{ icon: <span />, title: "Demo · acme", resumenTo: "/v/demo" }}
        sidebarPie={[{ label: "Pregúntale a tus datos", to: "/v/demo/copiloto", icon: MessageCircle }]}
      >
        {hijo}
      </VerticalShell>
    </MemoryRouter>,
  );

describe("ResumenLayout bajo ds3: H1 = nombre de la pagina", () => {
  it("el saludo sigue siendo el <h1> (apagado bajo ds3 por CSS) y «Resumen» es el encabezado de nivel 1 de ds3 (oculto sin bandera)", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout saludo="Buenas noches" nombre="Owner" />
      </MemoryRouter>,
    );
    const h1 = qa("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe("Buenas noches, Owner");
    expect(h1[0]!.getAttribute("data-parte")).toBe("titulo");
    const ds3 = q('[data-testid="resumen-titulo-ds3"]')!;
    expect(ds3.hidden).toBe(true);
    expect(ds3.classList.contains("ds3-solo")).toBe(true);
    expect(ds3.getAttribute("role")).toBe("heading");
    expect(ds3.getAttribute("aria-level")).toBe("1");
    expect(ds3.textContent).toBe("Resumen");
  });

  it("el titulo ds3 es configurable", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout saludo="Hola" nombre="Ana" titulo="Panel" />
      </MemoryRouter>,
    );
    expect(q('[data-testid="resumen-titulo-ds3"]')!.textContent).toBe("Panel");
  });
});

describe("ResumenLayout bajo ds3: estado de los datos y «Requiere tu atención»", () => {
  it("la franja pinta pares etiqueta/valor en un <dl> oculto sin bandera; vacia no se pinta", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout
          saludo="Hola"
          nombre="Ana"
          estadoDatos={[
            { etiqueta: "Periodo", valor: "7 días" },
            { etiqueta: "Último WhatsApp", valor: "hace 5 min" },
          ]}
        />
      </MemoryRouter>,
    );
    const dl = q('[data-testid="resumen-estado-datos"]')!;
    expect(dl.tagName).toBe("DL");
    expect(dl.hidden).toBe(true);
    expect([...dl.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Periodo:", "Último WhatsApp:"]);
    expect([...dl.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["7 días", "hace 5 min"]);
    rendered.unmount();
    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout saludo="Hola" nombre="Ana" estadoDatos={[]} />
      </MemoryRouter>,
    );
    expect(q('[data-testid="resumen-estado-datos"]')).toBeNull();
  });

  it("atencion: undefined = no se pinta; [] = «nada pendiente» con (0); items con enlace, detalle, cifra y tono", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout saludo="Hola" nombre="Ana" />
      </MemoryRouter>,
    );
    expect(q('[data-testid="resumen-atencion"]')).toBeNull();
    rendered.unmount();

    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout saludo="Hola" nombre="Ana" atencion={[]} />
      </MemoryRouter>,
    );
    const vacia = q('[data-testid="resumen-atencion"]')!;
    expect(vacia.hidden).toBe(true);
    expect(vacia.querySelector("h2")!.textContent).toBe("Requiere tu atención (0)");
    expect(vacia.textContent).toContain("Nada requiere tu atención ahora.");
    rendered.unmount();

    rendered = renderComponent(
      <MemoryRouter>
        <ResumenLayout
          saludo="Hola"
          nombre="Ana"
          atencion={[
            { id: "a", titulo: "3 conversaciones esperan a una persona", detalle: "Toma humana", to: "/v/demo/conversaciones", tono: "alto" },
            { id: "b", titulo: "Pedido sin confirmar", valor: "$420.00" },
          ]}
        />
      </MemoryRouter>,
    );
    const at = q('[data-testid="resumen-atencion"]')!;
    expect(at.getAttribute("aria-labelledby")).toBe(at.querySelector("h2")!.id);
    expect(at.querySelector("h2")!.textContent).toBe("Requiere tu atención (2)");
    const filas = [...at.querySelectorAll("li")];
    expect(filas.map((f) => f.getAttribute("data-tono"))).toEqual(["alto", "medio"]);
    expect(filas[0]!.querySelector("a")!.getAttribute("href")).toBe("/v/demo/conversaciones");
    expect(filas[0]!.querySelector('[data-parte="atencion-detalle"]')!.textContent).toBe("Toma humana");
    expect(filas[1]!.querySelector("a")).toBeNull();
    expect(filas[1]!.querySelector('[data-parte="atencion-valor"]')!.textContent).toBe("$420.00");
  });
});

describe("antetitulo = grupo del menu, con texto real", () => {
  it("el shell lo pinta (oculto sin bandera) en una pantalla sin PageHeader", () => {
    rendered = shell("/v/demo/staff", <h1>Staff</h1>);
    const eb = q('[data-testid="eyebrow-pagina"]')!;
    expect(eb.hidden).toBe(true);
    expect(eb.classList.contains("ds3-solo")).toBe(true);
    expect(eb.textContent).toBe("Configuración");
  });

  it("ruta fuera del menu: sin grupo no hay antetitulo (ni <p> vacio)", () => {
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/otra"]}>
        <VerticalShell vertical="demo" sections={SECCIONES} mobileItems={[]} user={{ email: "a@b.mx" }} onLogout={() => {}} header={{ icon: <span />, title: "Demo" }}>
          <h1>404</h1>
        </VerticalShell>
      </MemoryRouter>,
    );
    expect(q('[data-testid="eyebrow-pagina"]')).toBeNull();
    expect(qa("main p").filter((p) => p.textContent === "")).toEqual([]);
  });

  // R2 #6: los items de la seccion raiz (CFO, Agenda, Panel...) no tienen categoria; antes heredaban el titulo oculto «Resumen».
  it("un item de la seccion raiz que no es el Resumen no hereda «Resumen» como antetitulo", () => {
    rendered = shell("/v/demo/copiloto/hilo", <PageHeader titulo="Copiloto" />);
    expect(q('[data-testid="eyebrow-pagina"]')).toBeNull();
    expect(q('[data-testid="encabezado-eyebrow-derivado"]')).toBeNull();
    expect(rendered.container.textContent).not.toMatch(/^Resumen$/m);
  });

  it("el antetitulo es la categoria del item activo", () => {
    rendered = shell("/v/demo/staff", <PageHeader titulo="Staff" />);
    expect(q('[data-testid="encabezado-eyebrow-derivado"]')!.textContent).toBe("Configuración");
  });

  it("ningun antetitulo del encabezado queda vacio", () => {
    rendered = shell("/v/demo/staff", <PageHeader titulo="Staff" />);
    for (const p of qa(".ds3-encabezado-eyebrow, .ds3-eyebrow-pagina")) expect(p.textContent!.trim()).not.toBe("");
  });
});

// Auditoria R2 #5: antetitulo + H1 (+ descripcion) juntos y los avisos globales DEBAJO, no entre el antetitulo y el contenido.
describe("encabezado de la pantalla y avisos debajo", () => {
  const aviso = <AvisoPagina><div data-testid="aviso">2 agregados por validar</div></AvisoPagina>;
  const orden = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

  it("sin PageHeader: el shell pinta antetitulo + nombre (nivel 1) y el aviso va despues, antes de la pagina", () => {
    rendered = shell("/v/demo/staff", <>{aviso}<ul data-testid="lista" /></>);
    const enc = q('[data-testid="encabezado-shell"]')!;
    expect(enc.querySelector('[data-testid="eyebrow-pagina"]')!.textContent).toBe("Configuración");
    expect(enc.querySelector('[role="heading"][aria-level="1"]')!.textContent).toBe("Staff");
    const av = q('[data-testid="aviso"]')!;
    expect(av.parentElement!.getAttribute("data-testid")).toBe("ranura-avisos-shell");
    expect(orden(enc, av)).toBeTruthy();
    expect(orden(av, q('[data-testid="lista"]')!)).toBeTruthy();
  });

  it("con un <h1> sr-only de la pagina: el nombre se ve en el encabezado del shell pero no duplica el nivel 1", () => {
    rendered = shell("/v/demo/staff", <h1 className="sr-only">Staff</h1>);
    const t = q('[data-testid="encabezado-shell-titulo"]')!;
    expect(t.textContent).toBe("Staff");
    expect(t.getAttribute("role")).toBeNull();
    expect(t.getAttribute("aria-hidden")).toBe("true");
  });

  it("con PageHeader: el aviso va en la ranura que sigue al encabezado, no arriba", () => {
    rendered = shell("/v/demo/staff", <>{aviso}<PageHeader titulo="Staff" descripcion="Tu equipo" /><ul data-testid="lista" /></>);
    const av = q('[data-testid="aviso"]')!;
    expect(av.parentElement!.getAttribute("data-testid")).toBe("ranura-avisos-pagina");
    expect(q('[data-testid="ranura-avisos-shell"]')!.childElementCount).toBe(0);
    expect(orden(q("header.ds3-encabezado")!, av)).toBeTruthy();
    expect(orden(av, q('[data-testid="lista"]')!)).toBeTruthy();
  });

  it("en el Resumen el aviso va debajo de su encabezado", () => {
    rendered = shell("/v/demo", <>{aviso}<ResumenLayout saludo="Hola" nombre="Ana" /></>);
    const av = q('[data-testid="aviso"]')!;
    expect(av.parentElement!.getAttribute("data-testid")).toBe("ranura-avisos-pagina");
    expect(orden(q('[data-parte="titulo"]')!, av)).toBeTruthy();
  });

  it("fuera de un shell el aviso se pinta en su lugar", () => {
    rendered = renderComponent(<MemoryRouter>{aviso}</MemoryRouter>);
    expect(q('[data-testid="aviso"]')).not.toBeNull();
  });
});

describe("un solo item activo", () => {
  it("en /copiloto el activo es «Copiloto» del menu; la pildora del pie con el mismo destino no se marca", () => {
    rendered = shell("/v/demo/copiloto", <p>chat</p>);
    const activos = qa('aside [aria-current="page"]');
    expect(activos).toHaveLength(1);
    expect(activos[0]!.getAttribute("aria-label")).toBe("Copiloto");
  });

  it("una pildora del pie cuya ruta no es del menu sigue marcandose", () => {
    const secciones: SidebarSection[] = [{ title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }] }];
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/v/demo/copiloto"]}>
        <VerticalShell
          vertical="demo"
          sections={secciones}
          mobileItems={[]}
          user={{ email: "a@b.mx" }}
          onLogout={() => {}}
          header={{ icon: <span />, title: "Demo" }}
          sidebarPie={[{ label: "Pregúntale a tus datos", to: "/v/demo/copiloto", icon: MessageCircle }]}
        >
          <p>chat</p>
        </VerticalShell>
      </MemoryRouter>,
    );
    const activos = qa('aside [aria-current="page"]');
    expect(activos).toHaveLength(1);
    expect(activos[0]!.getAttribute("title")).toBe("Pregúntale a tus datos");
  });
});

/** Parte una lista de selectores por las comas de nivel superior (no las de dentro de :is()/:not()/:has(), aunque se aniden). */
function partesDeNivelSuperior(lista: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let actual = "";
  for (const c of lista) {
    if (c === "(") nivel++;
    if (c === ")") nivel--;
    if (c === "," && nivel === 0) {
      partes.push(actual.trim());
      actual = "";
    } else actual += c;
  }
  partes.push(actual.trim());
  return partes;
}

describe("ds3/contenido.css", () => {
  const selectores = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim());

  it("toda regla esta bajo html[data-diseno=\"ds3\"] y no hay colores literales", () => {
    expect(selectores.length).toBeGreaterThan(10);
    for (const s of selectores) for (const parte of partesDeNivelSuperior(s)) expect(parte.startsWith('html[data-diseno="ds3"]'), parte).toBe(true);
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("H1 del Resumen 20/600/-0.5 y antetitulo 12/600 MAYUSCULAS 0.72 px; el del shell se apaga con PageHeader/Resumen y en el chat", () => {
    expect(CSS).toMatch(/\.ds3-resumen h1\[data-parte="titulo"\] \{ display: none; \}/);
    expect(CSS).toMatch(/\[data-parte="titulo-ds3"\] \{[^}]*font-size: 20px;[^}]*font-weight: 600;[^}]*letter-spacing: -0\.5px;/);
    expect(CSS).toMatch(/\.ds3-eyebrow-pagina\.ds3-solo \{[^}]*font-size: 12px;[^}]*font-weight: 600;[^}]*letter-spacing: 0\.72px;[^}]*text-transform: uppercase;/);
    // Cambio intencional (auditoria R2 #5): el antetitulo vive en el encabezado de respaldo del shell (antetitulo + nombre 20/600/-0.5),
    // que se apaga entero con PageHeader/Resumen y en el chat, y apaga solo el nombre si la pagina trae su <h1>.
    expect(CSS).toMatch(/\.ds3-encabezado-shell-titulo\.ds3-encabezado-shell-titulo \{[^}]*font-size: 20px;[^}]*font-weight: 600;[^}]*letter-spacing: -0\.5px;/);
    expect(CSS).toMatch(/\.ds3-encabezado-shell\.ds3-solo:has\(~ \.ds3-shell-pagina :is\(\.ds3-encabezado, \.ds3-resumen\)\),\s*html\[data-diseno="ds3"\] \.ds3-shell-marco\[data-pantalla="chat"\] \.ds3-encabezado-shell\.ds3-solo \{\s*display: none;/);
    expect(CSS).toMatch(/\.ds3-encabezado-shell\.ds3-solo:has\(~ \.ds3-shell-pagina :is\(h1, \[role="heading"\]\[aria-level="1"\]\):not\(\.sr-only\)\) \.ds3-encabezado-shell-titulo \{\s*display: none;/);
  });
});
