// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en los shells de RENTAS (dialogo) y HOTELES (CHAT-09: enlace a la pagina del Copiloto) sin reescribirlos: el boton del header sale de
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
  { nombre: "RentasShell", render: renderRentas, rolPermitido: "admin_gestora", ruta: "rentas" },
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
