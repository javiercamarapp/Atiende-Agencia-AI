// H-20 -- plomeria del webhook con el estado de la conversacion: mientras la atiende una persona el agente CALLA (guarda el
// mensaje, no corre el LLM, no responde, suma un no leido); el handoff del agente / gobierno pasa la conversacion a humano y
// notifica UNA vez por derivacion; una conversacion cerrada se reabre con el agente; sin la migracion 043 el agente responde como siempre.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryConversacionesRepository, InMemoryHotelesRepository, handleInboundWhatsAppMessage, type ConversacionesSistemaPort, type HotelesWhatsAppTurnHandler } from "../../src/index.ts";

const PHONE = "+5219991230000";

function setup(opts: { migrated?: boolean; handoff?: boolean } = {}) {
  const hoteles = new InMemoryHotelesRepository();
  const conv = new InMemoryConversacionesRepository({ migrated: opts.migrated ?? true });
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  hoteles.seedWhatsAppChannel(propertyId, organizationId, "9876543210");
  const handleInboundMessage = vi.fn(async () => ({ reply: "Hola, soy el asistente.", fnbOrderId: null, ...(opts.handoff ? { handoff: { motivo: "agente_derivo" } } : {}) }));
  const turnHandler: HotelesWhatsAppTurnHandler = { handleInboundMessage };
  let n = 0;
  const entra = (body: string, port: ConversacionesSistemaPort | undefined = conv.sistema()) =>
    handleInboundWhatsAppMessage(hoteles, turnHandler, { organizationId, propertyId, messageId: `wamid.${++n}`, phone: PHONE, body, phoneNumberId: "9876543210" }, port);
  const respuestasEncoladas = async () => (await hoteles.claimMessagingOutboxBatch(50, 60)).length;
  const historial = async () => (await hoteles.appendWhatsAppUserMessageOnce(propertyId, PHONE, { role: "user", content: "probe" })).length;
  return { hoteles, conv, organizationId, propertyId, handleInboundMessage, entra, respuestasEncoladas, historial };
}

describe("agente silenciado mientras la conversacion esta en humano", () => {
  it("guarda el mensaje, NO corre el agente, NO encola respuesta y suma un no leido", async () => {
    const s = setup();
    s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE, modo: "humano", responsableId: randomUUID() });
    const out = await s.entra("Necesito mi factura, por favor");
    expect(out).toEqual({ ok: true, retryable: false, silenciado: true });
    expect(s.handleInboundMessage).not.toHaveBeenCalled();
    expect(await s.respuestasEncoladas()).toBe(0);
    // el mensaje del huesped SI quedo en el historial (user + la sonda de esta prueba = 2)
    expect(await s.historial()).toBe(2);
    expect(s.conv.estado(s.conv.porTelefono(s.propertyId, PHONE)!)).toMatchObject({ modo: "humano", noLeidos: 1 });
    await s.entra("¿Alguien me atiende?");
    expect(s.conv.estado(s.conv.porTelefono(s.propertyId, PHONE)!)!.noLeidos).toBe(2);
    expect(s.handleInboundMessage).not.toHaveBeenCalled();
  });

  it("humano SIN responsable (esperando a alguien) tambien silencia al agente", async () => {
    const s = setup();
    s.conv.seedConversacion({ propertyId: s.propertyId, phone: PHONE, modo: "humano" });
    expect((await s.entra("hola")).silenciado).toBe(true);
    expect(s.handleInboundMessage).not.toHaveBeenCalled();
  });

  it("al devolver la conversacion al agente, vuelve a responder", async () => {
    const s = setup();
    const id = s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE, modo: "humano", responsableId: "u1" });
    await s.conv.devolver({ userId: "u1", role: "frontdesk" }, s.propertyId, id);
    const out = await s.entra("gracias");
    expect(out).toMatchObject({ ok: true, reply: "Hola, soy el asistente." });
    expect(s.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(await s.respuestasEncoladas()).toBe(1);
  });

  it("una conversacion cerrada se reabre con el agente cuando el huesped vuelve a escribir", async () => {
    const s = setup();
    const id = s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE, modo: "cerrada" });
    const out = await s.entra("hola otra vez");
    expect(out.reply).toBe("Hola, soy el asistente.");
    expect(s.conv.estado(id)!.modo).toBe("agente");
  });
});

describe("handoff: el agente (o el gobierno) pide una persona", () => {
  it("pasa la conversacion a humano, la respuesta de ese turno se envia y se notifica UNA vez por derivacion", async () => {
    const s = setup({ handoff: true });
    const id = s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE });
    const out = await s.entra("Quiero negociar un precio para un grupo");
    expect(out).toMatchObject({ ok: true, reply: "Hola, soy el asistente." });
    expect(await s.respuestasEncoladas()).toBe(1);
    expect(s.conv.estado(id)).toMatchObject({ modo: "humano", responsableId: null, handoffN: 1, motivo: "agente_derivo" });
    expect(s.conv.notificaciones).toEqual([{ evento: "hoteles.conversacion.handoff", organizationId: s.organizationId, propertyId: s.propertyId, clave: `${id}:1` }]);
    // el siguiente mensaje ya no lo atiende el agente ni notifica de nuevo
    await s.entra("¿hay alguien?");
    expect(s.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(s.conv.notificaciones).toHaveLength(1);
  });

  it("una segunda derivacion (tras devolver al agente) notifica con otra clave de dedupe", async () => {
    const s = setup({ handoff: true });
    const id = s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE });
    await s.entra("uno");
    await s.conv.tomar({ userId: "u1", role: "frontdesk" }, s.propertyId, id, false);
    await s.conv.devolver({ userId: "u1", role: "frontdesk" }, s.propertyId, id);
    await s.entra("dos");
    expect(s.conv.notificaciones.map((n) => n.clave)).toEqual([`${id}:1`, `${id}:2`]);
  });

  it("un handoff sobre una conversacion que ya esta en humano no cuenta ni notifica", async () => {
    const s = setup({ handoff: true });
    const id = s.conv.seedConversacion({ propertyId: s.propertyId, organizationId: s.organizationId, phone: PHONE });
    const port = s.conv.sistema();
    await port.derivarAHumano(s.propertyId, PHONE, "agente_derivo");
    const otra = await port.derivarAHumano(s.propertyId, PHONE, "agente_derivo");
    expect(otra).toMatchObject({ transicion: false, handoffN: 1 });
    expect(s.conv.estado(id)!.handoffN).toBe(1);
    expect(s.conv.notificaciones).toHaveLength(1);
  });
});

describe("base SIN la migracion 043", () => {
  it("sin el puerto o con la base sin migrar, el agente responde como siempre (nunca silencia ni falla)", async () => {
    const sinPuerto = setup({ handoff: true });
    expect(await sinPuerto.entra("hola", undefined)).toMatchObject({ ok: true, reply: "Hola, soy el asistente." });
    const sinMigrar = setup({ migrated: false, handoff: true });
    sinMigrar.conv.seedConversacion({ propertyId: sinMigrar.propertyId, phone: PHONE, modo: "humano" });
    expect(await sinMigrar.entra("hola")).toMatchObject({ ok: true, reply: "Hola, soy el asistente." });
    expect(sinMigrar.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(sinMigrar.conv.notificaciones).toHaveLength(0);
  });
});
