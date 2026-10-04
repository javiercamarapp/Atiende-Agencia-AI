// QA R1 -- agente de WhatsApp: rafagas (agentes-02) y loop de herramientas agotado (agentes-04).
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyHighRiskIntentInMessages } from "../../src/whatsapp/guards.ts";
import { recibirMensajeConEspera, responderTrasEspera } from "../../src/whatsapp/inbound.ts";
import { PNID_T7, banco, call, say } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("agentes-02: en una rafaga el clasificador revisa TODOS los mensajes pendientes", () => {
  it("classifyHighRiskIntentInMessages escoge el motivo de mayor prioridad y devuelve el texto que lo disparo", () => {
    const r = classifyHighRiskIntentInMessages(["hola??", "me cobraron dos veces el pedido", "es urgente"]);
    expect(r?.intent).toBe("cobro_duplicado");
    expect(r?.text).toBe("me cobraron dos veces el pedido");
    expect(classifyHighRiskIntentInMessages(["hola", "quiero 3 de pastor"])).toBeNull();
  });

  it("rafaga 'me cobraron dos veces' + 'hola??': escala cobro_duplicado antes del LLM (0 llamadas al modelo)", async () => {
    const b = await banco();
    b.setGuion([say("Hola, ¿qué le preparamos hoy?")]);
    const tel = "+5219990000004";
    const a = await recibirMensajeConEspera(b.w.repo, { organizationId: b.w.organizationId, messageId: "wamid.r1", phone: tel, body: "oigan me cobraron dos veces el pedido de ayer" });
    expect(a.estado).toBe("responder");
    const c = await recibirMensajeConEspera(b.w.repo, { organizationId: b.w.organizationId, messageId: "wamid.r2", phone: tel, body: "hola??" });
    expect(c.estado).toBe("absorbido");
    const out = await responderTrasEspera(b.w.repo, b.handler, { organizationId: b.w.organizationId, messageId: "wamid.r1", phone: tel, phoneNumberId: PNID_T7, propertyId: b.t7, handoffGate: b.gate, deliverReply: false });
    expect(out.escalated).toBe(true);
    expect(b.llamadasLlm()).toBe(0);
    const aviso = b.callbacks().find((cb) => cb.reason === "escalada:cobro_duplicado");
    expect(aviso?.propertyId).toBe(b.t7);
  });

  it("rafaga sin riesgo: sigue yendo al agente (una llamada al modelo)", async () => {
    const b = await banco();
    b.setGuion([say("Hola, ¿qué le preparamos hoy?")]);
    const tel = "+5219990000032";
    await recibirMensajeConEspera(b.w.repo, { organizationId: b.w.organizationId, messageId: "wamid.s1", phone: tel, body: "hola" });
    await recibirMensajeConEspera(b.w.repo, { organizationId: b.w.organizationId, messageId: "wamid.s2", phone: tel, body: "quiero pedir" });
    const out = await responderTrasEspera(b.w.repo, b.handler, { organizationId: b.w.organizationId, messageId: "wamid.s1", phone: tel, phoneNumberId: PNID_T7, propertyId: b.t7, handoffGate: b.gate, deliverReply: false });
    expect(out.escalated).not.toBe(true);
    expect(b.llamadasLlm()).toBe(1);
  });

  it("un riesgo en un mensaje YA contestado no se revive en el turno siguiente", async () => {
    const b = await banco();
    b.setGuion([say("Con gusto, ¿qué le preparamos?")]);
    const tel = "+5219990000033";
    await b.enviar(tel, "quiero hablar con una persona");
    const r2 = await b.enviar(tel, "hola de nuevo, quiero 3 de pastor");
    // el primer mensaje abrio la toma de handoff: el agente calla; el segundo no genera otra escalacion
    expect(b.callbacks().filter((c) => c.reason === "escalada:cliente_lo_pide")).toHaveLength(1);
    expect(r2.escalated).not.toBe(true);
  });
});

describe("agentes-04: el loop agota sus vueltas sin crear pedido", () => {
  it("el equipo se entera (callback no_puedo_resolver, abre handoff) y el cliente recibe un texto honesto, no un 'un momento' mudo", async () => {
    const b = await banco();
    b.setGuion([call("buscar_producto", { query: "pastor", branch_slug: "garcia-lavin" })]); // el modelo se queda buscando
    const r = await b.enviar("+5219990000007", "quiero de todo un poco jaja");
    expect(r.reply).toMatch(/avis[ée] al equipo/);
    expect(r.reply).not.toMatch(/Un momento/i);
    expect(r.escalated).toBe(true);
    const aviso = b.callbacks().find((c) => c.reason === "escalada:no_puedo_resolver");
    expect(aviso?.propertyId).toBe(b.t7);
    expect(b.llamadasLlm()).toBe(8);
  });

  it("si el aviso al equipo no se pudo registrar, NO se dice 'ya avise': el cliente recibe una pregunta concreta", async () => {
    const b = await banco();
    b.w.repo.createCallbackRequest = async () => {
      throw new Error("sin tabla de avisos");
    };
    b.setGuion([call("buscar_producto", { query: "pastor", branch_slug: "garcia-lavin" })]);
    const r = await b.enviar("+5219990000034", "quiero de todo un poco jaja");
    expect(r.reply).toMatch(/[?¿]/);
    expect(r.reply).not.toMatch(/avis[ée] al equipo/);
    expect(r.escalated).not.toBe(true);
  });
});
