// QA R1 -- entrada de Meta: texto de 4,001 a 4,096 caracteres (agentes-07) y respuestas de boton / lista (agentes-08).
import { describe, expect, it } from "vitest";
import { extractMetaInboundMessages, extractMetaTextMessages, META_TEXT_MAX_CHARS } from "../../src/whatsapp/channel-config.ts";
import { PNID_T7 } from "./r1-arnes-whatsapp-pm.ts";

const payload = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID_T7 }, messages: [message] } }] }] });
const FROM = "5219990000010";

describe("agentes-07: el limite de texto es el de Meta (4,096), no 4,000", () => {
  it("un texto de 4,050 caracteres se procesa (antes se descartaba en silencio y el cliente no recibia respuesta)", () => {
    const largo = `quiero ${"3 de pastor y una coca, ".repeat(170)}`.slice(0, 4050);
    const out = extractMetaInboundMessages(payload({ id: "wamid.big", from: FROM, type: "text", text: { body: largo } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toHaveLength(4050);
    expect(extractMetaTextMessages(payload({ id: "wamid.big2", from: FROM, type: "text", text: { body: largo } }))).toHaveLength(1);
  });
  it("exactamente 4,096 pasa; 4,097 queda fuera (Meta no manda mas de 4,096)", () => {
    expect(extractMetaInboundMessages(payload({ id: "wamid.a", from: FROM, type: "text", text: { body: "a".repeat(META_TEXT_MAX_CHARS) } }))).toHaveLength(1);
    expect(extractMetaInboundMessages(payload({ id: "wamid.b", from: FROM, type: "text", text: { body: "a".repeat(META_TEXT_MAX_CHARS + 1) } }))).toHaveLength(0);
  });
});

describe("agentes-08: el texto de un boton o de una lista es el mensaje del cliente", () => {
  it("type 'button' (respuesta rapida de una plantilla)", () => {
    const out = extractMetaInboundMessages(payload({ id: "wamid.btn", from: FROM, type: "button", button: { text: "Sí, confirmo", payload: "SI" } }));
    expect(out).toEqual([{ id: "wamid.btn", from: FROM, body: "Sí, confirmo" }]);
  });
  it("type 'interactive' con button_reply y con list_reply", () => {
    const boton = extractMetaInboundMessages(payload({ id: "wamid.int", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "si", title: "Sí" } } }));
    const lista = extractMetaInboundMessages(payload({ id: "wamid.lst", from: FROM, type: "interactive", interactive: { type: "list_reply", list_reply: { id: "t7", title: "García Lavín" } } }));
    expect(boton[0]?.body).toBe("Sí");
    expect(lista[0]?.body).toBe("García Lavín");
  });
  it("un boton sin texto, de otro tipo interactivo o con remitente invalido se ignora sin lanzar", () => {
    expect(extractMetaInboundMessages(payload({ id: "wamid.x1", from: FROM, type: "button", button: {} }))).toHaveLength(0);
    expect(extractMetaInboundMessages(payload({ id: "wamid.x2", from: FROM, type: "interactive", interactive: { type: "nfm_reply" } }))).toHaveLength(0);
    expect(extractMetaInboundMessages(payload({ id: "wamid.x3", from: "abc", type: "button", button: { text: "Sí" } }))).toHaveLength(0);
  });
});
