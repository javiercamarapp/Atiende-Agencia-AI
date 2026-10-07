// QA-citas-R1-agentes-10 (mensajes que el agente no puede leer) y -11 (tope de turnos de modelo por remitente).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractMetaInboundMessages, MAX_TEXTO_ENTRANTE } from "../src/whatsapp/channel-config.ts";
import { TOPE_TURNOS_POR_REMITENTE, handleUnsupportedWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { montarConsultorio, pasos, PNID } from "./qa/r1-agentes-support.ts";

const payload = (m: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.${randomUUID()}`, from: "5219991234567", ...m }] } }] }] });

describe("extractMetaInboundMessages: contenido que el agente no lee", () => {
  it.each([
    ["audio", { audio: { id: "m1" } }, "audio"],
    ["image", { image: { id: "m2" } }, "imagen"],
    ["video", { video: { id: "m3" } }, "video"],
    ["document", { document: { id: "m4" } }, "documento"],
    ["sticker", { sticker: { id: "m5" } }, "sticker"],
    ["location", { location: { latitude: 1, longitude: 2 } }, "ubicacion"],
    ["contacts", { contacts: [] }, "contacto"],
  ])("%s llega marcado como no soportado y sin cuerpo", (type, extra, esperado) => {
    const [m] = extractMetaInboundMessages(payload({ type, ...extra }));
    expect(m).toMatchObject({ body: "", noSoportado: esperado });
  });

  it("una reaccion o un mensaje de sistema siguen ignorandose", () => {
    expect(extractMetaInboundMessages(payload({ type: "reaction", reaction: { emoji: "👍" } }))).toEqual([]);
    expect(extractMetaInboundMessages(payload({ type: "system", system: {} }))).toEqual([]);
  });

  it("un texto de mas de 4000 caracteres se recorta en vez de descartarse", () => {
    const [m] = extractMetaInboundMessages(payload({ type: "text", text: { body: "a".repeat(MAX_TEXTO_ENTRANTE + 500) } }));
    expect(m!.body).toHaveLength(MAX_TEXTO_ENTRANTE);
    expect(m!.noSoportado).toBeUndefined();
  });

  it("un texto vacio o solo espacios sigue ignorandose", () => {
    expect(extractMetaInboundMessages(payload({ type: "text", text: { body: "   " } }))).toEqual([]);
  });
});

describe("handleUnsupportedWhatsAppMessage", () => {
  it("responde un aviso fijo por el outbox, una sola vez aunque Meta reintente el mismo mensaje", async () => {
    const t = montarConsultorio();
    const args = { organizationId: t.organizationId, messageId: "wamid.audio-1", phone: t.telefono, phoneNumberId: PNID, tipo: "audio" as const };
    const r1 = await handleUnsupportedWhatsAppMessage(t.repo, args);
    const r2 = await handleUnsupportedWhatsAppMessage(t.repo, args);
    expect(r1).toMatchObject({ ok: true, retryable: false });
    expect(r1.reply).toMatch(/notas de voz/);
    expect(r2.reply).toBeUndefined();
    const avisos = t.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_no_soportado");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.payload).toMatchObject({ to: t.telefono, phone_number_id: PNID, transaccional: true });
    expect(t.modelo.llamadas()).toBe(0);
  });

  it("varios archivos seguidos del mismo remitente: un solo aviso por ventana (no se convierte en spam saliente)", async () => {
    const t = montarConsultorio();
    for (let i = 0; i < 5; i++) await handleUnsupportedWhatsAppMessage(t.repo, { organizationId: t.organizationId, messageId: `wamid.img-${i}`, phone: t.telefono, phoneNumberId: PNID, tipo: "imagen" });
    expect(t.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_no_soportado")).toHaveLength(1);
  });
});

describe("handleUnsupportedWhatsAppMessage con una toma humana abierta", () => {
  const gateTomada = { estadoParaAgente: async () => "tomada" as const, solicitarHumano: async () => null };

  it("no responde el aviso, pero deja el tipo de contenido en el historial para quien atiende", async () => {
    const t = montarConsultorio();
    const r = await handleUnsupportedWhatsAppMessage(t.repo, { organizationId: t.organizationId, messageId: "wamid.audio-h", phone: t.telefono, phoneNumberId: PNID, tipo: "audio", handoffGate: gateTomada });
    expect(r).toMatchObject({ ok: true, retryable: false });
    expect(r.reply).toBeUndefined();
    expect(t.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_no_soportado")).toHaveLength(0);
    const historial = await t.repo.appendWhatsAppUserMessageOnce(t.organizationId, t.telefono, { role: "user", content: "hola" });
    expect(historial.map((m) => m.content)).toContain("[El paciente envió una nota de voz]");
  });

  it("sin toma abierta el aviso sale como siempre", async () => {
    const t = montarConsultorio();
    const gateLibre = { estadoParaAgente: async () => null, solicitarHumano: async () => null };
    const r = await handleUnsupportedWhatsAppMessage(t.repo, { organizationId: t.organizationId, messageId: "wamid.audio-l", phone: t.telefono, phoneNumberId: PNID, tipo: "audio", handoffGate: gateLibre });
    expect(r.reply).toMatch(/notas de voz/);
  });
});

describe("tope de turnos de modelo por remitente", () => {
  it("el remitente que pasa el tope ya no gasta modelo; recibe UN aviso y despues silencio", async () => {
    const t = montarConsultorio();
    t.modelo.encolar(...Array.from({ length: 40 }, () => pasos.di("ok")));
    const resultados = [];
    for (let i = 0; i < 40; i++) resultados.push(await t.entrante(`hola ${i}`));
    expect(t.modelo.llamadas()).toBe(TOPE_TURNOS_POR_REMITENTE.max);
    const avisos = t.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_tope");
    expect(avisos).toHaveLength(1);
    expect(resultados.slice(TOPE_TURNOS_POR_REMITENTE.max).filter((r) => r.reply)).toHaveLength(1);
    expect(resultados.slice(TOPE_TURNOS_POR_REMITENTE.max + 1).every((r) => r.silenciado === true && r.ok)).toBe(true);
  });

  it("otro paciente del mismo negocio NO se ve afectado por el exceso de uno", async () => {
    const t = montarConsultorio();
    t.modelo.encolar(...Array.from({ length: 60 }, () => pasos.di("ok")));
    for (let i = 0; i < 30; i++) await t.entrante(`spam ${i}`);
    const antes = t.modelo.llamadas();
    const otro = await t.entrante("hola, quisiera una cita", { phone: "+5219997654321" });
    expect(t.modelo.llamadas()).toBe(antes + 1);
    expect(otro.reply).toBe("ok");
  });

  it("la guardia de crisis NO cuenta contra el tope: una crisis siempre se atiende", async () => {
    const t = montarConsultorio();
    t.modelo.encolar(...Array.from({ length: 40 }, () => pasos.di("ok")));
    for (let i = 0; i < 25; i++) await t.entrante(`hola ${i}`);
    const crisis = await t.entrante("ya no aguanto, quiero morirme");
    expect(crisis.reply).toMatch(/Línea de la Vida/);
    expect(t.repo.getEmergencyEscalations()).toHaveLength(1);
  });

  it("si el contador falla (error de infraestructura) el paciente sigue atendiendose", async () => {
    const t = montarConsultorio();
    t.repo.consumeRateLimit = async () => {
      throw new Error("rate limit caido");
    };
    t.modelo.encolar(pasos.di("hola"));
    const r = await t.entrante("hola");
    expect(r.reply).toBe("hola");
  });
});
