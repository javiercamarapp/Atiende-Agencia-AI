// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// CitasShell.tsx -- mismo patrón que restaurantes-shell-mobile-nav.spec.tsx:
// el <Sidebar> compartido de @atiende/ui es `hidden md:flex`, y en viewport
// móvil el usuario depende de <MobileHeader> + <BottomNav> (4 destinos
// curados + "Más", ver buildMobileItems en CitasShell.tsx). Protege que el fix se
// mantenga y que la curación siga siendo Resumen/Agenda/Servicios/Clientes.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CitasShell } from "../src/verticals/citas/CitasShell.tsx";
import type { BranchOption } from "../src/verticals/citas/lib/admin-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { cerrarSesionDesdeMenuMovil } from "./test-utils/menu-cuenta-movil.ts";
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/citas/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/citas/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "staff@example.com",
  fullName: "Staff Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "citas", rol: "owner" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fetchBranchesMock.mockReset();
});

async function renderShell(rol = "owner"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.citas.session", JSON.stringify({ ...SESSION, organizations: [{ ...SESSION.organizations[0], rol }] }));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Sucursal Centro" }]);
  const result = renderComponent(
    <MemoryRouter>
      <CitasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </CitasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("CitasShell — nav móvil", () => {
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

  // PR-4 (shell unico): antes eran 5 destinos fijos y Disponibilidad/Staff/Auditoría/Privacidad no se
  // alcanzaban en móvil. Ahora la barra trae 4 destinos curados + "Más", que abre TODAS las secciones; decisión de Omar 7-nov-2026:
  // «Preguntar» es el 5.o destino fijo (solo ds3) cuando el rol tiene el chat de datos y el servidor lo confirma. Sin chat confirmado
  // (este caso) la barra se queda en 4 + «Más».
  it("el BottomNav trae los 4 destinos operativos curados más 'Más' (sin chat confirmado no hay «Preguntar»), y Más lista todas las secciones", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]')!;
    const labels = [...bottomNav.querySelectorAll("a span")].map((s) => s.textContent);
    expect(labels).toEqual(["Resumen", "Agenda", "Servicios", "Clientes"]);
    const mas = [...bottomNav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!;
    expect(bottomNav.querySelectorAll("a, button")).toHaveLength(5);
    expect(bottomNav.querySelector('[data-testid="barra-preguntar"]')).toBeNull();
    click(mas);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect([...hoja.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "Resumen",
      "Copiloto",
      "Agenda",
      "Avisos",
      "Primeros pasos",
      "Proveedores",
      "Servicios",
      "Clientes",
      "Disponibilidad",
      "Conversaciones",
      "Agente de WhatsApp",
      "Mensajes de WhatsApp",
      "Configuración",
      "Staff",
      "Auditoría",
      "Privacidad",
      "Notificaciones", // la campana salio del encabezado: vive en la seccion "Cuenta" de la hoja
      "Seguridad de la cuenta", // PL-21: destino comun del pie, seccion "Cuenta" de la hoja
    ]);
  });

  // UNI-6: marco de Likida -- Resumen, Agenda y Primeros pasos raiz sin titulo, categorias en el orden de Likida y acordeon exclusivo.
  it("el Sidebar agrupa los 16 destinos en el orden de Likida con acordeon exclusivo y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Negocio", "Comunicación", "Administrar"]);
    expect(categoriasAbiertas(root)).toEqual(["Negocio"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Agenda", "Avisos", "Primeros pasos", "Proveedores", "Servicios", "Clientes", "Disponibilidad"]);
    abrirCategoria(root, "Comunicación");
    expect(categoriasAbiertas(root)).toEqual(["Comunicación"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Agenda", "Avisos", "Primeros pasos", "Conversaciones", "Agente de WhatsApp", "Mensajes de WhatsApp"]);
    abrirCategoria(root, "Administrar");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Agenda", "Avisos", "Primeros pasos", "Configuración", "Staff", "Auditoría", "Privacidad"]);
    expect(tarjetaUsuario(root).rol).toBe("Propietario");
  });

  it("expone skip link y <main> enfocable, y el Sidebar recuerda sus preferencias bajo la clave de la vertical citas", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    expect(root.querySelector("main#contenido-principal")!.getAttribute("tabindex")).toBe("-1");
    const negocio = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Administrar"))!;
    click(negocio);
    expect(window.localStorage.getItem("atiende:citas:sidebar:grupo")).toBe("Administrar");
    expect(window.localStorage.getItem("atiende-hoteles-sidebar-grupo-abierto")).toBeNull();
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Citas · demo"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  // Decisión de Omar 7-nov-2026: con el chat confirmado, «Preguntar» es el 5.o destino fijo (4 + Preguntar + Más), solo-ds3; el staff
  // (sin Copiloto de citas) no lo recibe.
  it("con el asistente activo la barra trae 4 destinos + «Preguntar» (solo ds3, al Copiloto) + «Más»; el staff no lo ve", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith("/estado") ? { available: true, permitido: true, motivo: null, usoHoyPct: 0 } : {}), { status: 200, headers: { "content-type": "application/json" } })));
    rendered = await renderShell();
    const barra = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    const lugares = [...barra.querySelectorAll(":scope > ul > li")];
    expect(lugares.map((li) => li.textContent?.trim())).toEqual(["Resumen", "Agenda", "Servicios", "Clientes", "Preguntar", "Más"]);
    const preguntar = barra.querySelector<HTMLAnchorElement>('a[data-testid="barra-preguntar"]')!;
    expect(preguntar.getAttribute("href")).toBe("/citas/demo/copiloto");
    expect(preguntar.closest("li")!.hidden).toBe(true);
    rendered.unmount();
    rendered = await renderShell("staff");
    expect(rendered.container.querySelector('nav[aria-label="Navegación móvil"] [data-testid="barra-preguntar"]')).toBeNull();
  });

  it("el encabezado móvil lleva la campana (decisión de Omar 7-nov-2026) y no el chat; el menú de cuenta conserva cerrar sesión", async () => {
    rendered = await renderShell();
    await cerrarSesionDesdeMenuMovil(rendered.container);
    expect(window.localStorage.getItem("atiende.citas.session")).toBeNull();
  });
});
