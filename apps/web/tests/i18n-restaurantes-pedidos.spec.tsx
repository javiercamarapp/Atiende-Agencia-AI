// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes (Resumen y Pedidos). Con la consola en espanol el DOM es identico al de sin proveedor (nadie que no
// elija EN ve un byte distinto); con EN (diseno ds3) el tablero de Pedidos sale en ingles natural, sin claves crudas, y los datos
// del cliente (nombre, sucursal, productos) quedan tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { ORDER_STATUS_LABELS, etiquetaVenta } from "../src/verticals/restaurantes/lib/orders-client.ts";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { etiquetaActualizado, faltaPara } from "../src/verticals/restaurantes/lib/sondeo-pedidos.ts";
import { PERIOD_OPTIONS } from "../src/verticals/restaurantes/dashboard-client.ts";
import { saludoEnZona } from "../src/verticals/restaurantes/lib/resumen-formato.ts";
import { ETIQUETA_ESTADO_COMANDA, etiquetaInsigniaPedido } from "../src/verticals/restaurantes/lib/pos-comandas-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Manager Demo",
  staffEmail: "manager@example.com",
};

const PEDIDO: OrderSummary = {
  id: "ord-r1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "cust-1",
  customerName: "Ana Recoge",
  customerPhone: "5511112222",
  customerAddress: "Calle 5",
  total: 200,
  status: "preparando",
  items: [{ id: "it-1", name: "Nachos de pastor", price: 90, quantity: 1 }],
  source: "whatsapp",
  notes: null,
  paymentMethod: "tarjeta",
  createdAt: "2026-09-30T18:00:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  canal: "domicilio",
  propina: null,
  horaRecogida: null,
  orderNumber: 7,
};

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/admin/staff/repartidores")) return { ok: true, status: 200, json: async () => ({ repartidores: [] }) } as unknown as Response;
      if (url.includes("/admin/orders")) {
        const status = new URL(url).searchParams.get("status") ?? "";
        return { ok: true, status: 200, json: async () => ({ orders: status === "preparando" ? [PEDIDO] : [], nextCursor: null }) } as unknown as Response;
      }
      throw new Error(`sin respuesta simulada: ${url}`);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

async function montar(el: ReactElement): Promise<HTMLElement> {
  rendered = renderComponent(el);
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  const html = c.innerHTML;
  rendered?.unmount();
  rendered = undefined;
  return html;
}

const CLAVE_CRUDA = /\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/;

describe("Pedidos ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(<PedidosPage {...CTX} />);
    const con = await htmlDe(
      <IdiomaProvider idiomaInicial="es">
        <PedidosPage {...CTX} />
      </IdiomaProvider>,
    );
    expect(con).toBe(sin);
    expect(sin).toContain("Órdenes recibidas");
    expect(sin).toContain("Asignar repartidor");
  });

  it("en ingles el tablero sale en ingles y los datos del cliente quedan tal cual", async () => {
    const c = await montar(
      <IdiomaProvider idiomaInicial="en">
        <PedidosPage {...CTX} />
      </IdiomaProvider>,
    );
    const texto = c.textContent ?? "";
    for (const en of ["Received orders", "Out for delivery", "Scheduled orders", "Assign driver", "Cancel order", "Report issue", "Order #", "Sale", "Delivery", "Tools"]) {
      expect(texto, en).toContain(en);
    }
    for (const es of ["Órdenes recibidas", "Asignar repartidor", "Cancelar pedido", "Herramientas", "Domicilio", "en total"]) {
      expect(texto, es).not.toContain(es);
    }
    expect(texto).toContain("Ana Recoge");
    expect(texto).toContain("Centro");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
    expect(c.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Order view");
  });
});

describe("etiquetas de lib/ (traducen al idioma activo)", () => {
  it("en espanol son los textos de siempre", () => {
    expect(ORDER_STATUS_LABELS.pending).toBe("Recibido");
    expect(ORDER_STATUS_LABELS.listo_para_recoger).toBe("Listo para recoger");
    expect(Object.keys(ORDER_STATUS_LABELS)).toHaveLength(11);
    expect(etiquetaVenta({ id: "x", orderNumber: 12 })).toBe("Venta 0012");
    expect(etiquetaActualizado(null, 0)).toBe("Sin actualizar todavía");
    expect(etiquetaActualizado(0, 12_000)).toBe("Actualizado hace 12 s");
    expect(faltaPara("2026-01-01T02:15:00Z", Date.parse("2026-01-01T00:00:00Z"))).toBe("en 2 h 15 min");
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(["Hoy", "7 días", "1 mes", "3 meses", "6 meses", "1 año", "Histórico"]);
    expect(saludoEnZona(new Date("2026-10-02T15:00:00Z"), "America/Mexico_City")).toBe("Buenos días");
    expect(ETIQUETA_ESTADO_COMANDA.confirmada).toBe("En POS");
    expect(etiquetaInsigniaPedido("capturada_manual")).toBe("En POS");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(ORDER_STATUS_LABELS.pending).toBe("Received");
    expect(etiquetaVenta({ id: "x", orderNumber: 12 })).toBe("Sale 0012");
    expect(etiquetaActualizado(0, 12_000)).toBe("Updated 12s ago");
    expect(faltaPara("2026-01-01T00:40:00Z", Date.parse("2026-01-01T00:00:00Z"))).toBe("in 40 min");
    expect(PERIOD_OPTIONS[0]?.label).toBe("Today");
    expect(saludoEnZona(new Date("2026-10-02T15:00:00Z"), "America/Mexico_City")).toBe("Good morning");
    expect(ETIQUETA_ESTADO_COMANDA.fallida).toBe("Failed");
  });
});
