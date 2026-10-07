// Adjuntos de los chats reales de T7: imagen, sticker y mensaje borrado ya no reciben «no puedo abrirlo, escríbalo».
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { extractMetaInboundMessages, STICKER_MARKER, esSoloSticker } from "../src/whatsapp/channel-config.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const FROM = "5219991234567";
const payload = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn" }, messages: [message] } }] }] });

describe("extractMetaInboundMessages: adjuntos", () => {
  it("imagen: el marcador pide el pin si es ubicación o una descripción en una línea si es una referencia", () => {
    const [m] = extractMetaInboundMessages(payload({ id: "i1", from: FROM, type: "image", image: { id: "x" } }));
    expect(m!.body).toBe("[El cliente envió una imagen que el asistente no puede ver: si es su ubicación pida el pin de WhatsApp; si es una referencia, pida que la describa en una línea.]");
  });

  it("sticker: marcador de cortesía, sin pedirle que escriba; los demás archivos conservan la nota anterior", () => {
    const [m] = extractMetaInboundMessages(payload({ id: "s1", from: FROM, type: "sticker", sticker: { id: "x" } }));
    expect(m!.body).toBe(STICKER_MARKER);
    expect(m!.body).not.toMatch(/no puede abrir|pídale amablemente/i);
    const [v] = extractMetaInboundMessages(payload({ id: "v1", from: FROM, type: "video", video: { id: "x" } }));
    expect(v!.body).toMatch(/archivo \(video\)/);
  });

  it("mensaje no soportado o borrado: el agente debe preguntar antes de aplicar un cambio", () => {
    const [m] = extractMetaInboundMessages(payload({ id: "u1", from: FROM, type: "unsupported", errors: [{ code: 131051 }] }));
    expect(m!.body).toMatch(/envió o borró un mensaje que el asistente no puede leer/);
    expect(m!.body).toMatch(/pregúntele qué quería antes de aplicarlo/);
  });

  it("esSoloSticker: solo si todo el turno son stickers", () => {
    expect(esSoloSticker(`${STICKER_MARKER}\n${STICKER_MARKER}`)).toBe(true);
    expect(esSoloSticker(`${STICKER_MARKER}\ny cambio la dirección`)).toBe(false);
    expect(esSoloSticker("gracias")).toBe(false);
    expect(esSoloSticker("")).toBe(false);
  });
});

describe("un sticker tras un pedido cerrado no se contesta", () => {
  function setup() {
    const fixture = buildRestaurantFixture();
    let turnos = 0;
    const turnHandler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnos += 1;
        return { reply: "Respuesta del agente", orderId: null, propertyId: null };
      },
    };
    const enviar = (messageId: string, body: string) => handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, messageId, phone: FROM, body, phoneNumberId: "1" });
    const pedido = () =>
      createOrder(fixture.repo, {
        organizationId: fixture.organizationId,
        branchSlug: "fco-montejo",
        customerName: "Cliente Sintético",
        customerPhone: FROM,
        customerAddress: "Calle 50 #200",
        items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
        source: "whatsapp",
        paymentMethod: "efectivo",
        canal: "domicilio",
      });
    return { fixture, enviar, pedido, turnos: () => turnos };
  }

  it("con un pedido vigente reciente: sin respuesta, sin turno de LLM, mensaje procesado y guardado", async () => {
    const t = setup();
    await t.pedido();
    const out = await t.enviar("st1", STICKER_MARKER);
    expect(out).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
    const historial = await t.fixture.repo.appendWhatsAppUserMessageOnce(t.fixture.organizationId, FROM, { role: "user", content: "probe" });
    expect(historial.map((m) => m.content)).toEqual([STICKER_MARKER, "probe"]);
    expect(historial.some((m) => m.role === "assistant")).toBe(false);
  });

  it("el mismo id de Meta reentregado no se reprocesa ni contesta", async () => {
    const t = setup();
    await t.pedido();
    await t.enviar("st2", STICKER_MARKER);
    expect(await t.enviar("st2", STICKER_MARKER)).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
  });

  it("sin pedido reciente el turno sigue (es un gesto en medio de una conversación)", async () => {
    const t = setup();
    expect(await t.enviar("st3", STICKER_MARKER)).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("con pedido reciente pero con texto de verdad, el agente responde", async () => {
    const t = setup();
    await t.pedido();
    expect(await t.enviar("st4", "quiero agregar una coca")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });
});
