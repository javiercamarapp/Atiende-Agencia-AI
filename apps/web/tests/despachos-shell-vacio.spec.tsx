// @vitest-environment jsdom
//
// D-21 -- un despacho sin ningun contribuyente no tiene cliente activo: el administrador/contador captura el primero
// desde el propio shell (antes el panel quedaba en un callejon sin salida y habia que dar de alta por SQL); el resto de
// roles ve un mensaje que les dice a quien pedirlo.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DespachosShell } from "../src/verticals/despachos/DespachosShell.tsx";
import type { BranchOption } from "../src/verticals/despachos/lib/admin-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/despachos/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/despachos/lib/admin-client.ts")>();
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
  vi.unstubAllGlobals();
});

async function montar(rol: string): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.despachos.session", JSON.stringify({ token: "tok", refreshToken: "r", email: "x@example.com", fullName: "X", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "despachos", rol }] }));
  fetchBranchesMock.mockResolvedValue([]);
  const r = renderComponent(
    <MemoryRouter>
      <DespachosShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </DespachosShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

describe("DespachosShell sin contribuyentes", () => {
  it.each(["admin", "contador"])("%s: ofrece dar de alta el primer cliente", async (rol) => {
    rendered = await montar(rol);
    expect(rendered.container.textContent).toContain("Da de alta tu primer cliente");
    expect(rendered.container.querySelector("#form-primer-cliente")).not.toBeNull();
  });

  it.each(["auditor", "readonly"])("%s: solo ve el mensaje de que lo dé de alta un administrador", async (rol) => {
    rendered = await montar(rol);
    expect(rendered.container.textContent).toContain("Pide a un administrador que lo dé de alta");
    expect(rendered.container.querySelector("#form-primer-cliente")).toBeNull();
  });
});
