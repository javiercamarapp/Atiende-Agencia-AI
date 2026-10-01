// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux (4.5/4.6): <VerticalShell> unico de @atiende/ui.
// Se prueban landmarks, skip link, aria-current, migas (solo visibles bajo
// data-theme=v2), BottomNav con "Más", menu de cuenta movil, slots,
// transiciones de navegacion, limite de error de ruta y 404.
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter } from "react-router-dom";
import { CalendarCheck, Settings, ShieldCheck, UserRound } from "lucide-react";
import {
  VerticalNoEncontrado,
  VerticalShell,
  VerticalShellEstado,
  RutaBoundary,
  construirMigas,
  VERTICAL_SHELL_MAIN_ID,
  type SidebarSection,
} from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Agenda", siempreAbierto: true, items: [{ to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck }] },
  { title: "Negocio", items: [{ to: "/v/demo/proveedores", label: "Proveedores", icon: UserRound }] },
  { title: "Administrar", items: [{ to: "/v/demo/configuracion", label: "Configuración", icon: Settings }, { to: "/v/demo/staff", label: "Staff", icon: ShieldCheck }] },
];
const MOBILE = [
  { to: "/v/demo/agenda", label: "Agenda", icon: CalendarCheck },
  { to: "/v/demo/proveedores", label: "Proveedores", icon: UserRound },
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
  document.documentElement.removeAttribute("data-theme");
});

interface Opciones {
  ruta?: string;
  onLogout?: () => void;
  contentKey?: string;
  children?: React.ReactNode;
  organizationSelector?: React.ReactNode;
}

function renderShell(o: Opciones = {}): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[o.ruta ?? "/v/demo/agenda"]}>
      <VerticalShell
        vertical="demo"
        sections={SECCIONES}
        mobileItems={MOBILE}
        user={{ email: "staff@example.com", rol: "owner" }}
        onLogout={o.onLogout ?? (() => {})}
        header={{ icon: <span />, title: "Demo · acme", fecha: "30 sept 2026" }}
        notificationBell={<button type="button" aria-label="Notificaciones (campana)" />}
        chatButton={<button type="button">Chatea con tus datos</button>}
        branchSelector={<p>Sucursal Centro</p>}
        organizationSelector={o.organizationSelector}
        contentKey={o.contentKey}
      >
        {o.children ?? <p>contenido</p>}
      </VerticalShell>
      <Link to="/v/demo/proveedores">ir-proveedores</Link>
    </MemoryRouter>,
  );
}

describe("VerticalShell — accesibilidad y landmarks", () => {
  it("expone un skip link que apunta al <main> enfocable, más aside, nav móvil y migas con nombre", () => {
    rendered = renderShell();
    const root = rendered.container;
    const skip = root.querySelector<HTMLAnchorElement>("a.sr-only")!;
    expect(skip.textContent).toBe("Saltar al contenido");
    expect(skip.getAttribute("href")).toBe(`#${VERTICAL_SHELL_MAIN_ID}`);
    const main = root.querySelector("main")!;
    expect(main.id).toBe(VERTICAL_SHELL_MAIN_ID);
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(root.querySelectorAll("main")).toHaveLength(1);
    expect(root.querySelector('aside[aria-label="Navegación principal"]')).not.toBeNull();
    expect(root.querySelector('nav[aria-label="Navegación móvil"]')).not.toBeNull();
    expect(root.querySelector('nav[aria-label="Migas de pan"]')).not.toBeNull();
  });

  it("marca con aria-current=page el destino activo del Sidebar y de la barra móvil", () => {
    rendered = renderShell({ ruta: "/v/demo/proveedores" });
    const activos = [...rendered.container.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent);
    expect(activos).toEqual(expect.arrayContaining(["Proveedores"]));
    expect(activos.filter((t) => t === "Proveedores")).toHaveLength(2); // sidebar + bottom nav
    expect(activos).not.toContain("Agenda");
  });

  it("el Sidebar del shell guarda sus preferencias bajo el namespace de la vertical", () => {
    rendered = renderShell();
    const boton = [...rendered.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.includes("Administrar"))!;
    click(boton);
    expect(storage.getItem("atiende:demo:sidebar:grupo")).toBe("Administrar");
  });
});

describe("VerticalShell — migas", () => {
  it("construye raíz > grupo > destino con el prefijo más largo y omite el grupo repetido", () => {
    expect(construirMigas(SECCIONES, "/v/demo/proveedores/abc", { etiqueta: "Demo" })).toEqual([{ etiqueta: "Demo" }, { etiqueta: "Negocio" }, { etiqueta: "Proveedores" }]);
    expect(construirMigas(SECCIONES, "/v/demo/agenda", { etiqueta: "Demo" })).toEqual([{ etiqueta: "Demo" }, { etiqueta: "Agenda" }]);
    expect(construirMigas(SECCIONES, "/v/demo/no-existe", { etiqueta: "Demo" })).toEqual([{ etiqueta: "Demo" }]);
  });

  it("se pintan en el DOM, ocultas sin data-theme=v2 y mostradas por una clase atada al atributo del <html>", () => {
    rendered = renderShell({ ruta: "/v/demo/staff" });
    const migas = rendered.container.querySelector('[data-testid="vertical-migas"]')!;
    expect(migas.textContent).toBe("Demo · acmeAdministrarStaff");
    expect(migas.className).toContain("hidden");
    expect(migas.className).toContain("[[data-theme=v2]_&]:flex");
    expect(migas.querySelector('[aria-current="page"]')!.textContent).toBe("Staff");
  });
});

describe("VerticalShell — móvil", () => {
  it("la barra inferior suma 'Más' con TODAS las secciones y el menú de cuenta cierra sesión", () => {
    const onLogout = vi.fn();
    rendered = renderShell({ onLogout });
    const root = rendered.container;
    const mas = [...root.querySelectorAll("nav[aria-label='Navegación móvil'] button")].find((b) => b.textContent?.trim() === "Más")!;
    click(mas);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect([...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/v/demo/agenda", "/v/demo/proveedores", "/v/demo/configuracion", "/v/demo/staff"]);
    click([...hoja.querySelectorAll("a")][3]!);

    const mobileHeader = [...root.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('button[aria-label^="Notificaciones"]')).not.toBeNull();
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const cuenta = document.body.querySelector('[role="dialog"]')!;
    expect(cuenta.textContent).toContain("Chatea con tus datos");
    click([...cuenta.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar sesión")!);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("VerticalShell — slots, transiciones y remontaje", () => {
  it("pinta los slots de organización y sucursal en el Sidebar", () => {
    rendered = renderShell({ organizationSelector: <p>Org: Acme</p> });
    const aside = rendered.container.querySelector("aside")!;
    expect(aside.textContent).toContain("Org: Acme");
    expect(aside.textContent).toContain("Sucursal Centro");
    expect(aside.textContent!.indexOf("Org: Acme")).toBeLessThan(aside.textContent!.indexOf("Sucursal Centro"));
  });

  it("al navegar remonta el envoltorio de la página con la animación page-in (solo motion-safe)", () => {
    rendered = renderShell();
    const antes = rendered.container.querySelector("main > div")!;
    expect(antes.className).toContain("motion-safe:animate-page-in");
    click([...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "ir-proveedores")!);
    const despues = rendered.container.querySelector("main > div")!;
    expect(despues).not.toBe(antes);
    expect(antes.isConnected).toBe(false);
  });

  it("contentKey remonta el <main> (cambio de sucursal activa)", () => {
    let montajes = 0;
    function HijoMontaje() {
      useEffect(() => {
        montajes += 1;
      }, []);
      return <p>hijo</p>;
    }
    rendered = renderShell({ contentKey: "a", children: <HijoMontaje /> });
    const main1 = rendered.container.querySelector("main")!;
    rendered.rerender(
      <MemoryRouter initialEntries={["/v/demo/agenda"]}>
        <VerticalShell
          vertical="demo"
          sections={SECCIONES}
          mobileItems={MOBILE}
          user={null}
          onLogout={() => {}}
          header={{ icon: <span />, title: "Demo · acme", fecha: "x" }}
          notificationBell={<span />}
          contentKey="b"
        >
          <HijoMontaje />
        </VerticalShell>
      </MemoryRouter>,
    );
    expect(rendered.container.querySelector("main")).not.toBe(main1);
    expect(montajes).toBe(2);
  });
});

describe("RutaBoundary, estados y 404", () => {
  it("una página que lanza muestra EstadoError con Reintentar, y reintentar la vuelve a pintar", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    let falla = true;
    function Rota() {
      if (falla) throw new Error("boom");
      return <p>ya funciona</p>;
    }
    rendered = renderComponent(
      <RutaBoundary resetKey="/a">
        <Rota />
      </RutaBoundary>,
    );
    expect(rendered.container.querySelector('[role="alert"]')!.textContent).toContain("Esta pantalla no pudo mostrarse");
    falla = false;
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Reintentar")!);
    expect(rendered.container.textContent).toContain("ya funciona");
    consola.mockRestore();
  });

  it("cambiar resetKey (navegar) descarta el error anterior", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    function Rota(): never {
      throw new Error("boom");
    }
    rendered = renderComponent(
      <RutaBoundary resetKey="/a">
        <Rota />
      </RutaBoundary>,
    );
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
    rendered.rerender(
      <RutaBoundary resetKey="/b">
        <p>otra ruta</p>
      </RutaBoundary>,
    );
    expect(rendered.container.textContent).toContain("otra ruta");
    consola.mockRestore();
  });

  it("una página perezosa muestra el estado de carga mientras resuelve", async () => {
    let resolver!: (m: { default: () => React.ReactElement }) => void;
    const Perezosa = (await import("react")).lazy(() => new Promise<{ default: () => React.ReactElement }>((r) => (resolver = r)));
    rendered = renderComponent(
      <RutaBoundary resetKey="/a">
        <Perezosa />
      </RutaBoundary>,
    );
    expect(rendered.container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      resolver({ default: () => <p>cargada</p> });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("cargada");
  });

  it("VerticalShellEstado pinta carga (pantalla), error con reintentar y vacío", () => {
    const onReintentar = vi.fn();
    rendered = renderComponent(<VerticalShellEstado estado="cargando" mensaje="Cargando sucursales…" />);
    expect(rendered.container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Cargando sucursales…");
    rendered.rerender(<VerticalShellEstado estado="error" mensaje="Falló" onReintentar={onReintentar} />);
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Reintentar")!);
    expect(onReintentar).toHaveBeenCalledTimes(1);
    rendered.rerender(<VerticalShellEstado estado="vacio" mensaje="Sin sucursales" />);
    expect(rendered.container.textContent).toContain("Sin sucursales");
  });

  it("VerticalNoEncontrado ofrece un enlace real de regreso al panel", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <VerticalNoEncontrado volverA="/v/demo/agenda" />
      </MemoryRouter>,
    );
    expect(rendered.container.textContent).toContain("Página no encontrada");
    expect(rendered.container.querySelector("a")!.getAttribute("href")).toBe("/v/demo/agenda");
  });
});
