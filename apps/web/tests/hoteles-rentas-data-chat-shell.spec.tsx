// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en los shells de HOTELES (dialogo) y RENTAS (CHAT-10: enlace a la pagina del Copiloto) sin reescribirlos: el boton del header sale de
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

/** El boton del header de ESCRITORIO (el del menu movil solo existe con la hoja abierta). */
function botonChat(): HTMLButtonElement {
  // Con el shell unico (VerticalShell) el primer `div.hidden.md:block` es la envoltura del Sidebar: se busca la del header.
  const desktop = [...rendered!.container.querySelectorAll("div.hidden.md\\:block")].find((d) => d.querySelector("header"))!;
  return [...desktop.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement;
}

describe.each([
  { nombre: "HotelesShell", render: renderHoteles, rolPermitido: "owner", ruta: "hoteles" },
])("$nombre — Chatea con tus datos", ({ render, rolPermitido, ruta }) => {
  it("con el asistente activo: sin 'Pronto', abre la conversacion real y manda SOLO la pregunta a la ruta de la propiedad activa", async () => {
    const calls = stubFetch(() => json(200, { available: true }));
    await render(rolPermitido);
    expect(calls.some((c) => c.url === `https://api.test/${ruta}/prop-1/chat-datos/estado`)).toBe(true);
    expect(botonChat().textContent).not.toContain("Pronto");

    click(botonChat());
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const input = dialogo.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "¿Cómo voy este mes?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (dialogo.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe(`https://api.test/${ruta}/prop-1/chat-datos`);
    expect(Object.keys(JSON.parse(post.init!.body as string)).sort()).toEqual(["history", "question"]);
    expect(JSON.parse(post.init!.body as string).question).toBe("¿Cómo voy este mes?");
    expect(dialogo.textContent).toContain("Listo.");
    expect(dialogo.textContent).toContain("Fuente: Fuente de prueba");
  });

  it("rol sin acceso (el servidor responde 403 en /estado): sigue 'Pronto' y el aviso honesto, nunca una conversacion", async () => {
    stubFetch(() => json(403, {}));
    await render("housekeeping");
    expect(botonChat().textContent).toContain("Pronto");
    click(botonChat());
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("todavía no está disponible");
    expect(dialogo.querySelector("input")).toBeNull();
  });

  it("asistente sin proveedor (available=false) o servidor caido: sigue 'Pronto'", async () => {
    stubFetch(() => json(200, { available: false }));
    await render(rolPermitido);
    expect(botonChat().textContent).toContain("Pronto");
    rendered!.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await render(rolPermitido);
    expect(botonChat().textContent).toContain("Pronto");
  });
});

// CHAT-10: en RENTAS el boton del header es un ENLACE a la pagina del Copiloto (ya no abre el dialogo) y solo existe para
// admin_gestora/contador; los demas roles no lo ven (el servidor igual responde 403). Sin confirmacion del servidor sigue
// siendo el aviso honesto "Pronto" (solo para un rol permitido).
function enlaceChatRentas(): HTMLAnchorElement | undefined {
  const desktop = [...rendered!.container.querySelectorAll("div.hidden.md\\:block")].find((d) => d.querySelector("header"))!;
  return [...desktop.querySelectorAll("a")].find((a) => a.textContent?.includes("Chatea con tus datos")) as HTMLAnchorElement | undefined;
}
function botonProntoRentas(): HTMLButtonElement | undefined {
  const desktop = [...rendered!.container.querySelectorAll("div.hidden.md\\:block")].find((d) => d.querySelector("header"))!;
  return [...desktop.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement | undefined;
}

describe("RentasShell — Chatea con tus datos (CHAT-10)", () => {
  it.each(["admin_gestora", "contador"])("%s con el asistente activo: el boton es un enlace a /rentas/:org/copiloto y no abre dialogo", async (rol) => {
    const calls = stubFetch(() => json(200, { available: true }));
    await renderRentas(rol);
    expect(calls.some((c) => c.url === "https://api.test/rentas/prop-1/chat-datos/estado")).toBe(true);
    const enlace = enlaceChatRentas();
    expect(enlace?.getAttribute("href")).toBe("/rentas/demo/copiloto");
    expect(enlace?.textContent).not.toContain("Pronto");
    click(enlace!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  it.each(["operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "limpieza", "housekeeping"])(
    "%s no ve el boton ni consulta /estado (el servidor responde 403 de todas formas)",
    async (rol) => {
      const calls = stubFetch(() => json(403, {}));
      await renderRentas(rol);
      expect(enlaceChatRentas()).toBeUndefined();
      expect(botonProntoRentas()).toBeUndefined();
      expect(calls.filter((c) => c.url.endsWith("/chat-datos/estado"))).toHaveLength(0);
    },
  );

  it("asistente sin proveedor (available=false) o servidor caido: un rol permitido ve 'Pronto' y el aviso honesto, nunca una conversacion", async () => {
    stubFetch(() => json(200, { available: false }));
    await renderRentas("admin_gestora");
    expect(enlaceChatRentas()).toBeUndefined();
    expect(botonProntoRentas()?.textContent).toContain("Pronto");
    click(botonProntoRentas()!);
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
    expect(botonProntoRentas()?.textContent).toContain("Pronto");
  });
});
