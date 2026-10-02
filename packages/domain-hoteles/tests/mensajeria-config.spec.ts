// H-29 -- validacion del numero de WhatsApp, generacion del secreto de voz y espejo en memoria (numero unico por propiedad).
import { describe, expect, it } from "vitest";
import { InMemoryMensajeriaConfigRepository, MensajeriaConflictError, MensajeriaInvalidInputError, MensajeriaUnavailableError, generateVoiceSecret, parseWhatsAppChannelInput } from "../src/index.ts";

describe("parseWhatsAppChannelInput", () => {
  it("acepta el phone_number_id de Meta (5-20 digitos) y habilitado booleano", () => {
    expect(parseWhatsAppChannelInput({ phoneNumberId: " 109876543210987 ", habilitado: true })).toEqual({ phoneNumberId: "109876543210987", enabled: true });
  });
  it.each([
    [{ phoneNumberId: "+52 55 1234 5678", habilitado: true }, /5 a 20 digitos/],
    [{ phoneNumberId: "1234", habilitado: true }, /5 a 20 digitos/],
    [{ phoneNumberId: "1".repeat(21), habilitado: true }, /5 a 20 digitos/],
    [{ phoneNumberId: "12345", habilitado: "si" }, /true o false/],
    [{ phoneNumberId: "12345", habilitado: true, token: "EAAB..." }, /Campo desconocido: token/],
    ["texto", /objeto/],
  ])("rechaza %j", (body, msg) => {
    expect(() => parseWhatsAppChannelInput(body)).toThrow(MensajeriaInvalidInputError);
    expect(() => parseWhatsAppChannelInput(body)).toThrow(msg);
  });
});

describe("secreto de voz", () => {
  it("lo genera el servidor: 256 bits en hex, distinto cada vez", () => {
    const a = generateVoiceSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateVoiceSecret()).not.toBe(a);
  });
});

describe("InMemoryMensajeriaConfigRepository", () => {
  it("un numero ya conectado a otra propiedad es conflicto; la misma propiedad puede reeditar", async () => {
    const repo = new InMemoryMensajeriaConfigRepository();
    await repo.saveWhatsAppChannel("p1", { phoneNumberId: "11111", enabled: true }, "u");
    await expect(repo.saveWhatsAppChannel("p2", { phoneNumberId: "11111", enabled: true }, "u")).rejects.toBeInstanceOf(MensajeriaConflictError);
    expect((await repo.saveWhatsAppChannel("p1", { phoneNumberId: "11111", enabled: false }, "u")).enabled).toBe(false);
  });
  it("setVoiceEnabled sin fila de voz -> null; rotar crea la fila y el estado nunca expone el secreto", async () => {
    const repo = new InMemoryMensajeriaConfigRepository();
    expect(await repo.setVoiceEnabled("p1", true)).toBeNull();
    const status = await repo.rotateVoiceSecret("p1", "o1", "abc", false);
    expect(status).toMatchObject({ configurado: true, secretoConfigurado: true, enabled: false });
    expect(JSON.stringify(await repo.getVoiceAgent("p1"))).not.toContain("abc");
    expect(repo.storedSecret("p1")).toBe("abc");
  });
  it("sin 039 las escrituras lanzan MensajeriaUnavailableError y las lecturas dicen 'no configurado'", async () => {
    const repo = new InMemoryMensajeriaConfigRepository({ migrated: false });
    await expect(repo.rotateVoiceSecret("p1", "o1", "x", true)).rejects.toBeInstanceOf(MensajeriaUnavailableError);
    expect((await repo.getWhatsAppChannel("p1")).configurado).toBe(false);
  });
});
