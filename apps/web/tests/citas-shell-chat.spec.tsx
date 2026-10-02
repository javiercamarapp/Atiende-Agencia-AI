// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en CitasShell (CHAT-13): en citas el Copiloto es una PAGINA (/citas/:org/copiloto), solo owner/admin
// (DATA_CHAT_ROLES). Con el asistente activo el boton del header es un ENLACE a la pagina (ya no abre un dialogo ni manda la pregunta
// desde ahi: eso lo cubre citas-copiloto-page.spec.tsx). Los roles que el servidor rechaza (staff) no ven el boton, ni la entrada
// "Copiloto" del menu, ni consultan /estado. Si el servidor no confirma que el asistente esta activo, sigue el aviso honesto "Pronto".
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CitasShell } from "../src/verticals/citas/CitasShell.tsx";
import type { BranchOption } from "../src/verticals/citas/lib/admin-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/citas/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/citas/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});
vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const RUTA = "https://api.test/citas/prop-1/chat-datos";
let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  fetchBranchesMock.mockReset();
  vi.unstubAllGlobals();
});

type Llamada = { url: string; init: RequestInit | undefined };

function stubFetch(estado: () => Response | Promise<Response>): Llamada[] {
  const calls: Llamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === `${RUTA}/estado`) return estado();
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}
const siEsta = () => new Response(JSON.stringify({ available: true }), { status: 200, headers: { "content-type": "application/json" } });

async function renderCitas(rol = "owner"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.citas.session", JSON.stringify({ token: "tok-c", refreshToken: "r", email: "o@example.com", fullName: "O", organizations: [{ id: "o", slug: "demo", nombre: "Demo", vertical: "citas", rol }] }));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Sucursal Centro" }]);
  const r = renderComponent(
    <MemoryRouter>
      <CitasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </CitasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

const botonesChat = (): HTMLElement[] => [...document.body.querySelectorAll("a, button")].filter((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLElement[];
const enlaceChat = (): HTMLAnchorElement | undefined => botonesChat().find((e): e is HTMLAnchorElement => e instanceof HTMLAnchorElement);
const entradaCopiloto = (): HTMLAnchorElement | undefined => [...document.body.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Copiloto");

describe("CitasShell — Chatea con tus datos (CHAT-13)", () => {
  it.each(["owner", "admin"])("%s con el asistente activo: consulta /estado de CITAS con el Bearer, el boton es un enlace al Copiloto y no abre dialogo", async (rol) => {
    const calls = stubFetch(siEsta);
    rendered = await renderCitas(rol);
    const estado = calls.find((c) => c.url === `${RUTA}/estado`);
    expect(estado).toBeDefined();
    expect((estado!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-c");
    expect(enlaceChat()?.getAttribute("href")).toBe("/citas/demo/copiloto");
    expect(botonesChat().some((b) => b.textContent?.includes("Pronto"))).toBe(false);
    expect(entradaCopiloto()?.getAttribute("href")).toBe("/citas/demo/copiloto");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  it("staff: no hay boton 'Chatea con tus datos', ni entrada 'Copiloto' en el menu, ni se consulta /estado", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 403 }));
    rendered = await renderCitas("staff");
    expect(botonesChat()).toHaveLength(0);
    expect(entradaCopiloto()).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/chat-datos"))).toBe(false);
  });

  it("owner con el asistente sin proveedor (available=false), 500 o servidor caido: SIGUE el aviso honesto 'Pronto' (boton, nunca enlace)", async () => {
    for (const estado of [
      () => new Response(JSON.stringify({ available: false }), { status: 200 }),
      () => new Response("{}", { status: 500 }),
      () => Promise.reject(new TypeError("offline")),
    ]) {
      stubFetch(estado);
      rendered = await renderCitas("owner");
      expect(enlaceChat()).toBeUndefined();
      expect(botonesChat()[0]!.textContent).toContain("Pronto");
      click(botonesChat()[0]!);
      expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("todavía no está disponible");
      expect(document.body.querySelector('[role="dialog"] textarea, [role="dialog"] input')).toBeNull();
      rendered.unmount();
      rendered = undefined;
      document.body.innerHTML = "";
      vi.unstubAllGlobals();
    }
  });
});
