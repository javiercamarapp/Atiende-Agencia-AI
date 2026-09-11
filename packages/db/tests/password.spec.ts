import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.ts";

describe("password (scrypt, ported de hoteles/packages/db/src/password.ts)", () => {
  it("verifyPassword acepta la contraseña correcta contra su propio hash", async () => {
    const stored = await hashPassword("correcto-caballo-batería-grapa");
    expect(await verifyPassword("correcto-caballo-batería-grapa", stored)).toBe(true);
  });

  it("verifyPassword rechaza una contraseña incorrecta", async () => {
    const stored = await hashPassword("la-real");
    expect(await verifyPassword("otra-cosa", stored)).toBe(false);
  });

  it("verifyPassword rechaza null/undefined/formato corrupto sin lanzar", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "no-es-un-hash-scrypt")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$saltnohex$hashnohex")).toBe(false);
  });

  it("dos hashes de la misma contraseña usan salt distinto (nunca hash reutilizable)", async () => {
    const a = await hashPassword("misma-contraseña");
    const b = await hashPassword("misma-contraseña");
    expect(a).not.toBe(b);
    expect(await verifyPassword("misma-contraseña", a)).toBe(true);
    expect(await verifyPassword("misma-contraseña", b)).toBe(true);
  });
});
