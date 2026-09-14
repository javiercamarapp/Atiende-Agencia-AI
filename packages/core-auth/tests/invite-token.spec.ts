import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "../src/index.ts";

describe("generateInviteToken / hashInviteToken", () => {
  it("genera un token plano y su hash sha256 en hex", () => {
    const { tokenPlain, tokenHash } = generateInviteToken();
    expect(tokenPlain.length).toBeGreaterThan(20);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(tokenPlain)).toBe(tokenHash);
  });

  it("dos tokens generados nunca coinciden (aleatorio real, no determinista)", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.tokenPlain).not.toBe(b.tokenPlain);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("hashInviteToken es determinista para el mismo token plano", () => {
    const { tokenPlain, tokenHash } = generateInviteToken();
    expect(hashInviteToken(tokenPlain)).toBe(tokenHash);
    expect(hashInviteToken(tokenPlain)).toBe(hashInviteToken(tokenPlain));
  });

  it("un cambio mínimo en el token produce un hash totalmente distinto", () => {
    const { tokenPlain, tokenHash } = generateInviteToken();
    const mutado = tokenPlain.slice(0, -1) + (tokenPlain.at(-1) === "a" ? "b" : "a");
    expect(hashInviteToken(mutado)).not.toBe(tokenHash);
  });
});
