// @vitest-environment jsdom
//
// Entrada "Ajustes del agente" en la nav lateral de RestaurantesShell: visible para owner/admin (mismo umbral que el resto de la categoría
// Agente) y ausente para el resto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RestaurantesShell } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { BranchOption } from "../src/verticals/restaurantes/dashboard-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/restaurantes/dashboard-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/restaurantes/dashboard-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});
vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchBranchesMock.mockReset();
});

async function renderShell(rol: string): Promise<HTMLElement> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem(
    "atiende.restaurantes.session",
    JSON.stringify({ token: "tok", refreshToken: "r", email: "m@example.com", fullName: "M", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "restaurantes", rol }] }),
  );
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
  return rendered.container;
}

const enlaceVoz = (root: HTMLElement) => [...root.querySelectorAll<HTMLAnchorElement>("aside a")].find((a) => a.textContent?.includes("Ajustes del agente"));

describe("RestaurantesShell — entrada Ajustes del agente", () => {
  it("owner y admin la ven y apunta a la ruta del agente", async () => {
    for (const rol of ["owner", "admin"]) {
      const root = await renderShell(rol);
      // El Sidebar es un acordeón: la categoría "Agente" (solo owner/admin) arranca cerrada.
      click([...root.querySelectorAll<HTMLButtonElement>("aside button")].find((b) => b.textContent?.trim() === "Agente")!);
      expect(enlaceVoz(root)?.getAttribute("href")).toBe("/restaurantes/demo/agente-ajustes");
      rendered!.unmount();
      rendered = undefined;
    }
  });

  it("el staff de operación no la ve", async () => {
    const root = await renderShell("staff");
    expect([...root.querySelectorAll("aside button")].some((b) => b.textContent?.trim() === "Agente")).toBe(false); // sin categoría Agente, sin la entrada
    expect(enlaceVoz(root)).toBeUndefined();
    expect([...root.querySelectorAll("aside a")].some((a) => a.textContent?.includes("Pedidos"))).toBe(true);
  });
});
