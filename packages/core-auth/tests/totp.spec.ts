import { describe, expect, it } from "vitest";
import {
  STEPUP_TTL_SECONDS,
  TokenExpiredError,
  TokenInvalidError,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  hotp,
  signStepUpToken,
  totpAt,
  totpStep,
  verifyStepUpToken,
  verifyTotp,
} from "../src/index.ts";

// Vectores de RFC 4226 apéndice D (secreto ASCII "12345678901234567890").
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_HOTP = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

describe("TOTP/HOTP", () => {
  it("coincide con los vectores de RFC 4226", () => {
    RFC_HOTP.forEach((expected, counter) => expect(hotp(RFC_SECRET, counter)).toBe(expected));
  });

  it("coincide con el vector de RFC 6238 (T=59 s -> 94287082 con 8 dígitos; 6 dígitos = 287082)", () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe("287082");
  });

  it("base32 ida y vuelta, y rechaza caracteres inválidos", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(() => base32Decode("AB1!")).toThrow();
  });

  it("verifyTotp devuelve el paso que coincide dentro de ±1 y null fuera de la ventana", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, now - 120_000), now)).toBeNull();
  });

  it("verifyTotp rechaza formatos que no son 6 dígitos", () => {
    const secret = generateTotpSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 456", "٠٠٠٠٠٠"]) expect(verifyTotp(secret, bad, Date.now())).toBeNull();
  });

  it("el secreto generado tiene 32 caracteres base32 (160 bits)", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/u);
  });

  it("otpauth URI trae secreto, emisor y parámetros estándar", () => {
    const uri = buildOtpauthUri({ secretBase32: "ABC234", accountName: "ana@example.com", issuer: "Atiende" });
    expect(uri).toBe("otpauth://totp/Atiende:ana%40example.com?secret=ABC234&issuer=Atiende&algorithm=SHA1&digits=6&period=30");
  });
});

describe("cifrado del secreto TOTP", () => {
  const KEY = "una-llave-de-servidor-suficientemente-larga";
  it("ida y vuelta", () => {
    const secret = generateTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret, KEY, "user-1"), KEY, "user-1")).toBe(secret);
  });
  it("falla con otra llave, con otro dueño (aad) o con el ciphertext alterado", () => {
    const enc = encryptTotpSecret("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(() => decryptTotpSecret(enc, "otra-llave-de-servidor-distinta-xx", "user-1")).toThrow();
    expect(() => decryptTotpSecret(enc, KEY, "user-2")).toThrow();
    const parts = enc.split(".");
    parts[3] = Buffer.from("alterado").toString("base64url");
    expect(() => decryptTotpSecret(parts.join("."), KEY, "user-1")).toThrow();
    expect(() => decryptTotpSecret("v2.a.b.c", KEY, "user-1")).toThrow();
  });
  it("rechaza material de llave vacio y produce cifrados distintos (IV aleatorio)", () => {
    expect(() => encryptTotpSecret("X", "", "u")).toThrow();
    expect(encryptTotpSecret("X", KEY, "u")).not.toBe(encryptTotpSecret("X", KEY, "u"));
  });
});

describe("token de step-up", () => {
  const SECRET = "jwt-secret-de-prueba-0123456789";
  it("valida con el mismo access token y usuario", async () => {
    const t = await signStepUpToken("u1", "access-A", SECRET);
    await expect(verifyStepUpToken(t, "access-A", "u1", SECRET)).resolves.toMatchObject({ sub: "u1", type: "stepup" });
  });
  it("rechaza otro access token (atadura ath), otro usuario y otra firma", async () => {
    const t = await signStepUpToken("u1", "access-A", SECRET);
    await expect(verifyStepUpToken(t, "access-B", "u1", SECRET)).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(verifyStepUpToken(t, "access-A", "u2", SECRET)).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(verifyStepUpToken(t, "access-A", "u1", "otro-secreto-distinto-0123456789")).rejects.toBeInstanceOf(TokenInvalidError);
  });
  it("rechaza un access token o refresh token usado como step-up", async () => {
    const { signAccessToken } = await import("../src/index.ts");
    const access = await signAccessToken({ sub: "u1", org_id: "o", vertical: "hoteles", property_ids: null, email: "a@b.c" }, SECRET, 60);
    await expect(verifyStepUpToken(access, access, "u1", SECRET)).rejects.toBeInstanceOf(TokenInvalidError);
  });
  it("expira", async () => {
    const t = await signStepUpToken("u1", "access-A", SECRET, -10);
    await expect(verifyStepUpToken(t, "access-A", "u1", SECRET)).rejects.toBeInstanceOf(TokenExpiredError);
  });
  it("TTL por defecto de 5 minutos", () => {
    expect(STEPUP_TTL_SECONDS).toBe(300);
  });
});
