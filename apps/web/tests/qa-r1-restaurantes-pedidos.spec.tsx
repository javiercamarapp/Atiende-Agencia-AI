// @vitest-environment jsdom
//
// QA R1 (restaurantes) en Pedidos: botones-01 (carrera de pestanas), botones-02 (pedido que llega antes del primer sondeo) y
// caos-18 (dos pestanas con auto-impresion imprimen el mismo ticket dos veces).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketCocina } from "@atiende/ui";

const imprimir = vi.hoisted(() => vi.fn((_tickets: readonly unknown[]) => true));
vi.mock("@atiende/ui", async (orig) => ({ ...(await orig<typeof import("@atiende/ui")>()), imprimirTicketsCocina: imprimir }));
const aviso = vi.hoisted(() => vi.fn());
vi.mock("../src/verticals/restaurantes/lib/sondeo-pedidos.ts", async (orig) => ({ ...(await orig<typeof import("../src/verticals/restaurantes/lib/sondeo-pedidos.ts")>()), reproducirAviso: aviso }));

import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const rendered: RenderedComponent[] = [];
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "M", staffEmail: "m@example.com" };

function pedido(id: string, nombre: string, status: OrderSummary["status"], over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id, propertyId: "prop-1", branch: "Centro", customerId: null, customerName: nombre, customerPhone: "5511112222", customerAddress: "Calle 1", total: 100, status,
    items: [{ id: "i", name: "Tacos", price: 50, quantity: 2 }], source: "web", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-19T10:00:00.000Z",
    assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, ...over,
  };
}
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function storageEnMemoria(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k: string) => m.get(k) ?? null, key: (i: number) => [...m.keys()][i] ?? null, removeItem: (k: string) => void m.delete(k), setItem: (k: string, v: string) => void m.set(k, String(v)) };
}

let porEstado: Record<string, OrderSummary[]>;
let retrasos: Record<string, Promise<void>>;

beforeEach(() => {
  imprimir.mockClear();
  aviso.mockClear();
  Object.defineProperty(window, "localStorage", { value: storageEnMemoria(), configurable: true });
  porEstado = { pending: [pedido("ord-aaaaaa1", "Marisol Pech", "pending")] };
  retrasos = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/admin/staff/repartidores")) return json({ repartidores: [] });
      const status = new URL(url).searchParams.get("status") ?? "";
      const branchId = new URL(url).searchParams.get("branchId");
      if (retrasos[status]) await retrasos[status];
      const lista = (porEstado[status] ?? []).filter((o) => !branchId || o.propertyId === branchId);
      return json({ orders: lista, nextCursor: null });
    }),
  );
});

afterEach(() => {
  while (rendered.length) rendered.pop()!.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const montar = () => {
  rendered.push(renderComponent(<PedidosPage {...CTX} />));
};
const texto = () => document.body.textContent ?? "";
async function abrirPestana(nombre: string) {
  const tab = [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === nombre)!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await flushMicrotasks();
  });
  await flush();
}
const boton = (t: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

describe("Pedidos: carrera de pestanas (botones-01)", () => {
  it("la respuesta lenta de 'Todos' no pisa la pestana 'Preparando' ya elegida", async () => {
    // "Todos" = una consulta por estado operativo; la de en_camino tarda y devuelve un pedido que NO es de Preparando.
    let soltar!: () => void;
    retrasos["en_camino"] = new Promise<void>((r) => (soltar = r));
    porEstado["en_camino"] = [pedido("ord-camino01", "Pedro EnCamino", "en_camino")];
    porEstado["preparando"] = [pedido("ord-prep0001", "Jorge Canul", "preparando")];
    montar();
    await flush();
    await abrirPestana("Preparando");
    expect(texto()).toContain("Jorge Canul");
    soltar();
    await flush();
    expect(texto()).toContain("Jorge Canul");
    expect(texto()).not.toContain("Pedro EnCamino");
  });
});

describe("Pedidos: pedido que llega antes del primer sondeo (botones-02)", () => {
  it("'Actualizar ahora' lo pinta, sube el contador y suena el aviso", async () => {
    window.localStorage.setItem("restaurantes:sonido-pedidos:demo:prop-1", "1");
    montar();
    await flush();
    expect(texto()).toContain("Marisol Pech");
    // Entra un pedido nuevo DESPUES de la carga inicial y ANTES del primer sondeo.
    porEstado["pending"] = [pedido("ord-nuevo002", "Cliente Nuevo", "pending", { createdAt: "2026-09-19T10:05:00.000Z" }), ...porEstado["pending"]!];
    await act(async () => {
      boton("Actualizar ahora").click();
      await flushMicrotasks();
    });
    await flush();
    expect(texto()).toContain("Cliente Nuevo");
    expect(document.body.querySelector('[data-testid="aviso-nuevos"]')?.textContent).toContain("1 pedido nuevo");
    expect(aviso).toHaveBeenCalledTimes(1);
  });

  it("un pedido que ya estaba en la lista cargada NO cuenta como nuevo", async () => {
    window.localStorage.setItem("restaurantes:sonido-pedidos:demo:prop-1", "1");
    montar();
    await flush();
    await act(async () => {
      boton("Actualizar ahora").click();
      await flushMicrotasks();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="aviso-nuevos"]')).toBeNull();
    expect(aviso).not.toHaveBeenCalled();
  });
});

describe("Pedidos: dos pestanas con auto-impresion (caos-18)", () => {
  it("un pedido nuevo se imprime UNA sola vez aunque haya dos pestanas con la auto-impresion activa", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    montar();
    await flush();
    await act(async () => {
      (document.getElementById("auto-imprimir-cocina") as HTMLInputElement).click();
      await flushMicrotasks();
    });
    await flush();
    // Segunda pestana del mismo equipo (mismo localStorage): lee la preferencia ya activa.
    montar();
    await flush();
    expect(document.body.querySelectorAll("#auto-imprimir-cocina")).toHaveLength(2);
    expect(imprimir).not.toHaveBeenCalled();

    porEstado["pending"] = [...porEstado["pending"]!, pedido("ord-bbbbbb2", "Cliente B", "pending", { createdAt: "2026-09-19T10:05:00.000Z" })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(imprimir).toHaveBeenCalledTimes(1);
    expect((imprimir.mock.calls[0]![0] as TicketCocina[]).map((t) => t.folio)).toEqual(["BBBBB2"]);
    // y el siguiente ciclo tampoco lo repite en ninguna pestana
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(imprimir).toHaveBeenCalledTimes(1);
  });

  it("otra pestana marca impresos: el evento storage actualiza esta (la etiqueta pasa a Reimprimir)", async () => {
    montar();
    await flush();
    expect(boton("Imprimir ticket")).toBeTruthy();
    const clave = "atiende.restaurantes.ticketCocina.demo.prop-1";
    window.localStorage.setItem(clave, JSON.stringify({ autoImprimir: false, impresos: ["ord-aaaaaa1"], reimpresiones: {} }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: clave }));
      await flushMicrotasks();
    });
    expect(boton("Reimprimir ticket")).toBeTruthy();
  });
});
