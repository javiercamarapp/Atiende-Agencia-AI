// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") del hallazgo de
// auditoría ALTA cerrado en esta ronda: RentasShell.tsx nunca importaba/
// renderizaba <MobileHeader>/<BottomNav> (a diferencia de CitasShell.tsx/
// HotelesShell.tsx/LicitacionesShell.tsx) -- el <Sidebar> compartido de
// @atiende/ui es `hidden md:flex`, así que en viewport móvil el usuario se
// quedaba sin logo/menú/logout. Protege que el fix se mantenga: verifica en el
// DOM real que el Sidebar sigue oculto en mobile, que aparece un MobileHeader
// con el wordmark real, y que el BottomNav trae exactamente los 5 destinos
// operativos curados (Resumen/Calendario/Aprobaciones/Mis tareas/Precios) --
// nunca más de 5 (REQ-UX-003).
//
// PR-7 (DS v2): el shell usa <VerticalShell>; la barra trae los 4 destinos de uso diario y
// "Más" abre TODOS los destinos (11), de modo que Precios/Finanzas/iCal/... no quedan
// inalcanzables en móvil. Un único <main>, skip link y nombre de la propiedad visible.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RentasShell } from "../src/verticals/rentas/RentasShell.tsx";
import type { PropertyOption } from "../src/verticals/rentas/lib/discovery-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { cerrarSesionDesdeMenuMovil } from "./test-utils/menu-cuenta-movil.ts";
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

const fetchPropertiesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly PropertyOption[]>>();

vi.mock("../src/verticals/rentas/lib/discovery-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/rentas/lib/discovery-client.ts")>();
  return { ...actual, fetchProperties: (...args: Parameters<typeof fetchPropertiesMock>) => fetchPropertiesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "gestora@example.com",
  fullName: "Gestora Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol: "admin_gestora" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fetchPropertiesMock.mockReset();
});

async function renderShell(rol = "admin_gestora"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.rentas.session", JSON.stringify({ ...SESSION, organizations: [{ ...SESSION.organizations[0]!, rol }] }));
  fetchPropertiesMock.mockResolvedValue([{ propertyId: "prop-1", nombre: "Depa Marina" }]);
  const result = renderComponent(
    <MemoryRouter>
      <RentasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </RentasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("RentasShell — nav móvil (hallazgo ALTA)", () => {
  it("mantiene el Sidebar oculto en mobile (hidden md:flex) y agrega MobileHeader + BottomNav", async () => {
    rendered = await renderShell();
    const root = rendered.container;

    const aside = root.querySelector('aside[aria-label="Navegación principal"]');
    expect(aside).not.toBeNull();
    expect(aside!.className).toContain("hidden");
    expect(aside!.className).toContain("md:flex");

    const headers = [...root.querySelectorAll("header")];
    const mobileHeader = headers.find((h) => h.className.includes("md:hidden"));
    expect(mobileHeader).toBeDefined();
    expect(mobileHeader!.textContent).toContain("atiende");

    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain("md:hidden");
  });

  it("el BottomNav trae los 4 destinos de uso diario y el botón Más (nunca más de 5 lugares)", async () => {
    rendered = await renderShell();
    const bottomNav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    expect([...bottomNav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/rentas/demo",
      "/rentas/demo/calendario",
      "/rentas/demo/mis-tareas",
      "/rentas/demo/finanzas",
    ]);
    expect([...bottomNav.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Más"]);
  });

  it('el botón "Más" abre los 18 destinos (15 + Copiloto + 2 de Privacidad para admin_gestora), incluidos Copiloto, Precios, Finanzas, Auditoría, Catálogo y Equipo', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const hrefs = [...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(19); // + Seguridad de la cuenta (PL-21)
    expect(hrefs).toEqual(
      expect.arrayContaining(["/rentas/demo/copiloto", "/rentas/demo/precios", "/rentas/demo/finanzas", "/rentas/demo/conectividad", "/rentas/demo/ical-sync", "/rentas/demo/monitor-sync", "/rentas/demo/acceso-huesped", "/rentas/demo/plantillas", "/rentas/demo/reportes", "/rentas/demo/auditoria", "/rentas/demo/catalogo", "/rentas/demo/equipo", "/rentas/demo/privacidad", "/rentas/demo/privacidad-organizacion"]),
    );
  });

  // UNI-6: marco de Likida -- Resumen y Calendario raiz sin titulo, categorias en el orden de Likida y acordeon exclusivo.
  it("el Sidebar agrupa los 18 destinos en el orden de Likida con acordeon exclusivo y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Operación", "Canales", "Finanzas", "Configuración", "Control"]);
    expect(categoriasAbiertas(root)).toEqual(["Operación"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Calendario", "Aprobaciones", "Mis tareas", "Plantillas", "Acceso al huésped"]);
    abrirCategoria(root, "Canales");
    expect(categoriasAbiertas(root)).toEqual(["Canales"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Calendario", "Conectividad", "Sincronización iCal", "Monitor de conflictos"]);
    abrirCategoria(root, "Finanzas");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Calendario", "Precios", "Finanzas", "Reportes"]);
    abrirCategoria(root, "Configuración");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Calendario", "Catálogo", "Equipo"]);
    abrirCategoria(root, "Control");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Calendario", "Auditoría", "Privacidad", "Privacidad de la organización"]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Gestora Demo", rol: "Administrador gestora" });
  });

  it("expone skip link, un único <main> enfocable y el nombre de la propiedad activa", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    const mains = root.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).toBe("contenido-principal");
    expect(root.querySelector("aside")!.textContent).toContain("Depa Marina");
    expect([...root.querySelectorAll("header")].some((h) => h.textContent?.includes("Demo · Depa Marina"))).toBe(true);
  });

  it("el item Resumen del Sidebar solo esta activo en la raiz, no en las paginas hijas", async () => {
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.rentas.session", JSON.stringify(SESSION));
    fetchPropertiesMock.mockResolvedValue([{ propertyId: "prop-1", nombre: "Depa Marina" }]);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/rentas/demo/aprobaciones"]}>
        <RentasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
          {() => <div>child</div>}
        </RentasShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const activos = [...rendered.container.querySelectorAll('aside a[aria-current="page"]')].map((a) => a.getAttribute("href"));
    expect(activos).toEqual(["/rentas/demo/aprobaciones"]);
  });

  it("con varias propiedades ofrece el selector real, lo persiste por organización y remonta la página", async () => {
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.rentas.session", JSON.stringify(SESSION));
    fetchPropertiesMock.mockResolvedValue([
      { propertyId: "prop-1", nombre: "Depa Marina" },
      { propertyId: "prop-2", nombre: "Casa Centro" },
    ]);
    rendered = renderComponent(
      <MemoryRouter>
        <RentasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
          {(ctx) => <div data-testid="hijo">{ctx.propertyId}</div>}
        </RentasShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const select = rendered.container.querySelector<HTMLSelectElement>("select#rentas-propiedad-activa")!;
    expect(select).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="hijo"]')!.textContent).toBe("prop-1");
    await act(async () => {
      select.value = "prop-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    expect(rendered.container.querySelector('[data-testid="hijo"]')!.textContent).toBe("prop-2");
    expect(window.localStorage.getItem("atiende.rentas.selectedProperty.demo")).toBe("prop-2");
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Demo ·") && !h.className.includes("md:hidden"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  it("campana, chat y cerrar sesión son alcanzables en móvil (header + menú de cuenta)", async () => {
    rendered = await renderShell();
    await cerrarSesionDesdeMenuMovil(rendered.container);
    expect(window.localStorage.getItem("atiende.rentas.session")).toBeNull();
  });

  // CHAT-10: el Copiloto solo existe para admin_gestora y contador (FINANZAS_LECTURA_ROLES del servidor); operador y limpieza no
  // ven la entrada en el Sidebar ni en la hoja "Más" de la barra móvil (el servidor igual responde 403).
  it.each(["contador"])("%s ve la entrada Copiloto en el Sidebar y en la hoja Más", async (rol) => {
    rendered = await renderShell(rol);
    expect(linksSidebar(rendered.container).slice(0, 2)).toEqual(["Resumen", "Copiloto"]);
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/rentas/demo/copiloto");
  });

  it.each(["operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "limpieza"])("%s NO ve la entrada Copiloto ni en el Sidebar ni en la hoja Más", async (rol) => {
    rendered = await renderShell(rol);
    expect(linksSidebar(rendered.container)).not.toContain("Copiloto");
    expect([...rendered.container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/rentas/demo/copiloto")).toBe(false);
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(16); // + Seguridad de la cuenta (PL-21)
    expect(hrefs).not.toContain("/rentas/demo/copiloto");
  });
});
