import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIdentityCipher, identityAad, parseIdentityKey } from "../../src/identity/cipher.ts";
import { IdentityDecryptError, IdentityUnavailableError } from "../../src/identity/errors.ts";

// Mismo patron que el CHECK de formato de migrations/031 (payload_enc).
const SQL_FORMAT = /^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$/;

describe("IdentityCipher (AES-256-GCM)", () => {
  const key = randomBytes(32);
  const aad = identityAad("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");

  it("cifra y descifra ida y vuelta; el sobre cumple el formato que exige el CHECK de la base y no contiene el texto plano", () => {
    const cipher = createIdentityCipher(key, 1);
    const secret = JSON.stringify({ fullName: "Ana Torres", documentNumber: "G12345678" });
    const envelope = cipher.encrypt(secret, aad);
    expect(envelope).toMatch(SQL_FORMAT);
    expect(envelope).not.toContain("Ana");
    expect(envelope).not.toContain("G12345678");
    expect(cipher.decrypt(envelope, aad)).toBe(secret);
  });

  it("dos cifrados del mismo texto producen sobres distintos (IV aleatorio)", () => {
    const cipher = createIdentityCipher(key, 1);
    expect(cipher.encrypt("igual", aad)).not.toBe(cipher.encrypt("igual", aad));
  });

  it("un sobre copiado a otra fila/property falla la autenticacion (AAD distinta)", () => {
    const cipher = createIdentityCipher(key, 1);
    const envelope = cipher.encrypt("secreto", aad);
    expect(() => cipher.decrypt(envelope, identityAad("33333333-3333-3333-3333-333333333333", "22222222-2222-2222-2222-222222222222"))).toThrow(IdentityDecryptError);
    expect(() => cipher.decrypt(envelope, identityAad("11111111-1111-1111-1111-111111111111", "44444444-4444-4444-4444-444444444444"))).toThrow(IdentityDecryptError);
  });

  it("un sobre alterado (un byte del ciphertext o del tag) falla la autenticacion", () => {
    const cipher = createIdentityCipher(key, 1);
    const [v, iv, tag, ct] = cipher.encrypt("secreto-largo-para-alterar", aad).split(".") as [string, string, string, string];
    const flipped = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(() => cipher.decrypt([v, iv, tag, flipped(ct)].join("."), aad)).toThrow(IdentityDecryptError);
    expect(() => cipher.decrypt([v, iv, flipped(tag), ct].join("."), aad)).toThrow(IdentityDecryptError);
  });

  it("una llave distinta no descifra", () => {
    const envelope = createIdentityCipher(key, 1).encrypt("secreto", aad);
    expect(() => createIdentityCipher(randomBytes(32), 1).decrypt(envelope, aad)).toThrow(IdentityDecryptError);
  });

  it("un sobre de otra version de llave responde 'no disponible' (rotacion), no un error de descifrado generico", () => {
    const envelope = createIdentityCipher(key, 1).encrypt("secreto", aad);
    expect(() => createIdentityCipher(key, 2).decrypt(envelope, aad)).toThrow(IdentityUnavailableError);
  });

  it("basura que no es un sobre falla con IdentityDecryptError", () => {
    expect(() => createIdentityCipher(key, 1).decrypt("no-es-un-sobre", aad)).toThrow(IdentityDecryptError);
  });

  it("parseIdentityKey: null/vacio = sin llave; 32 bytes base64 ok; otra longitud o basura = error de configuracion", () => {
    expect(parseIdentityKey(undefined)).toBeNull();
    expect(parseIdentityKey("   ")).toBeNull();
    expect(parseIdentityKey(randomBytes(32).toString("base64"))?.length).toBe(32);
    expect(() => parseIdentityKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseIdentityKey("esto no es base64 !!!")).toThrow(/base64/);
  });
});
