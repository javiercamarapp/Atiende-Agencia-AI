// R11 romper -- el proveedor de WhatsApp (Meta Graph API) falla o contesta raro. Cliente real (MetaGraphWhatsAppClient) con `fetch` simulado: nada sale a la red.
// Afirma como se clasifica cada falla (reintentable / permanente / falla de proveedor) y que una respuesta rara NUNCA se toma por envio exitoso.
import { describe, expect, it, vi } from "vitest";
import { MAX_TEXT_BODY_LENGTH, MetaGraphWhatsAppClient, WhatsAppInvalidPayloadError, WhatsAppSendError } from "../src/index.ts";

const msg = (body = "Hola") => ({ to: "5219991234567", phoneNumberId: "123456", body });
const respuesta = (status: number, cuerpo: unknown) => vi.fn(async () => new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status }));
const cliente = (fetchImpl: typeof fetch) => new MetaGraphWhatsAppClient({ accessToken: "token-de-prueba", fetchImpl });

describe("R11-W1 clasificacion de fallas del proveedor", () => {
  const casos: ReadonlyArray<readonly [string, number, unknown, boolean]> = [
    ["429 limite de Meta", 429, { error: { code: 4, message: "rate" } }, true],
    ["500 error de Meta", 500, { error: { message: "boom" } }, true],
    ["503 con HTML", 503, "<html>Service Unavailable</html>", true],
    ["400 parametro invalido", 400, { error: { code: 100, message: "invalid" } }, false],
    ["401/190 token vencido", 401, { error: { code: 190, message: "expired" } }, false],
    ["403 sin permiso", 403, { error: { code: 10, message: "perm" } }, false],
    ["404 numero inexistente", 404, { error: { message: "nope" } }, false],
  ];
  it.each(casos)("%s -> reintentable=%s", async (_n, status, cuerpo, reintentable) => {
    const err = await cliente(respuesta(status, cuerpo) as unknown as typeof fetch).sendMessage(msg()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect((err as WhatsAppSendError).retryable).toBe(reintentable);
  });

  it("el token vencido (190) cuenta como falla del PROVEEDOR (alerta de proveedor caido); un 400 por el contenido del mensaje no", async () => {
    const vencido = await cliente(respuesta(401, { error: { code: 190, message: "x" } }) as unknown as typeof fetch).sendMessage(msg()).catch((e: WhatsAppSendError) => e);
    const malo = await cliente(respuesta(400, { error: { code: 100, message: "x" } }) as unknown as typeof fetch).sendMessage(msg()).catch((e: WhatsAppSendError) => e);
    expect((vencido as WhatsAppSendError).info?.proveedor).toBe(true);
    expect((malo as WhatsAppSendError).info?.proveedor).toBe(false);
  });

  it("un fallo de red (DNS, conexion rechazada, timeout) es reintentable y falla de proveedor", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = (await cliente(f as unknown as typeof fetch).sendMessage(msg()).catch((e: unknown) => e)) as WhatsAppSendError;
    expect(err.retryable).toBe(true);
    expect(err.info?.proveedor).toBe(true);
  });

  it("un 2xx raro (cuerpo que no es JSON, JSON sin id de mensaje, arreglo, null) NUNCA se toma por envio exitoso", async () => {
    for (const cuerpo of ["<html>ok</html>", "{}", "[]", "null", '{"messages":[]}', '{"messages":[{}]}']) {
      await expect(cliente(respuesta(200, cuerpo) as unknown as typeof fetch).sendMessage(msg()), cuerpo).rejects.toBeInstanceOf(Error);
    }
  });

  it("(control) un 2xx con id de mensaje se acepta y devuelve el wamid", async () => {
    const r = await cliente(respuesta(200, { messages: [{ id: "wamid.OK" }] }) as unknown as typeof fetch).sendMessage(msg());
    expect(r.providerMessageId).toBe("wamid.OK");
  });

  it("mensajes incompletos (sin destino, sin numero emisor, sin cuerpo) se rechazan antes de tocar la red", async () => {
    const f = vi.fn();
    const c = cliente(f as unknown as typeof fetch);
    for (const m of [{ ...msg(), to: "" }, { ...msg(), phoneNumberId: "" }, { ...msg(), body: "" }]) await expect(c.sendMessage(m)).rejects.toBeInstanceOf(WhatsAppSendError);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("R11-W2 tamano del texto saliente", () => {
  // R11-12b (corregido): Meta rechaza un texto de mas de 4096 caracteres (400, no reintentable). `encolarRespuesta` ya divide en partes <= 4000; este cliente
  // es la ultima red: rechaza localmente con WhatsAppInvalidPayloadError ANTES de la red, para que el outbox explique por que quedo `dead`.
  it("R11-12b [P2] un texto de 6000 caracteres no viaja a Meta tal cual (se divide / acota, o se rechaza localmente)", async () => {
    const f = respuesta(200, { messages: [{ id: "wamid.LARGO" }] });
    const cuerpo = "Tenemos tacos de bistec, pastor y arrachera. ".repeat(140);
    expect(cuerpo.length).toBeGreaterThan(4096); // control del insumo
    await cliente(f as unknown as typeof fetch).sendMessage(msg(cuerpo)).catch(() => undefined);
    for (const llamada of f.mock.calls as unknown as Array<[string, { body: string }]>) {
      const enviado = JSON.parse(llamada[1].body) as { text?: { body?: string } };
      expect((enviado.text?.body ?? "").length).toBeLessThanOrEqual(4096);
    }
  });

  it("el limite es exacto: 4096 caracteres viajan; 4097 se rechazan antes de la red con un error permanente y explicado", async () => {
    const ok = respuesta(200, { messages: [{ id: "wamid.OK" }] });
    await expect(cliente(ok as unknown as typeof fetch).sendMessage(msg("a".repeat(MAX_TEXT_BODY_LENGTH)))).resolves.toMatchObject({ providerMessageId: "wamid.OK" });
    const f = respuesta(200, { messages: [{ id: "wamid.NO" }] });
    const err = await cliente(f as unknown as typeof fetch).sendMessage(msg("a".repeat(MAX_TEXT_BODY_LENGTH + 1))).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppInvalidPayloadError);
    expect((err as WhatsAppSendError).retryable).toBe(false);
    expect(String((err as Error).message)).toContain("4096");
    expect(f).not.toHaveBeenCalled();
  });
});
