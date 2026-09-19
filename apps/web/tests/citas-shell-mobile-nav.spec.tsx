// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") de la nav de
// CitasShell.tsx -- mismo patrón que restaurantes-shell-mobile-nav.spec.tsx:
// el <Sidebar> compartido de @atiende/ui es `hidden md:flex`, y en viewport
// móvil el usuario depende de <MobileHeader> + <BottomNav> (≤5 destinos
// curados, ver buildMobileItems en CitasShell.tsx). Protege que el fix se
// mantenga y que la curación siga siendo exactamente Agenda/Proveedores/
// Servicios/Clientes/Configuración.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CitasShell } from "../src/verticals/citas/CitasShell.tsx";
import type { BranchOption } from "../src/verticals/citas/lib/admin-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

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
  fetchBranchesMock.mockReset();
});

async function renderShell(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.citas.session", JSON.stringify(SESSION));
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

  it("el BottomNav trae exactamente los 5 destinos operativos curados, nunca más de 5", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const bottomNav = root.querySelector('nav[aria-label="Navegación móvil"]')!;
    const labels = [...bottomNav.querySelectorAll("a span")].map((s) => s.textContent);
    expect(labels).toEqual(["Agenda", "Proveedores", "Servicios", "Clientes", "Configuración"]);
  });

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Citas · demo"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });
});
