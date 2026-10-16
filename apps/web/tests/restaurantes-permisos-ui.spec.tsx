// @vitest-environment jsdom
//
// PL-23 -- el panel de restaurantes lee el rol de la sesion y oculta lo que el servidor rechazaria: el staff (cajero/cocina) ve el
// menu y marca agotado/disponible pero no ve edicion de precio ni altas; promociones y edicion de sucursal no aparecen para staff.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import { PromocionesPage } from "../src/verticals/restaurantes/pages/Promociones.tsx";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const ctx = (role: string): RestaurantesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "G", staffEmail: "g@example.com" });
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";
const PRODUCTOS = [
  { id: "p1", categoryId: null, categoryName: null, name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: { propertyId: "prop-1", productId: "p1", price: 70, isAvailable: true } },
  { id: "p2", categoryId: null, categoryName: null, name: "Taco", description: null, price: 42, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 1, searchKeywords: [], branch: null },
];
const SUCURSAL = { propertyId: "prop-1", name: "Sucursal Centro", slug: "centro", status: "active", phone: "5511112222", address: "Av. Reforma 123", lat: null, lng: null };

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await flushMicrotasks();
  });
}

function stubCatalogo(calls: Array<{ method: string; url: string; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === `${BASE}/categories`) return json({ categories: [] });
      if (url === `${BASE}/products` && method === "GET") return json({ products: PRODUCTOS });
      if (url === `${BASE}/config/no-domicilio`) return json({ message: "no disponible" }, 503);
      if (url === `${BASE}/products/p1/branch-availability` && method === "PATCH") return json({ branch: { propertyId: "prop-1", productId: "p1", price: 70, isAvailable: false } });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

const botones = (c: HTMLElement) => [...c.querySelectorAll("button")];

describe("PL-23 UI -- Productos", () => {
  it("staff: ve el menu y el precio como texto, sin alta, sin edicion de precio, y marca agotado mandando SOLO isAvailable", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stubCatalogo(calls);
    rendered = renderComponent(<ProductosPage {...ctx("staff")} />);
    await settle();
    const c = rendered.container;
    expect(c.textContent).toContain("Sol");
    expect(c.textContent).toContain("Solo el dueño o un administrador cambia precios");
    expect(botones(c).some((b) => /Nuevo producto|Nueva categoría/.test(b.textContent ?? ""))).toBe(false);
    expect(c.querySelector('input[aria-label^="Precio de"]')).toBeNull();
    expect((c.querySelector('input[aria-label="Marcar Sol como popular"]') as HTMLInputElement).disabled).toBe(true);

    const toggles = botones(c).filter((b) => /^(Disponible|No disponible)$/.test(b.textContent ?? ""));
    expect(toggles).toHaveLength(2);
    expect(toggles[1]!.disabled).toBe(true); // Taco: nunca dado de alta en la sucursal -> solo un administrador lo activa
    await act(async () => {
      click(toggles[0]!);
      for (let i = 0; i < 8; i += 1) await flushMicrotasks();
    });
    const patch = calls.find((x) => x.method === "PATCH");
    expect(patch).toMatchObject({ url: `${BASE}/products/p1/branch-availability`, body: { isAvailable: false } });
    expect(Object.keys(patch!.body as object)).toEqual(["isAvailable"]);
  });

  it("owner/admin: ven las altas y editan el precio por sucursal", async () => {
    for (const role of ["owner", "admin"]) {
      stubCatalogo([]);
      rendered = renderComponent(<ProductosPage {...ctx(role)} />);
      await settle();
      const c = rendered.container;
      expect(botones(c).some((b) => /Nuevo producto/.test(b.textContent ?? ""))).toBe(true);
      expect(botones(c).some((b) => /Nueva categoría/.test(b.textContent ?? ""))).toBe(true);
      expect(c.querySelectorAll('input[aria-label^="Precio de"]')).toHaveLength(2);
      expect((c.querySelector('input[aria-label="Marcar Sol como popular"]') as HTMLInputElement).disabled).toBe(false);
      rendered.unmount();
      rendered = undefined;
    }
  });
});

describe("PL-23 UI -- Promociones y Sucursales", () => {
  it("staff en Promociones: estado honesto y NINGUNA llamada a la API", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("no debe llamar a la API");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(
      <MemoryRouter>
        <PromocionesPage {...ctx("staff")} />
      </MemoryRouter>,
    );
    await settle();
    expect(rendered.container.textContent).toContain("Solo el dueño o un administrador puede ver y gestionar las promociones");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("staff en Sucursales: ve los datos pero no el boton Editar; admin si", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${BASE}/sucursales`) return json({ branches: [SUCURSAL] });
        throw new Error(`fetch inesperado ${url}`);
      }),
    );
    rendered = renderComponent(
      <MemoryRouter>
        <SucursalesPage {...ctx("staff")} />
      </MemoryRouter>,
    );
    await settle();
    expect(rendered.container.textContent).toContain("Av. Reforma 123");
    expect(rendered.container.textContent).toContain("Solo el dueño o un administrador puede editar los datos de la sucursal");
    expect(botones(rendered.container).some((b) => b.textContent?.includes("Editar"))).toBe(false);
    rendered.unmount();

    rendered = renderComponent(
      <MemoryRouter>
        <SucursalesPage {...ctx("admin")} />
      </MemoryRouter>,
    );
    await settle();
    expect(botones(rendered.container).some((b) => b.textContent?.includes("Editar"))).toBe(true);
  });
});
