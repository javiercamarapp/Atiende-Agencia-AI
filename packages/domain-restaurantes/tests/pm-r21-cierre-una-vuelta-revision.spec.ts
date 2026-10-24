// R21, hallazgos de la revision independiente: toques mezclados en una rafaga, texto del modelo que contradice al servidor tras el pedido adelantado,
// rechazo de regla del pedido adelantado, y lectura fallida del estado fresco. Modelo guionado, sin red ni llaves, datos sinteticos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textoContradiceConfirmacion } from "../src/whatsapp/llm-turn-handler.ts";
import { idDeBoton } from "../src/whatsapp/botones-confirmacion.ts";
import { recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
import { MARTES_14H, nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const items = (v: Viaje) => [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 2 }];
async function conResumen(v: Viaje) {
  v.guion([
    { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", items: items(v), customer_name: "Ana Prueba" } }] },
    { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" },
  ]);
  await v.escribe("dos cocas");
}
async function toques(v: Viaje) {
  const flow = await v.world.repo.readOrderFlow(v.world.organizationId, `wa:${TEL_CLIENTE}`);
  const ctx = flow!.context!;
  const id = (accion: "confirmar" | "cambiar") => idDeBoton({ accion, quoteHash: ctx.quoteHash, quotedAtMs: ctx.quotedAtMs });
  return { confirmar: id("confirmar"), cambiar: id("cambiar") };
}
/** Rafaga: cada mensaje se agrega al historial (fase A) y UN solo turno contesta todo (fase B). */
async function rafaga(v: Viaje, mensajes: ReadonlyArray<{ body: string; botonId?: string }>) {
  const base = { organizationId: v.world.organizationId, phone: TEL_CLIENTE };
  let primero = "";
  for (const [i, m] of mensajes.entries()) {
    const messageId = `wamid.r21-rev-${Date.now()}-${i}`;
    if (i === 0) primero = messageId;
    await recibirMensajeConEspera(v.world.repo, { ...base, messageId, body: m.body, ...(m.botonId ? { botonId: m.botonId } : {}) });
  }
  return responderTrasEspera(v.world.repo, v.handler, { ...base, messageId: primero, phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: v.gate, privacy: v.privacidad, deliverReply: false });
}

describe("R21 revision: toques mezclados en una rafaga NO confirman", () => {
  it("[Cambiar, Confirmar]: el cliente pidio cambiar algo, el servidor no crea el pedido por su cuenta", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    const t = await toques(v);
    v.guion([{ texto: "Claro, ¿qué desea cambiar?" }]);
    await rafaga(v, [{ body: "Cambiar algo", botonId: t.cambiar }, { body: "Confirmar pedido", botonId: t.confirmar }]);
    expect(await pedidosDe(v)).toHaveLength(0);
    const llamadas = v.requests.at(-1)!.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
    expect(llamadas).not.toContain("crear_pedido");
  });

  it("[Confirmar, Cambiar]: el ultimo toque es Cambiar, tampoco se crea", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    const t = await toques(v);
    v.guion([{ texto: "Claro, ¿qué desea cambiar?" }]);
    await rafaga(v, [{ body: "Confirmar pedido", botonId: t.confirmar }, { body: "Cambiar algo", botonId: t.cambiar }]);
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("[Confirmar, Confirmar] (doble toque): todos confirman, un solo pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    const t = await toques(v);
    v.guion([{ texto: "Listo, su pedido quedó registrado." }]);
    await rafaga(v, [{ body: "Confirmar pedido", botonId: t.confirmar }, { body: "Confirmar pedido", botonId: t.confirmar }]);
    expect(await pedidosDe(v)).toHaveLength(1);
  });
});

describe("R21 revision: el texto del modelo tras el pedido adelantado no contradice al servidor", () => {
  it("el modelo dice «no pude registrarlo» y cambia el total: la respuesta es la confirmacion del servidor", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    v.guion([{ texto: "Lo siento, no pude registrarlo. El total sería $999.00 y estará listo a las 3:45." }]);
    const r = await v.escribe("Sí, es correcto");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(r.reply).not.toMatch(/no pude/i);
    expect(r.reply).not.toMatch(/999/);
    expect(r.reply).toMatch(/106/);
  });

  it("textoContradiceConfirmacion: niega, monto u hora ajenos; un texto coherente pasa", () => {
    const srv = "Su pedido quedó registrado. Total $106.00. Lo tendrá listo a las 14:20.";
    expect(textoContradiceConfirmacion("No alcancé a registrarlo.", srv)).toBe(true);
    expect(textoContradiceConfirmacion("Total $99.00", srv)).toBe(true);
    expect(textoContradiceConfirmacion("Listo a las 15:00", srv)).toBe(true);
    expect(textoContradiceConfirmacion("Listo, quedó registrado por $106.00 a las 14:20. ¡Gracias!", srv)).toBe(false);
    expect(textoContradiceConfirmacion("Quedó registrado. Lo tendrá en unos 20 minutos.", srv)).toBe(false);
  });
});

describe("R21 revision: pedido adelantado rechazado por regla", () => {
  it("el ultimo pedido de la sucursal paso entre el resumen y el «si»: el modelo lo explica y no se crea pedido", async () => {
    // Resumen a las 00:20 (Merida); el ultimo pedido se toma a las 00:30 (30 min antes del cierre). El «si» llega a las 00:35, aun dentro de los 20 min de vigencia.
    vi.setSystemTime(new Date("2026-10-14T06:20:00Z"));
    const v = await nuevoViaje();
    await conResumen(v);
    vi.setSystemTime(new Date("2026-10-14T06:35:00Z"));
    v.guion([{ texto: "Lo siento, ya pasó la hora del último pedido y no pude registrarlo. Abrimos mañana a las 12:00." }]);
    const antes = v.requests.length;
    const r = await v.escribe("Sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(v.requests.length - antes).toBe(1);
    const resultados = v.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados.join(" ")).toMatch(/cerrad|abre|horario|cierr/i);
    expect(r.reply).toMatch(/último pedido/i);
    expect(r.orderId).toBeNull();
  });
});

describe("R21 revision: lectura fallida del estado fresco deja libre el respaldo R18", () => {
  it("si readOrderFlow falla una vez al adelantar, no se marca como intentado y el pedido igual se crea por el camino de siempre", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    const original = v.world.repo.readOrderFlow.bind(v.world.repo);
    let fallos = 0;
    let llamadas = 0;
    v.world.repo.readOrderFlow = async (...a: Parameters<typeof original>) => {
      llamadas += 1;
      // La lectura fresca del adelantado es la primera tras el estado inicial; se hace fallar una sola vez.
      if (fallos === 0 && llamadas >= 2) { fallos += 1; throw new Error("lectura transitoria"); }
      return original(...a);
    };
    v.guion([
      { tools: [{ name: "confirmar_resumen", args: {} }] },
      { tools: [{ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo", items: items(v) } }] },
      { texto: "Su pedido ya quedó registrado." },
    ]);
    await v.escribe("Sí, es correcto");
    expect(fallos).toBe(1);
    expect(await pedidosDe(v)).toHaveLength(1);
  });
});
