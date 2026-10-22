// PM Ronda 18, G7-8-10 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// En la ruta de PRODUCCION (espera de mensajes) una queja con detalle deja el aviso `queja` aunque ya haya una toma pendiente por un cambio.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
import { MARTES_14H, nuevoViaje, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const min = (n: number) => n * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const motivos = (v: Viaje) => v.callbacks.map((c) => c.reason);
// La negacion fija del servidor («yo no puedo prometerle una reposicion ni un descuento») no es una promesa.
const promete = (reply: string | undefined) => /reembols|devoluci[oó]n de (?:su )?dinero|de cortes[ií]a|descuento|reposici[oó]n|en \d+ minutos|aproximadamente/i.test((reply ?? "").replace(/(?:yo )?no puedo prometerle[^.]*\./gi, "").replace(/no hacemos devoluciones de dinero[^.;]*[.;]/gi, ""));

let seq = 0;
/** Ruta de produccion con espera de mensajes: fase A (guardar) + fase B (contestar). */
async function escribeConEspera(v: Viaje, body: string) {
  const messageId = `wamid.r18-${++seq}`;
  const rec = await recibirMensajeConEspera(v.world.repo, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, body });
  expect(rec.estado).toBe("responder");
  return responderTrasEspera(v.world.repo, v.handler, { organizationId: v.world.organizationId, messageId, phone: TEL_CLIENTE, phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: v.gate, privacy: v.privacidad });
}

const escalaCambio = { tools: [{ name: "escalar_a_humano", args: { customer_name: "Ana", motivo: "cancelacion_modificacion", resumen: "quiere agregar un guacamole" } }] };

describe("G7-8-10: la queja deja su aviso `queja` en la ruta con espera de mensajes", () => {
  it("cambio escalado (toma pendiente) y luego la queja con detalle: queda `queja` ademas de `cancelacion_modificacion`, sin promesas", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina; le confirmo en un momento." }]);
    const r1 = await escribeConEspera(v, "Disculpe, ¿le pudiera agregar un guacamole a mi pedido?");
    expect(r1.ok).toBe(true);
    expect(motivos(v)).toEqual(["escalada:cancelacion_modificacion"]);
    avanza(min(2));
    const llamadas = v.requests.length;
    const r2 = await escribeConEspera(v, "Recibí el pedido pero no mandaron el guacamole");
    expect(motivos(v)).toEqual(["escalada:cancelacion_modificacion", "escalada:queja"]);
    expect(v.requests.length).toBe(llamadas); // sin modelo: la toma pendiente sigue callando al agente
    expect(r2.reply).toBeTruthy();
    expect(promete(r2.reply)).toBe(false);
    const queja = v.callbacks.find((c) => c.reason === "escalada:queja");
    expect(queja?.message).toMatch(/guacamole/i);
    expect(queja?.message).toMatch(/queja/i);
  });

  it("la queja llega dentro del minuto del acuse anterior (el acuse se silencia, el aviso NO)", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await escribeConEspera(v, "¿Me agrega un guacamole a mi pedido?");
    await escribeConEspera(v, "¿Ya salió mi pedido?");
    await escribeConEspera(v, "Recibí el pedido pero no mandaron el guacamole");
    expect(motivos(v)).toContain("escalada:queja");
  });

  it("exigir dinero: se avisa como queja, se aclara que no hay devoluciones y no se promete reembolso", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await escribeConEspera(v, "¿Me agrega un guacamole a mi pedido?");
    avanza(min(2));
    const r = await escribeConEspera(v, "No me mandaron el guacamole de mi pedido, quiero mi dinero de vuelta");
    expect(motivos(v)).toContain("escalada:queja");
    expect(r.reply).toMatch(/no hacemos devoluciones de dinero/i);
    expect(r.reply).not.toMatch(/le (?:devolvemos|reembolsamos)|haremos el reembolso/i);
  });

  it("un mensaje que NO es queja con la toma pendiente no crea el aviso `queja`", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await escribeConEspera(v, "¿Me agrega un guacamole a mi pedido?");
    avanza(min(2));
    await escribeConEspera(v, "Gracias, quedo al pendiente");
    await escribeConEspera(v, "¿A qué hora cierran?");
    expect(motivos(v)).toEqual(["escalada:cancelacion_modificacion"]);
  });

  it("la misma queja repetida no multiplica avisos: el segundo es una nota del mismo aviso abierto", async () => {
    const v = await nuevoViaje();
    v.guion([escalaCambio, { texto: "Se lo paso a cocina." }]);
    await escribeConEspera(v, "¿Me agrega un guacamole a mi pedido?");
    avanza(min(2));
    await escribeConEspera(v, "Recibí el pedido pero no mandaron el guacamole");
    avanza(min(2));
    await escribeConEspera(v, "Recibí el pedido pero no mandaron el guacamole");
    const abiertos = v.world.repo.listCallbackRequests(v.world.organizationId);
    expect(abiertos.filter((c) => c.reason === "escalada:queja")).toHaveLength(1);
  });
});
