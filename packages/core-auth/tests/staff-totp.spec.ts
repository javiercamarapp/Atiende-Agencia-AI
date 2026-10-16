import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpAuthUrl,
  computeTotp,
  decryptStaffTotpSecret,
  encryptStaffTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  normalizeBackupCode,
  signAccessToken,
  signContractStepUpToken,
  TokenExpiredError,
  TokenInvalidError,
  totpTimeStep,
  verifyAccessToken,
  verifyContractStepUpToken,
  verifyStaffTotp,
} from "../src/index.ts";

// Vector de RFC 6238 (apendice B): secreto ASCII "12345678901234567890", SHA1, T=59 s.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("coincide con los vectores oficiales del RFC (6 digitos = ultimos 6 de los de 8)", () => {
    expect(computeTotp(RFC_SECRET, 59_000)).toBe("287082");
    expect(computeTotp(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(computeTotp(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
    expect(computeTotp(RFC_SECRET, 20_000_000_000_000)).toBe("353130");
  });

  it("base32 hace ida y vuelta", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(() => base32Decode("no-es-base32!")).toThrow();
  });

  it("acepta el paso actual y +-1, rechaza +-2 y devuelve el paso coincidente", () => {
    const now = 1_700_000_000_000;
    const step = totpTimeStep(now);
    expect(verifyStaffTotp(RFC_SECRET, computeTotp(RFC_SECRET, now), now)).toBe(step);
    expect(verifyStaffTotp(RFC_SECRET, computeTotp(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyStaffTotp(RFC_SECRET, computeTotp(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
    expect(verifyStaffTotp(RFC_SECRET, computeTotp(RFC_SECRET, now - 60_000), now)).toBeNull();
    expect(verifyStaffTotp(RFC_SECRET, computeTotp(RFC_SECRET, now + 60_000), now)).toBeNull();
  });

  it("rechaza formatos que no son 6 digitos sin lanzar", () => {
    expect(verifyStaffTotp(RFC_SECRET, "12345", 0)).toBeNull();
    expect(verifyStaffTotp(RFC_SECRET, "abcdef", 0)).toBeNull();
    expect(verifyStaffTotp(RFC_SECRET, "1234567", 0)).toBeNull();
  });

  it("genera secretos distintos de 160 bits y una URL otpauth bien formada", () => {
    const a = generateTotpSecret();
    expect(a).not.toBe(generateTotpSecret());
    expect(base32Decode(a)).toHaveLength(20);
    const url = buildOtpAuthUrl({ issuer: "Atiende", accountEmail: "ana@ejemplo.mx", secretBase32: a });
    expect(url.startsWith("otpauth://totp/Atiende:ana%40ejemplo.mx?")).toBe(true);
    expect(url).toContain(`secret=${a}`);
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});

describe("codigos de respaldo", () => {
  it("genera 8 codigos unicos con formato XXXXX-XXXXX sin caracteres ambiguos", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/u);
  });

  it("normaliza minusculas, espacios y guion opcional; rechaza basura", () => {
    expect(normalizeBackupCode("abcde fghjk")).toBe("ABCDE-FGHJK");
    expect(normalizeBackupCode("abcdefghjk")).toBe("ABCDE-FGHJK");
    expect(normalizeBackupCode("ABCDE-FGHJ")).toBeNull();
    expect(normalizeBackupCode("ABCDE-FGHJ0")).toBeNull();
  });

  it("el hash es determinista, hex de 64 y distinto por codigo", () => {
    expect(hashBackupCode("ABCDE-FGHJK")).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashBackupCode("ABCDE-FGHJK")).toBe(hashBackupCode("ABCDE-FGHJK"));
    expect(hashBackupCode("ABCDE-FGHJK")).not.toBe(hashBackupCode("ABCDE-FGHJM"));
  });
});

describe("cifrado del secreto TOTP", () => {
  it("descifra con la misma clave, no con otra, y detecta manipulacion", () => {
    const s = generateTotpSecret();
    const stored = encryptStaffTotpSecret(s, "secreto-app-1");
    expect(stored).not.toContain(s);
    expect(decryptStaffTotpSecret(stored, "secreto-app-1")).toBe(s);
    expect(() => decryptStaffTotpSecret(stored, "otro-secreto")).toThrow();
    const parts = stored.split(".");
    parts[3] = Buffer.from("manipulado").toString("base64url");
    expect(() => decryptStaffTotpSecret(parts.join("."), "secreto-app-1")).toThrow();
    expect(() => decryptStaffTotpSecret("basura", "secreto-app-1")).toThrow();
  });

  it("dos cifrados del mismo secreto difieren (IV aleatorio)", () => {
    expect(encryptStaffTotpSecret("ABC", "k")).not.toBe(encryptStaffTotpSecret("ABC", "k"));
  });
});

describe("token de step-up", () => {
  const secret = "s".repeat(40);
  const expected = { userId: "u1", organizationId: "o1", scope: "contract_sensitive" } as const;

  it("emite y verifica un token atado a usuario, organizacion y alcance", async () => {
    const t = await signContractStepUpToken(expected, secret);
    const claims = await verifyContractStepUpToken(t, secret, expected);
    expect(claims.sub).toBe("u1");
    expect(claims.org).toBe("o1");
  });

  it("rechaza otro usuario, otra organizacion, otro secreto y un token vencido", async () => {
    const t = await signContractStepUpToken(expected, secret);
    await expect(verifyContractStepUpToken(t, secret, { ...expected, userId: "u2" })).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(verifyContractStepUpToken(t, secret, { ...expected, organizationId: "o2" })).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(verifyContractStepUpToken(t, "otro".repeat(12), expected)).rejects.toBeInstanceOf(TokenInvalidError);
    const vencido = await signContractStepUpToken(expected, secret, -10);
    await expect(verifyContractStepUpToken(vencido, secret, expected)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("cada token trae un jti unico y vigencia (llave del consumo de un solo uso)", async () => {
    const a = await verifyContractStepUpToken(await signContractStepUpToken(expected, secret), secret, expected);
    const b = await verifyContractStepUpToken(await signContractStepUpToken(expected, secret), secret, expected);
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.jti).not.toBe(b.jti);
    expect(typeof a.exp).toBe("number");
  });

  it("un token sin jti (emitido antes del uso unico) no se acepta", async () => {
    const { SignJWT } = await import("jose");
    const sinJti = await new SignJWT({ org: "o1", scope: "contract_sensitive", type: "step_up" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("60s").setSubject("u1")
      .sign(new TextEncoder().encode(`step-up:${secret}`));
    await expect(verifyContractStepUpToken(sinJti, secret, expected)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("un access token no sirve como step-up ni al reves", async () => {
    const access = await signAccessToken({ sub: "u1", org_id: "o1", vertical: "licitaciones", property_ids: null, email: "a@b.mx" }, secret, 60);
    await expect(verifyContractStepUpToken(access, secret, expected)).rejects.toBeInstanceOf(TokenInvalidError);
    const stepUp = await signContractStepUpToken(expected, secret);
    await expect(verifyAccessToken(stepUp, secret)).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
