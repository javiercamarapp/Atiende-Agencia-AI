// @vitest-environment jsdom
//
// Insignia de la comanda al POS en Pedidos: "En POS" / "Capturar a mano" / "Falló" con enlace a la cola. Lectura liviana por ids; si falla
// o la base no tiene la migracion, la lista de pedidos sigue igual (sin insignias, sin error).
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };

function pedido(id: string, nombre: string) {
  return { id, propertyId: "prop-1", branch: "Centro", customerId: null, customerName: nombre, customerPhone: "5511112222", customerAddress: null, total: 100, status: "pending", items: [{ id: "i", name: "Tacos", price: 100, quantity: 1 }], source: "voice", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-19T10:00:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null };
}
const PEDIDOS = [pedido("o1", "Ana"), pedido("o2", "Beto"), pedido("o3", "Carla")];

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}
function stub(estados: Response | Record<string, string>) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/admin/softrestaurant/estados")) return estados instanceof Object && "ok" in estados ? (estados as Response) : json({ disponible: true, estados });
    if (url.includes("/admin/staff/repartidores")) return json({ repartidores: [] });
    if (url.includes("/admin/orders")) return json({ orders: PEDIDOS, nextCursor: null });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const montar = () => {
  rendered = renderComponent(
    <MemoryRouter>
      <PedidosPage {...CTX} />
    </MemoryRouter>,
  );
};
const insignia = (id: string) => rendered!.container.querySelector<HTMLElement>(`[data-testid='comanda-pos-${id}']`);

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("PedidosPage -- insignia de la comanda al POS", () => {
  it("pinta 'En POS', 'Capturar a mano' y 'Falló' segun el estado de la comanda, con enlace a Comandas al POS; un pedido sin comanda no lleva insignia", async () => {
    stub({ o1: "confirmada", o2: "captura_manual", o3: "fallida" });
    montar();
    await esperar();
    expect(insignia("o1")!.textContent).toBe("En POS");
    expect(insignia("o2")!.textContent).toBe("Capturar a mano");
    expect(insignia("o3")!.textContent).toBe("Falló");
    expect(insignia("o2")!.getAttribute("href")).toBe("/restaurantes/demo/comandas-pos");
    const consulta = String(fetchMock.mock.calls.find((c) => String(c[0]).includes("/softrestaurant/estados"))![0]);
    expect(consulta.split("orderIds=")[1]!.split(",").sort()).toEqual(["o1", "o2", "o3"]);
  });

  it("una comanda capturada a mano cuenta como 'En POS'; sin comanda no hay insignia", async () => {
    stub({ o1: "capturada_manual" });
    montar();
    await esperar();
    expect(insignia("o1")!.textContent).toBe("En POS");
    expect(insignia("o2")).toBeNull();
  });

  it("si la lectura falla o la base no la tiene, la lista de pedidos sigue y no hay insignias ni error", async () => {
    stub(json({ error: "x" }, 500));
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("Ana");
    expect(insignia("o1")).toBeNull();
    expect(rendered!.container.querySelector("[role='alert']")).toBeNull();
    rendered!.unmount();
    stub(json({ disponible: false, estados: {} }));
    montar();
    await esperar();
    expect(insignia("o1")).toBeNull();
    expect(rendered!.container.textContent).toContain("Beto");
  });
});
