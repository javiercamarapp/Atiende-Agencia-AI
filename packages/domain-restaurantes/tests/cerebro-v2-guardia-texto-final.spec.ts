// Cerebro v2, plan de conexión paso 1 (SUELTO-VS-718-V2.md, B3 pasos 3-4 del suelto, whatsapp-agent-core.ts ~7777-7787):
//  - con el pedido creado en el turno, el texto del modelo no dice que «no se pudo registrar» (R82-4): sale la confirmación del servidor;
//  - con el pedido del número por aprobar (pedido grande retenido), el texto no dice que ya está confirmado, en cocina o en camino (R87-T/R88-4):
//    acuse del cambio + PEDIDO_POR_APROBAR_REPLY;
//  - un crear_pedido con error del sistema y sin pedido: el texto lo arma el servidor y se deja el aviso `operativo:pedido_no_registrado` (R81-G/R83-2).
// Paridad: la respuesta es la misma que da `guardiaTextoFinal` (puerto literal del suelto) con las mismas entradas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { guardiaTextoFinal, MOTIVO_PEDIDO_NO_REGISTRADO, PEDIDO_NO_REGISTRADO_INTERNO, PEDIDO_POR_APROBAR_REPLY } from "../src/whatsapp/cerebro-v2/texto-final.ts";

const enMerida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);

describe("cerebro v2: guardia del texto final del suelto conectada al turno", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enMerida("2026-10-13", "19:00"));
  });
  afterEach(() => vi.useRealTimers());

  async function hastaElResumen(v: Viaje) {
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
  }

  it("pedido creado en el turno y el modelo dice que no se pudo: confirmación del servidor (paridad con guardiaTextoFinal)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await hastaElResumen(v);
    const FALSO = "Lo siento, no se pudo registrar su pedido. ¿Lo intentamos de nuevo?";
    v.guion([{ texto: FALSO }]);
    const r = await v.escribe("Sí, así está bien");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    const suelto = guardiaTextoFinal(FALSO, { pedidoCreadoEnTurno: true, orderId: pedidos[0]!.id, pedidoPorAprobar: false, productosDevueltosPorHerramientas: [], productoPrometidoEnMenu: null });
    expect(suelto.reemplazado).toBe(true);
    expect(r.reply).not.toMatch(/no se pudo registrar/i);
    expect(r.reply).toContain(suelto.texto);
  });

  it("pedido del número por aprobar y el modelo dice que va en camino: acuse + PEDIDO_POR_APROBAR_REPLY", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await hastaElResumen(v);
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    const [pedido] = await pedidosDe(v);
    // La sucursal aún no lo aprueba (pedido grande retenido por el autopiloto).
    const guardados = (v.world.repo as unknown as { orders: Array<{ id: string; status: string }> }).orders;
    guardados.find((o) => o.id === pedido!.id)!.status = "por_aprobar";
    const FALSO = "Ya avisé a la sucursal. Su pedido ya está en camino, llega en 40 minutos.";
    v.guion([{ texto: FALSO }]);
    const r = await v.escribe("¿Ya viene mi pedido? Y que no le pongan hielo a las cocas");
    const suelto = guardiaTextoFinal(FALSO, { pedidoCreadoEnTurno: false, pedidoPorAprobar: true, productosDevueltosPorHerramientas: [], productoPrometidoEnMenu: null, pedidoPrevioRegistrado: true });
    expect(suelto.texto).toContain(PEDIDO_POR_APROBAR_REPLY);
    expect(r.reply).not.toMatch(/en camino|40 minutos/i);
    expect(r.reply).toContain(PEDIDO_POR_APROBAR_REPLY);
    expect(r.reply).toContain(suelto.texto);
  });

  it("crear_pedido con error del sistema y sin pedido: texto del servidor y aviso operativo:pedido_no_registrado", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await hastaElResumen(v);
    v.world.repo.createOrderIdempotent = async () => {
      throw new Error("conexion perdida");
    };
    v.guion([{ tools: [{ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items: [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }] } }] }, { texto: "¡Listo! Su pedido quedó registrado, llega en 40 minutos." }]);
    const r = await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).not.toMatch(/qued[oó] registrado/i);
    expect(r.reply).toContain(PEDIDO_NO_REGISTRADO_INTERNO);
    expect(v.callbacks.some((c) => c.reason === MOTIVO_PEDIDO_NO_REGISTRADO)).toBe(true);
  });

});
