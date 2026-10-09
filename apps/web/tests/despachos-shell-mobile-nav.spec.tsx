// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav móvil de
// DespachosShell.tsx. El <Sidebar> compartido de @atiende/ui es `hidden md:flex`,
// así que en viewport móvil el usuario depende de <MobileHeader> + <BottomNav>.
// Despachos tiene 20 destinos: la barra trae los 4 de uso diario y "Más" abre
// TODOS (PR-0 del informe de diseno-ux, F-01: antes había un comentario que
// afirmaba que el Sidebar de escritorio cubría el móvil, lo cual era falso).
// Protege también que campana, chat y cerrar sesión sean alcanzables en móvil.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DespachosShell } from "../src/verticals/despachos/DespachosShell.tsx";
import type { BranchOption } from "../src/verticals/despachos/lib/admin-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { abrirCategoria, categoriasAbiertas, categoriasSidebar, linksSidebar, tarjetaUsuario } from "./test-utils/sidebar-estructura.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/despachos/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/despachos/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "contador@example.com",
  fullName: "Contador Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "despachos", rol: "admin" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchBranchesMock.mockReset();
  vi.unstubAllGlobals();
});

async function renderShell(rol = "admin"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.despachos.session", JSON.stringify({ ...SESSION, organizations: [{ ...SESSION.organizations[0], rol }] }));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Contribuyente Uno" }]);
  const result = renderComponent(
    <MemoryRouter>
      <DespachosShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </DespachosShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("DespachosShell — nav móvil (hallazgo ALTA)", () => {
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
      "/despachos/demo/dashboard",
      "/despachos/demo/cierre-mensual",
      "/despachos/demo/cfdi",
      "/despachos/demo/cobranza",
    ]);
  });

  it('el botón "Más" abre los 20 destinos + el Copiloto, incluidos Cartera de clientes, Cola de cobranza, Libro contable, Pagos provisionales, Portal del cliente, Staff y Configuración', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const hrefs = [...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(22); // 20 destinos + Copiloto + Seguridad de la cuenta (PL-21)
    // CHAT-11: el Copiloto tambien esta en la hoja "Más" (admin, contador, auditor y readonly).
    expect(hrefs).toContain("/despachos/demo/copiloto");
    expect(hrefs).toEqual(expect.arrayContaining(["/despachos/demo/cartera", "/despachos/demo/nomina", "/despachos/demo/cola-cobranza", "/despachos/demo/libro-contable", "/despachos/demo/pagos-provisionales", "/despachos/demo/portal-cliente", "/despachos/demo/staff", "/despachos/demo/configuracion"]));
  });

  // UNI-6: marco de Likida -- Resumen y Cierre mensual raiz sin titulo, categorias en el orden de Likida y acordeon exclusivo.
  it("el Sidebar agrupa los 20 destinos en el orden de Likida con acordeon exclusivo y tarjeta de usuario", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(categoriasSidebar(root)).toEqual(["Facturación", "Fiscal", "Contabilidad", "Clientes y equipo"]);
    expect(categoriasAbiertas(root)).toEqual(["Facturación"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Cierre mensual", "CFDI", "Cobranza", "Cola de cobranza", "Vencimientos"]);
    abrirCategoria(root, "Fiscal");
    expect(categoriasAbiertas(root)).toEqual(["Fiscal"]);
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Cierre mensual", "Declaraciones", "Pagos provisionales", "Contabilidad electrónica", "Devolución de IVA", "Nómina"]);
    abrirCategoria(root, "Contabilidad");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Cierre mensual", "Conciliación bancaria", "Libro contable", "Bookkeeping", "Reportes de cliente", "Migración de catálogo"]);
    abrirCategoria(root, "Clientes y equipo");
    expect(linksSidebar(root)).toEqual(["Resumen", "Copiloto", "Cierre mensual", "Cartera de clientes", "Portal del cliente", "Staff", "Configuración"]);
    expect(tarjetaUsuario(root)).toEqual({ nombre: "Contador Demo", rol: "Administrador" });
  });

  // CHAT-11: el Copiloto es una PAGINA para los roles que el servidor deja usar chat-datos (admin, contador, auditor, readonly). Con el
  // asistente activo el boton del header y la pildora del pie son enlaces a /despachos/:org/copiloto y ya no abren el dialogo viejo.
  it("admin/contador/auditor/readonly: con el asistente activo, el botón del header y la píldora del pie enlazan a la página del Copiloto", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith("/estado") ? { available: true, permitido: true, motivo: null, usoHoyPct: 0 } : {}), { status: 200, headers: { "content-type": "application/json" } })));
    for (const rol of ["admin", "contador", "auditor", "readonly"]) {
      rendered = await renderShell(rol);
      const root = rendered.container;
      const hrefs = (texto: string) => [...root.querySelectorAll("a")].filter((a) => a.textContent?.includes(texto)).map((a) => a.getAttribute("href"));
      expect(hrefs("Chatea con tus datos")).toContain("/despachos/demo/copiloto");
      expect(hrefs("Pregunta a tus datos")).toContain("/despachos/demo/copiloto");
      expect(hrefs("Copiloto")).toContain("/despachos/demo/copiloto");
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      rendered.unmount();
      rendered = undefined;
    }
  });

  it("un rol sin acceso (owner, staff) no ve la entrada Copiloto, ni el botón del chat ni la píldora, y no consulta /estado", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    for (const rol of ["owner", "staff"]) {
      rendered = await renderShell(rol);
      const root = rendered.container;
      expect(linksSidebar(root)).not.toContain("Copiloto");
      const textos = [...root.querySelectorAll("a, button")].map((e) => e.textContent ?? "");
      expect(textos.some((t) => t.includes("Chatea con tus datos") || t.includes("Pregunta a tus datos"))).toBe(false);
      rendered.unmount();
      rendered = undefined;
    }
    expect(fetchMock.mock.calls.filter(([u]) => u.includes("/chat-datos"))).toHaveLength(0);
  });

  it("si /estado no confirma el asistente, el botón sigue diciendo Pronto (aviso honesto) y no hay píldora ni enlace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 403 })));
    rendered = await renderShell();
    const root = rendered.container;
    const boton = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos"));
    expect(boton?.textContent).toContain("Pronto");
    expect([...root.querySelectorAll("a")].some((a) => a.textContent?.includes("Pregunta a tus datos"))).toBe(false);
  });

  it("campana, chat y cerrar sesión son alcanzables en móvil (header + menú de cuenta)", async () => {
    rendered = await renderShell();
    const mobileHeader = [...rendered.container.querySelectorAll("header")].find((h) => h.className.includes("md:hidden"))!;
    expect(mobileHeader.querySelector('button[aria-label^="Notificaciones"]')).not.toBeNull();
    click(mobileHeader.querySelector('button[aria-label="Abrir menú de cuenta"]')!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    expect(hoja.textContent).toContain("Chatea con tus datos");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      click([...hoja.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar sesión")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/auth/logout");
    expect(window.localStorage.getItem("atiende.despachos.session")).toBeNull();
  });

  it("el BarraPagina de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Despachos ·"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });

  // PR-8 (shell unico): un solo <main> (antes el shell propio anidaba su <main> dentro de las paginas), skip link,
  // clave de grupo por vertical y el nombre del contribuyente activo visible tambien en el Sidebar.
  it("expone skip link, un único <main> enfocable y el nombre del contribuyente activo", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    expect(root.querySelector('a[href="#contenido-principal"]')).not.toBeNull();
    const mains = root.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!.id).toBe("contenido-principal");
    expect(mains[0]!.getAttribute("tabindex")).toBe("-1");
    expect(root.querySelector("aside")!.textContent).toContain("Contribuyente Uno");
    const equipo = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Clientes y equipo"))!;
    click(equipo);
    expect(window.localStorage.getItem("atiende:despachos:sidebar:grupo")).toBe("Clientes y equipo");
  });

  it("con varios contribuyentes ofrece el selector real y lo persiste por organización", async () => {
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.despachos.session", JSON.stringify(SESSION));
    fetchBranchesMock.mockResolvedValue([
      { propertyId: "prop-1", name: "Contribuyente Uno" },
      { propertyId: "prop-2", name: "Contribuyente Dos" },
    ]);
    rendered = renderComponent(
      <MemoryRouter>
        <DespachosShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
          {(ctx) => <div data-testid="hijo">{ctx.propertyId}</div>}
        </DespachosShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    const select = rendered.container.querySelector<HTMLSelectElement>("select#despachos-contribuyente-activo")!;
    expect(select).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="hijo"]')!.textContent).toBe("prop-1");
    await act(async () => {
      select.value = "prop-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    expect(rendered.container.querySelector('[data-testid="hijo"]')!.textContent).toBe("prop-2");
    expect(window.localStorage.getItem("atiende.despachos.selectedProperty.demo")).toBe("prop-2");
  });
});
