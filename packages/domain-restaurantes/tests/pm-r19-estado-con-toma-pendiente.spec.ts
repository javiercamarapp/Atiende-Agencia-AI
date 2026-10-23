// PM Ronda 19, G7-8-10 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// Con la toma pendiente, «¿ya salio mi pedido?» recibe el estado que marco la sucursal aunque llegue dentro del minuto del acuse anterior
// (antes el limitador de recordatorios lo dejaba sin respuesta).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recibirMensajeConEspera, responderTrasEspera, textoEstadoEnTomaPendiente } from "../src/whatsapp/inbound.ts";
import { createOrder } from "../src/orders.ts";
import { MARTES_14H, nuevoViaje, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const escalaCambio = { tools: [{ name: "escalar_a_humano", args: { customer_name: "Ana", motivo: "cancelacion_modificacion", resumen: "quiere agregar un guacamole" } }] };

async function conPedido(): Promise<Viaje> {
  const v = await nuevoViaje();
  await createOrder(v.world.repo, {
    organizationId: v.world.organizationId,
    branchSlug: "garcia-lavin",
    customerName: "Ana Prueba",
    customerPhone: TEL_CLIENTE,
    canal: "recoger",
    paymentMethod: "efectivo",
    source: "whatsapp",
    items: [{ productId: v.producto("Bistec de Res — 1 kg"), requestedQuantity: 1 }],
  });
  return v;
}

let seq = 0;
async function escribeConEspera(v: Viaje, body: string) {
  const messageId = `wamid.r19-${++seq}`;
  const rec = await recibirMensajeConEspera(v.world.repo, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, body });
  expect(rec.estado).toBe("responder");
  return responderTrasEspera(v.world.repo, v.handler, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: v.gate, privacy: v.privacidad });
}

describe("textoEstadoEnTomaPendiente (pura)", () => {
  it("responde solo lo que marco la sucursal y nunca inventa", () => {
    expect(textoEstadoEnTomaPendiente("¿Ya salió mi pedido?", { estado: "registrado", canal: "recoger" })).toMatch(/figura registrado.*no lo marca en preparación ni como listo/i);
    expect(textoEstadoEnTomaPendiente("¿ya salió?", { estado: "salio", canal: "domicilio" })).toMatch(/marcó su pedido como salido/i);
    expect(textoEstadoEnTomaPendiente("¿Ya salió mi pedido?", { estado: "entregado", canal: null })).toBeNull();
    expect(textoEstadoEnTomaPendiente("¿Ya salió mi pedido?", null)).toBeNull();
    expect(textoEstadoEnTomaPendiente("Recibí el pedido pero no mandaron el guacamole", { estado: "registrado", canal: null })).toBeNull();
  });
});

describe("G7-8-10: estado del pedido con la toma pendiente", () => {
  it("la pregunta llega 6 s despues del acuse de la queja: se contesta con el estado real (ruta con espera)", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina; le confirmo en un momento." }]);
    await escribeConEspera(v, "Disculpe, ¿le pudiera agregar un guacamole a mi pedido?");
    vi.setSystemTime(new Date(Date.now() + 120_000));
    await escribeConEspera(v, "Recibí el pedido pero no mandaron el guacamole");
    vi.setSystemTime(new Date(Date.now() + 6_000));
    const llamadas = v.requests.length;
    const r = await escribeConEspera(v, "¿Ya salió mi pedido?");
    expect(v.requests.length).toBe(llamadas); // sin modelo
    expect(r.reply).toMatch(/figura registrado/i);
    expect(r.reply).not.toMatch(/ya sali[oó] a reparto|en camino/i);
  });

  it("ruta directa: lo mismo", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega un guacamole a mi pedido?");
    const r = await v.escribe("¿Ya salió mi pedido?");
    expect(r.reply).toMatch(/figura registrado/i);
  });

  it("sin pedido reciente, la pregunta sigue el camino de antes (acuse/silencio del limitador)", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega un guacamole a mi pedido?");
    const r = await v.escribe("¿Ya salió mi pedido?");
    expect(r.reply ?? "").not.toMatch(/figura registrado/i);
  });
});

describe("A32: cancelar un pedido ya hecho", () => {
  it("la respuesta fija dice que se lo pasa a cocina, no cancela y avisa al equipo", async () => {
    const v = await conPedido();
    const r = await v.escribe("quiero cancelar mi pedido");
    expect(r.reply).toMatch(/se lo paso a cocina/i);
    expect(r.reply).not.toMatch(/reembols|queda cancelado|ya cancel/i);
    expect(v.callbacks.map((c) => c.reason)).toContain("escalada:cancelacion_modificacion");
  });
});
