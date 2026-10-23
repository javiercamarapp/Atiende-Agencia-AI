// PM Ronda 19, G7-8-10 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// Con la toma pendiente, «¿ya salio mi pedido?» recibe el estado que marco la sucursal aunque llegue dentro del minuto del acuse anterior
// (antes el limitador de recordatorios lo dejaba sin respuesta).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTADO_TOMA_VENTANA_SEGUNDOS, esPreguntaDeEstadoSegura, handleInboundWhatsAppMessage, recibirMensajeConEspera, responderTrasEspera, textoEstadoEnTomaPendiente } from "../src/whatsapp/inbound.ts";
import { createOrder } from "../src/orders.ts";
import { classifyHighRiskIntent } from "../src/whatsapp/guards.ts";
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

const ESTADO_FIJO = /figura registrado|va en preparación|marcó su pedido/i;
const FRASES_DE_RIESGO = [
  "Ya salió el repartidor y el pedido llegó frío, quiero reembolso",
  "Cuánto falta para que me devuelvan mi dinero",
  "quiero cancelar, ya salió?",
  "ya esta listo, cancelen todo",
  "falta mucho? ya quiero mi reembolso",
  "Ya lo mandaron pero llegó incompleto",
  "cuanto tarda el reembolso",
  "ya está en camino? cancela",
  "como va mi pedido, tengo alergia",
  // 2.ª revision: lenguaje de riesgo o de cambio que una lista negra no cubre
  "ya lo enviaron y me enferme",
  "ya salió, hay un pelo",
  "ya salio, voy a llamar a profeco",
  "ya salio, abogado",
  "ya salio, anulen el pedido",
  "ya salió, den de baja",
  "ya salió, cambien la direccion",
  "manden a otra dirección, ya salió?",
  "ya salió, agreguen una coca",
  "cuanto falta pa que me regresen la lana",
  "falta mucho? quiero mi lana",
  "estafadores, ya salió?",
  "ya salió, esto es un robo",
  "ya salió, fraude",
  "ladrones, cuanto falta",
  "pésimo servicio, ya salió?",
  "qué asco, ya salió?",
  "pinche servicio, falta mucho?",
];

describe("pregunta de estado: solo mensajes cortos y sin senal de riesgo", () => {
  it.each(FRASES_DE_RIESGO)("%s no recibe el texto fijo de estado (predicado)", (frase) => {
    expect(esPreguntaDeEstadoSegura(frase)).toBe(false);
    expect(textoEstadoEnTomaPendiente(frase, { estado: "salio", canal: "domicilio" })).toBeNull();
  });
  it.each(["¿Ya salió mi pedido?", "ya esta listo?", "¿Cuánto falta?", "¿falta mucho?", "como va mi pedido?", "Ya salió porfa", "ya salio mi orden, gracias", "¡Ya está en camino!", "ya lo mandaron?", "Disculpe, ¿cuánto se tarda?"])("%s si es pregunta de estado", (frase) => {
    expect(esPreguntaDeEstadoSegura(frase)).toBe(true);
  });
  it("mensaje largo no cuenta aunque contenga la frase", () => {
    expect(esPreguntaDeEstadoSegura("Buenas tardes, disculpe la molestia, quisiera saber por favor si ya salió mi pedido de hoy")).toBe(false);
  });

  it.each(FRASES_DE_RIESGO)("%s con la toma pendiente: ninguna rama devuelve el texto de estado (ruta directa y con espera)", async (frase) => {
    for (const ruta of ["directa", "espera"] as const) {
      const v = await conPedido();
      v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
      await v.escribe("¿Me agrega un guacamole a mi pedido?");
      vi.setSystemTime(new Date(Date.now() + 120_000));
      const r = ruta === "directa" ? await v.escribe(frase) : await escribeConEspera(v, frase);
      expect(r.reply ?? "").not.toMatch(ESTADO_FIJO);
    }
  });
});

describe("estado con toma pendiente: R16 y repeticion", () => {
  it("agente apagado en la sucursal: no se usa el texto de estado", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega un guacamole a mi pedido?");
    await v.world.repo.fijarAgenteWhatsappActivo(v.world.organizationId, v.t7, "00000000-0000-4000-8000-0000000000f1", false);
    vi.setSystemTime(new Date(Date.now() + 120_000));
    const r = await v.escribe("¿Ya salió mi pedido?");
    expect(r.reply ?? "").not.toMatch(ESTADO_FIJO);
  });

  it("compuerta sin `acusePendiente`: se comporta como antes (sin texto de estado)", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega un guacamole a mi pedido?");
    const gateSinAcuse = { estadoParaAgente: v.gate.estadoParaAgente.bind(v.gate), solicitarHumano: v.gate.solicitarHumano.bind(v.gate) };
    const r = await handleInboundWhatsAppMessage(v.world.repo, v.handler, { organizationId: v.world.organizationId, messageId: "wamid.sin-acuse", phone: TEL_CLIENTE, body: "¿Ya salió mi pedido?", phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: gateSinAcuse as never, privacy: v.privacidad });
    expect(r.reply ?? "").not.toMatch(ESTADO_FIJO);
  });

  it("20 «¿ya salió?» seguidos: el texto de estado sale una vez por ventana, no 20", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega un guacamole a mi pedido?");
    vi.setSystemTime(new Date(Date.now() + 120_000));
    let con = 0;
    for (let i = 0; i < 20; i++) {
      const r = await v.escribe("¿ya salió?");
      if (ESTADO_FIJO.test(r.reply ?? "")) con += 1;
    }
    expect(con).toBe(1);
    vi.setSystemTime(new Date(Date.now() + (ESTADO_TOMA_VENTANA_SEGUNDOS + 1) * 1000));
    expect(ESTADO_FIJO.test((await v.escribe("¿ya salió?")).reply ?? "")).toBe(true);
  });
});

describe("A32: la frase «lo paso a cocina» solo con el pedido en cocina", () => {
  it("pedido registrado: la dice; pedido ya salido: no promete cocina", () => {
    const base = { canal: "recoger" as const, sucursal: null, confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: 5 };
    expect(classifyHighRiskIntent("quiero cancelar mi pedido", { pedidoReciente: { ...base, estado: "registrado" } })?.reply).toMatch(/se lo paso a cocina/i);
    expect(classifyHighRiskIntent("quiero cancelar mi pedido", { pedidoReciente: { ...base, estado: "preparando" } })?.reply).toMatch(/se lo paso a cocina/i);
    const salido = classifyHighRiskIntent("quiero cancelar mi pedido", { pedidoReciente: { ...base, estado: "salio" } })?.reply;
    expect(salido).toBeTruthy();
    expect(salido).not.toMatch(/cocina/i);
  });
});
