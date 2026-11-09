// Turno asincrono de WhatsApp (cerebro v2): si la funcion muere y el turno se re-ejecuta para el MISMO mensaje de Meta (reintento de Meta o barredor de
// turnos huerfanos), el modelo vuelve a llamar crear_pedido y suele redactar distinto las notas. La huella por contenido incluye las notas, asi que sin una
// llave atada al mensaje saldria un segundo pedido rumbo a cocina. Con cerebro v2 la llave sale del id del mensaje + sucursal + renglones canonicos.
import { describe, expect, it } from "vitest";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Fixture = ReturnType<typeof buildRestaurantFixture>;

const crear = (f: Fixture, extra: { cerebroV2?: boolean; sourceEventId?: string }, notas: string, cantidad = 3) =>
  executeAgentToolSafely(f.repo, { organizationId: f.organizationId, phone: "9991234567", channel: "whatsapp", ...extra }, "crear_pedido", {
    branch_slug: "fco-montejo",
    customer_name: "Cliente Sintético",
    customer_address: "Calle 50 #200",
    colonia_entrega: "Centro",
    payment_method: "efectivo",
    canal: "domicilio",
    notes: notas,
    items: [{ product_id: f.products.tacosPastor, requested_quantity: cantidad, tortilla: "maiz" }],
  });

const pedidos = async (f: Fixture) => (await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders;

describe("crear_pedido por WhatsApp con cerebro v2: idempotente por mensaje de Meta", () => {
  it("dos ejecuciones del mismo mensaje con notas distintas devuelven UN solo pedido", async () => {
    const f = buildRestaurantFixture();
    const a = await crear(f, { cerebroV2: true, sourceEventId: "wamid.reintento" }, "sin cebolla");
    const b = await crear(f, { cerebroV2: true, sourceEventId: "wamid.reintento" }, "Por favor, sin cebolla en los tacos");
    expect(a.orderId).toBeTruthy();
    expect(b.orderId).toBe(a.orderId);
    expect(await pedidos(f)).toHaveLength(1);
  });

  it("mismo mensaje pero renglones distintos: son pedidos distintos (no se confunden)", async () => {
    const f = buildRestaurantFixture();
    const a = await crear(f, { cerebroV2: true, sourceEventId: "wamid.dos" }, "sin cebolla", 3);
    const b = await crear(f, { cerebroV2: true, sourceEventId: "wamid.dos" }, "sin cebolla", 5);
    expect(b.orderId).not.toBe(a.orderId);
  });

  it("sin cerebro v2 el comportamiento es el de siempre: la huella incluye las notas", async () => {
    const f = buildRestaurantFixture();
    const a = await crear(f, { sourceEventId: "wamid.viejo" }, "sin cebolla");
    const b = await crear(f, { sourceEventId: "wamid.viejo" }, "Por favor, sin cebolla en los tacos");
    expect(b.orderId).not.toBe(a.orderId);
    // Y el reintento identico se sigue deduplicando por contenido.
    const c = await crear(f, { sourceEventId: "wamid.viejo" }, "sin cebolla");
    expect(c.orderId).toBe(a.orderId);
  });
});
