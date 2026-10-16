// rescate-orig-restaurantes-1 §6: una edicion de mensaje (webhook `type: "edit"`) entra como mensaje nuevo con la nota de correccion.
// Forma del payload segun la documentacion publica de Meta; NO probado contra Meta real.
import { describe, expect, it } from "vitest";
import { EDICION_NOTA, extractMetaInboundMessages } from "../src/whatsapp/channel-config.ts";

const payload = (m: unknown) => ({ entry: [{ changes: [{ value: { messages: [m] } }] }] });

describe("ediciones de mensajes del cliente", () => {
  it("una edicion de texto llega con la nota y el texto corregido", () => {
    const r = extractMetaInboundMessages(payload({ from: "5219991112233", id: "wamid.E1", type: "edit", edit: { original_message_id: "wamid.O1", message: { type: "text", text: { body: "dos de pastor, no tres" } } } }));
    expect(r).toEqual([{ id: "wamid.E1", from: "5219991112233", body: `${EDICION_NOTA} dos de pastor, no tres` }]);
  });
  it("una edicion sin texto, vacia, de medios o con remitente invalido se ignora sin lanzar", () => {
    for (const m of [
      { from: "5219991112233", id: "w", type: "edit", edit: { original_message_id: "o", message: { type: "image", image: { caption: "x" } } } },
      { from: "5219991112233", id: "w", type: "edit", edit: { original_message_id: "o", message: { type: "text", text: { body: "  " } } } },
      { from: "abc", id: "w", type: "edit", edit: { message: { type: "text", text: { body: "hola" } } } },
      { from: "5219991112233", id: "w", type: "edit" },
    ]) expect(extractMetaInboundMessages(payload(m))).toEqual([]);
  });
});
