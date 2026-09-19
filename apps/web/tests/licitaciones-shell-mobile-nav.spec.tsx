// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// LicitacionesShell.tsx -- mismo patrón que citas-shell-mobile-nav.spec.tsx:
// el <Sidebar> compartido de @atiende/ui es `hidden md:flex`, y en viewport
// móvil el usuario depende de <MobileHeader> + <BottomNav> (4 destinos
// curados, ver el JSX de LicitacionesShell.tsx). A diferencia de otras
// verticales, aquí el título del MobileHeader es un <img alt="atiende"> (no
// <AtiendeWordmark>), así que el logo se verifica por el `alt`, no por
// `textContent`.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LicitacionesShell } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import type { BranchOption } from "../src/verticals/licitaciones/lib/admin-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

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

    const headers = [...root.querySelectorAll("header")];
    const mobileHeader = headers.find((h) => h.className.includes("md:hidden"));
    expect(mobileHeader).toBeDefined();
    expect(mobileHeader!.querySelector('img[alt="atiende"]')).not.toBeNull();
    expect(mobileHeader!.textContent).toContain("Licitaciones · demo");

    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain("md:hidden");
  });

  it("el BottomNav trae exactamente los 4 destinos curados", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]')!;
    const labels = [...bottomNav.querySelectorAll("a span")].map((s) => s.textContent);
    expect(labels).toEqual(["Convocatorias", "Radar", "Matching", "Empresa"]);
  });

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:flex, directo en el <header>)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Licitaciones · demo") && h.className.includes("md:flex"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.className).toContain("hidden");
    expect(desktopHeader!.className).toContain("md:flex");
  });

  it("botón 'Salir' del MobileHeader dispara logout y regresa a onRequireLogin", async () => {
    const onRequireLogin = vi.fn();
    installMatchMediaStub();
    installMemoryLocalStorage().setItem("atiende.licitaciones.session", JSON.stringify(SESSION));
    fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Empresa Demo" }]);
    const logoutFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal("fetch", logoutFetch);
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
    const salirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Salir")!;
    await act(async () => {
      salirBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    // logout() real (apps/web/src/lib/auth-client.ts) -- POST /auth/logout con
    // el refreshToken de la sesión, no solo la navegación de vuelta al login.
    expect(logoutFetch).toHaveBeenCalledWith(
      "https://api.test/auth/logout",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ refreshToken: "reftok" }) }),
    );
    expect(onRequireLogin).toHaveBeenCalled();
  });
});
