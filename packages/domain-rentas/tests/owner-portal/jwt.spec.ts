// Test real (sin mocks) del JWT de scope "propietario" -- verifica el discriminador de
// tipo, el secreto de firma independiente del de staff, y la expiración. Ver diseño
// Fase 3 rentas §1.2/§3.
import { describe, expect, it } from "vitest";
import {
  RentasPropertyOwnerTokenExpiredError,
  RentasPropertyOwnerTokenInvalidError,
  signRentasPropertyOwnerAccessToken,
  signRentasPropertyOwnerRefreshToken,
  verifyRentasPropertyOwnerAccessToken,
  verifyRentasPropertyOwnerRefreshToken,
} from "../../src/owner-portal/jwt.ts";

const SECRET_A = "secreto-de-propietario-de-prueba";
const SECRET_B = "otro-secreto-completamente-distinto";

describe("JWT de portal de propietario", () => {
  it("firma y verifica un access token con el discriminador rentas_property_owner_access", async () => {
    const token = await signRentasPropertyOwnerAccessToken({ sub: "owner-1", email: "propietario@ejemplo.mx" }, SECRET_A, 900);
    const claims = await verifyRentasPropertyOwnerAccessToken(token, SECRET_A);
    expect(claims.sub).toBe("owner-1");
    expect(claims.email).toBe("propietario@ejemplo.mx");
    expect(claims.type).toBe("rentas_property_owner_access");
  });

  it("un token firmado con OTRO secreto (ej. el de staff) nunca verifica -- secretos independientes por diseño", async () => {
    const token = await signRentasPropertyOwnerAccessToken({ sub: "owner-1", email: "propietario@ejemplo.mx" }, SECRET_A, 900);
    await expect(verifyRentasPropertyOwnerAccessToken(token, SECRET_B)).rejects.toBeInstanceOf(RentasPropertyOwnerTokenInvalidError);
  });

  it("un access token expirado lanza RentasPropertyOwnerTokenExpiredError", async () => {
    const token = await signRentasPropertyOwnerAccessToken({ sub: "owner-1", email: "propietario@ejemplo.mx" }, SECRET_A, -1);
    await expect(verifyRentasPropertyOwnerAccessToken(token, SECRET_A)).rejects.toBeInstanceOf(RentasPropertyOwnerTokenExpiredError);
  });

  it("un refresh token no verifica como access token, y viceversa", async () => {
    const refresh = await signRentasPropertyOwnerRefreshToken("owner-1", SECRET_A, 900);
    await expect(verifyRentasPropertyOwnerAccessToken(refresh, SECRET_A)).rejects.toBeInstanceOf(RentasPropertyOwnerTokenInvalidError);

    const access = await signRentasPropertyOwnerAccessToken({ sub: "owner-1", email: "x@x.mx" }, SECRET_A, 900);
    await expect(verifyRentasPropertyOwnerRefreshToken(access, SECRET_A)).rejects.toBeInstanceOf(RentasPropertyOwnerTokenInvalidError);
  });

  it("roundtrip de refresh token", async () => {
    const token = await signRentasPropertyOwnerRefreshToken("owner-42", SECRET_A, 900);
    const claims = await verifyRentasPropertyOwnerRefreshToken(token, SECRET_A);
    expect(claims.sub).toBe("owner-42");
    expect(claims.type).toBe("rentas_property_owner_refresh");
  });
});
