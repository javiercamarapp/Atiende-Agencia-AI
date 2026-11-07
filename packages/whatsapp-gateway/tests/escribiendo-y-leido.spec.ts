// Indicador de «escribiendo» + leido de la Cloud API (POST /{phone_number_id}/messages con status=read y typing_indicator). Lo manda el webhook de
// restaurantes al tomar un turno ASINCRONO: Meta ya tiene su 200 y el turno puede tardar, asi que el cliente ve que se le atiende. Best-effort.
import { describe, expect, it, vi } from "vitest";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";

const TOKEN = "token-de-prueba";

describe("MetaGraphWhatsAppClient.marcarLeidoYEscribiendo", () => {
  it("hace UN POST con status=read, el id del mensaje del cliente y typing_indicator de texto", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: "https://graph.test" });
    await client.marcarLeidoYEscribiendo({ phoneNumberId: "pn-1", messageId: "wamid.1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.test/v21.0/pn-1/messages");
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.1", typing_indicator: { type: "text" } });
  });

  it("un error de Meta o de red se reporta sin el token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: `token ${TOKEN} invalido`, code: 190 } }), { status: 401 }));
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await client.marcarLeidoYEscribiendo({ phoneNumberId: "pn-1", messageId: "wamid.1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    const caido = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    await expect(caido.marcarLeidoYEscribiendo({ phoneNumberId: "pn-1", messageId: "wamid.1" })).rejects.toThrow();
  });

  it("sin ids no llama a Meta", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.marcarLeidoYEscribiendo({ phoneNumberId: "", messageId: "wamid.1" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
