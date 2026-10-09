// @vitest-environment jsdom
//
// QA R1 restaurantes botones-11 (mismo patron que citas-ruta-404-shell): una ruta desconocida bajo
// `/restaurantes/:orgSlug/` se resuelve DENTRO del shell de restaurantes (la navegacion sigue
// ahi y hay enlace al resumen); sin sesion redirige al login de restaurantes, y
// `/restaurantes/login/...` no se confunde con un negocio llamado "login".
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
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "restaurantes", rol: "owner" }],
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
  await esperarRutaCargada(rendered.container);
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return rendered.container;
}

describe("restaurantes — 404 dentro del shell (QA-restaurantes-R1-botones-11)", () => {
  it("con sesion: conserva la navegacion y ofrece volver al resumen", async () => {
    storage.setItem("atiende.restaurantes.session", JSON.stringify(SESSION));
    const c = await renderEn("/restaurantes/demo/pedidoss");
    expect(c.textContent).toContain("Página no encontrada");
    expect(c.querySelector('aside[aria-label="Navegación principal"]')).not.toBeNull();
    const volver = [...c.querySelectorAll("a")].find((a) => a.textContent === "Volver al resumen")!;
    expect(volver.getAttribute("href")).toBe("/restaurantes/demo");
  });

  it("sin sesion redirige al login de restaurantes en vez de mostrar el 404", async () => {
    await renderEn("/restaurantes/demo/pedidoss");
    expect(window.location.pathname).toBe("/restaurantes/login");
  });

  it("/restaurantes/login/algo no se trata como un negocio: cae al 404 global", async () => {
    storage.setItem("atiende.restaurantes.session", JSON.stringify(SESSION));
    const c = await renderEn("/restaurantes/login/algo");
    expect(c.querySelector("h1")?.textContent).toBe("No encontramos esta página");
  });
});

describe("restaurantes — selector de sucursal (QA-restaurantes-R1-botones-03)", () => {
  it("con dos sucursales no hay ids duplicados y cada select tiene su propia etiqueta", async () => {
    storage.setItem("atiende.restaurantes.session", JSON.stringify(SESSION));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/admin/branches") || String(url).includes("/admin/sucursales")) {
          return new Response(JSON.stringify({ branches: [{ propertyId: "p1", name: "Centro" }, { propertyId: "p2", name: "Norte" }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const c = await renderEn("/restaurantes/demo/pedidoss");
    const selects = [...c.querySelectorAll("[role='combobox']")].filter((s) => s.id.startsWith("restaurantes-sucursal-activa"));
    expect(selects.map((s) => s.id).sort()).toEqual(["restaurantes-sucursal-activa", "restaurantes-sucursal-activa-movil"]);
    for (const s of selects) {
      expect(c.querySelectorAll(`#${s.id}`)).toHaveLength(1);
      expect(c.querySelector(`label[for="${s.id}"]`)?.textContent).toBe("Sucursal activa");
    }
  });
});
