// @vitest-environment jsdom
//
// import-orig-14 — <ProductosPage /> permite EDITAR un producto (nombre, descripción, precio base, categoría, alias o palabras
// clave y si se vende en la sucursal), renombrar y reordenar categorías, y mantiene lo que ya hacía (marcar popular, alta).
// La API es un doble con estado: PATCH/POST cambian lo que devuelve el siguiente GET, igual que el servidor real.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix, valorDe } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const ADMIN: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "admin", staffFullName: "G", staffEmail: "g@example.com" };
const STAFF: RestaurantesShellContext = { ...ADMIN, role: "staff" };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

interface Cat {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
}
interface Prod {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  isPopular: boolean;
  isAvailable: boolean;
  displayOrder: number;
  searchKeywords: string[];
  branch: { propertyId: string; productId: string; price: number; isAvailable: boolean; agotadoHasta?: string | null } | null;
}
interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function productoBase(over: Partial<Prod> = {}): Prod {
  return {
    id: "p1",
    categoryId: "c1",
    categoryName: "Tacos",
    name: "Taco dorado",
    description: "Tres piezas",
    price: 60,
    imageUrl: null,
    isPopular: false,
    isAvailable: true,
    displayOrder: 0,
    searchKeywords: ["flautas"],
    branch: { propertyId: "prop-1", productId: "p1", price: 65, isAvailable: true },
    ...over,
  };
}

interface Mundo {
  categorias: Cat[];
  productos: Prod[];
  /** Fallos a inyectar por "METODO url-sufijo" -> status (una sola vez). */
  fallos?: Map<string, number>;
}

function mundoBase(): Mundo {
  return {
    categorias: [
      { id: "c1", name: "Tacos", slug: "tacos", displayOrder: 0 },
      { id: "c2", name: "Bebidas", slug: "bebidas", displayOrder: 1 },
      { id: "c3", name: "Postres", slug: "postres", displayOrder: 2 },
    ],
    productos: [productoBase(), productoBase({ id: "p2", categoryId: "c2", categoryName: "Bebidas", name: "Horchata", description: null, price: 30, searchKeywords: [], branch: null })],
  };
}

function stubApi(mundo: Mundo, calls: Call[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      const clave = [...(mundo.fallos?.keys() ?? [])].find((k) => k.startsWith(`${method} `) && url.endsWith(k.slice(method.length + 1)));
      if (clave) {
        const status = mundo.fallos!.get(clave)!;
        mundo.fallos!.delete(clave);
        return json({ message: "El servidor dijo que no." }, status);
      }
      if (url === `${BASE}/categories` && method === "GET") return json({ categories: structuredClone(mundo.categorias) });
      if (url === `${BASE}/products` && method === "GET") return json({ products: structuredClone(mundo.productos) });
      if (url === `${BASE}/config/no-domicilio`) return json({ message: "no disponible" }, 503);
      const cat = url.match(/\/admin\/categories\/([^/]+)$/);
      if (cat && method === "PATCH") {
        const c = mundo.categorias.find((x) => x.id === cat[1])!;
        Object.assign(c, body);
        mundo.categorias.sort((a, b) => a.displayOrder - b.displayOrder);
        return json({ category: c });
      }
      const suc = url.match(/\/admin\/products\/([^/]+)\/branch-availability$/);
      if (suc && method === "PATCH") {
        const p = mundo.productos.find((x) => x.id === suc[1])!;
        p.branch = { propertyId: "prop-1", productId: p.id, price: p.branch?.price ?? p.price, isAvailable: body!.isAvailable as boolean };
        return json({ branch: p.branch });
      }
      const prod = url.match(/\/admin\/products\/([^/]+)$/);
      if (prod && method === "PATCH") {
        const p = mundo.productos.find((x) => x.id === prod[1])!;
        Object.assign(p, body);
        if ("categoryId" in body!) p.categoryName = mundo.categorias.find((c) => c.id === body!.categoryId)?.name ?? null;
        return json({ product: p });
      }
      if (url === `${BASE}/products` && method === "POST") {
        const nuevo = productoBase({ id: "p9", name: body!.name as string, price: body!.price as number, description: (body!.description as string | undefined) ?? null, searchKeywords: (body!.searchKeywords as string[] | undefined) ?? [], branch: null });
        mundo.productos.push(nuevo);
        return json({ product: nuevo }, 201);
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await flushMicrotasks();
  });
}

async function montar(ctx: RestaurantesShellContext, mundo: Mundo, calls: Call[]) {
  stubApi(mundo, calls);
  rendered = renderComponent(<ProductosPage {...ctx} />);
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as T | null;
const porEtiqueta = (texto: string) => q(`[aria-label="${texto}"]`) as HTMLElement;
const dialogo = () => q('[role="dialog"]');
const campo = (etiqueta: string) => {
  const label = [...(dialogo()?.querySelectorAll("label") ?? [])].find((l) => l.textContent?.trim().startsWith(etiqueta));
  return dialogo()!.querySelector(`#${label!.getAttribute("for")}`) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
};
const botonGuardar = () => [...(dialogo()?.querySelectorAll("button") ?? [])].find((b) => /Guardar/.test(b.textContent ?? "")) as HTMLButtonElement;
const escritas = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

async function abrirEditar(nombre: string) {
  await act(async () => {
    click(porEtiqueta(`Editar ${nombre}`));
    await flushMicrotasks();
  });
}
async function guardar() {
  await act(async () => {
    click(botonGuardar());
    for (let i = 0; i < 30; i += 1) await flushMicrotasks();
  });
}

describe("ProductosPage — editar producto", () => {
  it("abre el diálogo con los datos reales del producto y sus alias como fichas", async () => {
    await montar(ADMIN, mundoBase(), []);
    await abrirEditar("Taco dorado");
    expect(dialogo()).not.toBeNull();
    expect(campo("Nombre").value).toBe("Taco dorado");
    expect(campo("Descripción").value).toBe("Tres piezas");
    expect(campo("Precio base").value).toBe("60");
    expect(valorDe(campo("Categoría"))).toBe("c1");
    expect(q('[aria-label="Alias del producto"]')?.textContent).toContain("flautas");
    expect(q('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("guarda nombre, descripción, categoría y alias en un solo PATCH con SOLO lo que cambió, y refresca la tabla", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");

    changeValue(campo("Nombre"), "Flauta dorada");
    changeValue(campo("Descripción"), "Tres flautas crujientes");
    elegirValor(campo("Categoría"), "c3");
    const alias = q<HTMLInputElement>('input[placeholder^="Escribe un alias"]')!;
    changeValue(alias, "Taquitos Dorados, FLAUTAS");
    keydown(alias, "Enter");
    await guardar();

    expect(escritas(calls)).toEqual([
      {
        method: "PATCH",
        url: `${BASE}/products/p1`,
        body: { name: "Flauta dorada", description: "Tres flautas crujientes", categoryId: "c3", searchKeywords: ["flautas", "taquitos dorados"] },
      },
    ]);
    expect(dialogo()).toBeNull();
    expect(rendered!.container.textContent).toContain("Flauta dorada");
    expect(q('[aria-label="Editar Taco dorado"]')).toBeNull();
  });

  it("Enter en el campo de alias agrega la ficha y NO envía el formulario; las fichas se normalizan, se quitan y no se duplican", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");
    const alias = q<HTMLInputElement>('input[placeholder^="Escribe un alias"]')!;

    changeValue(alias, "  Frijólito  Charro ");
    keydown(alias, "Enter");
    await settle();
    expect(escritas(calls)).toEqual([]);
    expect(dialogo()).not.toBeNull();
    const fichas = () => [...q('[aria-label="Alias del producto"]')!.querySelectorAll("li")].map((li) => li.textContent);
    expect(fichas()).toEqual(["flautas", "frijolito charro"]);

    changeValue(alias, "FLAUTAS");
    keydown(alias, "Enter");
    expect(fichas()).toEqual(["flautas", "frijolito charro"]);

    changeValue(alias, "<script>");
    keydown(alias, "Enter");
    expect(dialogo()!.textContent).toContain("Usa solo letras, números, espacios, punto o guion.");
    expect(fichas()).toEqual(["flautas", "frijolito charro"]);

    click(porEtiqueta("Quitar alias flautas"));
    expect(fichas()).toEqual(["frijolito charro"]);
  });

  it("quitar todos los alias manda searchKeywords: [] (limpia, no ignora)", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");
    click(porEtiqueta("Quitar alias flautas"));
    await guardar();
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p1`, body: { searchKeywords: [] } }]);
  });

  it("desactivar no borra: apaga el producto en la sucursal con el endpoint de disponibilidad y no toca el catálogo", async () => {
    const calls: Call[] = [];
    const mundo = mundoBase();
    await montar(ADMIN, mundo, calls);
    await abrirEditar("Taco dorado");
    click(q('[role="switch"]')!);
    await guardar();

    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p1/branch-availability`, body: { isAvailable: false } }]);
    expect(mundo.productos[0]!.searchKeywords).toEqual(["flautas"]);
    expect(mundo.productos[0]!.description).toBe("Tres piezas");
    expect(dialogo()).toBeNull();
    expect(rendered!.container.textContent).toContain("No disponible");
  });

  it("guardar sin cambios no escribe nada y cierra", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");
    await guardar();
    expect(escritas(calls)).toEqual([]);
    expect(dialogo()).toBeNull();
  });

  it("nombre vacío o precio vacío marcan el campo y no mandan nada", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");
    changeValue(campo("Nombre"), "   ");
    // (un valor negativo lo frena el propio navegador por `min=0`; vacío sí llega a la validación de la pantalla)
    changeValue(campo("Precio base"), "");
    await guardar();
    expect(escritas(calls)).toEqual([]);
    expect(dialogo()!.textContent).toContain("Escribe el nombre del producto.");
    expect(dialogo()!.textContent).toContain("Escribe un precio base válido (0 o más).");
  });

  it("si el servidor rechaza, el error se ve DENTRO del diálogo, que sigue abierto con lo escrito", async () => {
    const calls: Call[] = [];
    const mundo = mundoBase();
    mundo.fallos = new Map([["PATCH /products/p1", 403]]);
    await montar(ADMIN, mundo, calls);
    await abrirEditar("Taco dorado");
    changeValue(campo("Nombre"), "Otro nombre");
    await guardar();

    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("El servidor dijo que no.");
    expect(campo("Nombre").value).toBe("Otro nombre");
    expect(botonGuardar().disabled).toBe(false);
    // Reintentar funciona (el fallo era de una sola vez).
    await guardar();
    expect(dialogo()).toBeNull();
    expect(mundo.productos[0]!.name).toBe("Otro nombre");
  });

  it("guardado parcial: si el catálogo se guardó pero la disponibilidad falló, lo dice y refresca el catálogo de fondo", async () => {
    const calls: Call[] = [];
    const mundo = mundoBase();
    mundo.fallos = new Map([["PATCH /products/p1/branch-availability", 409]]);
    await montar(ADMIN, mundo, calls);
    await abrirEditar("Taco dorado");
    changeValue(campo("Nombre"), "Flauta dorada");
    click(q('[role="switch"]')!);
    await guardar();

    expect(dialogo()!.textContent).toContain("Se guardaron los datos del producto, pero no se pudo cambiar su disponibilidad en esta sucursal");
    expect(rendered!.container.textContent).toContain("Flauta dorada");
  });

  it("un producto nunca dado de alta en la sucursal se abre apagado y se puede encender desde el diálogo", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Horchata");
    expect(q('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    click(q('[role="switch"]')!);
    await guardar();
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p2/branch-availability`, body: { isAvailable: true } }]);
  });

  it("cada apertura parte de los datos reales: lo escrito y cancelado no se arrastra al siguiente producto", async () => {
    await montar(ADMIN, mundoBase(), []);
    await abrirEditar("Taco dorado");
    changeValue(campo("Nombre"), "Basura sin guardar");
    await act(async () => {
      keydown(dialogo()!, "Escape");
      await flushMicrotasks();
    });
    await abrirEditar("Horchata");
    expect(campo("Nombre").value).toBe("Horchata");
    expect(campo("Descripción").value).toBe("");
  });
});

describe("ProductosPage — agotado «solo por hoy» y «Dejar de venderlo»", () => {
  function mundoAgotado(): Mundo {
    const m = mundoBase();
    m.productos[0]!.branch = { propertyId: "prop-1", productId: "p1", price: 65, isAvailable: false, agotadoHasta: "2026-10-08" };
    return m;
  }
  const botonDejar = () => [...(dialogo()?.querySelectorAll("button") ?? [])].find((b) => /Dejar de venderlo/.test(b.textContent ?? ""));

  it("un producto agotado hasta mañana lo dice en el diálogo y ofrece «Dejar de venderlo»", async () => {
    await montar(ADMIN, mundoAgotado(), []);
    await abrirEditar("Taco dorado");
    expect(dialogo()!.textContent).toContain("Agotado hasta el 2026-10-08: vuelve a la venta solo.");
    expect(botonDejar()).toBeDefined();
  });

  it("guardar sin pulsar nada NO cambia la reposición; «Dejar de venderlo» manda isAvailable:false y avisa que ya no volverá solo", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoAgotado(), calls);
    await abrirEditar("Taco dorado");
    await guardar();
    expect(escritas(calls)).toEqual([]);

    await abrirEditar("Taco dorado");
    click(botonDejar()!);
    expect(dialogo()!.textContent).toContain("Se dejará de vender: no volverá solo a la venta.");
    expect(botonDejar()).toBeUndefined();
    await guardar();
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p1/branch-availability`, body: { isAvailable: false } }]);
  });

  it("si lo enciende en vez de dejarlo de vender, manda isAvailable:true y no queda la marca de «dejar»", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoAgotado(), calls);
    await abrirEditar("Taco dorado");
    click(botonDejar()!);
    click(q('[role="switch"]')!);
    await guardar();
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p1/branch-availability`, body: { isAvailable: true } }]);
  });

  it("base sin la 050 (sin agotadoHasta): ni aviso ni botón", async () => {
    await montar(ADMIN, mundoBase(), []);
    await abrirEditar("Taco dorado");
    expect(dialogo()!.textContent).not.toContain("Agotado hasta");
    expect(botonDejar()).toBeUndefined();
  });
});

describe("ProductosPage — alias a medio escribir", () => {
  it("Guardar con texto en el campo de alias (válido o no) NO lo pierde en silencio: avisa y no guarda", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await abrirEditar("Taco dorado");
    changeValue(campo("Nombre"), "Otro");
    changeValue(q<HTMLInputElement>('input[placeholder^="Escribe un alias"]')!, "<script>");
    await guardar();
    expect(escritas(calls)).toEqual([]);
    expect(dialogo()!.textContent).toContain("Tienes un alias sin agregar («<script>»)");
    expect(q<HTMLInputElement>('input[placeholder^="Escribe un alias"]')!.value).toBe("<script>");
  });
});

describe("ProductosPage — permisos por rol", () => {
  it("el staff (cajero/cocina) no ve Editar, ni reordenar, ni renombrar; sí ve las categorías como fichas y el aviso", async () => {
    await montar(STAFF, mundoBase(), []);
    expect(q('[aria-label^="Editar "]')).toBeNull();
    expect(q('[aria-label^="Subir "]')).toBeNull();
    expect(q('[aria-label^="Renombrar "]')).toBeNull();
    expect(rendered!.container.textContent).toContain("Tacos");
    expect(rendered!.container.textContent).toContain("Solo el dueño o un administrador cambia precios y edita el catálogo.");
  });

  it("el admin sí ve los controles de edición", async () => {
    await montar(ADMIN, mundoBase(), []);
    expect(porEtiqueta("Editar Taco dorado")).not.toBeNull();
    expect(porEtiqueta("Renombrar Tacos")).not.toBeNull();
    expect(porEtiqueta("Subir Bebidas")).not.toBeNull();
  });
});

describe("ProductosPage — categorías: renombrar y reordenar", () => {
  it("renombrar manda solo el nombre (el slug no cambia) y refresca", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await act(async () => {
      click(porEtiqueta("Renombrar Bebidas"));
      await flushMicrotasks();
    });
    expect(campo("Nombre").value).toBe("Bebidas");
    changeValue(campo("Nombre"), "Bebidas y aguas");
    await guardar();
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/categories/c2`, body: { name: "Bebidas y aguas" } }]);
    expect(rendered!.container.textContent).toContain("Bebidas y aguas");
  });

  it("renombrar con nombre vacío no manda nada; un error del servidor queda dentro del diálogo", async () => {
    const calls: Call[] = [];
    const mundo = mundoBase();
    mundo.fallos = new Map([["PATCH /categories/c2", 400]]);
    await montar(ADMIN, mundo, calls);
    await act(async () => {
      click(porEtiqueta("Renombrar Bebidas"));
      await flushMicrotasks();
    });
    changeValue(campo("Nombre"), "  ");
    await guardar();
    expect(escritas(calls)).toEqual([]);
    expect(dialogo()!.textContent).toContain("Escribe el nombre de la categoría.");
    changeValue(campo("Nombre"), "Aguas");
    await guardar();
    expect(dialogo()!.textContent).toContain("El servidor dijo que no.");
  });

  it("subir una categoría intercambia posiciones: solo se escriben las que cambian de número, y el orden se ve", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    await act(async () => {
      click(porEtiqueta("Subir Bebidas"));
      for (let i = 0; i < 30; i += 1) await flushMicrotasks();
    });
    expect(escritas(calls)).toEqual([
      { method: "PATCH", url: `${BASE}/categories/c2`, body: { displayOrder: 0 } },
      { method: "PATCH", url: `${BASE}/categories/c1`, body: { displayOrder: 1 } },
    ]);
    const nombres = [...rendered!.container.querySelectorAll('[aria-label="Orden de las categorías"] li')].map((li) => li.textContent);
    expect(nombres[0]).toContain("Bebidas");
    expect(nombres[1]).toContain("Tacos");
  });

  it("con órdenes repetidos (todas en 0, como deja el alta) mover una las numera de forma única", async () => {
    const mundo = mundoBase();
    mundo.categorias.forEach((c) => (c.displayOrder = 0));
    const calls: Call[] = [];
    await montar(ADMIN, mundo, calls);
    await act(async () => {
      click(porEtiqueta("Bajar Tacos"));
      for (let i = 0; i < 8; i += 1) await flushMicrotasks();
    });
    expect(escritas(calls).map((c) => [c.url.split("/").pop(), c.body])).toEqual([
      // Bebidas (c2) ya tenía 0: queda en la posición 0 sin escribirse; solo cambian Tacos y Postres.
      ["c1", { displayOrder: 1 }],
      ["c3", { displayOrder: 2 }],
    ]);
  });

  it("los extremos no se mueven: la primera no sube y la última no baja", async () => {
    await montar(ADMIN, mundoBase(), []);
    expect((porEtiqueta("Subir Tacos") as HTMLButtonElement).disabled).toBe(true);
    expect((porEtiqueta("Bajar Postres") as HTMLButtonElement).disabled).toBe(true);
  });

  it("si un reordenamiento falla a medias muestra el error y vuelve a leer el orden real", async () => {
    const calls: Call[] = [];
    const mundo = mundoBase();
    mundo.fallos = new Map([["PATCH /categories/c1", 500]]);
    await montar(ADMIN, mundo, calls);
    await act(async () => {
      click(porEtiqueta("Subir Bebidas"));
      for (let i = 0; i < 30; i += 1) await flushMicrotasks();
    });
    expect(rendered!.container.textContent).toContain("El servidor dijo que no.");
    // Releyó categorías y productos tras el fallo.
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/categories`).length).toBeGreaterThanOrEqual(2);
  });

  it("sin categorías, el admin ve un vacío explicado (no una tarjeta en blanco)", async () => {
    const mundo = mundoBase();
    mundo.categorias = [];
    mundo.productos = [];
    await montar(ADMIN, mundo, []);
    expect(rendered!.container.textContent).toContain("Todavía no hay categorías.");
    expect(rendered!.container.textContent).toContain("Sin productos");
  });

  it("sin categorías, el staff no ve la tarjeta de categorías", async () => {
    const mundo = mundoBase();
    mundo.categorias = [];
    await montar(STAFF, mundo, []);
    expect(rendered!.container.textContent).not.toContain("Todavía no hay categorías.");
  });
});

describe("ProductosPage — regresión: lo que ya hacía", () => {
  it("marcar popular sigue mandando SOLO isPopular", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    const popular = q<HTMLInputElement>('input[aria-label="Marcar Taco dorado como popular"]')!;
    await act(async () => {
      click(popular);
      for (let i = 0; i < 6; i += 1) await flushMicrotasks();
    });
    expect(escritas(calls)).toEqual([{ method: "PATCH", url: `${BASE}/products/p1`, body: { isPopular: true } }]);
  });

  it("el alta ahora manda descripción y alias, y sin ellos no manda las claves", async () => {
    const calls: Call[] = [];
    await montar(ADMIN, mundoBase(), calls);
    const nuevo = [...rendered!.container.querySelectorAll("button")].find((b) => /Nuevo producto/.test(b.textContent ?? ""))!;
    await act(async () => {
      click(nuevo);
      await flushMicrotasks();
    });
    changeValue(campo("Nombre"), "Sopa de lima");
    changeValue(campo("Precio base"), "85");
    changeValue(campo("Descripción"), "Con tortilla frita");
    const alias = q<HTMLInputElement>('input[placeholder^="Escribe un alias"]')!;
    changeValue(alias, "Sopa Yucateca");
    keydown(alias, "Enter");
    await act(async () => {
      click([...dialogo()!.querySelectorAll("button")].find((b) => /Crear producto/.test(b.textContent ?? ""))!);
      for (let i = 0; i < 8; i += 1) await flushMicrotasks();
    });
    expect(escritas(calls)[0]).toEqual({
      method: "POST",
      url: `${BASE}/products`,
      body: { name: "Sopa de lima", price: 85, categoryId: null, description: "Con tortilla frita", searchKeywords: ["sopa yucateca"] },
    });
  });

  it("si el catálogo no carga, muestra el error con reintento", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Servidor caído." }, 500)));
    rendered = renderComponent(<ProductosPage {...ADMIN} />);
    await settle();
    expect(rendered.container.textContent).toContain("Servidor caído.");
  });
});
