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

  // --- Cierre adelantado + resumen canonico (#662) + ultimo pedido por tipo (#665) ---
  const enMerida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
  const cotiza = (v: Viaje, canal: "domicilio" | "recoger", extra: Record<string, unknown> = {}, total = canal === "domicilio" ? 212 : 106) =>
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal, payment_method: "efectivo", customer_name: "Ana Prueba", items: canal === "domicilio" ? [{ ...items(v)[0]!, requested_quantity: 4 }] : items(v), ...extra } }] },
      { texto: `Permítame repetirle su pedido. Total $${total}.00. ¿Es correcto?` },
    ]);

  it("«si» tras un resumen con direccion y salsas: el pedido sale con la direccion y las salsas del resumen, en 1 llamada", async () => {
    vi.setSystemTime(enMerida("2026-10-13", "19:00")); // martes abre a las 18:00
    const v = await nuevoViaje();
    const PASTOR = "Pastor — 500 g"; // platillo con salsas incluidas: la doble salsa solo aplica a esos
    const itemsSalsa = [{ product_id: v.producto(PASTOR), product_name: PASTOR, requested_quantity: 1 }, { product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 2 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Ana Prueba", payment_method: "efectivo", doble_salsas: ["salsa_verde"], items: itemsSalsa } }] },
      { texto: "Permítame repetirle su pedido: 1/2 kg de pastor con doble salsa verde y 2 Coca-Cola. Total $575.00. ¿Es correcto?" },
    ]);
    await v.escribe("dos cocas a domicilio con doble salsa verde");
    const flow = await v.world.repo.readOrderFlow(v.world.organizationId, `wa:${TEL_CLIENTE}`);
    expect(flow?.context?.quotedTotal, JSON.stringify(v.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content))).toBeTypeOf("number");
    v.guion([{ texto: "Su pedido ya quedó registrado." }]);
    const { vueltas } = await vueltasDe(v, "Sí, es correcto");
    expect(vueltas).toBe(1);
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(JSON.stringify(pedidos[0])).toMatch(/Calle 60/);
    const llamadas = v.requests.at(-1)!.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls : []));
    const crear = llamadas.find((c) => c.name === "crear_pedido")!;
    expect(JSON.parse(crear.argumentsJson)).toMatchObject({ customer_address: "Calle 60 #123 entre 21 y 23", colonia_entrega: "Temozón Norte", doble_salsas: ["salsa_verde"] });
  });

  it("T7 ultimo pedido de DOMICILIO 23:15: el «si» de las 23:16 (cotizado a las 23:10) NO crea pedido; el modelo ve el rechazo y lo explica", async () => {
    vi.setSystemTime(enMerida("2026-10-13", "23:10"));
    const v = await nuevoViaje();
    cotiza(v, "domicilio", { colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123" });
    await v.escribe("dos cocas a domicilio");
    const flow = await v.world.repo.readOrderFlow(v.world.organizationId, `wa:${TEL_CLIENTE}`);
    expect(flow?.context?.quotedTotal, JSON.stringify(v.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content))).toBeTypeOf("number");
    vi.setSystemTime(enMerida("2026-10-13", "23:16"));
    v.guion([{ texto: "Lo siento, ya pasó el último pedido a domicilio (23:15). Puede recoger hasta las 12:30 de la noche." }]);
    const { r, vueltas } = await vueltasDe(v, "Sí, es correcto");
    expect(vueltas).toBe(1);
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.orderId).toBeNull();
    const resultados = v.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(resultados).toMatch(/ya no toma pedidos|último pedido|ultimo pedido/i);
    expect(r.reply).toMatch(/último pedido/);
  });

  it("T7 ultimo pedido de RECOGER 00:30: el «si» de las 00:29 crea el pedido; el de las 00:31 no (control del mismo tipo)", async () => {
    vi.setSystemTime(enMerida("2026-10-14", "00:20"));
    const v = await nuevoViaje();
    cotiza(v, "recoger");
    await v.escribe("dos cocas para recoger");
    vi.setSystemTime(enMerida("2026-10-14", "00:29"));
    v.guion([{ texto: "Su pedido ya quedó registrado." }]);
    const ok = await vueltasDe(v, "Sí, es correcto");
    expect(ok.vueltas).toBe(1);
    expect(await pedidosDe(v), JSON.stringify(v.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content))).toHaveLength(1);

    const w = await nuevoViaje({ phone: "+5219995550177" });
    vi.setSystemTime(enMerida("2026-10-14", "00:20"));
    cotiza(w, "recoger");
    await w.escribe("dos cocas para recoger", { phone: "+5219995550177" });
    vi.setSystemTime(enMerida("2026-10-14", "00:31"));
    w.guion([{ texto: "Lo siento, ya pasó el último pedido para recoger." }]);
    const r = await w.escribe("Sí, es correcto", { phone: "+5219995550177" });
    expect(await pedidosDe(w)).toHaveLength(0);
    expect(r.orderId ?? null).toBeNull();
    expect(r.reply).toMatch(/último pedido/);
  });
});
