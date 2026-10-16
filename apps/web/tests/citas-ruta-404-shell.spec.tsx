// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux (4.6.7): una ruta desconocida bajo
// `/citas/:orgSlug/` se resuelve DENTRO del shell de citas (la navegacion sigue
// ahi y hay enlace a la agenda); sin sesion redirige al login de citas, y
// `/citas/login/...` no se confunde con un negocio llamado "login".
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { esperarRutaCargada, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SESSION = {
  token: "tok",
  refreshToken: "ref",
  email: "staff@example.com",
  fullName: "Staff",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "citas", rol: "owner" }],
};

let rendered: RenderedComponent | undefined;
let storage: Storage;

beforeEach(() => {
  installMatchMediaStub();
  storage = installMemoryLocalStorage();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/admin/branches")) return new Response(JSON.stringify({ branches: [{ propertyId: "p1", name: "Centro" }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

async function renderEn(ruta: string): Promise<HTMLElement> {
  window.history.pushState({}, "", ruta);
  rendered = renderComponent(<App />);
  await esperarRutaCargada(rendered!.container);
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return rendered.container;
}

describe("citas — 404 dentro del shell", () => {
  it("con sesion: conserva la navegacion y ofrece volver a la agenda", async () => {
    storage.setItem("atiende.citas.session", JSON.stringify(SESSION));
    const c = await renderEn("/citas/demo/ruta-que-no-existe");
    expect(c.textContent).toContain("Página no encontrada");
    expect(c.querySelector('aside[aria-label="Navegación principal"]')).not.toBeNull();
    const volver = [...c.querySelectorAll("a")].find((a) => a.textContent === "Volver a la agenda")!;
    expect(volver.getAttribute("href")).toBe("/citas/demo/agenda");
    // Sin item activo la barra (y la fila movil) conservan el titulo de la consola; ya no hay migas.
    expect(c.querySelector('[data-testid="barra-pagina-titulo"]')!.textContent).toBe("Citas · demo");
    expect(c.querySelector('[data-testid="mobile-pagina-titulo"]')!.textContent).toBe("Citas · demo");
  });

  it("sin sesion redirige al login de citas en vez de mostrar el 404", async () => {
    await renderEn("/citas/demo/ruta-que-no-existe");
    expect(window.location.pathname).toBe("/citas/login");
  });

  it("/citas/login/algo no se trata como un negocio: cae al 404 global", async () => {
    storage.setItem("atiende.citas.session", JSON.stringify(SESSION));
    const c = await renderEn("/citas/login/algo");
    expect(c.querySelector("h1")?.textContent).toBe("No encontramos esta página");
  });
});
