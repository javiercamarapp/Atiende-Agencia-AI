import { describe, expect, it, vi } from "vitest";
import { transitionContract } from "../src/verticals/licitaciones/lib/contract-client.ts";
import {
  CONTRACT_STEP_UP_TRANSITIONS,
  TWO_FACTOR_UNAVAILABLE,
  confirmTwoFactorSetup,
  disableTwoFactor,
  fetchTwoFactorStatus,
  regenerateBackupCodes,
  requestStepUpToken,
  secondFactorFromText,
  startTwoFactorSetup,
} from "../src/verticals/licitaciones/lib/two-factor-client.ts";

const API = "http://api.local";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchTwoFactorStatus (compatibilidad base sin migrar)", () => {
  it("devuelve el estado del servidor", async () => {
    const f = vi.fn(async () => json({ available: true, enabled: true, pending: false, lockedUntil: null, backupCodesRemaining: 6 })) as unknown as typeof fetch;
    expect(await fetchTwoFactorStatus(f, API, "tok")).toEqual({ available: true, enabled: true, pending: false, lockedUntil: null, backupCodesRemaining: 6 });
  });

  it("available:false del servidor => no disponible (la UI NO exige codigo)", async () => {
    const f = vi.fn(async () => json({ available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 })) as unknown as typeof fetch;
    expect((await fetchTwoFactorStatus(f, API, "tok")).available).toBe(false);
  });

  it("error de red o 5xx NUNCA lanza: cae a 'no disponible'", async () => {
    const boom = vi.fn(async () => {
      throw new Error("red caida");
    }) as unknown as typeof fetch;
    expect(await fetchTwoFactorStatus(boom, API, "tok")).toEqual(TWO_FACTOR_UNAVAILABLE);
    const fail = vi.fn(async () => json({ message: "x" }, 503)) as unknown as typeof fetch;
    expect(await fetchTwoFactorStatus(fail, API, "tok")).toEqual(TWO_FACTOR_UNAVAILABLE);
  });
});

describe("secondFactorFromText", () => {
  it("6 digitos (con o sin espacios) = TOTP; otra cosa = respaldo; vacio = null", () => {
    expect(secondFactorFromText("123456")).toEqual({ code: "123456" });
    expect(secondFactorFromText(" 123 456 ")).toEqual({ code: "123456" });
    expect(secondFactorFromText("ABCDE-FGHJK")).toEqual({ backupCode: "ABCDE-FGHJK" });
    expect(secondFactorFromText("12345")).toEqual({ backupCode: "12345" });
    expect(secondFactorFromText("   ")).toBeNull();
  });
});

describe("rutas de 2FA", () => {
  it("setup/confirm/step-up/respaldos/desactivar pegan a la ruta y cuerpo reales", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/auth/2fa/setup")) return json({ secret: "S", otpauthUrl: "otpauth://x" }, 201);
      if (url.endsWith("/auth/2fa/confirm")) return json({ enabled: true, backupCodes: ["A", "B"] });
      if (url.endsWith("/auth/step-up")) return json({ stepUpToken: "tok-su", expiresInSeconds: 300 });
      if (url.endsWith("/auth/2fa/backup-codes")) return json({ backupCodes: ["C"] });
      return json({ enabled: false });
    }) as unknown as typeof fetch;
    expect(await startTwoFactorSetup(f, API, "t")).toEqual({ secret: "S", otpauthUrl: "otpauth://x" });
    expect(await confirmTwoFactorSetup(f, API, "t", "123456")).toEqual(["A", "B"]);
    expect(await requestStepUpToken(f, API, "t", "contract_sensitive", { code: "654321" })).toBe("tok-su");
    expect(await regenerateBackupCodes(f, API, "t", { backupCode: "ABCDE-FGHJK" })).toEqual(["C"]);
    await disableTwoFactor(f, API, "t", "clave", { code: "111111" });
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["/auth/2fa/setup", "/auth/2fa/confirm", "/auth/step-up", "/auth/2fa/backup-codes", "/auth/2fa/disable"]);
    expect(calls[2]!.body).toEqual({ scope: "contract_sensitive", code: "654321" });
    expect(calls[4]!.body).toEqual({ password: "clave", code: "111111" });
  });

  it("un 422 de codigo incorrecto propaga el mensaje real del servidor", async () => {
    const f = vi.fn(async () => json({ code: "second_factor_invalid", message: "El código es incorrecto o ya se usó." }, 422)) as unknown as typeof fetch;
    await expect(confirmTwoFactorSetup(f, API, "t", "000000")).rejects.toThrow("El código es incorrecto");
  });
});

describe("transitionContract con step-up", () => {
  it("envia X-Step-Up-Token solo cuando hay token", async () => {
    const seen: Array<Record<string, string>> = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return json({ id: "c1", status: "rescindido" });
    }) as unknown as typeof fetch;
    await transitionContract(f, API, "tok", "p1", "t1", { toStatus: "rescindido", reason: "motivo" });
    await transitionContract(f, API, "tok", "p1", "t1", { toStatus: "rescindido", reason: "motivo", stepUpToken: "tok-su" });
    expect(seen[0]!["x-step-up-token"]).toBeUndefined();
    expect(seen[1]!["x-step-up-token"]).toBe("tok-su");
  });

  it("el espejo de transiciones sensibles coincide con el dominio (rescindir, penalizar, inconformidad, modificar, pagar)", () => {
    expect([...CONTRACT_STEP_UP_TRANSITIONS].sort()).toEqual(["en_inconformidad", "modificado", "pagado", "penalizado", "rescindido"]);
  });
});
