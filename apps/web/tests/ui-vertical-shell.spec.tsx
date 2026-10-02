// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux (4.5/4.6): <VerticalShell> unico de @atiende/ui.
// Se prueban landmarks, skip link, aria-current, migas (construirMigas; el
// shell ya no las pinta), marco gris sunken, MobileHeader con el nombre de la
// pagina y h1 de respaldo, BottomNav con "Más", menu de cuenta movil, slots,
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
  it("expone un skip link que apunta al <main> enfocable, más aside y nav móvil con nombre", () => {
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
    // Likida no usa migas: la barra de la pagina ya lleva el nombre (UNI-1 retiro el selector muerto de v2).
    expect(root.querySelector('nav[aria-label="Migas de pan"]')).toBeNull();
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

  it("el shell no pinta migas ni conserva el selector muerto de la bandera v2", () => {
    rendered = renderShell({ ruta: "/v/demo/staff" });
    expect(rendered.container.querySelector('[data-testid="vertical-migas"]')).toBeNull();
    expect(rendered.container.innerHTML).not.toContain("data-theme=v2");
  });
});

describe("VerticalShell — marco de Likida", () => {
  it("el marco es la columna gris sunken con hairline y rounded-2xl, a la misma altura y tope que el Sidebar (100dvh)", () => {
    rendered = renderShell();
    const main = rendered.container.querySelector("main")!;
    const marco = main.parentElement!;
    for (const clase of ["bg-sunken", "md:rounded-2xl", "md:border", "md:border-border", "md:sticky", "md:top-4", "md:h-[calc(100dvh-2rem)]", "md:overflow-hidden"]) {
      expect(marco.className, clase).toContain(clase);
    }
    expect(marco.className).not.toContain("100vh");
    expect(rendered.container.querySelector("aside")!.className).toContain("h-[calc(100dvh-2rem)]");
    expect(rendered.container.querySelector("aside")!.className).toContain("top-4");
    // La barra de pagina vive dentro del marco, en un padre `hidden md:block`.
    const barra = rendered.container.querySelector('[data-testid="barra-pagina"]')!;
    expect(marco.contains(barra)).toBe(true);
    expect(barra.parentElement!.className).toContain("hidden md:block");
  });

  it("los paddings del <main> usan safe-area arriba (cabecera movil) y abajo (barra inferior)", () => {
    rendered = renderShell();
    const clase = rendered.container.querySelector("main")!.className;
    expect(clase).toContain("pt-[calc(6rem+var(--safe-area-top))]");
    expect(clase).toContain("pb-[calc(7rem+var(--safe-area-bottom))]");
    expect(clase).toContain("md:pt-3.5");
  });
});

describe("VerticalShell — móvil", () => {
  it("la cabecera móvil muestra el nombre de la página activa y el <main> trae el <h1> de la página sin duplicar", () => {
    rendered = renderShell({ ruta: "/v/demo/proveedores", children: <h1>Proveedores</h1> });
    const titulo = rendered.container.querySelector('[data-testid="mobile-pagina-titulo"]')!;
    expect(titulo.textContent).toBe("Proveedores");
    expect(titulo.closest("[data-testid=mobile-header]")!.className).toContain("md:hidden");
    // La pagina trae su <h1>: ni la barra de escritorio ni la fila movil hacen de nivel 1.
    expect(titulo.getAttribute("role")).toBeNull();
    expect(rendered.container.querySelector('[data-testid="barra-pagina-titulo"]')!.getAttribute("role")).toBeNull();
  });

  it("una página sin <h1> deja el nombre como encabezado de nivel 1 TAMBIÉN en la fila móvil (no solo en la barra oculta)", async () => {
    rendered = renderShell({ ruta: "/v/demo/proveedores", children: <p>sin encabezado</p> });
    await act(async () => {
      await Promise.resolve();
    });
    const movil = rendered.container.querySelector('[data-testid="mobile-pagina-titulo"]')!;
    expect(movil.getAttribute("role")).toBe("heading");
    expect(movil.getAttribute("aria-level")).toBe("1");
    // La fila movil esta en una cabecera `md:hidden`, la de escritorio en `hidden md:block`: solo una se ve por viewport.
    expect(movil.closest("[data-testid=mobile-header]")!.className).toContain("md:hidden");
    expect(rendered.container.querySelector('[data-testid="barra-pagina-titulo"]')!.closest(".hidden")!.className).toContain("md:block");
  });

  it("sidebarPie llega al Sidebar y a la hoja 'Más' (sección Cuenta); sin destino real no se pinta", () => {
    const alta = vi.fn();
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/v/demo/agenda"]}>
        <VerticalShell
          vertical="demo"
          sections={SECCIONES}
          mobileItems={MOBILE}
          user={null}
          onLogout={() => {}}
          header={{ icon: <span />, title: "Demo", fecha: "x" }}
          notificationBell={<span />}
          sidebarPie={[{ label: "Costos de IA", to: "/v/demo/costos" }, { label: "Pregunta a tus datos", onClick: alta }, { label: "Solo texto" }]}
        >
          <p>c</p>
        </VerticalShell>
      </MemoryRouter>,
    );
    const aside = rendered.container.querySelector("aside")!;
    expect(aside.textContent).toContain("Costos de IA");
    expect(aside.textContent).not.toContain("Solo texto");
    const mas = [...rendered.container.querySelectorAll("nav[aria-label='Navegación móvil'] button")].find((b) => b.textContent?.trim() === "Más")!;
    click(mas);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("Cuenta");
    expect(hoja.textContent).not.toContain("Solo texto");
    click([...hoja.querySelectorAll("button")].find((b) => b.textContent === "Pregunta a tus datos")!);
    expect(alta).toHaveBeenCalledTimes(1);
  });

  it("un destino del pie que no esta en las secciones lleva su nombre en la barra; uno que ya es de una categoria conserva el de la categoria", () => {
    const montar = (ruta: string) =>
      renderComponent(
        <MemoryRouter initialEntries={[ruta]}>
          <VerticalShell
            vertical="demo"
            sections={SECCIONES}
            mobileItems={MOBILE}
            user={null}
            onLogout={() => {}}
            header={{ icon: <span />, title: "Consola de Demo", fecha: "x", resumenTo: "/v/demo" }}
            notificationBell={<span />}
            sidebarPie={[{ label: "Ver los otros paneles", to: "/v/demo/paneles", icon: UserRound }, { label: "Costos de IA", to: "/v/demo/staff" }]}
          >
            <p>c</p>
          </VerticalShell>
        </MemoryRouter>,
      );
    rendered = montar("/v/demo/paneles");
    expect(rendered.container.querySelector('[data-testid="barra-pagina-titulo"]')!.textContent).toBe("Ver los otros paneles");
    expect(rendered.container.querySelector('[data-testid="mobile-pagina-titulo"]')!.textContent).toBe("Ver los otros paneles");
    rendered.unmount();
    rendered = montar("/v/demo/staff");
    expect(rendered.container.querySelector('[data-testid="barra-pagina-titulo"]')!.textContent).toBe("Staff");
  });

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
