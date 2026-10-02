// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en los shells de HOTELES (CHAT-09) y RENTAS (CHAT-10): enlace a la pagina del Copiloto sin reescribirlos: el boton del header sale de
// "Pronto" solo cuando el servidor confirma (GET .../chat-datos/estado) que el asistente esta activo para ese rol, abre la
// conversacion real y manda SOLO la pregunta a la ruta de la propiedad activa. Si el servidor no lo confirma (403 por rol,
// proveedor sin configurar, error), sigue el aviso honesto de siempre.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { HotelesShell } from "../src/verticals/hoteles/HotelesShell.tsx";
import { RentasShell } from "../src/verticals/rentas/RentasShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchHotelesMock = vi.fn();
const fetchRentasMock = vi.fn();

vi.mock("../src/verticals/hoteles/lib/discovery-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/hoteles/lib/discovery-client.ts")>();
  return { ...actual, fetchProperties: (...args: unknown[]) => fetchHotelesMock(...args) };
});
vi.mock("../src/verticals/rentas/lib/discovery-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/rentas/lib/discovery-client.ts")>();
  return { ...actual, fetchProperties: (...args: unknown[]) => fetchRentasMock(...args) };
});
vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (vertical: string, rol: string) => ({
  token: "tok",
  refreshToken: "reftok",
  email: "staff@example.com",
  fullName: "Staff Demo",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical, rol }],
});

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fetchHotelesMock.mockReset();
  fetchRentasMock.mockReset();
  vi.unstubAllGlobals();
});

/** `fetch` global del navegador: responde /estado y el POST del chat; registra cada llamada. */
function stubFetch(estado: () => Response, respuesta?: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/chat-datos/estado")) return estado();
      if (String(url).endsWith("/chat-datos")) return json(200, respuesta ?? { status: "ok", text: "Listo.", blocks: [], sources: [{ source: "Fuente de prueba", scopeLabel: "todos tus hoteles" }], toolsUsed: [] });
      return json(404, {});
    }),
  );
  return calls;
}

async function renderHoteles(rol: string) {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.hoteles.session", JSON.stringify(session("hoteles", rol)));
  fetchHotelesMock.mockResolvedValue([{ propertyId: "prop-1", nombre: "Hotel Centro" }]);
  rendered = renderComponent(
    <MemoryRouter>
      <HotelesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </HotelesShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function renderRentas(rol: string) {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.rentas.session", JSON.stringify(session("rentas", rol)));
  fetchRentasMock.mockResolvedValue([{ propertyId: "prop-1", nombre: "Casas de Playa" }]);
  rendered = renderComponent(
    <MemoryRouter>
      <RentasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </RentasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

// CHAT-10: en rentas el Copiloto es una PAGINA (/rentas/:org/copiloto), solo admin_gestora/contador (FINANZAS_LECTURA_ROLES del servidor).
// Con el asistente activo el boton del header es un enlace (ya no abre el dialogo); los roles que el servidor rechaza (403) no ven el
// boton ni consultan /estado; sin confirmacion del servidor un rol permitido ve el aviso honesto "Pronto" (boton, nunca enlace).
describe("RentasShell — Chatea con tus datos (CHAT-10)", () => {
  const enlaceChat = () => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes("Chatea con tus datos"));
  const textoChat = () => [...rendered!.container.querySelectorAll("a, button")].filter((e) => e.textContent?.includes("Chatea con tus datos"));

  it.each(["admin_gestora", "contador"])("%s con el asistente activo: el boton es un enlace a /rentas/:org/copiloto y no abre dialogo", async (rol) => {
    const calls = stubFetch(() => json(200, { available: true }));
    await renderRentas(rol);
    expect(calls.some((c) => c.url === "https://api.test/rentas/prop-1/chat-datos/estado")).toBe(true);
    expect(enlaceChat()?.getAttribute("href")).toBe("/rentas/demo/copiloto");
    expect(enlaceChat()?.textContent).not.toContain("Pronto");
    click(enlaceChat()!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  it.each(["operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "limpieza", "housekeeping"])(
    "%s: no hay boton 'Chatea con tus datos' ni se consulta /estado (el servidor responde 403 de todas formas)",
    async (rol) => {
      const calls = stubFetch(() => json(403, {}));
      await renderRentas(rol);
      expect(textoChat()).toHaveLength(0);
      expect(calls.some((c) => c.url.includes("/chat-datos"))).toBe(false);
    },
  );

  it("admin_gestora con asistente sin proveedor (available=false) o servidor caido: sigue 'Pronto' y el aviso honesto, nunca una conversacion", async () => {
    stubFetch(() => json(200, { available: false }));
    await renderRentas("admin_gestora");
    expect(enlaceChat()).toBeUndefined();
    expect(textoChat()[0]?.textContent).toContain("Pronto");
    click(textoChat()[0]!);
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("todavía no está disponible");
    expect(dialogo.querySelector("input")).toBeNull();
    rendered!.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await renderRentas("contador");
    expect(enlaceChat()).toBeUndefined();
    expect(textoChat()[0]?.textContent).toContain("Pronto");
  });
});

// CHAT-09: en hoteles el Copiloto es una PAGINA (/hoteles/:org/copiloto), solo owner/gm. Con el asistente activo el boton del header es un
// enlace (ya no abre el dialogo ni manda la pregunta desde ahi: eso lo cubre hoteles-copiloto-page.spec.tsx). Los roles que el servidor
// rechaza (403) no ven el boton ni consultan /estado: ya no hay "Pronto" para ellos.
describe("HotelesShell — Chatea con tus datos (CHAT-09)", () => {
  const enlaceChat = () => [...rendered!.container.querySelectorAll("a")].find((a) => a.textContent?.includes("Chatea con tus datos"));
  const textoChat = () => [...rendered!.container.querySelectorAll("a, button")].filter((e) => e.textContent?.includes("Chatea con tus datos"));

  it("owner/gm con el asistente activo: el boton es un enlace a la pagina del Copiloto y no abre el dialogo", async () => {
    for (const rol of ["owner", "gm"]) {
      const calls = stubFetch(() => json(200, { available: true }));
      await renderHoteles(rol);
      expect(calls.some((c) => c.url === "https://api.test/hoteles/prop-1/chat-datos/estado")).toBe(true);
      expect(enlaceChat()?.getAttribute("href")).toBe("/hoteles/demo/copiloto");
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
      rendered!.unmount();
      rendered = undefined;
    }
  });

  it("rol sin acceso: no hay boton 'Chatea con tus datos' ni se consulta /estado", async () => {
    const calls = stubFetch(() => json(403, {}));
    await renderHoteles("housekeeping");
    expect(textoChat()).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("/chat-datos"))).toBe(false);
  });

  it("owner con asistente sin proveedor (available=false) o servidor caido: sigue 'Pronto' (boton, nunca enlace)", async () => {
    stubFetch(() => json(200, { available: false }));
    await renderHoteles("owner");
    expect(enlaceChat()).toBeUndefined();
    expect(textoChat()[0]?.textContent).toContain("Pronto");
    rendered!.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await renderHoteles("owner");
    expect(enlaceChat()).toBeUndefined();
    expect(textoChat()[0]?.textContent).toContain("Pronto");
  });
});
