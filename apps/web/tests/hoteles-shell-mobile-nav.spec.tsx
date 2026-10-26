// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// HotelesShell.tsx -- mismo patrón que despachos-shell-mobile-nav.spec.tsx/
// restaurantes-shell-mobile-nav.spec.tsx: el <Sidebar> compartido de
// @atiende/ui es `hidden md:flex`, así que en viewport móvil el usuario
// depende por completo de <MobileHeader> + <BottomNav>. Hoteles tiene hasta 17
// destinos: la barra trae los 4 de uso diario y "Más" abre TODOS (PR-0 del
// informe de diseno-ux, F-01: antes no había navegación móvil). Protege también
// que campana, chat y cerrar sesión sean alcanzables en móvil.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HotelesShell } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { PropertyOption } from "../src/verticals/hoteles/lib/discovery-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";
import { elegirValor, etiquetasDe, prepararJsdomParaRadix, valorDe } from "./test-utils/seleccionar.tsx";

const fetchPropertiesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly PropertyOption[]>>();

vi.mock("../src/verticals/hoteles/lib/discovery-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/hoteles/lib/discovery-client.ts")>();
  return { ...actual, fetchProperties: (...args: Parameters<typeof fetchPropertiesMock>) => fetchPropertiesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "gm@example.com",
  fullName: "GM Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "hoteles", rol: "owner" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchPropertiesMock.mockReset();
  vi.unstubAllGlobals();
});

async function renderShell(properties: readonly PropertyOption[] = [{ propertyId: "prop-1", nombre: "Hotel Centro" }], rol = "owner"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.hoteles.session", JSON.stringify({ ...SESSION, organizations: [{ ...SESSION.organizations[0], rol }] }));
  fetchPropertiesMock.mockResolvedValue(properties);
  const result = renderComponent(
    <MemoryRouter>
      <HotelesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </HotelesShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

beforeAll(() => prepararJsdomParaRadix());

describe("HotelesShell — nav móvil", () => {
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

    const nav = root.querySelector('nav[aria-label="Navegación móvil"]');
    expect(nav).not.toBeNull();
    expect([...nav!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/hoteles/demo",
      "/hoteles/demo/reservas",
      "/hoteles/demo/tickets",
      "/hoteles/demo/asistencia",
    ]);
  });

  // UNI-6: marco de Likida -- Resumen raiz sin titulo, categorias en el orden de Likida, acordeon exclusivo y gates de rol intactos.
  it("el Sidebar agrupa los destinos del owner en el orden de Likida con acordeon exclusivo y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Operación", "Huéspedes", "Finanzas", "Agentes", "Configuración"]);
    expect(categoriasAbiertas(root)).toEqual(["Operación"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Recepción", "Reservas", "Conversaciones", "Housekeeping", "Mantenimiento", "Tickets", "Asistencia"]);
    abrirCategoria(root, "Finanzas");
    expect(categoriasAbiertas(root)).toEqual(["Finanzas"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "P&L", "Revenue", "CFDI", "Fraude"]);
    abrirCategoria(root, "Huéspedes");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Huéspedes", "Pedidos F&B", "Reputación", "Identidad", "Grupos"]);
    abrirCategoria(root, "Agentes");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Agentes", "Aprobaciones"]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "GM Demo", rol: "Propietario" });
  });

  it("un rol operativo (housekeeping) solo ve las categorias con destinos para su rol: las vacias se omiten", async () => {
    rendered = await renderShell(undefined, "housekeeping");
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Operación", "Finanzas"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Reservas", "Housekeeping", "Mantenimiento", "Tickets", "Asistencia"]);
    expect(tarjetaUsuario(root).rol).toBe("Housekeeping");
  });

  it('el botón "Más" abre TODOS los destinos del rol (los 17 del owner, con Recepción, Conversaciones y Huéspedes), no solo los 4 de la barra', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const etiquetas = [...hoja.querySelectorAll("a")].map((a) => a.textContent);
    expect(etiquetas).toEqual(
      expect.arrayContaining(["Resumen", "Reservas", "Mantenimiento", "Asistencia", "Fraude", "CFDI", "P&L", "Revenue", "Catálogo"]),
    );
    const hrefs = [...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/hoteles/demo/fraude");
    expect(hrefs).toEqual(expect.arrayContaining(["/hoteles/demo/recepcion", "/hoteles/demo/huespedes", "/hoteles/demo/conversaciones"]));
    // CHAT-09: el Copiloto tambien esta en la hoja "Más" (solo owner/gm).
    expect(hrefs).toContain("/hoteles/demo/copiloto");
  });

  // CHAT-09: el Copiloto es una PÁGINA solo para owner/gm (los únicos roles que el servidor deja usar chat-datos). Con el asistente
  // activo, el botón del header y la píldora del pie son enlaces a /hoteles/:org/copiloto y ya no abren el diálogo viejo.
  it("owner/gm: con el asistente activo, la píldora del pie enlaza a la página del Copiloto (el header ya no lleva botón)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith("/estado") ? { available: true, permitido: true, motivo: null, usoHoyPct: 0 } : {}), { status: 200, headers: { "content-type": "application/json" } })));
    for (const rol of ["owner", "gm"]) {
      rendered = await renderShell(undefined, rol);
      const root = rendered.container;
      const hrefs = (texto: string) => [...root.querySelectorAll("a")].filter((a) => a.textContent?.includes(texto)).map((a) => a.getAttribute("href"));
      expect(root.querySelector('[data-testid="barra-pagina"]')!.querySelector("a, button"), "el encabezado ya no lleva el boton de chat").toBeNull();
      expect(hrefs("Pregúntale a tus datos")).toContain("/hoteles/demo/copiloto");
      expect(hrefs("Copiloto")).toContain("/hoteles/demo/copiloto");
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      rendered.unmount();
      rendered = undefined;
    }
  });

  it("un rol sin acceso (frontdesk, accountant) no ve la entrada Copiloto, ni el botón del chat ni la píldora, y no consulta /estado", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    for (const rol of ["frontdesk", "reservations", "housekeeping", "maintenance", "fnb", "accountant"]) {
      rendered = await renderShell(undefined, rol);
      const root = rendered.container;
      expect(linksSidebar(root)).not.toContain("Copiloto");
      const textos = [...root.querySelectorAll("a, button")].map((e) => e.textContent ?? "");
      expect(textos.some((t) => t.includes("Pregúntale a tus datos") || t.includes("Pregúntale a tus datos"))).toBe(false);
      rendered.unmount();
      rendered = undefined;
    }
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("/chat-datos"))).toHaveLength(0);
  });

  it("si /estado no confirma el asistente, no hay botón de chat ni píldora ni enlace (aviso honesto: nunca un control Pronto)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 403 })));
    rendered = await renderShell();
    const root = rendered.container;
    // Sin confirmacion del servidor ya no hay boton "Pronto" en el header: no hay ningun control de chat.
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Pregúntale a tus datos"))).toBe(false);
    expect([...root.querySelectorAll("a")].some((a) => a.textContent?.includes("Pregúntale a tus datos"))).toBe(false);
  });

  it("el encabezado móvil va sin campana ni chat; el menú de cuenta conserva cerrar sesión (campana y chat viven en Más > Cuenta)", async () => {
    rendered = await renderShell();
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('[aria-label^="Notificaciones"]'), "sin campana en el encabezado movil").toBeNull();
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).not.toContain("Pregúntale a tus datos");
    expect(hoja.textContent).toContain("gm@example.com");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      click([...hoja.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar sesión")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/auth/logout");
    expect(window.localStorage.getItem("atiende.hoteles.session")).toBeNull();
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Hoteles ·"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  it("con más de un hotel, el MobileHeader trae el selector real (no solo el desktop Sidebar)", async () => {
    rendered = await renderShell([
      { propertyId: "prop-1", nombre: "Hotel Centro" },
      { propertyId: "prop-2", nombre: "Hotel Norte" },
    ]);
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const mobileHeader = headers.find((h) => h.className.includes("md:hidden"))!;
    const select = mobileHeader.querySelector("button#hoteles-hotel-activo-movil");
    expect(select).not.toBeNull();
    expect(etiquetasDe(select)).toEqual(["Hotel Centro", "Hotel Norte"]);
    // Cada copia (Sidebar y cabecera movil) lleva su propio id y su propia etiqueta: sin ids duplicados.
    expect(root.querySelectorAll("#hoteles-hotel-activo")).toHaveLength(1);
    expect(root.querySelectorAll("#hoteles-hotel-activo-movil")).toHaveLength(1);
    expect(root.querySelector('label[for="hoteles-hotel-activo-movil"]')?.textContent).toBe("Hotel activo");
  });

  it("PR-6: expone skip link y <main> enfocable, y el Sidebar recuerda sus preferencias bajo la clave de la vertical hoteles", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    expect(root.querySelector("main#contenido-principal")!.getAttribute("tabindex")).toBe("-1");
    const operacion = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Finanzas"))!;
    click(operacion);
    expect(window.localStorage.getItem("atiende:hoteles:sidebar:grupo")).toBe("Finanzas");
  });

  it("PR-6: cambiar de hotel con el selector persiste la elección y remonta la página (key=propertyId)", async () => {
    rendered = await renderShell([
      { propertyId: "prop-1", nombre: "Hotel Centro" },
      { propertyId: "prop-2", nombre: "Hotel Norte" },
    ]);
    const select = rendered.container.querySelector<HTMLElement>("aside button#hoteles-hotel-activo")!;
    expect(valorDe(select)).toBe("prop-1");
    elegirValor(select, "prop-2");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(valorDe(rendered.container.querySelector<HTMLElement>("aside button#hoteles-hotel-activo"))).toBe("prop-2");
    expect(window.localStorage.getItem("atiende.hoteles.selectedProperty.demo")).toBe("prop-2");
  });
});
