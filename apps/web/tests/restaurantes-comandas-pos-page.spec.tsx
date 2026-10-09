// @vitest-environment jsdom
//
// Pantalla "Comandas al POS" (captura asistida de SoftRestaurant). `fetch` global mockeado por ruta real contra pos-comandas-client.ts:
// estado del POS honesto (sin adaptador real el selector de modo queda deshabilitado), cola con filtros, "Copiar para POS", "Marcar
// capturada" con confirmacion y nota opcional, umbral de aviso por sucursal (owner/admin) y los estados de carga, error y vacio.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { ComandasPosPage } from "../src/verticals/restaurantes/pages/ComandasPos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { ComandaWire, ConfigPosWire } from "../src/verticals/restaurantes/lib/pos-comandas-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const BASE = "https://api.test/v1/restaurantes/prop-1";

const CONFIG_SIN_POS: ConfigPosWire = {
  modo: "apagado",
  disponible: true,
  adaptador: { nombre: "no-configurado", esReal: false },
  umbralCapturaManual: { porOmisionMin: 5, minimo: 1, maximo: 240, disponible: true, porSucursal: { "prop-2": 12 } },
};

const COMANDA: ComandaWire = {
  id: "c1",
  propertyId: "prop-1",
  orderId: "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c01",
  estado: "captura_manual",
  intentos: 5,
  maxIntentos: 5,
  folio: null,
  ultimoError: "rechazada:producto_sin_codigo_pos",
  notaCaptura: null,
  capturadoEn: null,
  creadoEn: new Date(Date.now() - 12 * 60_000).toISOString(),
  totalPedido: 345.5,
  comanda: {
    sucursal: "T1",
    tipo: "recoger",
    cliente: { nombre: "Ana Torres", telefono: "9991112222" },
    formaPago: "efectivo",
    items: [{ codigo: "TAQ-001", cantidad: 2, nombre: "Tacos de bistec", modificadores: [] }],
  },
};

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);
const botones = () => [...rendered!.container.querySelectorAll("button")];
const boton = (texto: string) => botones().find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="alertdialog"]');

interface Respuestas {
  config?: ConfigPosWire | Response;
  comandas?: readonly ComandaWire[] | Response;
  disponible?: boolean;
  sucursales?: unknown;
}

function stub(r: Respuestas = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === `${BASE}/admin/softrestaurant/config` && method === "GET") return r.config instanceof Object && "ok" in r.config ? (r.config as Response) : json(r.config ?? CONFIG_SIN_POS);
    if (url.startsWith(`${BASE}/admin/softrestaurant/comandas?`) && method === "GET") {
      if (r.comandas instanceof Object && "ok" in r.comandas) return r.comandas as Response;
      const lista = (r.comandas as readonly ComandaWire[] | undefined) ?? [COMANDA];
      return json({ disponible: r.disponible ?? true, comandas: lista, resumen: { pendiente: 0, enviada: 0, confirmada: 0, fallida: 0, captura_manual: lista.length, capturada_manual: 0 }, requierenAtencion: lista.length });
    }
    if (url === "https://api.test/v1/restaurantes/demo/admin/branches") return json(r.sucursales ?? { branches: [{ propertyId: "prop-1", name: "Centro", slug: "centro" }, { propertyId: "prop-2", name: "Norte", slug: "norte" }] });
    if (url.endsWith("/capturada") && method === "POST") return json({ comanda: { ...COMANDA, estado: "capturada_manual" } });
    if (url.endsWith("/softrestaurant/config") && method === "PUT") return json({ modo: "apagado" });
    if (url.endsWith("/softrestaurant/umbral-captura-manual") && method === "PUT") return json({ branchId: "prop-1", minutos: 8 });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const llamadas = (metodo: string, fin: string) => fetchMock.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === metodo && String(c[0]).includes(fin));

beforeEach(() => {
  vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ComandasPosPage -- estado del POS", () => {
  it("sin adaptador real: avisa 'SoftRestaurant no conectado: requiere la API del distribuidor' y el selector de modo queda deshabilitado", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(q("[data-testid='pos-no-conectado']")!.textContent).toContain("SoftRestaurant no conectado: requiere la API del distribuidor");
    expect(q("[data-testid='pos-no-conectado']")!.textContent).toContain("409");
    const modo = q("#pos-modo") as HTMLElement;
    expect(modo.disabled).toBe(true);
    expect(q("[data-testid='pos-modo-actual']")!.textContent).toContain("Apagado");
    expect(llamadas("PUT", "/softrestaurant/config")).toHaveLength(0);
  });

  it("con adaptador real el dueño cambia el modo (PUT) y el staff no ve el selector", async () => {
    stub({ config: { ...CONFIG_SIN_POS, adaptador: { nombre: "http", esReal: true } } });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    const modo = q("#pos-modo") as HTMLElement;
    expect(modo.disabled).toBe(false);
    elegirValor(modo, "sombra");
    await esperar();
    expect(JSON.parse(String((llamadas("PUT", "/softrestaurant/config")[0]![1] as RequestInit).body))).toEqual({ modo: "sombra" });
    rendered.unmount();
    stub({ config: { ...CONFIG_SIN_POS, adaptador: { nombre: "http", esReal: true } } });
    rendered = renderComponent(<ComandasPosPage {...CTX} role="staff" />);
    await esperar();
    expect(q("#pos-modo")).toBeNull();
    expect(rendered.container.textContent).toContain("solo lo cambia un dueño o administrador");
  });

  it("sin la migracion 024 dice 'no disponible aun' en vez de una lista vacia fingida", async () => {
    stub({ config: { ...CONFIG_SIN_POS, disponible: false }, comandas: [], disponible: false });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(q("[data-testid='pos-sin-migracion']")!.textContent).toContain("migración 024");
    expect(rendered.container.textContent).toContain("aún no está disponible");
  });

  it("error del servidor: muestra el error con reintentar y no inventa datos", async () => {
    stub({ config: json({ error: "x" }, 500), comandas: json({ error: "x" }, 500) });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo");
    expect(q("[data-testid^='comanda-']")).toBeNull();
  });
});

describe("ComandasPosPage -- cola", () => {
  it("lista la comanda con folio de referencia, telefono enmascarado, codigos POS, total y antiguedad; por defecto pide los 4 estados por atender", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    const url = String(llamadas("GET", "/comandas?")[0]![0]);
    expect(decodeURIComponent(url)).toContain("estado=captura_manual,fallida,pendiente,enviada");
    const tarjeta = q("[data-testid='comanda-c1']")!;
    expect(tarjeta.textContent).toContain("Pedido 6129984C");
    expect(tarjeta.textContent).toContain("Ana Torres");
    expect(tarjeta.textContent).toContain("******2222");
    expect(tarjeta.textContent).not.toContain("9991112222");
    expect(tarjeta.textContent).toContain("TAQ-001");
    expect(tarjeta.textContent).toContain("Total del pedido $345.50");
    expect(tarjeta.textContent).toContain("hace 12 min");
    expect(tarjeta.textContent).toContain("producto_sin_codigo_pos");
    expect(q("[data-testid='estado-c1']")!.textContent).toBe("Capturar a mano");
  });

  it("filtro por estado y por sucursal viajan al servidor", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    const tab = [...rendered.container.querySelectorAll("[role='tab']")].find((t) => t.textContent?.startsWith("Falló")) as HTMLElement;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      tab.focus();
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    elegirValor(q("#pos-sucursal"), "prop-2");
    await esperar();
    const ultima = decodeURIComponent(String(llamadas("GET", "/comandas?").at(-1)![0]));
    expect(ultima).toContain("branchId=prop-2");
  });

  it("'Copiar para POS' copia el texto con los codigos POS al portapapeles", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    click(boton("Copiar para POS")!);
    await esperar();
    const copiado = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(copiado).toContain("COMANDA 6129984C - SUCURSAL T1 - PARA RECOGER");
    expect(copiado).toContain("1. 2 x TAQ-001 (Tacos de bistec)");
  });

  it("'Marcar capturada' pide confirmacion: Volver no llama al API; confirmar manda POST con el folio del POS y refresca", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    click(boton("Marcar capturada")!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    const volver = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Volver")!;
    await act(async () => {
      volver.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(llamadas("POST", "/capturada")).toHaveLength(0);

    click(boton("Marcar capturada")!);
    await esperar();
    const campo = dialogo()!.querySelector("input, textarea") as HTMLInputElement;
    await act(async () => {
      changeValue(campo, "  T1-004512 ");
      await flushMicrotasks();
    });
    const confirmar = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Marcar capturada")!;
    await act(async () => {
      confirmar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const posts = llamadas("POST", "/comandas/c1/capturada");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ nota: "T1-004512" });
  });

  it("una comanda ya confirmada no ofrece 'Marcar capturada'", async () => {
    stub({ comandas: [{ ...COMANDA, estado: "confirmada", folio: "T1-000001" }] });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(boton("Marcar capturada")).toBeUndefined();
    expect(q("[data-testid='comanda-c1']")!.textContent).toContain("Folio del POS: T1-000001");
  });

  it("sin comandas: estado vacio", async () => {
    stub({ comandas: [] });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No hay comandas en este filtro.");
  });
});

describe("ComandasPosPage -- umbral de aviso por sucursal", () => {
  it("owner/admin ven los minutos por sucursal, validan el rango y guardan por PUT", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("12 min");
    const entrada = rendered.container.querySelector<HTMLInputElement>("input[aria-label='Minutos de espera en Centro']")!;
    changeValue(entrada, "0");
    click(botones().filter((b) => b.textContent === "Guardar")[0]!);
    await esperar();
    expect(llamadas("PUT", "/umbral-captura-manual")).toHaveLength(0);
    changeValue(entrada, "8");
    click(botones().filter((b) => b.textContent === "Guardar")[0]!);
    await esperar();
    expect(JSON.parse(String((llamadas("PUT", "/umbral-captura-manual")[0]![1] as RequestInit).body))).toEqual({ branchId: "prop-1", minutos: 8 });
  });

  it("el staff no ve la seccion; sin la migracion 054 dice 'No disponible aun'", async () => {
    stub();
    rendered = renderComponent(<ComandasPosPage {...CTX} role="staff" />);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Aviso de captura manual por sucursal");
    rendered.unmount();
    stub({ config: { ...CONFIG_SIN_POS, umbralCapturaManual: { ...CONFIG_SIN_POS.umbralCapturaManual, disponible: false, porSucursal: {} } } });
    rendered = renderComponent(<ComandasPosPage {...CTX} />);
    await esperar();
    expect(q("[data-testid='umbral-sin-migracion']")!.textContent).toContain("migración 054");
    expect(rendered.container.querySelector("input[aria-label^='Minutos de espera']")).toBeNull();
  });
});
