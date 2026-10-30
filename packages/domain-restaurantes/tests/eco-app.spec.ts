// Coexistencia PR-1: el eco de la app (`smb_message_echoes`) se guarda en el hilo como «personal (app)», con hora real y wamid, sin duplicar.
import { describe, expect, it } from "vitest";
import { extractMetaEchoes, registrarEcoDeApp } from "../src/whatsapp/eco-app.ts";
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
});

describe("registrarEcoDeApp", () => {
  const setup = () => buildRestaurantFixture();
  const historial = (f: ReturnType<typeof setup>) => f.repo.whatsappAppendTurn(f.organizationId, `+${CLIENTE}`, [], null, null, null);

  it("guarda el mensaje del personal con autor humano_app, hora real y wamid, sin rol de cliente", async () => {
    const f = setup();
    const [e] = extractMetaEchoes(payload([eco()])).ecos;
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("guardado");
    const h = await historial(f);
    expect(h).toEqual([{ role: "assistant", content: "Hola, ya va su pedido", autor: "humano_app", wamid: "wamid.ECO1", at: new Date(1790000000_000).toISOString() }]);
  });

  it("es idempotente: el mismo wamid (reintento de Meta) no duplica", async () => {
    const f = setup();
    const [e] = extractMetaEchoes(payload([eco()])).ecos;
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("guardado");
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("duplicado");
    expect(await historial(f)).toHaveLength(1);
  });

  it("sin hora de Meta usa el reloj; crea la conversacion si el personal le escribio primero a un cliente nuevo", async () => {
    const f = setup();
    const [e] = extractMetaEchoes(payload([eco({ timestamp: undefined })])).ecos;
    await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e!, ahoraMs: () => 1_700_000_000_000 });
    expect((await historial(f))[0]).toMatchObject({ at: new Date(1_700_000_000_000).toISOString() });
  });

  it("NO toca los mensajes del cliente: quedan en su orden y un eco con el wamid de un mensaje del cliente se trata como duplicado", async () => {
    const f = setup();
    const turnHandler = { async handleInboundMessage() { return { reply: "Hola, le atiende el asistente", orderId: null, propertyId: null }; } };
    await handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId: "wamid.CLI1", phone: `+${CLIENTE}`, body: "Quiero tacos", phoneNumberId: "700", propertyId: PROPERTY });
    const [e] = extractMetaEchoes(payload([eco({ id: "wamid.CLI1" })])).ecos;
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("duplicado");
    const [e2] = extractMetaEchoes(payload([eco({ id: "wamid.ECO2", text: { body: "Con gusto" } })])).ecos;
    await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e2! });
    const h = await historial(f);
    expect(h.map((m) => [m.role, m.content])).toEqual([["user", "Quiero tacos"], ["assistant", "Hola, le atiende el asistente"], ["assistant", "Con gusto"]]);
    expect(h.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("si guardar falla devuelve `fallo` (Meta reintenta) y el wamid queda reclamable de nuevo", async () => {
    const f = setup();
    const [e] = extractMetaEchoes(payload([eco()])).ecos;
    const original = f.repo.whatsappAppendTurn.bind(f.repo);
    f.repo.whatsappAppendTurn = async () => { throw new Error("db caida"); };
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("fallo");
    f.repo.whatsappAppendTurn = original;
    expect(await registrarEcoDeApp(f.repo, { organizationId: f.organizationId, propertyId: PROPERTY, eco: e! })).toBe("guardado");
    expect(await historial(f)).toHaveLength(1);
  });
});
