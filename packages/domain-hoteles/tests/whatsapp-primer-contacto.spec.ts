// H-P3-03 -- primer contacto por WhatsApp: el PRIMER mensaje de una conversacion nueva lleva la linea de IA y el enlace del aviso de privacidad
// publico del hotel, puesto por el codigo (no por el LLM). Tambien el saludo pregrabado de voz.
import { describe, expect, it, vi } from "vitest";
import { acknowledgeOnlyTurnHandler, anteponerPrimerContacto, encabezadoPrimerContacto, handleInboundWhatsAppMessage, mensajesPregrabadosHotel, LINEA_IA_PRIMER_CONTACTO, type HotelesWhatsAppTurnHandler } from "../src/index.ts";
import { buildHotelFixture } from "./whatsapp/fixtures.ts";

const AVISO = "https://app.atiende.ai/hoteles/hotel-brisa/aviso";

describe("anteponerPrimerContacto (puro)", () => {
  it("agrega la linea de IA y el enlace del aviso antes de la respuesta", () => {
    const texto = anteponerPrimerContacto("Con gusto, ¿en que le ayudo?", AVISO);
    expect(texto).toBe(`${LINEA_IA_PRIMER_CONTACTO} Aviso de privacidad: ${AVISO}\n\nCon gusto, ¿en que le ayudo?`);
  });

  it("si la respuesta ya declara que es una IA, no repite la linea: solo agrega el enlace", () => {
    const respuesta = "Soy un asistente automático (inteligencia artificial). ¿En qué le ayudo?";
    expect(encabezadoPrimerContacto(respuesta, AVISO)).toBe(`Aviso de privacidad: ${AVISO}`);
    expect(anteponerPrimerContacto("ESTE NÚMERO ES ATENDIDO POR INTELIGENCIA ARTIFICIAL.", AVISO)).toBe(`Aviso de privacidad: ${AVISO}\n\nESTE NÚMERO ES ATENDIDO POR INTELIGENCIA ARTIFICIAL.`);
  });

  it("sin enlace conocido, sale solo la linea de IA; sin nada que agregar, la respuesta intacta", () => {
    expect(anteponerPrimerContacto("Hola", null)).toBe(`${LINEA_IA_PRIMER_CONTACTO}\n\nHola`);
    expect(anteponerPrimerContacto("Soy una inteligencia artificial", null)).toBe("Soy una inteligencia artificial");
  });
});

describe("handleInboundWhatsAppMessage -- primer contacto", () => {
  const args = (f: ReturnType<typeof buildHotelFixture>, messageId: string, body = "Hola") => ({ organizationId: f.organizationId, propertyId: f.propertyId, messageId, phone: "+5219991234567", body, phoneNumberId: "9876543210" });

  it("el PRIMER mensaje lleva la linea de IA y el enlace; el segundo no, y el enlace se resuelve una sola vez", async () => {
    const f = buildHotelFixture();
    const handler = acknowledgeOnlyTurnHandler(f.repo);
    const resolverAvisoUrl = vi.fn(async () => AVISO);
    const primero = await handleInboundWhatsAppMessage(f.repo, handler, args(f, "wamid.1"), undefined, { resolverAvisoUrl });
    expect(primero.reply).toContain(LINEA_IA_PRIMER_CONTACTO);
    expect(primero.reply).toContain(`Aviso de privacidad: ${AVISO}`);
    const segundo = await handleInboundWhatsAppMessage(f.repo, handler, args(f, "wamid.2", "Quiero saber algo mas"), undefined, { resolverAvisoUrl });
    expect(segundo.reply).not.toContain(LINEA_IA_PRIMER_CONTACTO);
    expect(segundo.reply).not.toContain("Aviso de privacidad");
    expect(resolverAvisoUrl).toHaveBeenCalledTimes(1);
  });

  it("lo que se guarda en la conversacion y se encola para enviar es EL MISMO texto con el encabezado", async () => {
    const f = buildHotelFixture();
    const out = await handleInboundWhatsAppMessage(f.repo, acknowledgeOnlyTurnHandler(f.repo), args(f, "wamid.10"), undefined, { resolverAvisoUrl: async () => AVISO });
    const lote = await f.repo.claimMessagingOutboxBatch(10, 60);
    const respuesta = lote.find((m) => (m.payload as { body?: string }).body === out.reply);
    expect(respuesta, "el outbox lleva el mismo texto").toBeDefined();
    const historial = await f.repo.appendWhatsAppUserMessageOnce(f.propertyId, "+5219991234567", { role: "user", content: "probe" });
    expect(historial.some((m) => m.role === "assistant" && m.content === out.reply)).toBe(true);
  });

  it("un fallo al resolver el enlace NUNCA tumba la respuesta: sale con la linea de IA y sin enlace", async () => {
    const f = buildHotelFixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await handleInboundWhatsAppMessage(f.repo, acknowledgeOnlyTurnHandler(f.repo), args(f, "wamid.20"), undefined, {
      resolverAvisoUrl: async () => {
        throw new Error("base sin migrar");
      },
    });
    error.mockRestore();
    expect(out).toMatchObject({ ok: true, retryable: false });
    expect(out.reply).toContain(LINEA_IA_PRIMER_CONTACTO);
    expect(out.reply).not.toContain("Aviso de privacidad");
  });

  it("sin el parametro de primer contacto el comportamiento es el anterior (la respuesta no se toca)", async () => {
    const f = buildHotelFixture();
    const out = await handleInboundWhatsAppMessage(f.repo, acknowledgeOnlyTurnHandler(f.repo), args(f, "wamid.30"));
    expect(out.reply).not.toContain(LINEA_IA_PRIMER_CONTACTO);
  });

  it("lo pone el codigo aunque el LLM no diga nada sobre la IA: un turno que responde 'Listo' tambien lo lleva", async () => {
    const f = buildHotelFixture();
    const mudo: HotelesWhatsAppTurnHandler = { handleInboundMessage: async () => ({ reply: "Listo.", fnbOrderId: null }) };
    const out = await handleInboundWhatsAppMessage(f.repo, mudo, args(f, "wamid.40"), undefined, { resolverAvisoUrl: async () => AVISO });
    expect(out.reply).toBe(`${LINEA_IA_PRIMER_CONTACTO} Aviso de privacidad: ${AVISO}\n\nListo.`);
  });
});

describe("saludo pregrabado de voz del hotel", () => {
  it("cada saludo dice que le atiende una IA, menciona el aviso de privacidad y nombra al hotel", () => {
    const c = mensajesPregrabadosHotel("Hotel Casa Maya");
    for (const id of ["saludo_respaldo", "saludo_respaldo_dias", "saludo_respaldo_tardes", "saludo_respaldo_noches"] as const) {
      expect(c[id], id).toContain("Hotel Casa Maya");
      expect(c[id], id).toContain("inteligencia artificial");
      expect(c[id], id).toContain("aviso de privacidad");
    }
  });
});
