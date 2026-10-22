// La cola de Entregado se separa por persona sin asumir correo (acceso de choferes por celular + codigo).
import { describe, expect, it } from "vitest";
import { identidadDeSesion } from "../src/verticals/restaurantes/lib/identidad-sesion.ts";

const jwt = (carga: object) => `cabecera.${btoa(JSON.stringify(carga)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.firma`;

describe("identidadDeSesion", () => {
  it("prefiere el id de usuario del token (estable aunque el token se refresque) sobre el correo", () => {
    const a = identidadDeSesion({ token: jwt({ sub: "usr-1", exp: 1 }), email: "x@example.test", fullName: "X" });
    const b = identidadDeSesion({ token: jwt({ sub: "usr-1", exp: 2 }), email: "otro@example.test", fullName: "X" });
    expect(a).toBe("usr-1");
    expect(b).toBe("usr-1");
  });
  it("sin correo (acceso por celular) sigue distinguiendo a las personas", () => {
    expect(identidadDeSesion({ token: jwt({ sub: "usr-1" }), email: "", fullName: "" })).not.toBe(identidadDeSesion({ token: jwt({ sub: "usr-2" }), email: "", fullName: "" }));
  });
  it("token ilegible: cae al correo, luego al nombre y por ultimo a un valor fijo, sin lanzar", () => {
    expect(identidadDeSesion({ token: "no-es-jwt", email: "ana@example.test", fullName: "Ana" })).toBe("ana@example.test");
    expect(identidadDeSesion({ token: "x.%%%.y", email: "", fullName: "Ana" })).toBe("Ana");
    expect(identidadDeSesion({ token: "", email: "", fullName: "" })).toBe("sin-identidad");
  });
});
