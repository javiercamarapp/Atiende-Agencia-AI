// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// HotelesShell.tsx -- mismo patrón que despachos-shell-mobile-nav.spec.tsx/
// restaurantes-shell-mobile-nav.spec.tsx: el <Sidebar> compartido de
// @atiende/ui es `hidden md:flex`, así que en viewport móvil el usuario
// depende por completo de <MobileHeader>. Hoteles tiene hasta 13 destinos de
// nav (Operación + Administración) -- deliberadamente SIN <BottomNav> (mismo
// criterio que DespachosShell.tsx: demasiados destinos para curar 5 sin
// arbitrariedad). Protege que el Shell siga exponiendo el wordmark real y el
// selector de hotel activo también en mobile (`action` de MobileHeader).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HotelesShell } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { PropertyOption } from "../src/verticals/hoteles/lib/discovery-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

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
});

async function renderShell(properties: readonly PropertyOption[] = [{ propertyId: "prop-1", nombre: "Hotel Centro" }]): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.hoteles.session", JSON.stringify(SESSION));
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

describe("HotelesShell — nav móvil", () => {
  it("mantiene el Sidebar oculto en mobile (hidden md:flex) y agrega MobileHeader (sin BottomNav: demasiados destinos)", async () => {
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

    expect(root.querySelector('nav[aria-label="Navegación móvil"]')).toBeNull();
  });

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:block)", async () => {
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
    const select = mobileHeader.querySelector("select#hoteles-hotel-activo");
    expect(select).not.toBeNull();
    expect([...select!.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Hotel Centro", "Hotel Norte"]);
  });
});
