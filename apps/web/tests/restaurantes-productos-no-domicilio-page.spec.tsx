// @vitest-environment jsdom
//
// Marcas "no se vende a domicilio" (modelo PM, migración 023) en <ProductosPage />: se ven y se
// cambian por producto y por categoría; si la API de marcas no está disponible (base sin migrar
// o sin permiso) los controles se ocultan en vez de mostrar un estado falso.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "admin", staffFullName: "G", staffEmail: "g@example.com" };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";
const CATEGORIAS = [{ id: "c1", name: "Cervezas", slug: "cervezas", displayOrder: 0 }];
const PRODUCTOS = [
  { id: "p1", categoryId: "c1", categoryName: "Cervezas", name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: { propertyId: "prop-1", productId: "p1", price: 66, isAvailable: true } },
  { id: "p2", categoryId: null, categoryName: null, name: "Taco", description: null, price: 42, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 1, searchKeywords: [], branch: null },
];

function stub(marks: { productIds: string[]; categoryIds: string[] } | "no-disponible", calls: Array<{ method: string; url: string; body?: unknown }>) {
  let current = marks === "no-disponible" ? null : { ...marks };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === `${BASE}/categories`) return json({ categories: CATEGORIAS });
      if (url === `${BASE}/products`) return json({ products: PRODUCTOS });
      if (url === `${BASE}/config/no-domicilio` && method === "GET") return current ? json(current) : json({ message: "no disponible" }, 503);
      const put = url.match(/\/config\/no-domicilio\/(productos|categorias)\/([^/]+)$/);
      if (put && method === "PUT" && current) {
        const { noDomicilio } = JSON.parse(init!.body as string) as { noDomicilio: boolean };
        const key = put[1] === "productos" ? "productIds" : "categoryIds";
        current = { ...current, [key]: noDomicilio ? [...current[key], put[2]!] : current[key].filter((id) => id !== put[2]) };
        return json({ id: put[2], noDomicilio });
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();
  });
}

describe("ProductosPage — marcas no_domicilio", () => {
  it("muestra las marcas reales y marcar un producto manda PUT y refresca", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub({ productIds: [], categoryIds: ["c1"] }, calls);
    rendered = renderComponent(<ProductosPage {...CTX} />);
    await settle();

    const cat = rendered.container.querySelector('input[aria-label="Cervezas: no se vende a domicilio"]') as HTMLInputElement;
    const sol = rendered.container.querySelector('input[aria-label="Sol: no se vende a domicilio"]') as HTMLInputElement;
    expect(cat.checked).toBe(true);
    expect(sol.checked).toBe(false);

    await act(async () => {
      click(sol);
      for (let i = 0; i < 6; i += 1) await flushMicrotasks();
    });
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: `${BASE}/config/no-domicilio/productos/p1`, body: { noDomicilio: true } });
    expect((rendered.container.querySelector('input[aria-label="Sol: no se vende a domicilio"]') as HTMLInputElement).checked).toBe(true);
  });

  it("desmarcar una categoria manda noDomicilio:false", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub({ productIds: [], categoryIds: ["c1"] }, calls);
    rendered = renderComponent(<ProductosPage {...CTX} />);
    await settle();
    await act(async () => {
      click(rendered!.container.querySelector('input[aria-label="Cervezas: no se vende a domicilio"]')!);
      for (let i = 0; i < 6; i += 1) await flushMicrotasks();
    });
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: `${BASE}/config/no-domicilio/categorias/c1`, body: { noDomicilio: false } });
  });

  it("para staff las marcas se ven pero estan deshabilitadas (solo owner/admin editan el catalogo)", async () => {
    stub({ productIds: [], categoryIds: ["c1"] }, []);
    rendered = renderComponent(<ProductosPage {...CTX} role="staff" />);
    await settle();
    const cat = rendered.container.querySelector('input[aria-label="Cervezas: no se vende a domicilio"]') as HTMLInputElement;
    const sol = rendered.container.querySelector('input[aria-label="Sol: no se vende a domicilio"]') as HTMLInputElement;
    expect(cat.disabled).toBe(true);
    expect(sol.disabled).toBe(true);
  });

  it("si las marcas no estan disponibles (503) el catalogo sigue funcionando y los controles se ocultan", async () => {
    stub("no-disponible", []);
    rendered = renderComponent(<ProductosPage {...CTX} />);
    await settle();
    expect(rendered.container.textContent).toContain("Sol");
    expect(rendered.container.querySelector('input[aria-label$="no se vende a domicilio"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("No a domicilio");
  });
});
