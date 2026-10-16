// @vitest-environment jsdom
//
// Detalle de pedido a pagina completa (UNI-R1, replica de PedidoDetalleSection): carga, error con reintento, datos del pedido (folio, estado, cliente,
// canal, direccion, pago, productos, notas, incidencia, entrega) y «Pedidos recientes». `fetch` mockeado por ruta; reloj fijo no necesario (fechas ISO fijas).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidoDetalle } from "../src/verticals/restaurantes/components/pedidos/PedidoDetalle.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const PEDIDO: OrderSummary = {
  id: "ord-1",
  orderNumber: 1001,
  propertyId: "prop-1",
  branch: "Sucursal Centro",
  customerId: "c1",
  customerName: "Marisol Pech",
  customerPhone: "+529995550101",
  customerAddress: "Calle 60 #412, Centro",
  total: 286,
  status: "entregado",
  items: [
    { id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 2 },
    { id: "p-2", name: "Horchata", price: 48, quantity: 2, tortilla: "maíz" },
  ],
  source: "whatsapp",
  notes: "Sin cebolla",
  paymentMethod: "efectivo",
  createdAt: "2026-10-08T20:58:00.000Z",
  deliveredAt: "2026-10-08T21:40:00.000Z",
  assignedRepartidorId: "rep-1",
  estimatedDeliveryAt: "2026-10-08T21:35:00.000Z",
  incidentNote: null,
  canal: "domicilio",
  propina: 20,
};
const RECIENTE: OrderSummary = { ...PEDIDO, id: "ord-2", orderNumber: 1002, customerName: "Jorge Canul", total: 190, status: "pending", source: "web", notes: null, createdAt: "2026-10-08T20:45:00.000Z" };
const REPARTIDORES = [{ id: "rep-1", email: "ramon@example.com", fullName: "Ramon Uc", propertyIds: null }];

function stub(opts: { pedido?: OrderSummary | null; fallaDetalle?: boolean; recientes?: readonly OrderSummary[]; fallaRecientes?: boolean }) {
  let intentos = 0;
  fetchMock = vi.fn(async (url: string) => {
    if (/\/admin\/orders\/[^/?]+$/.test(url)) {
      intentos += 1;
      if (opts.fallaDetalle && intentos === 1) return json({ message: "Pedido no encontrado." }, false, 404);
      return json({ order: opts.pedido ?? PEDIDO });
    }
    if (url.includes("/admin/orders")) return opts.fallaRecientes ? json({ message: "boom" }, false) : json({ orders: [opts.pedido ?? PEDIDO, ...(opts.recientes ?? [RECIENTE])], nextCursor: null });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function montar(onVolver = vi.fn(), onSelect = vi.fn(), onHistorial = vi.fn()) {
  rendered = renderComponent(<PedidoDetalle apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orderId="ord-1" repartidores={REPARTIDORES} onVolver={onVolver} onSelect={onSelect} onHistorial={onHistorial} />);
  return { onVolver, onSelect, onHistorial };
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;

describe("PedidoDetalle", () => {
  it("muestra el estado de carga y luego los datos del pedido", async () => {
    stub({});
    montar();
    expect(rendered!.container.querySelector('[aria-label="Cargando el pedido"]')).not.toBeNull();
    await esperar();
    const t = rendered!.container.textContent!;
    expect(t).toContain("Venta 1001");
    expect(t).toContain("Entregado");
    expect(t).toContain("8 oct 2026, 14:58");
    expect(t).toContain("Sucursal Centro");
    expect(t).toContain("Marisol Pech");
    expect(t).toContain("+529995550101");
    expect(t).toContain("WhatsApp");
    expect(t).toContain("Calle 60 #412, Centro");
    expect(t).toContain("efectivo");
    expect(t).toContain("Ramon Uc");
    expect(t).toContain("Domicilio");
    expect(t).toContain("Sin cebolla");
    expect(t).toContain("Instrucciones especiales");
    expect(t).toContain("Entregado el 8 oct 2026, 15:40");
  });

  it("tabla de productos con cantidad, precio unitario, subtotal y total (formato es-MX)", async () => {
    stub({});
    montar();
    await esperar();
    const tabla = rendered!.container.querySelector("table")!;
    const t = tabla.textContent!;
    for (const x of ["Producto", "Cant.", "P. unit.", "Subtotal", "Tacos al pastor (orden)", "$95.00", "$190.00", "Horchata", "$48.00", "$96.00", "maíz"]) expect(t).toContain(x);
    expect(rendered!.container.querySelector('[data-testid="detalle-total"]')?.textContent).toBe("$286.00");
    expect(rendered!.container.textContent).toContain("Propina (no incluida en el total)");
    expect(rendered!.container.textContent).toContain("$20.00");
  });

  it("un pedido en incidencia muestra la nota en el aviso fucsia", async () => {
    stub({ pedido: { ...PEDIDO, status: "problema", incidentNote: "Dirección incorrecta", deliveredAt: null } });
    montar();
    await esperar();
    const t = rendered!.container.textContent!;
    expect(t).toContain("Incidencia");
    expect(t).toContain("Dirección incorrecta");
    expect(t).toContain("Incidencia reportada");
    expect(t).not.toContain("Entregado el");
  });

  it("sin folio (API vieja) el titulo usa el id corto en mayusculas", async () => {
    stub({ pedido: { ...PEDIDO, orderNumber: null } });
    montar();
    await esperar();
    expect(rendered!.container.querySelector("h2")?.textContent).toBe("#ORD-1");
  });

  it("error 404: tarjeta «No se pudo cargar el pedido» con el mensaje real y «Volver a intentar» que reintenta", async () => {
    stub({ fallaDetalle: true });
    montar();
    await esperar();
    const alerta = rendered!.container.querySelector('[role="alert"]')!;
    expect(alerta.textContent).toContain("No se pudo cargar el pedido");
    expect(alerta.textContent).toContain("Pedido no encontrado.");
    click(boton("Volver a intentar")!);
    await esperar();
    expect(rendered!.container.querySelector('[role="alert"]')).toBeNull();
    expect(rendered!.container.textContent).toContain("Venta 1001");
  });

  it("«Volver» e «Historial» llaman a sus manejadores", async () => {
    stub({});
    const { onVolver, onHistorial } = montar();
    await esperar();
    click(boton("Volver")!);
    expect(onVolver).toHaveBeenCalledTimes(1);
    click(boton("Historial")!);
    expect(onHistorial).toHaveBeenCalledWith(expect.objectContaining({ id: "ord-1" }));
  });

  it("«Pedidos recientes»: sin el pedido actual, con folio, sucursal, monto y estado; un clic abre ese pedido", async () => {
    stub({});
    const { onSelect } = montar();
    await esperar();
    const t = rendered!.container.textContent!;
    expect(t).toContain("Pedidos recientes");
    const fila = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Jorge Canul"))!;
    expect(fila.textContent).toContain("Venta 1002");
    expect(fila.textContent).toContain("$190.00");
    expect(fila.textContent).toContain("Recibido");
    expect([...rendered!.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Marisol Pech"))).toHaveLength(0);
    click(fila);
    expect(onSelect).toHaveBeenCalledWith("ord-2");
  });

  it("sin otros pedidos: «No hay más pedidos recientes.»; si la consulta falla el detalle sigue intacto", async () => {
    stub({ recientes: [] });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("No hay más pedidos recientes.");
    rendered!.unmount();
    stub({ fallaRecientes: true });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("Venta 1001");
    expect(rendered!.container.textContent).toContain("No hay más pedidos recientes.");
  });
});
