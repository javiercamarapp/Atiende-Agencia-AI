// @vitest-environment jsdom
//
// UNI-C.2 (restaurantes): las altas de Staff ("Invitar a alguien") y de Productos ("Nueva categoria" /
// "Nuevo producto") salen de la pagina y viven en un FormDialog abierto desde el CTA de cabecera, con
// FormField (etiqueta real, error por campo). Revocar una invitacion pide confirmacion con useConfirm.
// Se afirma contra el `fetch` real de cada cliente: el dialogo abre, los campos vacios NO escriben,
// Cancelar/Escape NO escriben y guardar manda exactamente la misma llamada de antes.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "../src/verticals/restaurantes/pages/Staff.tsx";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Sam", staffEmail: "sam@example.com" };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

function stub(extra: (method: string, url: string, body: unknown) => Response | null) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const r = extra(method, url, body);
    if (r) return r;
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await flushMicrotasks();
  });
}

const escrituras = () => fetchMock.mock.calls.filter(([, init]) => ["POST", "PATCH", "PUT", "DELETE"].includes((init as RequestInit | undefined)?.method ?? "GET"));
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const boton = (root: ParentNode, texto: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;

async function enviar(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i += 1) await flushMicrotasks();
  });
}

describe("Staff (restaurantes) — invitar con FormDialog", () => {
  const INVITACION = { id: "inv-1", email: "nueva@example.com", verticalRole: "staff", status: "pending", expiresAt: "2026-10-30T00:00:00.000Z" };

  function stubStaff() {
    stub((method, url, body) => {
      if (method === "GET" && url === `${BASE}/staff/repartidores`) return json({ repartidores: [] });
      if (method === "GET" && url === `${BASE}/staff/invitaciones`) return json({ invitations: [INVITACION] });
      if (method === "GET" && url === `${BASE}/staff/miembros`) return json({ miembros: [] });
      if (method === "POST" && url === `${BASE}/staff/invitaciones`) return json({ id: "inv-2", email: (body as { email: string }).email, verticalRole: (body as { verticalRole: string }).verticalRole, status: "pending", expiresAt: "2026-10-30T00:00:00.000Z", inviteToken: "TOKEN-UNICO" });
      if (method === "DELETE" && url === `${BASE}/staff/invitaciones/inv-1`) return json({ ok: true });
      return null;
    });
  }

  async function montar() {
    stubStaff();
    rendered = renderComponent(
      <MemoryRouter>
        <StaffPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
  }

  it("el formulario de alta ya no esta siempre abierto: el CTA de cabecera abre un dialogo con Correo y Rol etiquetados", async () => {
    await montar();
    expect(dialogo()).toBeNull();
    expect(rendered!.container.querySelector("#staff-invitar-correo")).toBeNull();
    click(boton(rendered!.container, "Invitar a alguien")!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    const etiquetas = [...dialogo()!.querySelectorAll("label")].map((l) => l.textContent?.replace(/\s+/g, " ").trim());
    expect(etiquetas.some((t) => t?.startsWith("Correo"))).toBe(true);
    expect(etiquetas).toContain("Rol");
  });

  it("con el correo vacio marca el campo y NO manda el POST", async () => {
    await montar();
    click(boton(rendered!.container, "Invitar a alguien")!);
    await esperar();
    await enviar(dialogo()!.querySelector("form")!);
    expect(dialogo()!.textContent).toContain("Escribe el correo de la persona a invitar.");
    expect(escrituras()).toHaveLength(0);
  });

  it("Escape cierra el dialogo sin escribir", async () => {
    await montar();
    click(boton(rendered!.container, "Invitar a alguien")!);
    await esperar();
    await act(async () => {
      keydown(dialogo()!, "Escape");
      for (let i = 0; i < 6; i += 1) await flushMicrotasks();
    });
    expect(dialogo()).toBeNull();
    expect(escrituras()).toHaveLength(0);
  });

  it("guardar manda POST .../staff/invitaciones con el correo en minusculas y el rol, cierra el dialogo y muestra el token una vez", async () => {
    await montar();
    click(boton(rendered!.container, "Invitar a alguien")!);
    await esperar();
    const correo = dialogo()!.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async () => {
      changeValue(correo, "  Ana@Example.COM ");
      await flushMicrotasks();
    });
    await enviar(dialogo()!.querySelector("form")!);
    const posts = escrituras().filter(([, init]) => (init as RequestInit).method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0]![1] as RequestInit).body as string)).toEqual({ email: "ana@example.com", verticalRole: "staff" });
    expect(dialogo()).toBeNull();
    expect(rendered!.container.textContent).toContain("TOKEN-UNICO");
  });

  it("Revocar pide confirmacion: Cancelar no escribe y Revocar manda el DELETE", async () => {
    await montar();
    click(boton(rendered!.container, "Revocar")!);
    await esperar();
    const alerta = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(alerta().textContent).toContain("Revocar la invitación de nueva@example.com");
    click(boton(alerta(), "Cancelar")!);
    await esperar();
    expect(escrituras()).toHaveLength(0);
    click(boton(rendered!.container, "Revocar")!);
    await esperar();
    click(boton(alerta(), "Revocar")!);
    await esperar();
    expect(escrituras()).toHaveLength(1);
    expect((escrituras()[0]![1] as RequestInit).method).toBe("DELETE");
    expect(escrituras()[0]![0]).toBe(`${BASE}/staff/invitaciones/inv-1`);
  });
});

describe("Productos (restaurantes) — altas con FormDialog", () => {
  const CATEGORIAS = [{ id: "c1", name: "Cervezas", slug: "cervezas", displayOrder: 0 }];

  async function montar() {
    stub((method, url, body) => {
      if (method === "GET" && url === `${BASE}/categories`) return json({ categories: CATEGORIAS });
      if (method === "GET" && url === `${BASE}/products`) return json({ products: [] });
      if (method === "GET" && url === `${BASE}/config/no-domicilio`) return json({ message: "no disponible" }, 503);
      if (method === "POST" && url === `${BASE}/products`) return json({ product: { id: "p9", categoryId: null, categoryName: null, name: (body as { name: string }).name, description: null, price: (body as { price: number }).price, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: null } });
      if (method === "POST" && url === `${BASE}/categories`) return json({ category: { id: "c2", name: (body as { name: string }).name, slug: (body as { slug: string }).slug, displayOrder: 1 } });
      return null;
    });
    rendered = renderComponent(<ProductosPage {...CTX} />);
    await esperar();
  }

  it("las dos altas viven en dialogos abiertos desde la cabecera, con etiquetas reales", async () => {
    await montar();
    expect(dialogo()).toBeNull();
    click(boton(rendered!.container, "Nuevo producto")!);
    await esperar();
    const etiquetas = [...dialogo()!.querySelectorAll("label")].map((l) => l.textContent?.replace(/\s+/g, " ").trim() ?? "");
    expect(etiquetas.some((t) => t.startsWith("Nombre"))).toBe(true);
    expect(etiquetas.some((t) => t.startsWith("Precio base"))).toBe(true);
    expect(etiquetas).toContain("Categoría");
  });

  it("producto sin nombre ni precio valido: marca los campos y NO escribe", async () => {
    await montar();
    click(boton(rendered!.container, "Nuevo producto")!);
    await esperar();
    await enviar(dialogo()!.querySelector("form")!);
    expect(dialogo()!.textContent).toContain("Escribe el nombre del producto.");
    expect(dialogo()!.textContent).toContain("Escribe un precio base válido (0 o más).");
    expect(escrituras()).toHaveLength(0);
  });

  it("producto valido manda POST .../products y cierra el dialogo", async () => {
    await montar();
    click(boton(rendered!.container, "Nuevo producto")!);
    await esperar();
    const [nombre, precio] = [...dialogo()!.querySelectorAll("input")] as HTMLInputElement[];
    await act(async () => {
      changeValue(nombre!, " Flan ");
      changeValue(precio!, "45.5");
      await flushMicrotasks();
    });
    await enviar(dialogo()!.querySelector("form")!);
    const posts = escrituras();
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(`${BASE}/products`);
    expect(JSON.parse((posts[0]![1] as RequestInit).body as string)).toEqual({ name: "Flan", price: 45.5, categoryId: null });
    expect(dialogo()).toBeNull();
  });

  it("categoria sin slug: marca el campo y NO escribe; valida manda POST .../categories", async () => {
    await montar();
    click(boton(rendered!.container, "Nueva categoría")!);
    await esperar();
    const [nombre, slug] = [...dialogo()!.querySelectorAll("input")] as HTMLInputElement[];
    await act(async () => {
      changeValue(nombre!, "Postres");
      await flushMicrotasks();
    });
    await enviar(dialogo()!.querySelector("form")!);
    expect(dialogo()!.textContent).toContain("Escribe el slug de la categoría.");
    expect(escrituras()).toHaveLength(0);
    await act(async () => {
      changeValue(slug!, "postres");
      await flushMicrotasks();
    });
    await enviar(dialogo()!.querySelector("form")!);
    expect(escrituras()).toHaveLength(1);
    expect(JSON.parse((escrituras()[0]![1] as RequestInit).body as string)).toEqual({ name: "Postres", slug: "postres" });
  });
});
