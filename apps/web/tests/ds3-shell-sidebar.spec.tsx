// @vitest-environment jsdom
//
// ds3 / lote 5.2 (sidebar): el Sidebar marca sus zonas para la hoja ds3 y suma, OCULTAS sin la bandera, las piezas nuevas del pie
// (contador de notificaciones, selector de idioma, simbolo del riel, organizacion en la tarjeta). Las rutas y permisos salen de las
// mismas `sections`: nada se pierde. Solo AÑADE: no toca ningun spec existente.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Bell, CalendarCheck, Settings, ShieldCheck } from "lucide-react";
import { CLAVE_IDIOMA, IDIOMA_CAMBIO_EVENTO, Sidebar, VerticalShell, leerIdioma, type SidebarSection } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck, end: true }] },
  { title: "Operación", items: [{ to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck }] },
  { title: "Configuración", items: [{ to: "/v/demo/configuracion", label: "Configuración", icon: Settings }] },
];

let rendered: RenderedComponent | undefined;
let storage: Storage;

beforeEach(() => {
  installMatchMediaStub();
  storage = installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}, ruta = "/v/demo/agenda"): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Sidebar
        sections={SECCIONES}
        user={{ email: "ana@negocio.mx", nombre: "Ana Pérez", rolEtiqueta: "Propietaria" }}
        onLogout={() => {}}
        storageScope="demo"
        pie={[{ label: "Notificaciones", to: "/v/demo/notificaciones", icon: Bell, indicador: true, contador: 7 }]}
        hotelSelector={<p>Sucursal Centro</p>}
        {...props}
      />
    </MemoryRouter>,
  );
}

const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);

describe("ds3 — sidebar: zonas marcadas para la hoja del shell", () => {
  it("marca, navegacion, organizacion, pie, ajustes y tarjeta de cuenta llevan su clase ds3", () => {
    rendered = renderSidebar();
    for (const sel of [".ds3-sidebar-marca", ".ds3-sidebar-nav", ".ds3-sidebar-organizacion", ".ds3-sidebar-pie", ".ds3-sidebar-ajustes", ".ds3-sidebar-cuenta-zona", ".ds3-cuenta", ".ds3-monograma", ".ds3-cuenta-salir", ".ds3-tema"]) {
      expect(q(sel), sel).not.toBeNull();
    }
    expect(q(".ds3-sidebar-organizacion")!.textContent).toBe("Sucursal Centro");
    expect(rendered.container.querySelectorAll(".ds3-nav-grupo-toggle")).toHaveLength(2);
  });

  it("el item activo conserva aria-current y lleva la clase de item ds3 (el tinte y el filete los pone la hoja)", () => {
    rendered = renderSidebar();
    const activo = q('a[aria-current="page"]')!;
    expect(activo.textContent).toBe("Agenda");
    expect(activo.classList.contains("ds3-nav-item")).toBe(true);
    expect(activo.querySelector(".ds3-nav-icono")).not.toBeNull();
  });

  it("el estado contraido se expone como data-colapsado (la hoja fija 72 px) y se persiste por vertical", () => {
    rendered = renderSidebar();
    const aside = q("aside")!;
    expect(aside.hasAttribute("data-colapsado")).toBe(false);
    click(q('button[aria-label="Colapsar barra lateral"]')!);
    expect(q("aside")!.hasAttribute("data-colapsado")).toBe(true);
    expect(storage.getItem("atiende:demo:sidebar:colapsado")).toBe("1");
    // Contraido: el simbolo de la marca existe pero oculto sin la bandera.
    const simbolo = q(".ds3-sidebar-simbolo")!;
    expect(simbolo.hidden).toBe(true);
  });
});

describe("ds3 — sidebar: piezas nuevas ocultas sin la bandera", () => {
  it("el contador numerico de notificaciones existe oculto y el punto del diseno actual sigue visible", () => {
    rendered = renderSidebar();
    const contador = q('[data-testid="pildora-contador"]')!;
    expect(contador.hidden).toBe(true);
    expect(contador.classList.contains("ds3-solo")).toBe(true);
    expect(contador.getAttribute("data-contador")).toBe("7");
    // El numero lo pinta la hoja (::before): la fila no gana texto (los e2e de notificaciones leen su textContent).
    expect(contador.textContent).toBe("");
    const punto = q('[data-testid="pildora-indicador"]')!;
    expect(punto.classList.contains("ds3-no")).toBe(true);
    expect(punto.hidden).toBe(false);
    expect(q('a[href="/v/demo/notificaciones"]')!.getAttribute("aria-label")).toBe("Notificaciones, con avisos sin leer");
  });

  it("mas de 99 pendientes se muestran como 99+; sin conteo no hay contador", () => {
    rendered = renderSidebar({ pie: [{ label: "Notificaciones", to: "/n", icon: Bell, indicador: true, contador: 250 }] });
    expect(q('[data-testid="pildora-contador"]')!.getAttribute("data-contador")).toBe("99+");
    rendered.unmount();
    rendered = renderSidebar({ pie: [{ label: "Notificaciones", to: "/n", icon: Bell, indicador: false, contador: 0 }] });
    expect(q('[data-testid="pildora-contador"]')).toBeNull();
  });

  it("el selector de idioma ES/EN vive oculto junto al de tema", () => {
    rendered = renderSidebar();
    const envoltura = q(".ds3-sidebar-ajustes .ds3-sidebar-idioma")!;
    expect(envoltura.hidden).toBe(true);
    const grupo = envoltura.querySelector('[role="group"][aria-label="Idioma de la interfaz"]')!;
    expect([...grupo.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent)).toEqual(["es", "en"]);
  });

  it("con organizacion: la tarjeta suma el nombre (oculto sin la bandera) y el del usuario sigue visible", () => {
    rendered = renderSidebar({ organizacion: "Los Taquitos" });
    const org = q(".ds3-cuenta-organizacion")!;
    expect(org.hidden).toBe(true);
    expect(org.textContent).toBe("Los Taquitos");
    const nombre = [...rendered.container.querySelectorAll("p")].find((p) => p.textContent === "Ana Pérez")!;
    expect(nombre.hidden).toBe(false);
    expect(nombre.classList.contains("ds3-no")).toBe(true);
  });
});

describe("ds3 — selector de idioma", () => {
  it("guarda la preferencia, anuncia el cambio y marca aria-pressed", () => {
    rendered = renderSidebar();
    const anunciados: string[] = [];
    const oyente = (e: Event) => anunciados.push((e as CustomEvent<string>).detail);
    window.addEventListener(IDIOMA_CAMBIO_EVENTO, oyente);
    const en = q('button[aria-pressed][aria-label="English (EN)"]')!;
    click(en);
    window.removeEventListener(IDIOMA_CAMBIO_EVENTO, oyente);
    expect(storage.getItem(CLAVE_IDIOMA)).toBe("en");
    expect(anunciados).toEqual(["en"]);
    expect(en.getAttribute("aria-pressed")).toBe("true");
    expect(q('button[aria-pressed][aria-label="Español (ES)"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(leerIdioma()).toBe("en");
  });
});

describe("ds3 — enlace de administracion", () => {
  it("solo con adminHref aparece como ultima fila del pie (y en la hoja «Más»)", () => {
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/v/demo/agenda"]}>
        <VerticalShell
          vertical="demo"
          sections={SECCIONES}
          mobileItems={[{ to: "/v/demo", label: "Resumen", icon: CalendarCheck }]}
          user={{ email: "ana@negocio.mx" }}
          onLogout={() => {}}
          header={{ icon: <span />, title: "Demo" }}
          sidebarPie={[{ label: "Seguridad de la cuenta", to: "/v/demo/seguridad", icon: ShieldCheck }]}
          adminHref="/superadmin"
        >
          <p>contenido</p>
        </VerticalShell>
      </MemoryRouter>,
    );
    const filas = [...rendered.container.querySelectorAll("aside .ds3-sidebar-pie a")];
    expect(filas.map((a) => a.getAttribute("href"))).toEqual(["/v/demo/seguridad", "/superadmin"]);
    expect(filas[1]!.getAttribute("aria-label")).toBe("Administración de Atiende");
  });

  it("sin adminHref no hay enlace de administracion", () => {
    rendered = renderSidebar();
    expect(rendered.container.textContent).not.toContain("Administración de Atiende");
  });
});
