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
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

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
    expect(labels).toEqual(["Resumen", "Pedidos", "Historial", "Productos"]);
    const mas = [...bottomNav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!;
    expect(bottomNav.querySelectorAll("a, button")).toHaveLength(5);
    click(mas);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect([...hoja.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "Resumen",
      "Copiloto",
      "Pedidos",
      "Comandas al POS",
      "Conversaciones",
      "Turnos",
      "Historial",
      "Cierre del día", // R-42 (owner/admin)
      "Productos",
      "Promociones",
      "Clientes",
      "Campañas", // autopiloto 2 (owner/admin)
      "Sucursales",
      "Agente de voz",
      "Agente de WhatsApp",
      "Ajustes del agente",
      "Primeros pasos",
      "Configuración",
      "Staff",
      "Avisos",
      "Auditoría",
      "Privacidad",
      "Privacidad de la organización",
      "Seguridad de la cuenta", // PL-21: destino comun del pie, seccion "Cuenta" de la hoja
    ]);
  });

  // UNI-6: marco de Likida -- "Resumen" raiz sin titulo, categorias en el orden de Likida, acordeon exclusivo y tarjeta de usuario con nombre + rol.
  it("el Sidebar agrupa los destinos en el orden de Likida con acordeon exclusivo y tarjeta de usuario con nombre y rol legible", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Operación", "Catálogo", "Clientes", "Agente", "Configuración"]);
    // Abre la primera categoria; "Resumen" (raiz) esta siempre, sin boton ni titulo.
    expect(categoriasAbiertas(root)).toEqual(["Operación"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Pedidos", "Comandas al POS", "Conversaciones", "Turnos", "Historial", "Cierre del día"]);
    abrirCategoria(root, "Catálogo");
    expect(categoriasAbiertas(root)).toEqual(["Catálogo"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Productos", "Promociones"]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Manager Demo", rol: "Propietario" });
  });

  it("un rol sin gestion (staff) no ve Agente ni Configuracion, pero conserva el resto", async () => {
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.restaurantes.session", JSON.stringify({ ...SESSION, organizations: [{ ...SESSION.organizations[0], rol: "staff" }] }));
    fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Sucursal Centro", slug: "centro" }]);
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
          {() => <div>child</div>}
        </RestaurantesShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(categoriasSidebar(rendered.container)).toEqual(["Operación", "Catálogo", "Clientes"]);
    expect(tarjetaUsuario(rendered.container).rol).toBe("Equipo");
    // CHAT-08: el staff (MANAGER_ROLES del servidor) SÍ tiene Copiloto, justo debajo de Resumen.
    expect(linksSidebar(rendered.container).slice(0, 2)).toEqual(["Resumen", "Copiloto"]);
    // R-16: sin la categoria Configuración, el staff alcanza "Mis avisos" desde Operación (la misma pagina que owner/admin ven en Configuración).
    expect(linksSidebar(rendered.container)).toContain("Avisos");
  });

  // CHAT-08: el Copiloto es una PÁGINA. Con el asistente activo, el botón del header y la píldora "Pregunta a tus datos" del pie son
  // enlaces a /restaurantes/:org/copiloto (ya no abren el diálogo); la entrada del Sidebar apunta a la misma ruta.
  it("con el asistente activo, el botón del header y la píldora del pie enlazan a la página del Copiloto", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith("/estado") ? { available: true, permitido: true, motivo: null, usoHoyPct: 0 } : {}), { status: 200, headers: { "content-type": "application/json" } })));
    rendered = await renderShell();
    const root = rendered.container;
    const hrefs = (texto: string) => [...root.querySelectorAll("a")].filter((a) => a.textContent?.includes(texto)).map((a) => a.getAttribute("href"));
    expect(hrefs("Chatea con tus datos")).toContain("/restaurantes/demo/copiloto");
    expect(hrefs("Pregunta a tus datos")).toContain("/restaurantes/demo/copiloto");
    expect(hrefs("Copiloto")).toContain("/restaurantes/demo/copiloto");
    // Y ya no abre el diálogo del chat viejo.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("si /estado no confirma el asistente, el botón sigue diciendo Pronto (aviso honesto) y no hay píldora ni enlace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 403 })));
    rendered = await renderShell();
    const root = rendered.container;
    const boton = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos"));
    expect(boton?.textContent).toContain("Pronto");
    expect([...root.querySelectorAll("a")].some((a) => a.textContent?.includes("Pregunta a tus datos"))).toBe(false);
    expect([...root.querySelectorAll("a")].some((a) => a.textContent?.includes("Chatea con tus datos"))).toBe(false);
  });

  it("expone skip link y <main> enfocable, y el Sidebar recuerda sus preferencias bajo la clave de la vertical restaurantes", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    expect(root.querySelector("main#contenido-principal")!.getAttribute("tabindex")).toBe("-1");
    const configuracion = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Configuración"))!;
    click(configuracion);
    expect(window.localStorage.getItem("atiende:restaurantes:sidebar:grupo")).toBe("Configuración");
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
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
