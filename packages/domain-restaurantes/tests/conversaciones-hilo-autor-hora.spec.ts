// PM PR-4: el hilo de WhatsApp trae la hora real de cada mensaje y su autor (asistente / persona del panel con nombre / personal por la app).
import { describe, expect, it } from "vitest";
import { PostgresConversacionesRepository, handleInboundWhatsAppMessage } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const ANA = "00000000-0000-4000-8000-0000000000f1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const MENSAJES = [
  { role: "user", content: "Hola", at: "2026-10-30T18:00:00.000Z" },
  { role: "assistant", content: "Buenas, le atiende el asistente", at: "2026-10-30T18:00:03.500Z" },
  { role: "assistant", content: "Soy Ana, le ayudo", autor: "humano", staff_id: ANA, at: "2026-10-30T18:05:00.000Z" },
  { role: "assistant", content: "Ya va su pedido", autor: "humano_app", wamid: "wamid.X", at: "2026-10-30T18:09:00.000Z" },
  { role: "user", content: "mensaje viejo sin hora" },
  { role: "assistant", content: "respuesta vieja de persona", autor: "humano", staff_id: "no-es-uuid", at: "basura" },
];
const sinFuncion = Object.assign(new Error("function restaurantes.handoff_staff_nombres does not exist"), { code: "42883" });
const lecturas = (nombres: FakeSessionHandler): FakeSessionHandler[] => [
  { match: /from restaurantes\.whatsapp_conversations/i, respond: () => [{ messages: MENSAJES }] },
  nombres,
  { match: /handoff_detalle/i, respond: () => [] },
  SIGUIENTE,
];

describe("detalle del hilo de WhatsApp: hora y autor", () => {
  it("mapea hora real, autor del asistente, persona del panel (con nombre por staff_id) y personal (app)", async () => {
    const s = new AbortAwareFakeSession(lecturas({ match: /handoff_staff_nombres/i, respond: () => [{ id: ANA, nombre: "Ana Pérez" }] }));
    const r = await new PostgresConversacionesRepository(s).detalle(ORG, PROP, "whatsapp", CONV);
    expect(r.disponible).toBe(true);
    expect(r.valor!.mensajes).toEqual([
      { rol: "cliente", texto: "Hola", createdAt: "2026-10-30T18:00:00.000Z" },
      { rol: "agente", texto: "Buenas, le atiende el asistente", createdAt: "2026-10-30T18:00:03.500Z" },
      { rol: "humano", texto: "Soy Ana, le ayudo", createdAt: "2026-10-30T18:05:00.000Z", autorId: ANA, autorNombre: "Ana Pérez" },
      { rol: "humano_app", texto: "Ya va su pedido", createdAt: "2026-10-30T18:09:00.000Z" },
      { rol: "cliente", texto: "mensaje viejo sin hora", createdAt: null },
      { rol: "humano", texto: "respuesta vieja de persona", createdAt: null, autorId: null, autorNombre: null },
    ]);
  });

  it("sin la migracion 102 (no existe handoff_staff_nombres) el hilo igual se ve, con hora y sin nombre, y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession(lecturas({ match: /handoff_staff_nombres/i, respond: () => sinFuncion }));
    const r = await new PostgresConversacionesRepository(s).detalle(ORG, PROP, "whatsapp", CONV);
    expect(r.disponible).toBe(true);
    expect(r.valor!.mensajes[2]).toEqual(expect.objectContaining({ rol: "humano", createdAt: "2026-10-30T18:05:00.000Z", autorId: ANA, autorNombre: null }));
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("el asistente y el cliente guardan la hora real al escribir (`at`), sin tocar lo que ve el modelo", async () => {
    const f = buildRestaurantFixture();
    const antes = Date.now();
    await handleInboundWhatsAppMessage(f.repo, { async handleInboundMessage() { return { reply: "Hola, le atiende el asistente", orderId: null, propertyId: null }; } }, { organizationId: f.organizationId, messageId: "wamid.H1", phone: "+5219991234567", body: "Hola", phoneNumberId: "700" });
    const h = await f.repo.whatsappAppendTurn(f.organizationId, "+5219991234567", [], null, null, null);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant"]);
    for (const m of h) {
      expect(Date.parse(m.at ?? "")).toBeGreaterThanOrEqual(antes - 1000);
      expect(Date.parse(m.at ?? "")).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });
});
