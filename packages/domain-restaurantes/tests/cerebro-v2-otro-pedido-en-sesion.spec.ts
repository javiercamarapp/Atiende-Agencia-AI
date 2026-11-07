// Cerebro v2, bloque 4 (SUELTO-VS-718-V2.md B4; suelto whatsapp-agent-core.ts ~8022-8075, motivoOtroPedidoEnSesion): con un pedido creado en la sesión (90 min),
// otro crear_pedido es una MODIFICACIÓN (va a la sucursal) salvo el sí al «¿Quiere hacer un pedido aparte?» con su cotización posterior. El suelto lo lee de los
// tool_calls del hilo; el monorrepo guardaba solo texto: ahora el mensaje del asistente de un turno v2 guarda sus herramientas (aditivo, campo `herramientas`
// del jsonb del hilo, sin migración) y el hilo se expande al formato del suelto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { hiloDelSuelto } from "../src/whatsapp/cerebro-v2/hilo-herramientas.ts";
import { motivoOtroPedidoEnSesion } from "../src/whatsapp/cerebro-v2/pedido-aparte.ts";

const T0 = new Date("2026-10-13T19:00:00-06:00");

async function primerPedido(v: Viaje) {
  const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
  v.guion([
    { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
    { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
  ]);
  await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
  v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
  await v.escribe("Sí, así está bien");
}

describe("cerebro v2: otro pedido en la sesión", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("el hilo guarda las herramientas del turno v2 (cotizar_pedido y crear_pedido) y se expande al formato del suelto", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await primerPedido(v);
    const hilo = await v.world.repo.whatsappAppendTurn(v.world.organizationId, TEL_CLIENTE, [], null, null, null);
    const nombres = hilo.flatMap((m) => (m.herramientas ?? []).map((h) => h.nombre));
    expect(nombres).toContain("cotizar_pedido");
    expect(nombres).toContain("crear_pedido");
    const suelto = hiloDelSuelto(hilo);
    expect(suelto.some((m) => m.role === "tool" && /"order"/.test(String(m.content)))).toBe(true);
  });

  it("10 min después, un crear_pedido con otro producto se rechaza como modificación (paridad con motivoOtroPedidoEnSesion)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await primerPedido(v);
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    const guardado = await v.world.repo.whatsappAppendTurn(v.world.organizationId, TEL_CLIENTE, [], null, null, null);
    const hilo = hiloDelSuelto(guardado);
    const conversacionReciente = guardado.map((m) => ({ role: m.role, content: m.content }));
    const input = { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items: [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 6 }] };
    const esperado = motivoOtroPedidoEnSesion(hilo, input, { ahoraMs: Date.now(), intencionAparte: null });
    expect(esperado).not.toBeNull();
    const r = await executeAgentToolSafely(v.world.repo, { organizationId: v.world.organizationId, channel: "whatsapp", phone: TEL_CLIENTE, entryPropertyId: v.t7, cerebroV2: true, hiloV2: hilo, conversacionReciente }, "crear_pedido", input);
    expect((r.result as { error?: string }).error).toBe(esperado);
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("sin pedido en la sesión, la guarda no interviene", () => {
    expect(motivoOtroPedidoEnSesion(hiloDelSuelto([{ role: "user", content: "hola" }]), { items: [] }, { ahoraMs: Date.now(), intencionAparte: null })).toBeNull();
  });
});
