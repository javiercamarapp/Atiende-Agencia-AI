// Tests reales de MetaGraphWhatsAppClient — SIEMPRE con un `fetchImpl` inyectado,
// NUNCA toca graph.facebook.com ni usa un WHATSAPP_ACCESS_TOKEN real (fake fijo de
// prueba, ver README §"NO uses ningún token real de Meta").
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConfigError, WhatsAppInvalidPayloadError, WhatsAppSendError } from "../src/errors.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";

const FAKE_TOKEN = "test-fake-whatsapp-access-token-never-real";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MetaGraphWhatsAppClient", () => {
  it("falla en el constructor sin accessToken — nunca finge un envío sin configuración real", () => {
    expect(() => new MetaGraphWhatsAppClient({ accessToken: "" })).toThrow(WhatsAppConfigError);
  });

  it("llama al endpoint real de Graph API con el formato documentado (POST /v{version}/{phone_number_id}/messages)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.facebook.com/v21.0/phone-123/messages");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ messaging_product: "whatsapp", to: "+5219991112233", type: "text", text: { body: "hola", preview_url: false } });
      return jsonResponse({ messages: [{ id: "wamid.real123" }] });
    });

    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.sendMessage({ to: "+5219991112233", phoneNumberId: "phone-123", body: "hola" });

    expect(result.providerMessageId).toBe("wamid.real123");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("manda mensaje interactivo con botones cuando el payload los trae", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string; interactive?: { action: { buttons: unknown[] } } };
      expect(body.type).toBe("interactive");
      expect(body.interactive?.action.buttons).toHaveLength(3);
      return jsonResponse({ messages: [{ id: "wamid.btn" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "confirma", buttons: ["Confirmar", "Cancelar", "Reagendar"] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rechaza más de 3 botones sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", buttons: ["a", "b", "c", "d"] })).rejects.toThrow(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clasifica 500 como reintentable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "internal" } }, 500));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toMatchObject({ retryable: true });
  });

  it("clasifica 429 como reintentable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "rate limited" } }, 429));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toMatchObject({ retryable: true });
  });

  it("clasifica 400 (número inválido) como NO reintentable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "invalid recipient" } }, 400));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toMatchObject({ retryable: false });
  });

  it("clasifica un fallo de red (fetch rechaza) como reintentable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toMatchObject({ retryable: true });
  });

  it("un 2xx sin messages[0].id no finge éxito", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toThrow(WhatsAppSendError);
  });

  it("rechaza un payload incompleto sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "", phoneNumberId: "p1", body: "x" })).rejects.toThrow(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
