import { describe, expect, it } from "vitest";
import {
  TokenExpiredError,
  TokenInvalidError,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../src/index.ts";

const SECRET = "test-secret-do-not-use-in-prod";

describe("access token", () => {
  it("firma y verifica un roundtrip real con jose (HS256)", async () => {
    const token = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: ["p1"], email: "a@b.com" },
      SECRET,
      60,
    );
    const claims = await verifyAccessToken(token, SECRET);
    expect(claims.sub).toBe("user-1");
    expect(claims.org_id).toBe("org-1");
    expect(claims.vertical).toBe("hoteles");
    expect(claims.property_ids).toEqual(["p1"]);
    expect(claims.email).toBe("a@b.com");
    expect(claims.type).toBe("access");
  });

  it("property_ids:null (acceso a toda la organización) sobrevive el roundtrip", async () => {
    const token = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "rentas", property_ids: null, email: "a@b.com" },
      SECRET,
      60,
    );
    const claims = await verifyAccessToken(token, SECRET);
    expect(claims.property_ids).toBeNull();
  });

  it("rechaza un token expirado con TokenExpiredError", async () => {
    const token = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: null, email: "a@b.com" },
      SECRET,
      -1,
    );
    await expect(verifyAccessToken(token, SECRET)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("rechaza un token firmado con OTRO secreto con TokenInvalidError", async () => {
    const token = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: null, email: "a@b.com" },
      SECRET,
      60,
    );
    await expect(verifyAccessToken(token, "otro-secreto-distinto")).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("rechaza un refresh token pasado a verifyAccessToken (type mismatch)", async () => {
    const refresh = await signRefreshToken("user-1", SECRET, 60);
    await expect(verifyAccessToken(refresh, SECRET)).rejects.toBeInstanceOf(TokenInvalidError);
  });
});

describe("refresh token", () => {
  it("firma y verifica un roundtrip real", async () => {
    const token = await signRefreshToken("user-1", SECRET, 60);
    const claims = await verifyRefreshToken(token, SECRET);
    expect(claims.sub).toBe("user-1");
    expect(claims.type).toBe("refresh");
  });

  it("cada refresh token trae un jti único (necesario para revocar UNO solo en logout, no todos los del usuario)", async () => {
    const a = await verifyRefreshToken(await signRefreshToken("user-1", SECRET, 60), SECRET);
    const b = await verifyRefreshToken(await signRefreshToken("user-1", SECRET, 60), SECRET);
    expect(a.jti).toBeTruthy();
    expect(b.jti).toBeTruthy();
    expect(a.jti).not.toBe(b.jti);
  });

  it("expone `exp` (epoch seconds) para que /auth/logout calcule expires_at de la fila de revocación", async () => {
    const before = Math.floor(Date.now() / 1000);
    const claims = await verifyRefreshToken(await signRefreshToken("user-1", SECRET, 60), SECRET);
    expect(claims.exp).toBeGreaterThanOrEqual(before + 60);
    expect(claims.exp).toBeLessThan(before + 65);
  });

  it("rechaza un access token pasado a verifyRefreshToken (type mismatch)", async () => {
    const access = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: null, email: "a@b.com" },
      SECRET,
      60,
    );
    await expect(verifyRefreshToken(access, SECRET)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("rechaza un refresh token expirado con TokenExpiredError", async () => {
    const token = await signRefreshToken("user-1", SECRET, -1);
    await expect(verifyRefreshToken(token, SECRET)).rejects.toBeInstanceOf(TokenExpiredError);
  });
});
