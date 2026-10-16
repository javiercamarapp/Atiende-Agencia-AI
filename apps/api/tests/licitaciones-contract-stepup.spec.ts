// L-01 -- transiciones sensibles del contrato exigen step-up (segundo factor reciente) cuando
// la base tiene la migracion de 2FA; con la base sin migrar caen al control por rol de siempre.
import { describe, expect, it } from "vitest";
import { computeTotp, signContractStepUpToken } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
  const app = buildApp({ ...ctx.deps, staffSecurityRepo: security });
  const base = `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`;
  const created = await app.request(base, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
  expect(created.status).toBe(201);
  // Estado en ejecucion para poder rescindir/penalizar/pagar en pruebas.
  for (const toStatus of ["contrato_firmado_declarado", "en_ejecucion"]) {
    const r = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, { toStatus, reason: "Avance normal del contrato en prueba." }));
    expect(r.status).toBe(200);
  }
  return { ctx, security, app, base };
}

async function enrollAndStepUp(app: ReturnType<typeof buildApp>, token: string): Promise<string> {
  const setup = await app.request("/auth/2fa/setup", authedJson(token, {}));
  const { secret } = (await setup.json()) as { secret: string };
  const confirm = await app.request("/auth/2fa/confirm", authedJson(token, { code: computeTotp(secret, Date.now()) }));
  expect(confirm.status).toBe(200);
  const res = await app.request("/auth/step-up", authedJson(token, { scope: "contract_sensitive", code: computeTotp(secret, Date.now() + 30_000) }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { stepUpToken: string }).stepUpToken;
}

const rescindir = { toStatus: "rescindido", reason: "Incumplimiento reiterado documentado en el acta." };

describe("transiciones sensibles del contrato con step-up (L-01)", () => {
  it("sin 2FA activo: rescindir -> 403 step_up_enrollment_required y NO cambia el estado", async () => {
    const { ctx, app, base } = await setup();
    const res = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("step_up_enrollment_required");
    const contract = await app.request(base, authedJson(ctx.staff.owner.token));
    expect(((await contract.json()) as { status: string }).status).toBe("en_ejecucion");
  });

  it("con 2FA activo pero sin token: 403 step_up_required; con token valido: 200", async () => {
    const { ctx, app, base } = await setup();
    const stepUp = await enrollAndStepUp(app, ctx.staff.owner.token);
    const missing = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir));
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { code: string }).code).toBe("step_up_required");
    const ok = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir, { "x-step-up-token": stepUp }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("rescindido");
  });

  it("penalizar y marcar pago tambien lo exigen; una transicion no sensible (entregado) no", async () => {
    const { ctx, app, base } = await setup();
    const stepUp = await enrollAndStepUp(app, ctx.staff.owner.token);
    const penalizar = { toStatus: "penalizado", reason: "Penalizacion por entrega tardia segun clausula 12." };
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, penalizar))).status).toBe(403);
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, penalizar, { "x-step-up-token": stepUp }))).status).toBe(200);
    // En el estado penalizado se puede volver a entregado: transicion NO sensible, sin step-up.
    const entregado = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, { toStatus: "entregado", reason: "Se entrego tras la penalizacion." }));
    expect(entregado.status).toBe(200);
    const facturado = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, { toStatus: "facturado", reason: "Factura emitida." }));
    expect(facturado.status).toBe(200);
    const pagado = { toStatus: "pagado", reason: "Pago confirmado por tesoreria." };
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.writer.token, pagado))).status).toBe(403);
    // El step-up es de UN SOLO USO: el token de la penalizacion ya no sirve para marcar el pago; se pide otro.
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, pagado, { "x-step-up-token": stepUp }))).status).toBe(403);
    const otro = await signContractStepUpToken({ userId: ctx.staff.owner.id, organizationId: ctx.organizationId, scope: "contract_sensitive" }, TEST_ENV.jwtSecret);
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, pagado, { "x-step-up-token": otro }))).status).toBe(200);
  });

  it("token de otro usuario, de otro alcance, vencido o basura -> 403 step_up_required", async () => {
    const { ctx, app, base } = await setup();
    await enrollAndStepUp(app, ctx.staff.owner.token);
    const forOther = await signContractStepUpToken({ userId: ctx.staff.admin.id, organizationId: ctx.organizationId, scope: "contract_sensitive" }, TEST_ENV.jwtSecret);
    const otherOrg = await signContractStepUpToken({ userId: ctx.staff.owner.id, organizationId: "00000000-0000-0000-0000-000000000000", scope: "contract_sensitive" }, TEST_ENV.jwtSecret);
    const expired = await signContractStepUpToken({ userId: ctx.staff.owner.id, organizationId: ctx.organizationId, scope: "contract_sensitive" }, TEST_ENV.jwtSecret, -5);
    for (const token of [forOther, otherOrg, expired, "basura", ctx.staff.owner.token]) {
      const res = await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir, { "x-step-up-token": token }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("step_up_required");
    }
  });

  it("la capa de roles sigue primero: un writer sin DECISION_ROLES recibe 403 forbidden aunque tenga 2FA y token", async () => {
    const { ctx, app, base } = await setup();
    const stepUp = await enrollAndStepUp(app, ctx.staff.writer.token);
    const res = await app.request(`${base}/transition`, authedJson(ctx.staff.writer.token, rescindir, { "x-step-up-token": stepUp }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
  });

  it("COMPATIBILIDAD base sin migrar: migracion pendiente o sin puerto -> sigue funcionando solo con el rol (nunca 500)", async () => {
    const { ctx, security, base } = await setup();
    security.available = false;
    const pending = buildApp({ ...ctx.deps, staffSecurityRepo: security });
    const res = await pending.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("rescindido");
  });

  it("COMPATIBILIDAD: sin puerto de seguridad el comportamiento es el previo (DECISION_ROLES)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`;
    await app.request(base, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    for (const toStatus of ["contrato_firmado_declarado", "en_ejecucion"]) {
      await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, { toStatus, reason: "Avance normal en prueba." }));
    }
    expect((await app.request(`${base}/transition`, authedJson(ctx.staff.owner.token, rescindir))).status).toBe(200);
  });
});
