// @vitest-environment jsdom
//
// QA restaurantes, ronda 1 (lote storefront / dinero / idempotencia), lado navegador: regresiones de QA-restaurantes-R1-caos-07
// (red caida), 08 (200 con HTML), 09 (servidor colgado), 10 (estados del canal recoger), 11 (sondeo que falla), 12 (domicilio
// se paga al repartidor) y de la respuesta `ya_registrado` del servidor (caos-01/02). Red simulada: nunca la base real.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { crearClienteStorefront, MENSAJE_RED, MENSAJE_RESPUESTA_INVALIDA, MENSAJE_TIEMPO_AGOTADO, StorefrontError } from "../src/verticals/restaurantes/storefront/storefront-client.ts";
import { textoPago } from "../src/verticals/restaurantes/storefront/RastreoPage.tsx";
import { esperarRutaCargada, changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const DATOS = { sessionId: "sesion-web-0001-abcdef", items: [{ product_id: "p1", requested_quantity: 2 }], canal: "recoger" as const, metodoPago: "efectivo" as const };
const CLIENTE = { nombre: "Ana", telefono: "9991234567", aceptaAviso: true };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("cliente del storefront: red, HTML y tiempo maximo", () => {
  afterEach(() => vi.useRealTimers());

  it("caos-07: red caida -> StorefrontError en espanol (nunca 'Failed to fetch')", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    const err = await c.cotizar("centro", DATOS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorefrontError);
    expect((err as StorefrontError).message).toBe(MENSAJE_RED);
    expect((err as StorefrontError).motivo).toBe("red");
    expect((err as StorefrontError).message).not.toMatch(/failed to fetch/i);
  });

  it("caos-08: 200 con HTML (proxy/CDN) -> mensaje generico en espanol, no el SyntaxError de JSON", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<html><bod\"... is not valid JSON");
      },
    } as unknown as Response);
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    for (const llamada of [() => c.cotizar("centro", DATOS), () => c.menu("centro"), () => c.rastreo("t1.a.b")]) {
      const err = await llamada().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorefrontError);
      expect((err as StorefrontError).message).toBe(MENSAJE_RESPUESTA_INVALIDA);
      expect((err as StorefrontError).message).not.toMatch(/unexpected token|json/i);
    }
  });

  it("caos-09: un POST colgado se corta a los 20 s con un error que invita a reintentar; el cliente no queda bloqueado", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const colgado = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_ok, rechazar) => init!.signal!.addEventListener("abort", () => rechazar(new DOMException("Aborted", "AbortError")))));
    const c = crearClienteStorefront("https://api.test", "demo", colgado as unknown as typeof fetch);
    const resultado = c.crearPedido("centro", DATOS, CLIENTE, null).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    let terminado = false;
    void resultado.then(() => (terminado = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(terminado).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const err = (await resultado) as StorefrontError;
    expect(err).toBeInstanceOf(StorefrontError);
    expect(err.motivo).toBe("tiempo_agotado");
    expect(err.message).toBe(MENSAJE_TIEMPO_AGOTADO);
  });

  it("un 409 ya_registrado del servidor trae el rastreo del pedido existente en el error", async () => {
    const f = vi.fn().mockResolvedValue(json({ code: "conflict", message: "Esta sesión ya tiene un pedido registrado.", motivo: "pedido_ya_creado", ya_registrado: true, rastreo_token: "t1.abc.def" }, 409));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    const err = (await c.cotizar("centro", DATOS).catch((e: unknown) => e)) as StorefrontError;
    expect(err).toMatchObject({ status: 409, motivo: "pedido_ya_creado", rastreoToken: "t1.abc.def" });
  });

  it("una respuesta sana no se ve afectada: el JSON llega tal cual", async () => {
    const f = vi.fn().mockResolvedValue(json({ confirmado: true }));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    await expect(c.confirmar("centro", DATOS.sessionId, null)).resolves.toEqual({ confirmado: true });
  });
});

describe("textoPago (caos-12)", () => {
  it("a domicilio se paga al repartidor; al recoger, en la sucursal", () => {
    expect(textoPago("domicilio", "efectivo")).toBe("Pagas en efectivo al repartidor.");
    expect(textoPago("domicilio", "tarjeta")).toBe("Pagas con tarjeta al repartidor.");
    expect(textoPago("recoger", "efectivo")).toBe("Pagas en efectivo en la sucursal.");
    expect(textoPago("recoger", null)).toBe("Pagas en la sucursal.");
  });
});

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

const SUCURSAL = { slug: "centro", name: "Centro", address: "Calle 1 #100", phone: null, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null, zonasReparto: [] };
const SOL = { id: "sol", name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, available: true, packSize: null, requiresAdultConfirmation: false, requiresTortilla: false, noDomicilio: false };
const MENU = { sucursal: SUCURSAL, categorias: [{ id: "c1", name: "Bebidas", items: [SOL] }] };
const COTIZACION = { quote: { lines: [{ product_id: "sol", name: "Sol", price: 66, quantity: 1, tortilla: null, line_total: 66 }], total: 66, contains_alcohol: false }, quote_hash: "a".repeat(32), promo: null };
const pedido = (extra: Record<string, unknown>) => ({ disponible: true, pedido: { status: "preparando", branch: "Centro", total: 66, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T19:00:00Z", items: [{ name: "Sol", quantity: 1, tortilla: null }], ...extra } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  globalThis.sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

describe("rastreo publico", () => {
  it("caos-10: un pedido listo_para_recoger muestra 'Listo para recoger', nunca la clave interna", async () => {
    fetchMock.mockResolvedValue(json(pedido({ status: "listo_para_recoger" })));
    rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Listo para recoger");
    expect(texto).toContain("Lo recoges en la sucursal.");
    expect(texto).not.toContain("listo_para_recoger");
  });

  it("caos-10: no_recogido y programado tambien tienen etiqueta en espanol", async () => {
    for (const [status, etiqueta] of [["no_recogido", "No se recogió a tiempo"], ["programado", "Programado"]] as const) {
      fetchMock.mockResolvedValue(json(pedido({ status })));
      rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
      await esperar();
      expect(rendered.container.textContent).toContain(etiqueta);
      expect(rendered.container.textContent).not.toContain(status);
      rendered.unmount();
      rendered = undefined;
    }
  });

  it("caos-12: a domicilio dice que se paga al repartidor, no 'en la sucursal'", async () => {
    fetchMock.mockResolvedValue(json(pedido({ status: "en_camino", canal: "domicilio", total: 250 })));
    rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Va a domicilio.");
    expect(texto).toContain("Pagas en efectivo al repartidor.");
    expect(texto).not.toMatch(/Va a domicilio\..*en la sucursal/);
  });

  it("caos-11: un fallo transitorio del sondeo conserva el ultimo estado conocido con un aviso discreto, y se recupera solo", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fetchMock.mockResolvedValueOnce(json(pedido({ status: "preparando" }))).mockResolvedValueOnce(json({ message: "Servicio no disponible" }, 503)).mockResolvedValue(json(pedido({ status: "listo_para_recoger" })));
    rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
    await esperar();
    expect(rendered.container.textContent).toContain("Preparando tu pedido");
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    // el sondeo fallo: el pedido NO desaparece ni se reemplaza por la pantalla de error
    expect(rendered.container.textContent).toContain("Preparando tu pedido");
    expect(rendered.container.textContent).toContain("No pudimos actualizar el estado ahora");
    expect(rendered.container.querySelector("[role=alert]")).toBeNull();
    // el siguiente sondeo se recupera y el aviso desaparece
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("Listo para recoger");
    expect(rendered.container.textContent).not.toContain("No pudimos actualizar el estado ahora");
  });

  it("si el PRIMER sondeo falla (nunca se mostro el pedido) si se muestra el error con reintento", async () => {
    fetchMock.mockResolvedValue(json({ message: "Servicio no disponible" }, 503));
    rendered = await renderEn("/pedir/demo/pedido/t1.a.b");
    await esperar();
    expect(rendered.container.textContent).toContain("Servicio no disponible");
  });
});

describe("checkout: errores de red y pedido ya registrado", () => {
  async function llenarYRevisar(): Promise<HTMLElement> {
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    act(() => click(rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Agregar Sol al carrito"]')!));
    act(() => click(rendered!.container.querySelector<HTMLInputElement>('input[name="pago"][value="efectivo"]')!));
    const aside = rendered.container.querySelector<HTMLElement>("aside")!;
    const campo = (label: string) => aside.querySelector<HTMLInputElement>(`#${(Array.from(aside.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement).htmlFor}`)!;
    act(() => changeValue(campo("Nombre"), "Ana Pérez"));
    act(() => changeValue(campo("Teléfono"), "999 123 4567"));
    // El aviso de privacidad es SIEMPRE el ultimo checkbox (antes va, opcional y desmarcada, la casilla de promociones).
    act(() => click([...aside.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].at(-1)!));
    await act(async () => submitForm(aside.querySelector("form")!));
    await esperar();
    return aside;
  }

  it("caos-07: red caida al cotizar -> alerta en espanol y el formulario queda utilizable", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/menu")) return json(MENU);
      throw new TypeError("Failed to fetch");
    });
    const aside = await llenarYRevisar();
    const alerta = aside.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alerta).toContain(MENSAJE_RED);
    expect(alerta).not.toMatch(/failed to fetch/i);
    expect(document.body.textContent).not.toContain("Confirma tu pedido");
  });

  it("caos-09: si crear el pedido falla por red/tiempo, el dialogo se cierra con el error en espanol y se puede reintentar (la sesion se conserva)", async () => {
    const sesiones: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.body) sesiones.push((JSON.parse(init.body as string) as { session_id: string }).session_id);
      if (String(url).endsWith("/menu")) return json(MENU);
      if (String(url).endsWith("/quote")) return json(COTIZACION);
      if (String(url).endsWith("/confirm")) return json({ confirmado: true });
      throw new TypeError("Failed to fetch");
    });
    const aside = await llenarYRevisar();
    expect(document.body.textContent).toContain("Confirma tu pedido");
    const confirmar = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Confirmar pedido")) as HTMLButtonElement;
    await act(async () => click(confirmar));
    await esperar();
    expect(document.body.textContent).not.toContain("Confirma tu pedido");
    expect(aside.querySelector('[role="alert"]')?.textContent).toContain(MENSAJE_RED);
    expect(Array.from(aside.querySelectorAll("button")).find((b) => b.textContent?.includes("Revisar pedido"))!.disabled).toBe(false);
    expect(new Set(sesiones).size).toBe(1);
  });

  it("caos-02/01: si el servidor dice que la sesion ya tiene pedido (409 ya_registrado al revisar), se abre su rastreo en vez de un error", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/menu")) return json(MENU);
      if (String(url).endsWith("/quote")) return json({ code: "conflict", message: "Esta sesión ya tiene un pedido registrado.", motivo: "pedido_ya_creado", ya_registrado: true, rastreo_token: "t1.abc.def" }, 409);
      if (String(url).includes("/track/")) return json(pedido({ status: "pending" }));
      return json({}, 404);
    });
    await llenarYRevisar();
    expect(window.location.pathname).toBe("/pedir/demo/pedido/t1.abc.def");
    expect(globalThis.sessionStorage.getItem("atiende.storefront.sesion.demo.centro")).toBeNull();
  });
});
