// L-01 -- segundo factor TOTP, step-up y contrato, por HTTP real (Hono + repos en memoria).
// El SQL/RLS real se prueba en scripts/verify-staff-2fa; aqui se prueba la logica de rutas.
import { describe, expect, it } from "vitest";
import { computeTotp } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
  const deps = { ...ctx.deps, staffSecurityRepo: security };
  return { ctx, security, app: buildApp(deps) };
}

type App = ReturnType<typeof buildApp>;

/** Alta completa: devuelve el secreto y los codigos de respaldo. */
async function enroll(app: App, token: string): Promise<{ secret: string; backupCodes: string[] }> {
  const setup = await app.request("/auth/2fa/setup", authedJson(token, {}));
  expect(setup.status).toBe(201);
  const { secret } = (await setup.json()) as { secret: string };
  const confirm = await app.request("/auth/2fa/confirm", authedJson(token, { code: computeTotp(secret, Date.now()) }));
  expect(confirm.status).toBe(200);
  const { backupCodes } = (await confirm.json()) as { backupCodes: string[] };
  return { secret, backupCodes };
}

describe("POST /auth/2fa/setup, /confirm y GET /status", () => {
  it("requiere sesion; el estado inicial es 'disponible, sin activar'", async () => {
    const { app, ctx } = await setup();
    expect((await app.request("/auth/2fa/status")).status).toBe(401);
    const res = await app.request("/auth/2fa/status", authedJson(ctx.staff.owner.token));
    expect(await res.json()).toEqual({ available: true, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 });
  });

  it("alta: setup devuelve secreto y otpauth (el secreto se guarda CIFRADO); confirmar con codigo correcto activa y entrega 8 respaldos una vez", async () => {
    const { app, ctx, security } = await setup();
    const res = await app.request("/auth/2fa/setup", authedJson(ctx.staff.owner.token, {}));
    const body = (await res.json()) as { secret: string; otpauthUrl: string };
    expect(body.otpauthUrl).toContain("otpauth://totp/Atiende:owner%40empresa-de-prueba.mx");
    const stored = await security.getTotpSecret(ctx.staff.owner.id);
    expect(stored?.secretCiphertext).not.toContain(body.secret);
    expect((await (await app.request("/auth/2fa/status", authedJson(ctx.staff.owner.token))).json()) as { pending: boolean }).toMatchObject({ pending: true, enabled: false });

    const confirm = await app.request("/auth/2fa/confirm", authedJson(ctx.staff.owner.token, { code: computeTotp(body.secret, Date.now()) }));
    expect(confirm.status).toBe(200);
    const { backupCodes } = (await confirm.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(8);
    expect((await (await app.request("/auth/2fa/status", authedJson(ctx.staff.owner.token))).json()) as { enabled: boolean }).toMatchObject({ enabled: true, backupCodesRemaining: 8 });
  });

  it("confirmar con codigo incorrecto -> 422 (nunca 401) y cuenta el fallo; 5 fallos -> 429 bloqueado", async () => {
    const { app, ctx } = await setup();
    await app.request("/auth/2fa/setup", authedJson(ctx.staff.owner.token, {}));
    for (let i = 0; i < 4; i += 1) {
      const bad = await app.request("/auth/2fa/confirm", authedJson(ctx.staff.owner.token, { code: "000000" }));
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { code: string }).code).toBe("second_factor_invalid");
    }
    const locked = await app.request("/auth/2fa/confirm", authedJson(ctx.staff.owner.token, { code: "000000" }));
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { code: string }).code).toBe("second_factor_locked");
  });

  it("formato de codigo invalido -> 400; setup con 2FA activo -> 409", async () => {
    const { app, ctx } = await setup();
    await app.request("/auth/2fa/setup", authedJson(ctx.staff.owner.token, {}));
    expect((await app.request("/auth/2fa/confirm", authedJson(ctx.staff.owner.token, { code: "abc" }))).status).toBe(400);
    await enroll(app, ctx.staff.admin.token);
    expect((await app.request("/auth/2fa/setup", authedJson(ctx.staff.admin.token, {}))).status).toBe(409);
  });

  it("aislamiento entre usuarios: el 2FA de uno no afecta el estado de otro", async () => {
    const { app, ctx } = await setup();
    await enroll(app, ctx.staff.owner.token);
    const other = await app.request("/auth/2fa/status", authedJson(ctx.staff.admin.token));
    expect(await other.json()).toMatchObject({ enabled: false });
  });
});

describe("POST /auth/step-up", () => {
  it("sin 2FA activo -> 403 step_up_enrollment_required", async () => {
    const { app, ctx } = await setup();
    const res = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", code: "123456" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("step_up_enrollment_required");
  });

  it("codigo TOTP valido de un paso posterior emite token; el mismo paso ya usado es replay -> 422", async () => {
    const { app, ctx } = await setup();
    const { secret } = await enroll(app, ctx.staff.owner.token);
    // El paso de confirmacion ya se consumio: el codigo actual es replay.
    const replay = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", code: computeTotp(secret, Date.now()) }));
    expect(replay.status).toBe(422);
    const ok = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", code: computeTotp(secret, Date.now() + 30_000) }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { stepUpToken: string; expiresInSeconds: number }).expiresInSeconds).toBe(300);
  });

  it("codigo de respaldo sirve UNA vez; scope desconocido -> 400; sin codigo -> 400", async () => {
    const { app, ctx } = await setup();
    const { backupCodes } = await enroll(app, ctx.staff.owner.token);
    const first = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", backupCode: backupCodes[0]!.toLowerCase() }));
    expect(first.status).toBe(200);
    const again = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", backupCode: backupCodes[0] }));
    expect(again.status).toBe(422);
    expect((await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "otra", code: "123456" }))).status).toBe(400);
    expect((await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive" }))).status).toBe(400);
  });

  it("5 codigos incorrectos bloquean: despues ni un respaldo valido sirve (429)", async () => {
    const { app, ctx } = await setup();
    const { backupCodes } = await enroll(app, ctx.staff.owner.token);
    for (let i = 0; i < 5; i += 1) await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", code: "000000" }));
    const res = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", backupCode: backupCodes[1] }));
    expect(res.status).toBe(429);
  });
});

describe("POST /auth/2fa/backup-codes y /disable", () => {
  it("regenerar exige segundo factor; los codigos viejos dejan de servir", async () => {
    const { app, ctx } = await setup();
    const { backupCodes } = await enroll(app, ctx.staff.owner.token);
    expect((await app.request("/auth/2fa/backup-codes", authedJson(ctx.staff.owner.token, { code: "000000" }))).status).toBe(422);
    const res = await app.request("/auth/2fa/backup-codes", authedJson(ctx.staff.owner.token, { backupCode: backupCodes[0] }));
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as { backupCodes: string[] }).backupCodes;
    expect(fresh).toHaveLength(8);
    const old = await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", backupCode: backupCodes[2] }));
    expect(old.status).toBe(422);
  });

  it("desactivar exige contrasena actual Y segundo factor", async () => {
    const { app, ctx } = await setup();
    const { backupCodes } = await enroll(app, ctx.staff.owner.token);
    const badPassword = await app.request("/auth/2fa/disable", authedJson(ctx.staff.owner.token, { password: "mala", backupCode: backupCodes[0] }));
    expect(badPassword.status).toBe(422);
    expect(((await badPassword.json()) as { code: string }).code).toBe("current_password_invalid");
    const ok = await app.request("/auth/2fa/disable", authedJson(ctx.staff.owner.token, { password: ctx.staff.owner.password, backupCode: backupCodes[0] }));
    expect(ok.status).toBe(200);
    expect(await (await app.request("/auth/2fa/status", authedJson(ctx.staff.owner.token))).json()).toMatchObject({ enabled: false });
  });
});

describe("base sin migrar (compatibilidad)", () => {
  it("status responde available:false; setup/step-up responden 503; sin puerto igual", async () => {
    const { app, ctx, security } = await setup();
    security.available = false;
    expect(await (await app.request("/auth/2fa/status", authedJson(ctx.staff.owner.token))).json()).toMatchObject({ available: false, enabled: false });
    const setupRes = await app.request("/auth/2fa/setup", authedJson(ctx.staff.owner.token, {}));
    expect(setupRes.status).toBe(503);
    expect(((await setupRes.json()) as { code: string }).code).toBe("two_factor_unavailable");
    expect((await app.request("/auth/step-up", authedJson(ctx.staff.owner.token, { scope: "contract_sensitive", code: "123456" }))).status).toBe(503);

    const bare = buildApp(ctx.deps); // sin staffSecurityRepo
    expect(await (await bare.request("/auth/2fa/status", authedJson(ctx.staff.owner.token))).json()).toMatchObject({ available: false });
    expect((await bare.request("/auth/2fa/setup", authedJson(ctx.staff.owner.token, {}))).status).toBe(503);
  });
});
