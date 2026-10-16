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

  it("C-01: un botón {id,title} viaja con su id propio (ata el toque a una cita) y el string suelto conserva el id posicional", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { interactive: { action: { buttons: { type: string; reply: { id: string; title: string } }[] } } };
      expect(body.interactive.action.buttons).toEqual([
        { type: "reply", reply: { id: "cita:confirmar:abc", title: "Confirmar" } },
        { type: "reply", reply: { id: "btn_1", title: "Cancelar" } },
      ]);
      return jsonResponse({ messages: [{ id: "wamid.ids" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", buttons: [{ id: "cita:confirmar:abc", title: "Confirmar" }, "Cancelar"] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("C-01: rechaza ids de botón vacíos, de más de 256 caracteres o repetidos, sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const base = { to: "+52999", phoneNumberId: "p1", body: "x" };
    await expect(client.sendMessage({ ...base, buttons: [{ id: "", title: "Ok" }] })).rejects.toThrow(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, buttons: [{ id: "x".repeat(257), title: "Ok" }] })).rejects.toThrow(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, buttons: [{ id: "a", title: "Uno" }, { id: "a", title: "Dos" }] })).rejects.toThrow(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechaza más de 3 botones sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", buttons: ["a", "b", "c", "d"] })).rejects.toThrow(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("B03: si Meta rechaza los botones por su FORMA (parametro invalido) reintenta UNA vez como texto con el mismo cuerpo", async () => {
    const tipos: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string; text?: { body: string } };
      tipos.push(body.type);
      if (body.type === "interactive") return jsonResponse({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400);
      expect(body.text?.body).toBe("Resumen del pedido");
      return jsonResponse({ messages: [{ id: "wamid.texto" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "Resumen del pedido", buttons: [{ id: "rp1:confirmar:x", title: "Confirmar pedido" }, { id: "rp1:cambiar:x", title: "Cambiar algo" }] });
    expect(r).toEqual({ providerMessageId: "wamid.texto", enviadoComo: "texto" });
    expect(tipos).toEqual(["interactive", "text"]);
  });

  it("B03: un 4xx que NO es de forma (numero invalido) o un fallo transitorio con botones NO se reenvia como texto", async () => {
    for (const [status, code] of [[400, 131030], [500, 1], [429, 4]] as const) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "x", code } }, status));
      const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x", buttons: ["a", "b"] })).rejects.toMatchObject({ retryable: status !== 400 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("B03: un mensaje de texto (sin botones) con parametro invalido no se reintenta", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "x", code: 100 } }, 400));
    const client = new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "x" })).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
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
  it("una falla del proveedor lleva diagnostico estructurado: error 190 de Graph API (token invalido) y 5xx sin codigo; la config no es del proveedor", async () => {
    const send = (response: () => Response | Promise<Response>) =>
      new MetaGraphWhatsAppClient({ accessToken: FAKE_TOKEN, fetchImpl: (async () => response()) as unknown as typeof fetch }).sendMessage({ to: "+5219991112233", phoneNumberId: "phone-123", body: "hola" });

    const token = await send(() => jsonResponse({ error: { message: "token vencido", type: "OAuthException", code: 190 } }, 401)).catch((e: unknown) => e);
    expect(token).toBeInstanceOf(WhatsAppSendError);
    expect((token as WhatsAppSendError).info).toEqual({ proveedor: true, httpStatus: 401, graphCode: 190 });
    expect((token as WhatsAppSendError).retryable).toBe(false);

    const caido = await send(() => jsonResponse({}, 503)).catch((e: unknown) => e);
    expect((caido as WhatsAppSendError).info).toEqual({ proveedor: true, httpStatus: 503 });

    // 4xx causado por el mensaje (numero invalido, parametro de plantilla malo): NO es falla del proveedor.
    const numero = await send(() => jsonResponse({ error: { message: "numero invalido", type: "OAuthException", code: 131030 } }, 400)).catch((e: unknown) => e);
    expect((numero as WhatsAppSendError).info).toEqual({ proveedor: false, httpStatus: 400, graphCode: 131030 });
    const limite = await send(() => jsonResponse({}, 429)).catch((e: unknown) => e);
    expect((limite as WhatsAppSendError).info).toEqual({ proveedor: true, httpStatus: 429 });

    const red = await send(() => {
      throw new Error("ECONNRESET");
    }).catch((e: unknown) => e);
    expect((red as WhatsAppSendError).info).toEqual({ proveedor: true });

    expect(() => new MetaGraphWhatsAppClient({ accessToken: "" })).toThrow(WhatsAppConfigError);
    expect(new WhatsAppConfigError("falta algo").info).toBeUndefined();
  });
});
