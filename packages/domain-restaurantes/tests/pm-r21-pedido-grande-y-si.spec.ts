// PM Ronda 21 (T7-061, P0). Datos 100 % sinteticos, modelo guionado, sin LLM ni llaves.
// (1) `pedido_grande` lo fija SOLO el servidor: si el modelo lo manda en `escalar_a_humano` con una compra normal se rechaza y NO se abre una toma de handoff.
// (2) Con una toma `pendiente` y el pedido ya cotizado, el «sí» al resumen no recibe el acuse fijo: pasa al agente y el pedido se crea (una sola vez).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJE_PEDIDO_GRANDE_SOLO_SERVIDOR, solicitudEsPedidoGrande, toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { ACUSE_HANDOFF_REPETIDO } from "../src/whatsapp/inbound.ts";
import { MARTES_14H, nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const PASTOR = "Pastor — 500 g";
const items = (v: Viaje) => [{ product_id: v.producto(PASTOR), product_name: PASTOR, requested_quantity: 1 }];
const cotizar = (v: Viaje, cantidad = 1) => ({ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", customer_name: "Ana Prueba", items: items(v).map((i) => ({ ...i, requested_quantity: cantidad })) } });
const motivos = (v: Viaje) => v.callbacks.map((c) => c.reason);

describe("T7-061: pedido_grande solo lo fija el servidor", () => {
  it("el enum de la herramienta para el modelo ya no ofrece pedido_grande", () => {
    const def = toolDefinitionsForChannel("whatsapp").find((t) => t.name === "escalar_a_humano")!;
    const enumMotivos = (def.parameters.properties.motivo as { enum: string[] }).enum;
    expect(enumMotivos).not.toContain("pedido_grande");
    expect(enumMotivos).toContain("tiempos_entrega");
  });

  it("compra normal (bajo el umbral): el modelo escala con pedido_grande -> rechazado, sin aviso ni toma de handoff", async () => {
    const v = await nuevoViaje();
    v.guion([
      { tools: [cotizar(v)] },
      { tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_grande", resumen: "Solicitud de 1/4 kg de pechuga" } }] },
      { texto: "Permítame repetirle su pedido. ¿Es correcto?" },
    ]);
    await v.escribe("quiero medio kilo de pastor para recoger");
    expect(motivos(v)).not.toContain("escalada:pedido_grande");
    expect(v.conversaciones.handoffs).toHaveLength(0);
    // La herramienta le dijo al modelo por que (error de regla) y le indico el camino.
    const vistos = JSON.stringify(v.requests.at(-1)?.messages ?? []);
    expect(vistos).toContain(MENSAJE_PEDIDO_GRANDE_SOLO_SERVIDOR.slice(0, 40));
  });

  it("pedido realmente grande (la cotizacion supera el umbral): el aviso pedido_grande sigue saliendo", async () => {
    const v = await nuevoViaje();
    v.guion([
      { tools: [cotizar(v, 12)] },
      { tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_grande", resumen: "12 x pastor 500 g" } }] },
      { texto: "La sucursal ya fue avisada y le confirmará." },
    ]);
    await v.escribe("quiero 12 de pastor de medio kilo para recoger");
    // 12 x $450 = $5,400 > umbral: el servidor lo confirma.
    expect(motivos(v)).toContain("escalada:pedido_grande");
  });
});

describe("T7-061: el «sí» al resumen con una toma pendiente crea el pedido (sin duplicar)", () => {
  async function cotizadoConTomaPendiente(): Promise<Viaje> {
    const v = await nuevoViaje();
    v.guion([{ tools: [cotizar(v)] }, { tools: [{ name: "escalar_a_humano", args: { motivo: "modificacion_platillo", resumen: "Nota de acceso: tocar timbre" } }] }, { texto: "Permítame repetirle su pedido:\n- 1 Pastor — 500 g\nTotal a pagar: $450.00 en efectivo, para recoger.\n¿Es correcto?" }]);
    await v.escribe("quiero medio kilo de pastor para recoger");
    expect(v.conversaciones.handoffs[0]?.estado).toBe("pendiente");
    return v;
  }
  const crear = (v: Viaje) => ({ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana Prueba", items: items(v), payment_method: "efectivo", hora_recogida: "2026-10-13T14:40:00-06:00" } });

  it("«Sí» con el pedido cotizado: no recibe ACUSE_HANDOFF_REPETIDO y el pedido se crea una sola vez; el reenvío del mismo mensaje no duplica", async () => {
    const v = await cotizadoConTomaPendiente();
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear(v)] }, { texto: "Listo, su pedido quedó registrado." }]);
    const r = await v.escribe("Sí, es correcto", { messageId: "wamid.si-1" });
    expect(r.reply).not.toBe(ACUSE_HANDOFF_REPETIDO);
    expect(await pedidosDe(v)).toHaveLength(1);
    const dup = await v.escribe("Sí, es correcto", { messageId: "wamid.si-1" });
    expect(dup).toEqual({ ok: true, retryable: false });
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("un mensaje que NO es un «sí» corto (una queja, una pregunta) con el pedido cotizado sigue por la toma: acuse fijo y el modelo no corre", async () => {
    const v = await cotizadoConTomaPendiente();
    const antes = v.requests.length;
    const r = await v.escribe("¿alguien me atiende? llevo rato esperando");
    expect(r.reply).toBe(ACUSE_HANDOFF_REPETIDO);
    expect(v.requests.length).toBe(antes);
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("sin pedido cotizado, hasta un «sí» sigue por la toma pendiente (comportamiento de siempre)", async () => {
    const v = await nuevoViaje();
    await v.escribe("quiero hablar con una persona");
    const r = await v.escribe("sí");
    expect(r.reply).toBe(ACUSE_HANDOFF_REPETIDO);
  });
});

describe("T7-061: la solicitud realmente grande del cliente SI escala con pedido_grande", () => {
  it.each(["Necesito 60 ordenes de tacos para un evento", "quiero 40 kg de pastor", "mil tacos para el sabado", "99999 tacos"])("grande: %s", (t) => {
    expect(solicitudEsPedidoGrande(t)).toBe(true);
  });
  it.each(["1/4 de pechuga, 1 kilo de bistec", "2 ordenes de gringas", "5 kg de pastor", "quiero 12 tacos", "Solicitud de 1/4 kg de pechuga por $237.50"])("normal: %s", (t) => {
    expect(solicitudEsPedidoGrande(t)).toBe(false);
  });

  it("el modelo escala con pedido_grande tras «60 ordenes» (sin cotizacion): se acepta y queda el aviso", async () => {
    const v = await nuevoViaje();
    v.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_grande", resumen: "60 ordenes de tacos" } }] }, { texto: "Ya avisé al equipo." }]);
    await v.escribe("Necesito 60 ordenes de tacos para un evento el sabado");
    expect(motivos(v)).toContain("escalada:pedido_grande");
  });

  it("40 kg: se acepta; un pedido normal de $237.50 con mensaje normal sigue rechazado", async () => {
    const v = await nuevoViaje();
    v.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_grande", resumen: "40 kg" } }] }, { texto: "Listo." }]);
    await v.escribe("quiero 40 kg de pastor para recoger");
    expect(motivos(v)).toContain("escalada:pedido_grande");
    const w = await nuevoViaje();
    w.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_grande", resumen: "1/4 kg de pechuga" } }] }, { texto: "Listo." }]);
    await w.escribe("quiero 1/4 kg de pechuga para recoger");
    expect(motivos(w)).not.toContain("escalada:pedido_grande");
  });
});
