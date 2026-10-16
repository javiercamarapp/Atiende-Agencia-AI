// @vitest-environment jsdom
//
// R-16 -- el sonido del sondeo de pedidos respeta la preferencia de Avisos de la persona: con el aviso de pedido nuevo (o su sonido)
// apagado NO suena aunque la casilla local este marcada, y la casilla lo explica; sin respuesta de la base conserva el comportamiento de siempre.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let sonidos = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T18:00:00Z"));
  sonidos = 0;
  class AudioContextFalso {
    currentTime = 0;
    destination = {};
    constructor() {
      sonidos += 1;
    }
    createOscillator() {
      return { frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined };
    }
    createGain() {
      return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => ({ connect: () => undefined }) };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", AudioContextFalso);
  installMemoryLocalStorage().setItem("restaurantes:sonido-pedidos:demo:prop-1", "1");
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };

function pedido(id: string): OrderSummary {
  return {
    id,
    propertyId: "prop-1",
    branch: "Centro",
    customerId: null,
    customerName: `Cliente ${id}`,
    customerPhone: "5511112222",
    customerAddress: null,
    total: 100,
    status: "pending",
    items: [{ id: "it", name: "Tacos", price: 50, quantity: 2 }],
    source: "web",
    notes: null,
    paymentMethod: null,
    createdAt: "2026-10-02T17:00:00.000Z",
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
  };
}

/** `avisos`: cuerpo de GET .../admin/avisos, o `"falla"` para simular base sin migrar / error de red. */
function stubFetch(estado: { pending: OrderSummary[] }, avisos: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/admin/avisos")) return avisos === "falla" ? json({}, false) : json(avisos);
      if (url.includes("/admin/staff/repartidores")) return json({ repartidores: [] });
      if (method === "GET" && url.includes("/admin/scheduled-orders")) return json({ disponible: true, orders: [], promovidos: [], serverNow: new Date().toISOString() });
      if (method === "GET" && url.includes("/admin/orders")) return json({ orders: new URL(url).searchParams.get("status") === "pending" ? estado.pending : [], nextCursor: null });
      throw new Error(`fetch inesperado: ${method} ${url}`);
    }),
  );
}

async function asentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();
  });
}
async function avanzar(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await asentar();
}
/** La casilla de sonido vive en el menu «Herramientas»: se abre una vez (queda abierto mientras dura la prueba). */
async function abrirHerramientas(): Promise<void> {
  const b = [...document.body.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Herramientas de pedidos")!;
  await act(async () => {
    b.click();
  });
  await asentar();
}
const casilla = () => document.body.querySelector<HTMLInputElement>("#sonido-pedidos")!;

async function llegaUnPedidoNuevo(avisos: unknown) {
  const estado = { pending: [pedido("a")] };
  stubFetch(estado, avisos);
  rendered = renderComponent(<PedidosPage {...CTX} />);
  await asentar();
  await avanzar(20_000); // linea base
  estado.pending = [pedido("b"), pedido("a")];
  await avanzar(20_000);
}

const mias = (enabled: boolean, sonido: boolean) => ({ disponible: true, eventos: [], mias: [{ tipo: "restaurantes.pedido.nuevo", enabled, sonido }], equipo: null, umbrales: null, umbralDefectoMin: 45 });

describe("sonido del sondeo de pedidos y Avisos", () => {
  it("con el aviso y el sonido encendidos (o sin preferencia) SUENA al llegar un pedido nuevo", async () => {
    await llegaUnPedidoNuevo(mias(true, true));
    expect(sonidos).toBe(1);
    await abrirHerramientas();
    expect(casilla().disabled).toBe(false);
  });

  it("con el sonido apagado en Avisos NO suena, aunque la casilla local este marcada, y la casilla lo explica", async () => {
    await llegaUnPedidoNuevo(mias(true, false));
    expect(rendered!.container.querySelector('[data-testid="aviso-nuevos"]')?.textContent).toContain("1 pedido nuevo");
    expect(sonidos).toBe(0);
    await abrirHerramientas();
    expect(casilla().disabled).toBe(true);
    expect(casilla().checked).toBe(false);
    expect(document.body.textContent).toContain("apagado en tus Avisos");
  });

  it("con el aviso de pedido nuevo apagado tampoco suena", async () => {
    await llegaUnPedidoNuevo(mias(false, true));
    expect(sonidos).toBe(0);
  });

  it("si no se pueden leer los Avisos (base sin migrar o error) conserva el comportamiento de siempre: suena", async () => {
    await llegaUnPedidoNuevo("falla");
    expect(sonidos).toBe(1);
    await abrirHerramientas();
    expect(casilla().disabled).toBe(false);
  });

  it("si owner/admin apaga el sonido mientras la pantalla esta abierta, al volver a la pestana se recoge sin recargar", async () => {
    const prefs = mias(true, true);
    const estado = { pending: [pedido("a")] };
    stubFetch(estado, prefs);
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    await abrirHerramientas();
    expect(casilla().disabled).toBe(false);
    prefs.mias[0]!.sonido = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await asentar();
    expect(casilla().disabled).toBe(true);
    await avanzar(20_000); // linea base
    estado.pending = [pedido("b"), pedido("a")];
    await avanzar(20_000);
    expect(sonidos).toBe(0);
  });
});
