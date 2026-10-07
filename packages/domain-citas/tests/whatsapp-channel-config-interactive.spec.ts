// C-01 -- parseo de mensajes interactivos (button_reply/list_reply) del webhook de Meta.
// Antes el filtro solo aceptaba `type: "text"` y el toque a Confirmar/Cancelar/Reagendar
// del recordatorio 24h se descartaba en silencio.
import { describe, expect, it } from "vitest";
import { extractMetaInboundMessages, extractMetaTextMessages } from "../src/whatsapp/channel-config.ts";

function payloadWith(messages: unknown[]) {
  return { entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages } }] }] };
}

const FROM = "5219981234567";

describe("extractMetaInboundMessages", () => {
  it("un button_reply se normaliza con body=título e interactive={kind,id,title}", () => {
    const out = extractMetaInboundMessages(
      payloadWith([{ id: "wamid.1", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "cita:confirmar:abc", title: "Confirmar" } } }]),
    );
    expect(out).toEqual([{ id: "wamid.1", from: FROM, body: "Confirmar", interactive: { kind: "button_reply", id: "cita:confirmar:abc", title: "Confirmar" } }]);
  });

  it("un list_reply también se reconoce", () => {
    const out = extractMetaInboundMessages(
      payloadWith([{ id: "wamid.2", from: FROM, type: "interactive", interactive: { type: "list_reply", list_reply: { id: "slot_3", title: "Jueves 10:00", description: "x" } } }]),
    );
    expect(out[0]?.interactive).toEqual({ kind: "list_reply", id: "slot_3", title: "Jueves 10:00" });
    expect(out[0]?.body).toBe("Jueves 10:00");
  });

  it("los mensajes de texto siguen igual y se conserva el orden mezclado del payload", () => {
    const out = extractMetaInboundMessages(
      payloadWith([
        { id: "a", from: FROM, type: "text", text: { body: "hola" } },
        { id: "b", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "btn_0", title: "Cancelar" } } },
        { id: "c", from: FROM, type: "text", text: { body: "gracias" } },
      ]),
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(out[0]?.interactive).toBeUndefined();
  });

  it("formas inválidas se ignoran sin lanzar: sin reply, id/título vacíos o enormes, nfm_reply, remitente no numérico, id de mensaje vacío", () => {
    const out = extractMetaInboundMessages(
      payloadWith([
        { id: "1", from: FROM, type: "interactive", interactive: { type: "button_reply" } },
        { id: "2", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "", title: "Ok" } } },
        { id: "3", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title: "   " } } },
        { id: "4", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x".repeat(257), title: "Ok" } } },
        { id: "5", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title: "t".repeat(201) } } },
        { id: "6", from: FROM, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow" } } },
        { id: "7", from: "abc", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title: "Ok" } } },
        { id: "", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x", title: "Ok" } } },
        { id: "9", from: FROM, type: "reaction" },
        null,
        "basura",
      ]),
    );
    expect(out).toEqual([]);
  });

  it("payload sin entry/changes/messages (p. ej. statuses de entrega) devuelve []", () => {
    expect(extractMetaInboundMessages({})).toEqual([]);
    expect(extractMetaInboundMessages(null)).toEqual([]);
    expect(extractMetaInboundMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] })).toEqual([]);
  });

  it("extractMetaTextMessages (API anterior) sigue ignorando los interactivos: nada cambia para quien no migró", () => {
    const payload = payloadWith([{ id: "b", from: FROM, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "btn_0", title: "Cancelar" } } }]);
    expect(extractMetaTextMessages(payload)).toEqual([]);
  });
});
