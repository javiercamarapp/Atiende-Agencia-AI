// @vitest-environment jsdom
//
// <PedidosPage /> con el mapa «Entrega en curso» ENCENDIDO (la bandera MAPA_ENTREGA_HABILITADO vive apagada en mapa-entrega-config.ts hasta que existan
// coordenadas reales de cliente y repartidor). Esta prueba la enciende con vi.mock para que el codigo del mapa no se pudra mientras esta oculto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { esperarHasta, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

vi.mock("../src/verticals/restaurantes/components/pedidos/mapa-entrega-config.ts", () => ({ MAPA_ENTREGA_HABILITADO: true }));
vi.mock("leaflet", () => {
  const capa = { addTo: () => capa, bindTooltip: () => capa, remove: () => undefined, setLatLng: () => undefined };
  const mapa = { setView: () => mapa, fitBounds: () => undefined, stop: () => undefined, remove: () => undefined };
  return { default: { map: () => mapa, tileLayer: () => capa, divIcon: () => ({}), marker: () => capa, latLngBounds: () => ({}) } };
});

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Manager Demo", staffEmail: "manager@example.com" };
const PEDIDO: OrderSummary = {
  id: "ord-1", orderNumber: 1001, propertyId: "prop-1", branch: "Centro", customerId: "cust-1", customerName: "Juan Pérez", customerPhone: "5511112222",
  customerAddress: "Calle Falsa 123", total: 345.5, status: "pending", items: [{ id: "it-1", name: "Tacos al pastor", price: 115, quantity: 3 }], source: "web",
  notes: null, paymentMethod: "efectivo", createdAt: "2026-10-08T19:30:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio",
};
const SUCURSAL = { propertyId: "prop-1", name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: 20.9671, lng: -89.6237 };

function stub(sucursal: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/admin/staff/repartidores")) return json({ repartidores: [] });
    if (url.includes("/admin/sucursales")) return json({ branches: [sucursal] });
    if (url.includes("/admin/repartidor-sugerido")) return json({ sugerencias: {} });
    if (url.includes("/admin/scheduled-orders")) return json({ disponible: true, orders: [], promovidos: [], serverNow: new Date().toISOString() });
    if (url.includes("/admin/orders")) return json({ orders: new URL(url).searchParams.get("status") === "pending" ? [PEDIDO] : [], nextCursor: null });
    return json({});
  }));
}
async function cargar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}

describe("PedidosPage con la bandera del mapa encendida", () => {
  it("la columna derecha trae «Entrega en curso» con el primer pedido y la insignia «Simulado»", async () => {
    stub(SUCURSAL);
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await cargar();
    const mapa = rendered.container.querySelector('[data-testid="mapa-entrega"]')!;
    expect(mapa.textContent).toContain("Entrega en curso");
    expect(mapa.textContent).toContain("Simulado");
    expect(mapa.textContent).toContain("Juan Pérez");
    await esperarHasta(() => rendered!.container.querySelector('[data-testid="mapa-entrega-leaflet"]') !== null, "el mapa Leaflet carga bajo demanda");
  });

  it("una sucursal sin lat/lng muestra el estado vacio del mapa (sin marcadores inventados)", async () => {
    stub({ ...SUCURSAL, lat: null, lng: null });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await cargar();
    expect(rendered.container.querySelector('[data-testid="mapa-sin-ubicacion"]')?.textContent).toContain("Esta sucursal aún no tiene ubicación en el mapa");
    expect(rendered.container.querySelector('[data-testid="mapa-entrega-leaflet"]')).toBeNull();
  });
});
