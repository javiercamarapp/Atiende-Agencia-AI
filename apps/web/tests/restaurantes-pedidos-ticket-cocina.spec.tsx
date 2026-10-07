// @vitest-environment jsdom
//
// Ticket de cocina en el panel de pedidos (PM PR-7): boton Imprimir/Reimprimir, vista
// previa y auto-impresion por sucursal con polling. `imprimirTicketsCocina` se
// reemplaza (jsdom no imprime); todo lo demas -- ticket, cola, prefs, fetch -- es real.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketCocina } from "@atiende/ui";

const imprimir = vi.hoisted(() => vi.fn((_tickets: readonly unknown[]) => true));
vi.mock("@atiende/ui", async (orig) => ({ ...(await orig<typeof import("@atiende/ui")>()), imprimirTicketsCocina: imprimir }));

import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Manager",
  staffEmail: "m@example.com",
};

function pedido(id: string, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    propertyId: "prop-1",
    branch: "Centro",
    customerId: null,
    customerName: `Cliente ${id}`,
    customerPhone: "5511112222",
    customerAddress: "Calle 1",
    total: 100,
    status: "pending",
    items: [{ id: "i", name: "Tacos", price: 50, quantity: 2 }],
    source: "web",
    notes: null,
    paymentMethod: "efectivo",
    createdAt: "2026-09-19T10:00:00.000Z",
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
    ...over,
  };
}

let pendientes: OrderSummary[];

// Storage en memoria: el localStorage de Node/jsdom varía según la versión del runtime.
function storageEnMemoria(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  imprimir.mockClear();
  Object.defineProperty(window, "localStorage", { value: storageEnMemoria(), configurable: true });
  pendientes = [pedido("ord-aaaaaa1")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/admin/staff/repartidores")) return { ok: true, status: 200, json: async () => ({ repartidores: [] }) } as unknown as Response;
      const params = new URL(url).searchParams;
      const status = params.get("status");
      // Como el API real: sin branchId devuelve todo el alcance de la membresia (owner/admin).
      const branchId = params.get("branchId");
      const visibles = pendientes.filter((o) => !branchId || o.propertyId === branchId);
      return { ok: true, status: 200, json: async () => ({ orders: status === "pending" ? visibles : [], nextCursor: null }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

function boton(texto: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll("button")].find((x) => x.textContent?.includes(texto));
  if (!b) throw new Error(`boton no encontrado: ${texto}`);
  return b as HTMLButtonElement;
}

async function clic(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}

describe("PedidosPage -- ticket de cocina", () => {
  it("Imprimir manda un ticket sin marca; el segundo clic dice Reimprimir y marca la reimpresion", async () => {
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await flush();
    await clic(boton("Imprimir ticket"));
    expect(imprimir).toHaveBeenCalledTimes(1);
    expect((imprimir.mock.calls[0]![0] as TicketCocina[])[0]!.reimpresion).toBe(0);

    await clic(boton("Reimprimir ticket"));
    expect(imprimir).toHaveBeenCalledTimes(2);
    expect((imprimir.mock.calls[1]![0] as TicketCocina[])[0]!.reimpresion).toBe(1);
    // persistido para esta sucursal
    expect(window.localStorage.getItem("atiende.restaurantes.ticketCocina.demo.prop-1")).toContain("ord-aaaaaa1");
  });

  it("Vista previa muestra el ticket real sin imprimir hasta pulsar Imprimir", async () => {
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await flush();
    await clic(boton("Vista previa"));
    const vista = document.body.querySelector('[data-testid="ticket-cocina-vista"]')!;
    expect(vista.textContent).toContain("COCINA · Centro");
    expect(vista.textContent).toContain("2x");
    expect(imprimir).not.toHaveBeenCalled();
    await clic([...document.body.querySelectorAll("button")].filter((b) => b.textContent === "Imprimir").at(-1)!);
    expect(imprimir).toHaveBeenCalledTimes(1);
  });

  it("auto-impresion: no imprime el rezago al activarla y si imprime el pedido nuevo en el siguiente ciclo", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await flush();
    await act(async () => {
      const chk = document.getElementById("auto-imprimir-cocina") as HTMLInputElement;
      chk.click();
      await flushMicrotasks();
    });
    await flush();
    expect(imprimir).not.toHaveBeenCalled();

    pendientes = [pedido("ord-aaaaaa1"), pedido("ord-bbbbbb2", { createdAt: "2026-09-19T10:05:00.000Z" })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(imprimir).toHaveBeenCalledTimes(1);
    const tickets = imprimir.mock.calls[0]![0] as TicketCocina[];
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.folio).toBe("BBBBB2");

    // el mismo pedido no se vuelve a imprimir en el ciclo siguiente
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(imprimir).toHaveBeenCalledTimes(1);
  });

  it("auto-impresion solo de esta sucursal: pedidos de otra sucursal no se imprimen ni al activar ni en el ciclo", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    pendientes = [pedido("ord-aaaaaa1"), pedido("ord-otra001", { propertyId: "prop-2", branch: "Norte" })];
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await flush();
    await act(async () => {
      (document.getElementById("auto-imprimir-cocina") as HTMLInputElement).click();
      await flushMicrotasks();
    });
    await flush();
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("status=pending"));
    expect(urls.length).toBeGreaterThan(0);
    // la linea base consulta con branchId de esta sucursal
    expect(urls.at(-1)).toContain("branchId=prop-1");

    pendientes = [
      ...pendientes,
      pedido("ord-bbbbbb2", { createdAt: "2026-09-19T10:05:00.000Z" }),
      pedido("ord-otra002", { propertyId: "prop-2", branch: "Norte", createdAt: "2026-09-19T10:06:00.000Z" }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await flush();
    expect(imprimir).toHaveBeenCalledTimes(1);
    const folios = (imprimir.mock.calls[0]![0] as TicketCocina[]).map((t) => t.folio);
    expect(folios).toEqual(["BBBBB2"]);
    expect(window.localStorage.getItem("atiende.restaurantes.ticketCocina.demo.prop-1")).not.toContain("ord-otra");
  });

  // QA R2 features-05: sin POS, imprimir el ticket es lo que habilita la aceptacion automatica -> se avisa al servidor de cada pedido PENDIENTE impreso.
  describe("aviso de ticket impreso al servidor (aceptacion automatica sin POS)", () => {
    const llamadasTicket = () =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => String(c[0]).includes("/ticket-impreso"))
        .map((c) => ({ url: String(c[0]), method: (c[1] as { method?: string } | undefined)?.method }));

    it("Imprimir un pedido pendiente registra el ticket en el servidor (POST) una vez", async () => {
      rendered = renderComponent(<PedidosPage {...CTX} />);
      await flush();
      await clic(boton("Imprimir ticket"));
      await flush();
      expect(llamadasTicket()).toEqual([{ url: "https://api.test/v1/restaurantes/prop-1/admin/autopiloto/pedidos/ord-aaaaaa1/ticket-impreso", method: "POST" }]);
    });

    it("la auto-impresion avisa SOLO de los pedidos nuevos que imprimio, no del rezago de la linea base", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      rendered = renderComponent(<PedidosPage {...CTX} />);
      await flush();
      await act(async () => {
        (document.getElementById("auto-imprimir-cocina") as HTMLInputElement).click();
        await flushMicrotasks();
      });
      await flush();
      expect(llamadasTicket()).toHaveLength(0);
      pendientes = [pedido("ord-aaaaaa1"), pedido("ord-bbbbbb2", { createdAt: "2026-09-19T10:05:00.000Z" })];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      await flush();
      expect(llamadasTicket().map((l) => l.url)).toEqual(["https://api.test/v1/restaurantes/prop-1/admin/autopiloto/pedidos/ord-bbbbbb2/ticket-impreso"]);
    });

    it("si el aviso falla, el ticket ya salio y la pantalla lo dice (no se calla el fallo)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/ticket-impreso")) throw new Error("sin red");
          if (url.includes("/admin/staff/repartidores")) return { ok: true, status: 200, json: async () => ({ repartidores: [] }) } as unknown as Response;
          const status = new URL(url).searchParams.get("status");
          return { ok: true, status: 200, json: async () => ({ orders: status === "pending" ? pendientes : [], nextCursor: null }) } as unknown as Response;
        }),
      );
      rendered = renderComponent(<PedidosPage {...CTX} />);
      await flush();
      await clic(boton("Imprimir ticket"));
      await flush();
      expect(imprimir).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("no se pudo avisar al sistema");
    });
  });
});
