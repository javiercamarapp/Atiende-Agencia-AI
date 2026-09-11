import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/whatsapp/meta-signature.ts";

const APP_SECRET = "un-secreto-de-meta-app-de-prueba";

function sign(rawBody: Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("verifyMetaSignature — HMAC sobre bytes crudos", () => {
  it("acepta una firma real calculada sobre los mismos bytes", async () => {
    const rawBody = new TextEncoder().encode(JSON.stringify({ entry: [{ id: "1" }] }));
    const header = sign(rawBody, APP_SECRET);
    expect(await verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(true);
  });

  it("rechaza si el body fue alterado después de calcular la firma (detecta manipulación de bytes)", async () => {
    const original = new TextEncoder().encode(JSON.stringify({ entry: [{ id: "1" }] }));
    const header = sign(original, APP_SECRET);
    const tampered = new TextEncoder().encode(JSON.stringify({ entry: [{ id: "2" }] }));
    expect(await verifyMetaSignature(tampered, header, APP_SECRET)).toBe(false);
  });

  it("rechaza sin header, sin appSecret, o con formato de header inválido", async () => {
    const rawBody = new TextEncoder().encode("{}");
    expect(await verifyMetaSignature(rawBody, null, APP_SECRET)).toBe(false);
    expect(await verifyMetaSignature(rawBody, sign(rawBody, APP_SECRET), null)).toBe(false);
    expect(await verifyMetaSignature(rawBody, "no-trae-prefijo-sha256=", APP_SECRET)).toBe(false);
    expect(await verifyMetaSignature(rawBody, "sha256=no-es-hex", APP_SECRET)).toBe(false);
  });

  it("rechaza una firma calculada con el secreto equivocado", async () => {
    const rawBody = new TextEncoder().encode("{}");
    const header = sign(rawBody, "otro-secreto-distinto");
    expect(await verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(false);
  });

  it("verifica sobre bytes que incluyen UTF-8 multibyte real (nombres/direcciones con acentos), no solo ASCII", async () => {
    const rawBody = new TextEncoder().encode(JSON.stringify({ text: "Dirección: Calle Montejo, José Ñáñez" }));
    const header = sign(rawBody, APP_SECRET);
    expect(await verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(true);
  });
});
