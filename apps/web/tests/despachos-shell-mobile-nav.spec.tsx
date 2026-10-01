// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav móvil de
// DespachosShell.tsx. El <Sidebar> compartido de @atiende/ui es `hidden md:flex`,
// así que en viewport móvil el usuario depende de <MobileHeader> + <BottomNav>.
// Despachos tiene 17 destinos: la barra trae los 4 de uso diario y "Más" abre
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

async function renderShell(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.despachos.session", JSON.stringify(SESSION));
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
      "/despachos/demo/cierre-mensual",
      "/despachos/demo/cfdi",
      "/despachos/demo/cobranza",
      "/despachos/demo/vencimientos",
    ]);
  });

  it('el botón "Más" abre los 17 destinos, incluidos Cartera de clientes, Portal del cliente, Staff y Configuración', async () => {
    rendered = await renderShell();
    const nav = rendered.container.querySelector('nav[aria-label="Navegación móvil"]')!;
    click([...nav.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Más")!);
    const hoja = document.body.querySelector('[role="dialog"]')!;
    const hrefs = [...hoja.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toHaveLength(17);
    expect(hrefs).toEqual(expect.arrayContaining(["/despachos/demo/cartera", "/despachos/demo/nomina", "/despachos/demo/portal-cliente", "/despachos/demo/staff", "/despachos/demo/configuracion"]));
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

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:block)", async () => {
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
    const equipo = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.includes("Equipo"))!;
    click(equipo);
    expect(window.localStorage.getItem("atiende:despachos:sidebar:grupo")).toBe("Equipo");
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
