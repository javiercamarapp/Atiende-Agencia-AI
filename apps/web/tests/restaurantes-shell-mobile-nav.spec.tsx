// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") del hallazgo de
// auditoría ALTA cerrado en esta ronda: RestaurantesShell.tsx nunca importaba/
// renderizaba <MobileHeader>/<BottomNav> (a diferencia de CitasShell.tsx/
// HotelesShell.tsx/LicitacionesShell.tsx) -- el <Sidebar> compartido de
// @atiende/ui es `hidden md:flex`, así que en viewport móvil el usuario se
// quedaba sin logo/menú/logout. Protege que el fix se mantenga: verifica en el
// DOM real (jsdom, sin CSS aplicado -- lo que se puede probar aquí son las
// clases Tailwind correctas, no el resultado visual) que:
//   1. El <Sidebar> sigue siendo `hidden md:flex` (nunca deja de ocultarse en mobile).
//   2. Existe un <header> `md:hidden` (MobileHeader) con el wordmark real.
//   3. Existe un <nav aria-label="Navegación móvil"> (BottomNav) con exactamente
//      los 5 destinos operativos curados (Panel/Pedidos/Historial/Productos/
//      Clientes) -- nunca más de 5 (REQ-UX-003 de BottomNav.tsx: usable con el
//      pulgar).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RestaurantesShell } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { BranchOption } from "../src/verticals/restaurantes/dashboard-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { cerrarSesionDesdeMenuMovil } from "./test-utils/menu-cuenta-movil.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/restaurantes/dashboard-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/restaurantes/dashboard-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "manager@example.com",
  fullName: "Manager Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "restaurantes", rol: "owner" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fetchBranchesMock.mockReset();
});

async function renderShell(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.restaurantes.session", JSON.stringify(SESSION));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Sucursal Centro", slug: "centro" }]);
  const result = renderComponent(
    <MemoryRouter>
      <RestaurantesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </RestaurantesShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("RestaurantesShell — nav móvil (hallazgo ALTA)", () => {
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

  // PR-5 (shell unico): antes eran 5 destinos fijos y Conversaciones/Turnos/Promociones/Sucursales y las
  // de gestión no se alcanzaban en móvil. Ahora la barra trae 4 destinos curados + "Más", que abre TODAS las secciones.
  it("el BottomNav trae los 4 destinos operativos curados más 'Más', que lista todas las secciones (nunca más de 5 lugares)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]')!;
    const labels = [...bottomNav.querySelectorAll("a span")].map((s) => s.textContent);
    expect(labels).toEqual(["Panel", "Pedidos", "Historial", "Productos"]);
    const mas = [...bottomNav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!;
    expect(bottomNav.querySelectorAll("a, button")).toHaveLength(5);
    click(mas);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect([...hoja.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "Panel (KPIs)",
      "Pedidos",
      "Conversaciones",
      "Turnos",
      "Historial",
      "Productos",
      "Promociones",
      "Sucursales",
      "Clientes",
      "Staff",
      "Auditoría",
      "Configuración",
      "Agente de voz",
      "Privacidad",
    ]);
  });

  it("expone skip link y <main> enfocable, y el Sidebar recuerda sus preferencias bajo la clave de la vertical restaurantes", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    expect(root.querySelector("main#contenido-principal")!.getAttribute("tabindex")).toBe("-1");
    const equipo = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Equipo"))!;
    click(equipo);
    expect(window.localStorage.getItem("atiende:restaurantes:sidebar:grupo")).toBe("Equipo");
  });

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Restaurantes · demo"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  it("campana, chat y cerrar sesión son alcanzables en móvil (header + menú de cuenta)", async () => {
    rendered = await renderShell();
    await cerrarSesionDesdeMenuMovil(rendered.container);
    expect(window.localStorage.getItem("atiende.restaurantes.session")).toBeNull();
  });
});
