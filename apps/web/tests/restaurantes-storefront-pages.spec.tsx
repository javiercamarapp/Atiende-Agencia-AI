// @vitest-environment jsdom
//
// R-09: paginas publicas del storefront renderizadas por la App real (rutas /pedir/...), con la red simulada.
// Menu en vivo ("hoy no hay"), carrito con reglas duras, checkout completo cotizar -> confirmar -> crear,
// seguimiento por token (invalido, base sin migrar) y aviso de privacidad. Contrato: lib storefront-client.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { validarFormulario } from "../src/verticals/restaurantes/storefront/SucursalPage.tsx";
import { esperarHasta, esperarRutaCargada, changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const SUCURSAL = { slug: "centro", name: "Centro", address: "Calle 1 #100", phone: null, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: 200, pedidoMinimoRecoger: null, propinaPolitica: "solo_tarjeta", zonasReparto: ["Vista Alegre"] };
const TACOS = { id: "tacos", name: "Tacos de bistec (orden de 3)", description: "Con cebolla", price: 164, imageUrl: null, isPopular: true, available: true, packSize: 3, requiresAdultConfirmation: false, requiresTortilla: true, noDomicilio: false };
const SOL = { id: "sol", name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: true, requiresTortilla: false, noDomicilio: true };
const COCA = { id: "coca", name: "Coca-Cola", description: null, price: 45, imageUrl: null, isPopular: false, available: false, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false };
const MENU = { sucursal: SUCURSAL, categorias: [{ id: "c1", name: "Tacos", items: [TACOS] }, { id: "c2", name: "Bebidas", items: [SOL, COCA] }] };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  // R-37: tras navegar (p. ej. al seguimiento del pedido) la pantalla destino es un chunk lazy.
  await esperarRutaCargada(document.body);
}

async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  return r;
}

const q = <T extends Element>(sel: string): T => rendered!.container.querySelector<T>(sel) as T;
const botonPorTexto = (texto: string, raiz: ParentNode = document.body) => Array.from(raiz.querySelectorAll("button")).find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

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

describe("validarFormulario", () => {
  const ok = { nombre: "Ana", telefono: "999 123 4567", correo: "", direccion: "Calle 1", colonia: "Vista Alegre", notas: "", codigoPromo: "", propina: "", mayorDeEdad: false, promociones: false, acepta: true };
  it("acepta un formulario completo", () => {
    expect(validarFormulario(ok, "domicilio", "efectivo", false, true)).toEqual({});
  });
  it("exige nombre, telefono de 10 digitos, pago y privacidad; alcohol exige mayoria de edad", () => {
    const e = validarFormulario({ ...ok, nombre: " ", telefono: "123", acepta: false }, "recoger", null, true, false);
    expect(Object.keys(e).sort()).toEqual(["acepta", "mayorDeEdad", "nombre", "pago", "telefono"]);
  });
  it("a domicilio exige direccion y colonia; recoger no", () => {
    expect(Object.keys(validarFormulario({ ...ok, direccion: "", colonia: "" }, "domicilio", "efectivo", false, true)).sort()).toEqual(["colonia", "direccion"]);
    expect(validarFormulario({ ...ok, direccion: "", colonia: "" }, "recoger", "efectivo", false, true)).toEqual({});
  });
  it("telefono con +52/521 es valido; correo mal escrito se rechaza; propina negativa se rechaza", () => {
    expect(validarFormulario({ ...ok, telefono: "+52 1 999 123 4567" }, "domicilio", "efectivo", false, true)).toEqual({});
    expect(validarFormulario({ ...ok, correo: "ana@", propina: "-5" }, "domicilio", "tarjeta", false, true)).toMatchObject({ correo: expect.any(String), propina: expect.any(String) });
  });
});

describe("menu de la sucursal", () => {
  beforeEach(() => fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/menu") ? json(MENU) : json({}, 404))));

  it("muestra categorias, precios de la sucursal, 'Hoy no hay' deshabilitado y las notas de reglas duras", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Tacos de bistec (orden de 3)");
    expect(texto).toContain("$164");
    expect(texto).toContain("Orden de 3 piezas");
    expect(texto).toContain("Solo para recoger");
    expect(texto).toContain("Solo mayores de edad");
    expect(texto).toContain("Hoy no hay");
    expect(botonPorTexto("Agregar", q<HTMLElement>("main"))).toBeDefined();
    const botonCoca = q<HTMLButtonElement>('button[aria-label="Agregar Coca-Cola al carrito"]');
    expect(botonCoca.disabled).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8787/v1/restaurantes/demo/storefront/centro/menu");
  });

  it("los tacos exigen tortilla antes de poder agregarse", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    const agregar = q<HTMLButtonElement>('button[aria-label="Agregar Tacos de bistec (orden de 3) al carrito"]');
    expect(agregar.disabled).toBe(true);
    const select = q<HTMLSelectElement>('select[aria-label="Tortilla para Tacos de bistec (orden de 3)"]');
    act(() => changeValue(select, "maiz"));
    expect(agregar.disabled).toBe(false);
    act(() => click(agregar));
    expect(q("aside").textContent).toContain("Tacos de bistec (orden de 3) (tortilla maiz)");
  });

  it("carrito mixto a domicilio: el alcohol bloquea el envio con el mensaje; al recoger se habilita", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Sol al carrito"]')));
    const enviar = botonPorTexto("Revisar pedido", q("aside"))!;
    expect(enviar.disabled).toBe(false);
    const domicilio = q<HTMLInputElement>('input[name="canal"][value="domicilio"]');
    act(() => click(domicilio));
    expect(q("aside").textContent).toContain("Sol no se vende a domicilio");
    expect(botonPorTexto("Revisar pedido", q("aside"))!.disabled).toBe(true);
    act(() => click(q('input[name="canal"][value="recoger"]')));
    expect(botonPorTexto("Revisar pedido", q("aside"))!.disabled).toBe(false);
  });

  it("a domicilio bajo el minimo de $200 se avisa el faltante y no se puede enviar", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    act(() => changeValue(q<HTMLSelectElement>('select[aria-label^="Tortilla para"]'), "maiz"));
    act(() => click(q('button[aria-label^="Agregar Tacos"]')));
    act(() => click(q('input[name="canal"][value="domicilio"]')));
    expect(q("aside").textContent).toContain("Te faltan $36");
    expect(botonPorTexto("Revisar pedido", q("aside"))!.disabled).toBe(true);
  });

  it("propina solo aparece con tarjeta y el codigo de promocion solo al recoger", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    expect(q("aside").textContent).toContain("Código de promoción");
    expect(q("aside").textContent).not.toContain("Propina");
    act(() => click(q('input[name="pago"][value="efectivo"]')));
    expect(q("aside").textContent).not.toContain("Propina");
    act(() => click(q('input[name="pago"][value="tarjeta"]')));
    expect(q("aside").textContent).toContain("Propina");
    act(() => click(q('input[name="canal"][value="domicilio"]')));
    expect(q("aside").textContent).not.toContain("Código de promoción");
  });

  it("a11y: cada campo tiene etiqueta asociada y los botones del carrito nombre accesible", async () => {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    const campos = Array.from(rendered.container.querySelectorAll<HTMLElement>("aside input:not([type=radio]):not([type=checkbox]), aside textarea, aside select"));
    expect(campos.length).toBeGreaterThan(3);
    for (const c of campos) {
      expect(rendered.container.querySelector(`label[for="${c.id}"]`), c.outerHTML).not.toBeNull();
    }
    expect(rendered.container.querySelectorAll("aside fieldset legend").length).toBeGreaterThanOrEqual(2);
    expect(rendered.container.querySelector("h1")).not.toBeNull();
    expect(rendered.container.querySelector("a[href='#contenido']")).not.toBeNull();
  });

  it("error de carga: estado de error con reintento", async () => {
    fetchMock.mockImplementation(async () => json({ message: "Sucursal no encontrada." }, 404));
    rendered = await renderEn("/pedir/demo/inexistente");
    await esperar();
    expect(rendered.container.textContent).toContain("Sucursal no encontrada.");
    expect(botonPorTexto("Reintentar")).toBeDefined();
  });
});

describe("checkout completo", () => {
  it("revisar -> confirmar -> crear: usa los totales del servidor, navega al seguimiento por token y no pone datos personales en la URL", async () => {
    const llamadas: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      llamadas.push({ url: String(url), body });
      if (String(url).endsWith("/menu")) return json(MENU);
      if (String(url).endsWith("/quote")) return json({ quote: { lines: [{ product_id: "sol", name: "Sol", price: 66, quantity: 1, tortilla: null, line_total: 66 }], total: 66, contains_alcohol: true }, quote_hash: "a".repeat(32), promo: null });
      if (String(url).endsWith("/confirm")) return json({ confirmado: true });
      if (String(url).endsWith("/orders")) return json({ rastreo_token: "t1.abc.def", estado: "pending", total: 66, canal: "recoger" });
      if (String(url).includes("/track/")) return json({ disponible: true, pedido: { status: "preparando", branch: "Centro", total: 66, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-09-30T20:00:00Z", items: [{ name: "Sol", quantity: 1, tortilla: null }] } });
      return json({}, 404);
    });
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Sol al carrito"]')));
    act(() => click(q('input[name="pago"][value="efectivo"]')));
    const aside = q<HTMLElement>("aside");
    const campo = (label: string) => aside.querySelector<HTMLInputElement>(`#${(Array.from(aside.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement).htmlFor}`)!;
    act(() => changeValue(campo("Nombre"), "Ana Pérez"));
    act(() => changeValue(campo("Teléfono"), "999 123 4567"));
    act(() => click(aside.querySelector<HTMLInputElement>("input[type=checkbox]:not([id*=none])")!)); // mayoria de edad
    const checks = aside.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    act(() => click(checks[checks.length - 1]!)); // privacidad (siempre el ultimo; antes va la casilla opcional de promociones)
    await act(async () => submitForm(aside.querySelector("form")!));
    await esperar();
    const cot = llamadas.find((l) => l.url.endsWith("/quote"))!;
    expect(cot.body).toMatchObject({ canal: "recoger", payment_method: "efectivo", adult_confirmed: true, items: [{ product_id: "sol", requested_quantity: 1 }] });
    expect(Object.keys(cot.body!)).not.toContain("price");
    expect(document.body.textContent).toContain("Confirma tu pedido");
    expect(document.body.textContent).toContain("$66");
    await act(async () => click(botonPorTexto("Confirmar pedido", document.body)!));
    await esperar();
    const orden = llamadas.find((l) => l.url.endsWith("/orders"))!;
    expect(orden.body).toMatchObject({ customer_name: "Ana Pérez", customer_phone: "999 123 4567", quote_hash: "a".repeat(32), acepta_aviso_privacidad: true });
    // La casilla de promociones por WhatsApp nace DESMARCADA: sin que la persona la marque no viaja ningun consentimiento de marketing.
    expect(orden.body).not.toHaveProperty("acepta_promociones");
    expect(aside.textContent).toContain("Quiero recibir promociones por WhatsApp");
    expect(llamadas.map((l) => l.url.split("/").pop())).toEqual(expect.arrayContaining(["quote", "confirm", "orders"]));
    expect(window.location.pathname).toBe("/pedir/demo/pedido/t1.abc.def");
    expect(window.location.href).not.toMatch(/Ana|9991234567|999/);
    await esperar();
    await esperarHasta(() => (rendered!.container.textContent ?? "").includes("Preparando tu pedido"), "la pantalla de seguimiento (chunk lazy)");
    expect(rendered!.container.textContent).toContain("Preparando tu pedido");
    expect(rendered!.container.textContent).not.toContain("Ana");
    // el carrito guardado se limpio
    expect(globalThis.sessionStorage.getItem("atiende.storefront.carrito.demo.centro")).toBeNull();
  });

  it("si el servidor rechaza la cotizacion (p. ej. cerrada) muestra su mensaje real y no abre la confirmacion", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/menu")) return json(MENU);
      if (String(url).endsWith("/quote")) return json({ code: "validation_error", message: "La sucursal Centro está cerrada en este momento; abre hoy a las 18:00." }, 400);
      return json({}, 404);
    });
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(q('button[aria-label="Agregar Sol al carrito"]')));
    act(() => click(q('input[name="pago"][value="efectivo"]')));
    const aside = q<HTMLElement>("aside");
    const campo = (label: string) => aside.querySelector<HTMLInputElement>(`#${(Array.from(aside.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement).htmlFor}`)!;
    act(() => changeValue(campo("Nombre"), "Ana"));
    act(() => changeValue(campo("Teléfono"), "9991234567"));
    const checks = aside.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    act(() => click(checks[0]!)); // mayoria de edad
    act(() => click(checks[checks.length - 1]!)); // privacidad (la casilla opcional de promociones va antes)
    await act(async () => submitForm(aside.querySelector("form")!));
    await esperar();
    expect(aside.querySelector('[role="alert"]')?.textContent).toContain("cerrada en este momento");
    expect(document.body.textContent).not.toContain("Confirma tu pedido");
  });
});

describe("seguimiento por token", () => {
  it("token invalido: mensaje uniforme sin datos del pedido", async () => {
    fetchMock.mockResolvedValue(json({ code: "not_found", message: "No encontramos ese pedido." }, 404));
    rendered = await renderEn("/pedir/demo/pedido/basura");
    await esperar();
    expect(rendered.container.textContent).toContain("No encontramos ese pedido");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8787/v1/restaurantes/demo/storefront/track/basura");
  });

  it("base sin migrar (disponible:false): mensaje honesto, no 'no encontrado'", async () => {
    fetchMock.mockResolvedValue(json({ disponible: false, mensaje: "El rastreo en línea todavía no está disponible. Llama a la sucursal." }));
    rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
    await esperar();
    expect(rendered.container.textContent).toContain("no disponible por ahora");
    expect(rendered.container.textContent).not.toContain("No encontramos");
  });

  it("estado final deja de refrescarse y se pide no indexar la pagina", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      fetchMock.mockResolvedValue(json({ disponible: true, pedido: { status: "entregado", branch: "Centro", total: 90, paymentMethod: "tarjeta", canal: "domicilio", createdAt: "2026-09-30T20:00:00Z", items: [{ name: "Coca-Cola", quantity: 2, tortilla: null }] } }));
      rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
      await esperar();
      expect(rendered.container.textContent).toContain("Entregado");
      expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex,nofollow");
      const antes = fetchMock.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await flushMicrotasks();
      });
      expect(fetchMock.mock.calls.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("aviso de privacidad y lista de sucursales", () => {
  it("el aviso simplificado explica datos, uso y derechos", async () => {
    rendered = await renderEn("/pedir/demo/privacidad");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Aviso de privacidad");
    expect(t).toContain("Qué datos pedimos");
    expect(t).toContain("Tus derechos");
    expect(document.title).toContain("Aviso de privacidad");
  });

  it("muestra 'Encargados y transferencias' (borrador) con la configuracion real que manda el servidor", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/privacidad")
        ? json({ encargados: { borrador: true, revisionLegalPendiente: true, aviso: "BORRADOR pendiente de revisión legal. Algunos proveedores tratan sus datos.", encargados: [{ id: "meta_whatsapp", proveedor: "Meta (WhatsApp)", finalidad: "Enviar y recibir los mensajes de WhatsApp.", pais: "Estados Unidos" }] } })
        : json({}, 404),
    );
    rendered = await renderEn("/pedir/demo/privacidad");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Encargados y transferencias");
    expect(t).toContain("Borrador pendiente de revisión legal.");
    expect(t).toContain("Meta (WhatsApp) (Estados Unidos): Enviar y recibir los mensajes de WhatsApp.");
  });

  it("sin encargados (o si el servidor falla) la seccion no aparece y el aviso simplificado sigue completo", async () => {
    fetchMock.mockImplementation(async () => json({ encargados: { borrador: true, revisionLegalPendiente: true, aviso: "x", encargados: [] } }));
    rendered = await renderEn("/pedir/demo/privacidad");
    await esperar();
    expect(rendered.container.textContent).not.toContain("Encargados y transferencias");
    expect(rendered.container.textContent).toContain("Tus derechos");
    rendered.unmount();
    fetchMock.mockImplementation(async () => json({ message: "falla" }, 500));
    rendered = await renderEn("/pedir/demo/privacidad");
    await esperar();
    expect(rendered.container.textContent).not.toContain("Encargados y transferencias");
    expect(rendered.container.textContent).toContain("Tus derechos");
  });

  it("lista las sucursales con apertura y enlaza a su menu; titulo e indexable para SEO", async () => {
    fetchMock.mockResolvedValue(json({ restaurante: { slug: "demo", nombre: "Los Taquitos" }, sucursales: [SUCURSAL, { ...SUCURSAL, slug: "norte", name: "Norte", abiertoAhora: false, cierraA: null, proximaApertura: { dia: "martes", hora: "12:00", hoy: false } }] }));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Pide en Los Taquitos");
    expect(t).toContain("Abierto ahora · cierra a las 01:00");
    expect(t).toContain("Cerrado · abre el martes a las 12:00");
    expect(rendered.container.querySelector('a[href="/pedir/demo/norte"]')).not.toBeNull();
    expect(document.title).toBe("Los Taquitos · Pedir en línea");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("index,follow");
  });
});
