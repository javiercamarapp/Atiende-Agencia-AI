// @vitest-environment jsdom
//
// Smoke test real (rubro 9, "0 tests de componentes React") del hallazgo de
// auditoría ALTA cerrado en esta ronda: RentasShell.tsx nunca importaba/
// renderizaba <MobileHeader>/<BottomNav> (a diferencia de CitasShell.tsx/
// HotelesShell.tsx/LicitacionesShell.tsx) -- el <Sidebar> compartido de
// @atiende/ui es `hidden md:flex`, así que en viewport móvil el usuario se
// quedaba sin logo/menú/logout. Protege que el fix se mantenga: verifica en el
// DOM real que el Sidebar sigue oculto en mobile, que aparece un MobileHeader
// con el wordmark real, y que el BottomNav trae exactamente los 5 destinos
// operativos curados (Resumen/Calendario/Aprobaciones/Mis tareas/Precios) --
// nunca más de 5 (REQ-UX-003).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RentasShell } from "../src/verticals/rentas/RentasShell.tsx";
import type { PropertyOption } from "../src/verticals/rentas/lib/discovery-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchPropertiesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly PropertyOption[]>>();

vi.mock("../src/verticals/rentas/lib/discovery-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/rentas/lib/discovery-client.ts")>();
  return { ...actual, fetchProperties: (...args: Parameters<typeof fetchPropertiesMock>) => fetchPropertiesMock(...args) };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const SESSION = {
  token: "tok",
  refreshToken: "reftok",
  email: "gestora@example.com",
  fullName: "Gestora Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol: "admin_gestora" }],
};

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchPropertiesMock.mockReset();
});

async function renderShell(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.rentas.session", JSON.stringify(SESSION));
  fetchPropertiesMock.mockResolvedValue([{ propertyId: "prop-1", nombre: "Depa Marina" }]);
  const result = renderComponent(
    <MemoryRouter>
      <RentasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </RentasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("RentasShell — nav móvil (hallazgo ALTA)", () => {
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
    expect(labels).toEqual(["Resumen", "Calendario", "Aprobaciones", "Mis tareas", "Precios"]);
  });

  it("el DashboardHeader de escritorio se oculta en mobile (hidden md:block)", async () => {
    rendered = await renderShell();
    const root = rendered.container;
    const headers = [...root.querySelectorAll("header")];
    const desktopHeader = headers.find((h) => h.textContent?.includes("Demo") && !h.className.includes("md:hidden"));
    expect(desktopHeader).toBeDefined();
    expect(desktopHeader!.parentElement!.className).toContain("hidden");
    expect(desktopHeader!.parentElement!.className).toContain("md:block");
  });
});
