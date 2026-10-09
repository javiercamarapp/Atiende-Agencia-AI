// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// LicitacionesShell.tsx. El <Sidebar> compartido de @atiende/ui es `hidden md:flex`,
// y en viewport móvil el usuario depende de <MobileHeader> + <BottomNav>: la barra
// trae 4 destinos de uso diario y "Más" abre TODOS los destinos del Sidebar (PR-9 del
// plan de diseño-ux, shell único VerticalShell). Protege también que un único <main>
// (antes el shell anidaba el suyo), el skip link, campana, chat y cerrar sesión sean
// alcanzables en móvil.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LicitacionesShell } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import type { BranchOption } from "../src/verticals/licitaciones/lib/admin-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { cerrarSesionDesdeMenuMovil } from "./test-utils/menu-cuenta-movil.ts";
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/licitaciones/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/licitaciones/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "owner@example.com",
  fullName: "Owner Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "licitaciones", rol: "owner" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchBranchesMock.mockReset();
  // Revisión de PR #154 (bloqueante no-crítico): antes vivía al final del test
  // de logout -- si una aserción de ESE test fallaba, el stub de `fetch` se
  // fugaba a los tests siguientes del archivo (el `vi.stubGlobal` nunca se
  // deshacía). En `afterEach` corre siempre, incluso con el test en rojo.
  vi.unstubAllGlobals();
});

async function renderShell(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.licitaciones.session", JSON.stringify(SESSION));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Empresa Demo" }]);
  const result = renderComponent(
    <MemoryRouter>
      <LicitacionesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </LicitacionesShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("LicitacionesShell — nav móvil", () => {
  it("mantiene el Sidebar oculto en mobile (hidden md:flex) y agrega MobileHeader + BottomNav", async () => {
    rendered = await renderShell();
    const root = rendered.container;

    const aside = root.querySelector('aside[aria-label="Navegación principal"]');
    expect(aside).not.toBeNull();
    expect(aside!.className).toContain("hidden");
    expect(aside!.className).toContain("md:flex");

    const mobileHeader = [...root.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"));
    expect(mobileHeader).toBeDefined();
    expect(mobileHeader!.textContent).toContain("atiende");

    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain("md:hidden");
  });

  it("el BottomNav trae exactamente los 4 destinos curados (el resto, bajo Más)", async () => {
    rendered = await renderShell();
    const bottomNav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    expect([...bottomNav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/licitaciones/demo/panel",
      "/licitaciones/demo/convocatorias",
      "/licitaciones/demo/radar-renovaciones",
      "/licitaciones/demo/datos-empresa",
    ]);
  });

  it('el botón "Más" abre los 16 destinos de un owner (15 + Copiloto), incluidos KYC 69-B, Días inhábiles, Staff, Bitácora, WhatsApp, Seguridad y Privacidad', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const hrefs = [...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(16);
    expect(hrefs).toEqual(
      expect.arrayContaining(["/licitaciones/demo/copiloto", "/licitaciones/demo/radar-renovaciones", "/licitaciones/demo/fuentes", "/licitaciones/demo/kyc-69b", "/licitaciones/demo/dias-inhabiles", "/licitaciones/demo/staff", "/licitaciones/demo/bitacora", "/licitaciones/demo/whatsapp", "/licitaciones/demo/seguridad", "/licitaciones/demo/privacidad"]),
    );
  });

  // UNI-6: marco de Likida -- Resumen raiz sin titulo, categorias en el orden de Likida y acordeon exclusivo.
  it("el Sidebar agrupa los 16 destinos del owner en el orden de Likida con acordeon exclusivo y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Oportunidades", "Inteligencia", "Organización"]);
    expect(categoriasAbiertas(root)).toEqual(["Oportunidades"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Convocatorias", "Seguimiento", "Radar de renovaciones"]);
    abrirCategoria(root, "Inteligencia");
    expect(categoriasAbiertas(root)).toEqual(["Inteligencia"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Fuentes y frescura", "KYC proveedores (69-B)", "Perfil de matching"]);
    abrirCategoria(root, "Organización");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Datos de la empresa", "Días inhábiles", "Aprobaciones", "Staff", "Bitácora", "WhatsApp", "Seguridad", "Privacidad"]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Owner Demo", rol: "Propietario" });
  });

  it("un rol sin gestión de staff no ve Staff ni Privacidad (cosmético; el servidor es la barrera) y Más trae los otros 13", async () => {
    installMatchMediaStub();
    installMemoryLocalStorage().setItem(
      "atiende.licitaciones.session",
      JSON.stringify({ ...SESSION, organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "licitaciones", rol: "viewer" }] }),
    );
    fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Empresa Demo" }]);
    rendered = renderComponent(
      <MemoryRouter>
        <LicitacionesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
          {() => <div>child</div>}
        </LicitacionesShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hrefs = [...document.body.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(13);
    expect(hrefs).not.toContain("/licitaciones/demo/staff");
    expect(hrefs).not.toContain("/licitaciones/demo/privacidad");
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const desktopHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.textContent?.includes("Licitaciones · demo") && !h.className.includes("md:hidden"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  it("expone skip link y un único <main> enfocable (sin <main> anidado)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    const mains = root.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).toBe("contenido-principal");
    expect(mains[0]!.getAttribute("tabindex")).toBe("-1");
  });

  it("campana, chat y cerrar sesión son alcanzables en móvil (header + menú de cuenta)", async () => {
    const onRequireLogin = vi.fn();
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.licitaciones.session", JSON.stringify(SESSION));
    fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Empresa Demo" }]);
    rendered = renderComponent(
      <MemoryRouter>
        <LicitacionesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={onRequireLogin}>
          {() => <div>child</div>}
        </LicitacionesShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('button[aria-label^="Notificaciones"]')).not.toBeNull();
    const fetchMock = await cerrarSesionDesdeMenuMovil(rendered.container);
    // logout() real (apps/web/src/lib/auth-client.ts) -- POST /auth/logout con el refreshToken de la sesión.
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/auth/logout", expect.objectContaining({ method: "POST", body: JSON.stringify({ refreshToken: "reftok" }) }));
    expect(onRequireLogin).toHaveBeenCalled();
    expect(window.localStorage.getItem("atiende.licitaciones.session")).toBeNull();
  });
});
