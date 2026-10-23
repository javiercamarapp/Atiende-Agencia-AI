// PM Ronda 19, T7-043 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// Con la toma pendiente, pedir AGREGAR algo a un pedido ya hecho recibe el folio, el agregado y la opcion de envio aparte / pedirlo despues,
// y el aviso al equipo lleva lo que el cliente quiere agregar (antes: «quedo registrado su mensaje» y un aviso sin el agregado).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGREGADO_VENTANA_SEGUNDOS, esPeticionDeAgregado, sinEnlacesNiCorreos, recibirMensajeConEspera, responderTrasEspera, textoAgregadoEnToma } from "../src/whatsapp/inbound.ts";
import { createOrder } from "../src/orders.ts";
import { MARTES_14H, nuevoViaje, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const escalaCambio = { tools: [{ name: "escalar_a_humano", args: { customer_name: "Ana", motivo: "cancelacion_modificacion", resumen: "quiere agregar tacos" } }] };

async function conPedido(canal: "recoger" | "domicilio" = "recoger"): Promise<Viaje> {
  const v = await nuevoViaje();
  await createOrder(v.world.repo, {
    organizationId: v.world.organizationId,
    branchSlug: "garcia-lavin",
    customerName: "Ana Prueba",
    customerPhone: TEL_CLIENTE,
    ...(canal === "domicilio" ? { customerAddress: "Privada de prueba casa 3, Temozón Norte", colonia: "Temozón Norte" } : {}),
    canal,
    paymentMethod: "efectivo",
    source: "whatsapp",
    items: [{ productId: v.producto("Bistec de Res — 1 kg"), requestedQuantity: 1 }],
  });
  // La base real asigna el folio; el repositorio en memoria no: se fija para probar que el acuse y el aviso lo llevan.
  (v.world.repo as unknown as { orders: Array<{ orderNumber?: number }> }).orders.at(-1)!.orderNumber = 17;
  return v;
}

let seq = 0;
async function escribeConEspera(v: Viaje, body: string) {
  const messageId = `wamid.r19c-${++seq}`;
  const rec = await recibirMensajeConEspera(v.world.repo, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, body });
  expect(rec.estado).toBe("responder");
  return responderTrasEspera(v.world.repo, v.handler, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: v.gate, privacy: v.privacidad });
}

const NO_ES_AGREGADO_SIMPLE = [
  "cambia la dirección y agrega una coca",
  "mándalo a otra dirección y agrega coca",
  "agrega una coca, pero cambia mi pedido a recoger",
  "quita los tacos y agrega coca",
  "agrega coca, ya no quiero los tacos",
  "ya no, mejor agrega otra cosa",
  "no me agregaron la salsa",
  "quiero hacer otro pedido nuevo, agrega 3 tacos",
  "agrega una coca pero para otra sucursal",
  "agrega una coca gratis",
  "agrega una coca, ponle descuento",
  "agrega una orden de tacos y dime cuánto sale",
  "agrega 999999 tacos",
  "agrega algo",
  "quiero mi reembolso y que agreguen lo que faltó",
  "agregue una coca, tengo alergia",
  "cancelen todo y agreguen una coca",
  "ya salió?",
  "x".repeat(200) + " agregar",
];
const SI_ES_AGREGADO_SIMPLE = ["Agréguenme también 3 tacos de pastor", "¿le pudiera agregar 3 tacos de pastor tortilla maíz naturales?", "agregue una coca porfa", "Agrega una coca, por favor", "Disculpe, ¿me agrega 2 aguas de horchata? Gracias", "agrégale una orden de frijoles"];

describe("esPeticionDeAgregado (pura, lista blanca)", () => {
  it.each(SI_ES_AGREGADO_SIMPLE)("%s si", (t) => expect(esPeticionDeAgregado(t)).toBe(true));
  it.each(NO_ES_AGREGADO_SIMPLE)("%s no", (t) => expect(esPeticionDeAgregado(t)).toBe(false));
});

describe("sinEnlacesNiCorreos", () => {
  it("quita URLs y correos del texto que viaja al aviso", () => {
    const t = sinEnlacesNiCorreos("agrega coca https://ejemplo.invalid/x?a=1 o escribe a persona@ejemplo.invalid www.ejemplo.invalid");
    expect(t).not.toMatch(/ejemplo\.invalid|@/);
    expect(t).toMatch(/\[enlace\]/);
  });
});

describe("textoAgregadoEnToma (pura)", () => {
  it("domicilio: folio, agregado y ~60 min; no promete el mismo envio", () => {
    const t = textoAgregadoEnToma("Agréguenme 3 tacos de pastor", 17, "domicilio");
    expect(t).toMatch(/pedido #17/);
    expect(t).toMatch(/3 tacos de pastor/);
    expect(t).toMatch(/enviar aparte \(alrededor de una hora a domicilio, que la sucursal confirma\) o puede pedirlo después/);
    expect(t).toMatch(/no puedo prometerle que vaya en el mismo envío/i);
  });
  it("recoger: 25 a 35 minutos; sin folio, generico", () => {
    expect(textoAgregadoEnToma("agregue una coca", 5, "recoger")).toMatch(/entre 25 y 35 minutos para recoger, que la sucursal confirma/);
    expect(textoAgregadoEnToma("agregue una coca", null, null)).toMatch(/para su pedido/);
  });
});

describe("T7-043: agregado con la toma pendiente", () => {
  it.each(["directa", "espera"] as const)("ruta %s: acuse con folio + aviso al equipo con el agregado", async (ruta) => {
    const v = await conPedido("domicilio");
    v.guion([escalaCambio, { texto: "Se lo paso a cocina; le confirmo en un momento." }]);
    await v.escribe("Disculpe, ¿le pudiera agregar una coca a mi pedido?");
    vi.setSystemTime(new Date(Date.now() + 120_000));
    const llamadas = v.requests.length;
    const texto = "Agréguenme también 3 tacos de pastor";
    const r = ruta === "directa" ? await v.escribe(texto) : await escribeConEspera(v, texto);
    expect(v.requests.length).toBe(llamadas); // sin modelo
    expect(r.reply).toMatch(/pedido #17/);
    expect(r.reply).toMatch(/3 tacos de pastor/);
    expect(r.reply).toMatch(/enviar aparte.*alrededor de una hora.*pedirlo después/);
    expect(r.reply).not.toMatch(/quedó registrado su mensaje/);
    const aviso = v.callbacks.find((c) => /agregado con la toma ya abierta/.test(c.message ?? ""));
    expect(aviso?.message).toMatch(/3 tacos de pastor/);
    expect(aviso?.message).toMatch(/Pedido #17/);
  });

  it.each(NO_ES_AGREGADO_SIMPLE.filter((t) => t.length < 100))("%s con pedido en preparacion: acuse de siempre en ambas rutas", async (frase) => {
    for (const ruta of ["directa", "espera"] as const) {
      const v = await conPedido("domicilio");
      v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
      await v.escribe("¿Me agrega una coca a mi pedido?");
      vi.setSystemTime(new Date(Date.now() + 120_000));
      const r = ruta === "directa" ? await v.escribe(frase) : await escribeConEspera(v, frase);
      expect(r.reply ?? "").not.toMatch(/Anoté su agregado/);
      expect(v.callbacks.some((c) => /agregado con la toma ya abierta/.test(c.message ?? ""))).toBe(false);
    }
  });

  it("no es agregado (pregunta cualquiera): acuse de siempre", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega una coca a mi pedido?");
    vi.setSystemTime(new Date(Date.now() + 120_000));
    const r = await v.escribe("¿A qué hora cierran?");
    expect(r.reply ?? "").not.toMatch(/Anoté su agregado/);
  });

  it("20 agregados seguidos: el texto sale una vez por ventana", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega una coca a mi pedido?");
    vi.setSystemTime(new Date(Date.now() + 120_000));
    let con = 0;
    for (let i = 0; i < 20; i++) if (/Anoté su agregado/.test((await v.escribe("Agréguenme 3 tacos de pastor")).reply ?? "")) con += 1;
    expect(con).toBe(1);
    vi.setSystemTime(new Date(Date.now() + (AGREGADO_VENTANA_SEGUNDOS + 1) * 1000));
    expect((await v.escribe("Agréguenme 3 tacos de pastor")).reply).toMatch(/Anoté su agregado/);
  });

  it("agente apagado en la sucursal: no se usa el texto fijo", async () => {
    const v = await conPedido();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await v.escribe("¿Me agrega una coca a mi pedido?");
    await v.world.repo.fijarAgenteWhatsappActivo(v.world.organizationId, v.t7, "00000000-0000-4000-8000-0000000000f1", false);
    vi.setSystemTime(new Date(Date.now() + 120_000));
    expect((await v.escribe("Agréguenme 3 tacos de pastor")).reply ?? "").not.toMatch(/Anoté su agregado/);
  });
});
