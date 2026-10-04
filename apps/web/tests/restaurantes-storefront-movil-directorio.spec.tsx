// @vitest-environment jsdom
//
// Storefront en el telefono (barra inferior con contador, hoja del carrito, categorias con salto, buscador local) y
// directorio publico de sucursales (/pedir/:org/sucursales) con insignias. Red simulada: nunca la base real.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { filtrarMenu, totalArticulos } from "../src/verticals/restaurantes/storefront/carrito.ts";
import { enlaceTel, lineasHorario, textoDias } from "../src/verticals/restaurantes/storefront/horario-texto.ts";
import { insigniasDe } from "../src/verticals/restaurantes/storefront/SucursalesPage.tsx";
import type { CategoriaMenu, SucursalDirectorio } from "../src/verticals/restaurantes/storefront/storefront-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const SUCURSAL = { slug: "centro", name: "Centro", address: "Calle 1 #100", phone: null, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, zonasReparto: [] as string[] };
const item = (id: string, name: string, price: number, description: string | null = null) => ({ id, name, description, price, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false });
const CATEGORIAS: CategoriaMenu[] = [
  { id: "c1", name: "Tacos", items: [item("t1", "Tacos de cochinita", 120, "Con cebolla morada"), item("t2", "Tacos de bistec", 130)] },
  { id: "c2", name: "Bebidas", items: [item("b1", "Horchata", 40), item("b2", "Jamón en agua", 50)] },
];
const MENU = { sucursal: SUCURSAL, categorias: CATEGORIAS };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function esperar(): Promise<void> {
  return act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function renderEn(ruta: string): RenderedComponent {
  window.history.pushState({}, "", ruta);
  return renderComponent(<App />);
}
const q = <T extends Element>(sel: string, raiz: ParentNode = document): T => raiz.querySelector<T>(sel) as T;
const botonPorTexto = (texto: string, raiz: ParentNode = document.body) => Array.from(raiz.querySelectorAll("button")).find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

/** Simula una pantalla de 375 px: ninguna consulta min-width: 1024px coincide. */
function simularTelefono() {
  vi.stubGlobal("matchMedia", (consulta: string) => ({ matches: false, media: consulta, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  globalThis.sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("logica pura: buscador local, contador y horario", () => {
  it("filtrarMenu busca por nombre y descripcion, sin acentos ni mayusculas, y quita categorias vacias", () => {
    expect(filtrarMenu(CATEGORIAS, "").length).toBe(2);
    expect(filtrarMenu(CATEGORIAS, "JAMON").map((c) => c.name)).toEqual(["Bebidas"]);
    expect(filtrarMenu(CATEGORIAS, "cebolla morada").flatMap((c) => c.items.map((i) => i.id))).toEqual(["t1"]);
    expect(filtrarMenu(CATEGORIAS, "tacos bistec").flatMap((c) => c.items.map((i) => i.id))).toEqual(["t2"]);
    expect(filtrarMenu(CATEGORIAS, "pizza")).toEqual([]);
  });

  it("totalArticulos suma cantidades", () => {
    expect(totalArticulos([])).toBe(0);
    expect(totalArticulos([{ producto: CATEGORIAS[0]!.items[0]!, cantidad: 2, tortilla: null }, { producto: CATEGORIAS[1]!.items[0]!, cantidad: 3, tortilla: null }])).toBe(5);
  });

  it("textoDias, lineasHorario y enlaceTel", () => {
    expect(textoDias([1, 2, 3, 4, 5])).toBe("lun-vie");
    expect(textoDias([5, 6, 0])).toBe("vie-dom");
    expect(textoDias([1, 3])).toBe("lun, mié");
    expect(textoDias([0, 1, 2, 3, 4, 5, 6])).toBe("todos los días");
    expect(lineasHorario([{ dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "01:00" }])).toEqual(["lun-vie · 12:00 a 01:00 (cierra después de medianoche)"]);
    expect(lineasHorario(null)).toEqual([]);
    expect(enlaceTel("+52 999 123 4567")).toBe("tel:+529991234567");
    expect(enlaceTel("123")).toBeNull();
    expect(enlaceTel(null)).toBeNull();
  });
});

describe("storefront en el telefono (375 px)", () => {
  beforeEach(() => {
    simularTelefono();
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/menu") ? json(MENU) : json({}, 404)));
  });

  it("sin productos no hay barra; al agregar aparece con contador y total, y se actualiza", async () => {
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    expect(document.querySelector("aside")).toBeNull();
    expect(botonPorTexto("Ver pedido")).toBeUndefined();
    act(() => click(q('button[aria-label="Agregar Horchata al carrito"]')));
    expect(document.body.textContent).toContain("1 producto");
    expect(document.body.textContent).toContain("$40");
    act(() => click(q('button[aria-label="Agregar Horchata al carrito"]')));
    act(() => click(q('button[aria-label="Agregar Tacos de bistec al carrito"]')));
    expect(document.body.textContent).toContain("3 productos");
    expect(document.body.textContent).toContain("$210");
  });

  it("'Ver pedido' abre la hoja inferior (dialogo accesible con foco dentro) y Esc la cierra", async () => {
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Horchata al carrito"]')));
    act(() => click(botonPorTexto("Ver pedido")!));
    await esperar();
    const dialogo = q<HTMLElement>('[role="dialog"]');
    expect(dialogo).not.toBeNull();
    expect(dialogo.textContent).toContain("Tu pedido");
    expect(dialogo.textContent).toContain("Horchata");
    expect(dialogo.contains(document.activeElement)).toBe(true);
    // El formulario de checkout vive en la hoja.
    expect(dialogo.querySelector('input[name="canal"][value="recoger"]')).not.toBeNull();
    act(() => keydown(document.activeElement ?? document.body, "Escape"));
    await esperar();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // El carrito sigue ahi tras cerrar.
    expect(document.body.textContent).toContain("1 producto");
  });

  it("la hoja tiene boton de cierre accesible", async () => {
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Horchata al carrito"]')));
    act(() => click(botonPorTexto("Ver pedido")!));
    await esperar();
    const cerrar = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent?.includes("Cerrar"));
    expect(cerrar).toBeDefined();
    act(() => click(cerrar!));
    await esperar();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("barra de categorias: un boton por categoria y el salto lleva a la seccion", async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    const nav = q<HTMLElement>('nav[aria-label="Categorías del menú"]');
    const botones = Array.from(nav.querySelectorAll("button"));
    expect(botones.map((b) => b.textContent)).toEqual(["Tacos", "Bebidas"]);
    expect(botones[0]!.getAttribute("aria-current")).toBe("true");
    act(() => click(botones[1]!));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(document.getElementById("cat-c2"));
    expect(botones[1]!.getAttribute("aria-current")).toBe("true");
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("buscador: filtra local sin red, muestra vacio honesto y vuelve al menu completo", async () => {
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    const llamadas = fetchMock.mock.calls.length;
    const input = q<HTMLInputElement>("#buscar-menu");
    act(() => changeValue(input, "jamon"));
    expect(document.body.textContent).toContain("Jamón en agua");
    expect(document.body.textContent).not.toContain("Tacos de bistec");
    act(() => changeValue(input, "pizza"));
    expect(document.body.textContent).toContain("Sin resultados");
    act(() => changeValue(input, ""));
    expect(document.body.textContent).toContain("Tacos de bistec");
    expect(fetchMock.mock.calls.length).toBe(llamadas);
  });

  it("sucursal solo-recoger: domicilio deshabilitado con el motivo", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/menu") ? json({ ...MENU, sucursal: { ...SUCURSAL, aceptaDomicilio: false } }) : json({}, 404)));
    rendered = renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Horchata al carrito"]')));
    act(() => click(botonPorTexto("Ver pedido")!));
    await esperar();
    const dom = q<HTMLInputElement>('[role="dialog"] input[name="canal"][value="domicilio"]');
    expect(dom.disabled).toBe(true);
    expect(q<HTMLElement>('[role="dialog"]').textContent).toContain("solo atiende pedidos para recoger");
  });
});

describe("directorio publico de sucursales", () => {
  const base: SucursalDirectorio = { slug: "a", name: "A", address: "Calle 1", phone: null, horario: null, abiertoAhora: null, pideEnLinea: true, soloRecoger: false, insigniaDomicilio: null, deTemporada: false, soloInformativa: false, comoLlegarUrl: null };
  const DIRECTORIO = {
    restaurante: { slug: "demo", nombre: "Los Taquitos" },
    sucursales: [
      { ...base, slug: "pensiones", name: "Pensiones", address: "Calle 7 #1", phone: "+52 999 123 4567", horario: [{ dias: [1, 2, 3, 4, 5, 6, 0], abre: "12:00", cierra: "22:00" }], insigniaDomicilio: "Domicilio vie-dom", comoLlegarUrl: "https://www.google.com/maps/search/?api=1&query=Pensiones" },
      { ...base, slug: "chicxulub", name: "Chicxulub", soloRecoger: true, deTemporada: true },
      { ...base, slug: "galerias", name: "Galerías", pideEnLinea: false, soloInformativa: true },
    ],
  };

  it("insigniasDe: una por caracteristica, sin inventar", () => {
    expect(insigniasDe(DIRECTORIO.sucursales[0]!).map((i) => i.texto)).toEqual(["Pide en línea", "Domicilio vie-dom"]);
    expect(insigniasDe(DIRECTORIO.sucursales[1]!).map((i) => i.texto)).toEqual(["Pide en línea", "Solo recoger", "Temporada"]);
    expect(insigniasDe(DIRECTORIO.sucursales[2]!).map((i) => i.texto)).toEqual(["Solo informativa"]);
  });

  it("lista todas las visibles con direccion, horario, tel: y Como llegar; solo las activas llevan a pedir", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/directorio") ? json(DIRECTORIO) : json({}, 404)));
    rendered = renderEn("/pedir/demo/sucursales");
    await esperar();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8787/v1/restaurantes/demo/storefront/directorio");
    const texto = rendered.container.textContent ?? "";
    for (const n of ["Pensiones", "Chicxulub", "Galerías", "Calle 7 #1", "lun-dom"]) {
      if (n === "lun-dom") continue;
      expect(texto).toContain(n);
    }
    expect(texto).toContain("todos los días · 12:00 a 22:00");
    expect(texto).toContain("Domicilio vie-dom");
    expect(texto).toContain("Solo recoger");
    expect(texto).toContain("Temporada");
    expect(texto).toContain("Solo informativa");
    expect(q<HTMLAnchorElement>('a[href="tel:+529991234567"]')).not.toBeNull();
    expect(q<HTMLAnchorElement>('a[href^="https://www.google.com/maps/search/"]').getAttribute("rel")).toBe("noreferrer");
    const pedir = Array.from(rendered.container.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.textContent?.startsWith("Pedir en"));
    expect(pedir.map((a) => a.getAttribute("href"))).toEqual(["/pedir/demo/pensiones", "/pedir/demo/chicxulub"]);
    // Galerias no tiene horario ni direccion publicados: texto honesto, no inventado.
    expect(texto).toContain("Consulte el horario con la sucursal.");
  });

  it("error del servidor: estado de error con reintento; vacio: mensaje honesto", async () => {
    fetchMock.mockImplementation(async () => json({ message: "Restaurante no encontrado." }, 404));
    rendered = renderEn("/pedir/demo/sucursales");
    await esperar();
    expect(rendered.container.textContent).toContain("Restaurante no encontrado.");
    expect(botonPorTexto("Reintentar")).toBeDefined();
    rendered.unmount();
    fetchMock.mockImplementation(async () => json({ restaurante: { slug: "demo", nombre: "X" }, sucursales: [] }));
    rendered = renderEn("/pedir/demo/sucursales");
    await esperar();
    expect(rendered.container.textContent).toContain("Sin sucursales publicadas");
  });
});
