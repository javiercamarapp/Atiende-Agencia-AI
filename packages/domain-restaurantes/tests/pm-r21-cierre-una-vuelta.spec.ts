// R21 (latencia): el «si» a un resumen VIGENTE cuesta 1 llamada real al modelo (solo el texto) en vez de 3 (confirmar_resumen, crear_pedido, texto). Modelo guionado, sin red ni llaves,
// datos 100 % sinteticos. "Vueltas del modelo" = peticiones que llegan al proveedor simulado (`v.requests`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cierreUnaVueltaActivo } from "../src/whatsapp/llm-turn-handler.ts";
import { contenidoDeMensajeConToque, idDeBoton } from "../src/whatsapp/botones-confirmacion.ts";
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
async function conResumen(v: Viaje, extra: Record<string, unknown> = { customer_name: "Ana Prueba" }) {
  v.guion([
    { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", items: items(v), ...extra } }] },
    { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" },
  ]);
  await v.escribe("dos cocas");
}
/** Lo que haria el modelo SIN ayuda del servidor: confirmar, crear, texto (3 respuestas). */
const guionSecuencial = (v: Viaje) => [
  { tools: [{ name: "confirmar_resumen", args: {} }] },
  { tools: [{ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo", items: items(v) } }] },
  { texto: "Su pedido ya quedó registrado." },
];
const vueltasDe = async (v: Viaje, body: string) => {
  const antes = v.requests.length;
  const r = await v.escribe(body);
  return { r, vueltas: v.requests.length - antes };
};

describe("R21: cierre del «si» en una sola llamada al modelo", () => {
  it("el interruptor: encendido por omision, apagado con 0/false/off/no", () => {
    expect(cierreUnaVueltaActivo({})).toBe(true);
    expect(cierreUnaVueltaActivo({ WHATSAPP_CIERRE_UNA_VUELTA: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", "no"]) expect(cierreUnaVueltaActivo({ WHATSAPP_CIERRE_UNA_VUELTA: off })).toBe(false);
  });

  it("sin el cambio (interruptor en 0): el «si» escrito gasta 3 llamadas al modelo", async () => {
    vi.stubEnv("WHATSAPP_CIERRE_UNA_VUELTA", "0");
    const v = await nuevoViaje();
    await conResumen(v);
    v.guion(guionSecuencial(v));
    const { vueltas } = await vueltasDe(v, "Sí, es correcto");
    expect(vueltas).toBe(3);
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("con el cambio: el «si» escrito gasta 1 llamada (solo el texto), crea UN pedido con lo cotizado y el modelo ve ambas herramientas ya ejecutadas", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    v.guion([{ texto: "Su pedido ya quedó registrado. Lo tendrá listo en unos 20 minutos." }]); // el modelo solo redacta el texto
    const { r, vueltas } = await vueltasDe(v, "Sí, es correcto");
    expect(vueltas).toBe(1);
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.total).toBe(106);
    expect(pedidos[0]!.customerName ?? "").toMatch(/Ana/);
    expect(r.orderId).toBe(pedidos[0]!.id);
    expect(r.reply).toMatch(/20 minutos/); // el texto es el del MODELO, no una plantilla del servidor
    const ultima = v.requests.at(-1)!;
    const llamadas = ultima.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
    expect(llamadas).toEqual(["confirmar_resumen", "crear_pedido"]);
  });

  it("idempotente: otro «si» despues no crea un segundo pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    v.guion([{ texto: "Listo, su pedido quedó registrado." }]);
    await v.escribe("Sí, es correcto");
    v.guion([{ texto: "Con gusto." }]);
    await v.escribe("sí, gracias");
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("toque «Confirmar pedido» vigente: 1 llamada y UN pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    const flow = await v.world.repo.readOrderFlow(v.world.organizationId, `wa:${TEL_CLIENTE}`);
    const ctx = flow!.context!;
    const cuerpo = contenidoDeMensajeConToque("Confirmar pedido", idDeBoton({ accion: "confirmar", quoteHash: ctx.quoteHash, quotedAtMs: ctx.quotedAtMs }));
    v.guion([{ texto: "Listo, su pedido quedó registrado." }]);
    const { vueltas } = await vueltasDe(v, cuerpo);
    expect(vueltas).toBe(1);
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("SIN nombre (cliente nuevo que no lo dio): el servidor no inventa datos, nada se crea antes del modelo y el camino de siempre sigue (el modelo pregunta)", async () => {
    const v = await nuevoViaje({ phone: "+5219995550177" });
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", items: items(v) } }] },
      { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" },
    ]);
    await v.escribe("dos cocas", { phone: "+5219995550177" });
    v.guion([{ texto: "¿A nombre de quién lo registro?" }]);
    const antes = v.requests.length;
    const r = await v.escribe("Sí, es correcto", { phone: "+5219995550177" });
    expect(v.requests.length - antes).toBe(1);
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).toMatch(/nombre/i);
  });

  it("un mensaje que NO es un «si» claro («mejor 3 cocas») no dispara el cierre: el modelo recotiza", async () => {
    const v = await nuevoViaje();
    await conResumen(v);
    v.guion([{ texto: "Claro, ¿le cotizo 3 Coca-Cola?" }]);
    const { vueltas } = await vueltasDe(v, "mejor 3 cocas");
    expect(vueltas).toBe(1);
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});
