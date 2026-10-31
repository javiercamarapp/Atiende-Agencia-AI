// Coexistencia PR-1: el eco de la app (`smb_message_echoes`) se guarda en el hilo como «personal (app)», con hora real y wamid, sin duplicar,
// sin crear conversaciones, sin tocar mensajes de clientes y sin guardar lo que mando la propia plataforma.
import { describe, expect, it } from "vitest";
import { extractMetaEchoes, instanteDeSilencio, registrarEcoDeApp } from "../src/whatsapp/eco-app.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const CLIENTE = "5219991234567";
const PROPERTY = "00000000-0000-4000-8000-0000000000a1";
const eco = (over: Record<string, unknown> = {}) => ({ from: "5219990000000", to: CLIENTE, id: "wamid.ECO1", timestamp: "1790000000", type: "text", text: { body: "Hola, ya va su pedido" }, ...over });
const payload = (ecos: unknown[], field = "smb_message_echoes") => ({ entry: [{ changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: "700" }, message_echoes: ecos } }] }] });

describe("extractMetaEchoes", () => {
  it("lee el texto, el destinatario, el wamid y la hora real", () => {
    const r = extractMetaEchoes(payload([eco()]));
    expect(r.ecos).toEqual([{ id: "wamid.ECO1", to: CLIENTE, body: "Hola, ya va su pedido", atMs: 1790000000_000, type: "text" }]);
    expect(r.descartados).toBe(0);
  });
  it("un tipo que no es texto se guarda como nota honesta; lo ilegible se cuenta y NO lanza", () => {
    const r = extractMetaEchoes(payload([eco({ id: "wamid.IMG", type: "image", text: undefined }), null, "x", { id: 5 }, eco({ id: "wamid.SIN", to: "abc" }), eco({ id: "wamid.VACIO", text: { body: "  " } })]));
    expect(r.ecos).toHaveLength(1);
    expect(r.ecos[0]!.body).toMatch(/image/);
    expect(r.descartados).toBe(5);
  });
  it("ignora otros campos (history, smb_app_state_sync, messages) y payloads raros", () => {
    expect(extractMetaEchoes(payload([eco()], "history")).ecos).toHaveLength(0);
    expect(extractMetaEchoes(payload([eco()], "messages")).ecos).toHaveLength(0);
    for (const raro of [null, undefined, 5, {}, { entry: "x" }, { entry: [null] }, { entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: "x" } }] }] }]) {
      expect(extractMetaEchoes(raro).ecos).toHaveLength(0);
    }
  });
  it("quita el NUL (\\u0000) que haria fallar jsonb; un cuerpo solo de NULs se descarta", () => {
    const r = extractMetaEchoes(payload([eco({ text: { body: "Hola\u0000 mundo" } }), eco({ id: "wamid.NUL", text: { body: "\u0000\u0000" } })]));
    expect(r.ecos.map((e) => e.body)).toEqual(["Hola mundo"]);
    expect(r.descartados).toBe(1);
  });
});

describe("instanteDeSilencio (P2-5)", () => {
  const ahora = 1_800_000_000_000;
  it("acota la hora de Meta a [ahora - 5 min, ahora + 1 min]", () => {
    expect(instanteDeSilencio(ahora - 60_000, ahora)).toBe(ahora - 60_000);
    expect(instanteDeSilencio(ahora - 3 * 3_600_000, ahora)).toBe(ahora - 5 * 60_000);
    expect(instanteDeSilencio(ahora + 3 * 3_600_000, ahora)).toBe(ahora + 60_000);
    expect(instanteDeSilencio(null, ahora)).toBe(ahora);
  });
});

describe("registrarEcoDeApp", () => {
  const setup = (conConversacion = true) => {
    const f = buildRestaurantFixture();
    if (conConversacion) f.repo.seedWhatsAppConversation(f.organizationId, `+${CLIENTE}`, { messages: [{ role: "user", content: "Hola" }], status: "active", orderId: null, propertyId: PROPERTY });
    return f;
  };
  const historial = (f: ReturnType<typeof setup>, tel = `+${CLIENTE}`) => f.repo.whatsappAppendTurn(f.organizationId, tel, [], null, null, null);
  const registrar = (f: ReturnType<typeof setup>, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: extractMetaEchoes(payload([eco(over)])).ecos[0]!, ...extra });

  it("guarda el mensaje del personal con autor humano_app, hora real y wamid, sin rol de cliente", async () => {
    const f = setup();
    expect(await registrar(f)).toBe("guardado");
    const h = await historial(f);
    expect(h).toHaveLength(2);
    expect(h[1]).toEqual(expect.objectContaining({ role: "assistant", content: "Hola, ya va su pedido", autor: "humano_app", wamid: "wamid.ECO1", at: new Date(1790000000_000).toISOString() }));
  });

  it("es idempotente: el mismo wamid (reintento de Meta) no duplica", async () => {
    const f = setup();
    expect(await registrar(f)).toBe("guardado");
    expect(await registrar(f)).toBe("duplicado");
    expect(await historial(f)).toHaveLength(2);
  });

  it("P1-3: un eco para un cliente SIN conversacion no la crea: se acusa y no guarda nada", async () => {
    const f = setup(false);
    expect(await registrar(f)).toBe("sin_conversacion");
    expect(await historial(f, "+5219990000999")).toHaveLength(0);
  });

  it("base sin la 101 (no_disponible): no guarda, no reintenta", async () => {
    const f = setup();
    f.repo.ecosDisponibles = false;
    expect(await registrar(f)).toBe("sin_conversacion");
    expect(await historial(f)).toHaveLength(1);
  });

  it("P2-9: el cliente entra como 521... y el eco llega como 52...: se guarda en la MISMA conversacion (y al reves)", async () => {
    const f = setup();
    expect(await registrar(f, { to: "529991234567", id: "wamid.F52" })).toBe("guardado");
    const g = buildRestaurantFixture();
    g.repo.seedWhatsAppConversation(g.organizationId, "+529991234567", { messages: [{ role: "user", content: "Hola" }], status: "active", orderId: null, propertyId: PROPERTY });
    expect(await registrarEcoDeApp(g.repo, { organizationId: g.organizationId, propertyId: PROPERTY, eco: extractMetaEchoes(payload([eco({ id: "wamid.F521" })])).ecos[0]! })).toBe("guardado");
    expect((await historial(f)).map((m) => m.wamid)).toEqual([undefined, "wamid.F52"]);
    expect((await g.repo.whatsappAppendTurn(g.organizationId, "+529991234567", [], null, null, null)).map((m) => m.wamid)).toEqual([undefined, "wamid.F521"]);
  });

  it("P1-2: el eco de un mensaje que mando la PROPIA plataforma (wamid en el outbox enviado) se descarta y no silencia", async () => {
    const f = setup();
    await f.repo.enqueueMessagingOutbox(f.organizationId, "whatsapp", "whatsapp.inbound_reply", "inbound-reply:m1", { to: `+${CLIENTE}`, body: "Respuesta del asistente" });
    const [fila] = await f.repo.claimMessagingOutboxBatch(5, 60);
    await f.repo.markMessagingOutboxSent(fila!.id, { providerMessageId: "wamid.PROPIO" });
    expect(await registrar(f, { id: "wamid.PROPIO" })).toBe("propio");
    expect(await historial(f)).toHaveLength(1);
    // Con el interruptor de la organizacion apagado, ya no se descarta.
    f.repo.descartarEcosPropios = false;
    expect(await registrar(f, { id: "wamid.PROPIO2" })).toBe("guardado");
  });

  it("sin hora de Meta usa el reloj en `at`", async () => {
    const f = setup();
    await registrar(f, { timestamp: undefined }, { ahoraMs: () => 1_700_000_000_000 });
    expect((await historial(f))[1]).toEqual(expect.objectContaining({ at: new Date(1_700_000_000_000).toISOString() }));
  });

  it("NO toca los mensajes del cliente: quedan en su orden y un eco con el wamid de un mensaje del cliente se trata como duplicado", async () => {
    const f = buildRestaurantFixture();
    const turnHandler = { async handleInboundMessage() { return { reply: "Hola, le atiende el asistente", orderId: null, propertyId: null }; } };
    await handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId: "wamid.CLI1", phone: `+${CLIENTE}`, body: "Quiero tacos", phoneNumberId: "700", propertyId: PROPERTY });
    expect(await registrar(f, { id: "wamid.CLI1" })).toBe("duplicado");
    expect(await registrar(f, { id: "wamid.ECO2", text: { body: "Con gusto" } })).toBe("guardado");
    const h = await historial(f);
    expect(h.map((m) => [m.role, m.content])).toEqual([["user", "Quiero tacos"], ["assistant", "Hola, le atiende el asistente"], ["assistant", "Con gusto"]]);
  });

  it("P1-4: un error real al guardar devuelve `fallo` (Meta reintenta) y el reintento termina sin duplicar", async () => {
    const f = setup();
    const original = f.repo.appendEcoWhatsApp.bind(f.repo);
    f.repo.appendEcoWhatsApp = async () => { throw new Error("db caida"); };
    expect(await registrar(f)).toBe("fallo");
    f.repo.appendEcoWhatsApp = original;
    expect(await registrar(f)).toBe("guardado");
    expect(await historial(f)).toHaveLength(2);
  });
});
