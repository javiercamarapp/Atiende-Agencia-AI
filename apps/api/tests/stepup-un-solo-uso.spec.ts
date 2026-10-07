// L-P3-12 (R5-09 del suelto) -- el step-up es de UN SOLO USO: el `jti` del token se consume en la sesion de la accion; reusarlo (o repetir una
// peticion capturada) da 403 "vuelve a confirmar", en licitaciones (contrato, tarifa) y en despachos; dos peticiones concurrentes con el mismo
// token dejan pasar exactamente una; en PRODUCCION sin puerto de 2FA (o con su migracion pendiente) responde 503 en vez de dejar pasar; sin la
// migracion 038 se conserva el token sin estado (compatibilidad). El consumo contra Postgres real vive en scripts/verify-licitaciones-stepup-y-bitacora.
import { describe, expect, it } from "vitest";
import { signContractStepUpToken } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository, PostgresStaffSecurityRepository, StaffSecurityUnavailableError } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { InMemoryPortalClienteRepository } from "@atiende/domain-despachos";
import { computeTotp } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { authedJson as authedJsonLic, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { authedJson as authedJsonDesp, buildDespachosTestContext } from "./despachos-fixtures.ts";
import { TEST_ENV, buildTestDeps } from "./fixtures.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const rescindir = { toStatus: "rescindido", reason: "Incumplimiento reiterado documentado en el acta." };

async function enrolar(app: ReturnType<typeof buildApp>, bearer: string): Promise<void> {
  const { secret } = (await (await app.request("/auth/2fa/setup", authedJsonLic(bearer, {}))).json()) as { secret: string };
  expect((await app.request("/auth/2fa/confirm", authedJsonLic(bearer, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
}

async function contratoEnEjecucion() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
  const app = buildApp({ ...ctx.deps, staffSecurityRepo: security });
  const base = `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`;
  expect((await app.request(base, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } })).status).toBe(201);
  for (const toStatus of ["contrato_firmado_declarado", "en_ejecucion"]) {
    expect((await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, { toStatus, reason: "Avance normal del contrato en prueba." }))).status).toBe(200);
  }
  await enrolar(app, ctx.staff.owner.token);
  const mint = (scope: "contract_sensitive" | "company_rate_approval" = "contract_sensitive") =>
    signContractStepUpToken({ userId: ctx.staff.owner.id, organizationId: ctx.organizationId, scope }, TEST_ENV.jwtSecret);
  return { ctx, security, app, base, mint };
}

const codigo = async (res: Response) => ((await res.json()) as { code: string }).code;

describe("step-up de un solo uso (L-P3-12)", () => {
  it("contrato: el mismo token usado dos veces -> 403 la segunda (aunque la primera haya pasado)", async () => {
    const { ctx, app, base, mint } = await contratoEnEjecucion();
    const token = await mint();
    const penalizar = { toStatus: "penalizado", reason: "Penalizacion por entrega tardia segun clausula 12." };
    expect((await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, penalizar, { "x-step-up-token": token }))).status).toBe(200);
    const reuso = await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir, { "x-step-up-token": token }));
    expect(reuso.status).toBe(403);
    expect(await codigo(reuso)).toBe("step_up_required");
    const estado = await app.request(base, authedJsonLic(ctx.staff.owner.token));
    expect(((await estado.json()) as { status: string }).status).toBe("penalizado");
  });

  it("tarifa: aprobar dos tarifas seguidas con el mismo token -> la segunda pide confirmar de nuevo", async () => {
    const { ctx, app, mint } = await contratoEnEjecucion();
    const base = `/licitaciones/${ctx.propertyId}/company`;
    const crear = async (concept: string) =>
      ((await (await app.request(`${base}/rates`, authedJsonLic(ctx.staff.writer.token, { concept, unitPrice: "500.00", validFrom: "2026-01-01T00:00:00-06:00" }))).json()) as { id: string }).id;
    const [a, b] = [await crear("uno"), await crear("dos")];
    const token = await mint("company_rate_approval");
    expect((await app.request(`${base}/rates/${a}/approve`, authedJsonLic(ctx.staff.owner.token, {}, { "x-step-up-token": token }))).status).toBe(200);
    const segunda = await app.request(`${base}/rates/${b}/approve`, authedJsonLic(ctx.staff.owner.token, {}, { "x-step-up-token": token }));
    expect(segunda.status).toBe(403);
    expect(await codigo(segunda)).toBe("step_up_required");
    const fresco = await mint("company_rate_approval");
    expect((await app.request(`${base}/rates/${b}/approve`, authedJsonLic(ctx.staff.owner.token, {}, { "x-step-up-token": fresco }))).status).toBe(200);
  });

  it("un token rechazado por alcance u organizacion NO se gasta: despues sirve para su accion", async () => {
    const { ctx, app, base, mint } = await contratoEnEjecucion();
    const token = await mint("contract_sensitive");
    const otraOrg = await signContractStepUpToken({ userId: ctx.staff.owner.id, organizationId: "00000000-0000-0000-0000-000000000000", scope: "contract_sensitive" }, TEST_ENV.jwtSecret);
    expect((await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir, { "x-step-up-token": otraOrg }))).status).toBe(403);
    const tarifa = await app.request(`/licitaciones/${ctx.propertyId}/company/rates/00000000-0000-0000-0000-000000000000/approve`, authedJsonLic(ctx.staff.owner.token, {}, { "x-step-up-token": token }));
    expect(tarifa.status).toBe(403); // alcance equivocado (company_rate_approval)
    expect((await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir, { "x-step-up-token": token }))).status).toBe(200);
  });

  it("dos peticiones concurrentes con el MISMO token: exactamente una pasa", async () => {
    const { ctx, app, base, mint } = await contratoEnEjecucion();
    const token = await mint();
    const penalizar = { toStatus: "penalizado", reason: "Penalizacion por entrega tardia segun clausula 12." };
    const res = await Promise.all([
      app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, penalizar, { "x-step-up-token": token })),
      app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir, { "x-step-up-token": token })),
    ]);
    expect(res.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(res.map((r) => r.status).filter((s) => s === 403)).toHaveLength(1);
  });

  it("despachos: el mismo token no crea dos enlaces del portal", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
    const portalRepo = new InMemoryPortalClienteRepository();
    portalRepo.sembrarCliente({ propertyId: ctx.propertyId, clienteNombre: "Cliente A SA de CV", despachoNombre: "Despacho de Prueba SC", obligaciones: [], cierres: [] });
    const app = buildApp({ ...ctx.deps, portalClienteRepo: () => portalRepo, staffSecurityRepo: security });
    const { secret } = (await (await app.request("/auth/2fa/setup", authedJsonDesp(ctx.staff.admin.token, {}))).json()) as { secret: string };
    expect((await app.request("/auth/2fa/confirm", authedJsonDesp(ctx.staff.admin.token, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
    const token = await signContractStepUpToken({ userId: ctx.staff.admin.id, organizationId: ctx.organizationId, scope: "despachos_sensitive" }, TEST_ENV.jwtSecret);
    const url = `/despachos/${ctx.propertyId}/portal-cliente/enlaces`;
    expect((await app.request(url, authedJsonDesp(ctx.staff.admin.token, { etiqueta: "Cliente", dias: 7 }, { "x-step-up-token": token }))).status).toBe(201);
    const reuso = await app.request(url, authedJsonDesp(ctx.staff.admin.token, { etiqueta: "Cliente", dias: 7 }, { "x-step-up-token": token }));
    expect(reuso.status).toBe(403);
    expect(await codigo(reuso)).toBe("step_up_required");
  });
});

describe("fallar cerrado en produccion (L-P3-12)", () => {
  it("produccion sin puerto de 2FA -> 503 two_factor_unavailable y no cambia el estado; en desarrollo conserva el comportamiento anterior", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const base = `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/contract`;
    const dev = buildApp(ctx.deps);
    await dev.request(base, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    for (const toStatus of ["contrato_firmado_declarado", "en_ejecucion"]) {
      await dev.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, { toStatus, reason: "Avance normal en prueba." }));
    }
    const prod = buildApp({ ...ctx.deps, env: { ...ctx.deps.env, production: true } });
    const res = await prod.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir));
    expect(res.status).toBe(503);
    expect(await codigo(res)).toBe("two_factor_unavailable");
    expect(((await (await dev.request(base, authedJsonLic(ctx.staff.owner.token))).json()) as { status: string }).status).toBe("en_ejecucion");
    expect((await dev.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir))).status).toBe(200);
  });

  it("produccion con la migracion de 2FA pendiente -> 503; en desarrollo pasa solo con el rol", async () => {
    const { ctx, security, base } = await contratoEnEjecucion();
    security.available = false;
    const prod = buildApp({ ...ctx.deps, staffSecurityRepo: security, env: { ...ctx.deps.env, production: true } });
    const res = await prod.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir));
    expect(res.status).toBe(503);
    expect(await codigo(res)).toBe("two_factor_unavailable");
    const dev = buildApp({ ...ctx.deps, staffSecurityRepo: security });
    expect((await dev.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, rescindir))).status).toBe(200);
  });

  it("COMPATIBILIDAD: con 2FA (0026) pero sin la migracion 038, el token conserva su comportamiento sin estado (nunca 500)", async () => {
    const { ctx, security, app, base, mint } = await contratoEnEjecucion();
    security.stepUpConsumptionAvailable = false;
    const token = await mint();
    const penalizar = { toStatus: "penalizado", reason: "Penalizacion por entrega tardia segun clausula 12." };
    expect((await app.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, penalizar, { "x-step-up-token": token }))).status).toBe(200);
    const prod = buildApp({ ...ctx.deps, staffSecurityRepo: security, env: { ...ctx.deps.env, production: true } });
    expect((await prod.request(`${base}/transition`, authedJsonLic(ctx.staff.owner.token, { toStatus: "entregado", reason: "Se entrego tras la penalizacion." }))).status).toBe(200);
  });
});

describe("PostgresStaffSecurityRepository.consumeStepUpToken sobre una transaccion compartida", () => {
  const input = { jti: "jti-1234567", userId: "u1", organizationId: "o1", scope: "contract_sensitive", expiresAt: "2026-10-04T12:00:00.000Z" };
  const repo = new PostgresStaffSecurityRepository({ withAppSession: async () => { throw new Error("no se usa: el consumo corre en la sesion recibida"); } } as never);

  it("primer uso true, reuso false, en la sesion recibida", async () => {
    const vistos = new Set<string>();
    const session = new AbortAwareFakeSession([{ match: /core\.consume_step_up/, respond: () => [{ ok: !vistos.has("a") && (vistos.add("a"), true) }] }]);
    expect(await repo.consumeStepUpToken(session, input)).toBe(true);
    expect(await repo.consumeStepUpToken(session, input)).toBe(false);
  });

  it("migracion 038 pendiente (42883): lanza StaffSecurityUnavailableError y la transaccion compartida sigue VIVA (SAVEPOINT), no 25P02", async () => {
    const err = Object.assign(new Error("function core.consume_step_up(text, uuid, uuid, text, timestamp with time zone) does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /core\.consume_step_up/, respond: () => err },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    await expect(repo.consumeStepUpToken(session, input)).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
    // La consulta de la accion que sigue en la MISMA sesion no falla con 25P02.
    await expect(session.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion se repropaga tal cual (no se enmascara como compatibilidad)", async () => {
    const err = Object.assign(new Error("42501 permission denied"), { code: "42501" });
    const session = new AbortAwareFakeSession([{ match: /core\.consume_step_up/, respond: () => err }]);
    await expect(repo.consumeStepUpToken(session, input)).rejects.toBe(err);
  });
});

describe("limpieza de consumos vencidos en el barrido de mantenimiento (sin cron nuevo)", () => {
  const CRON = "/internal/superadmin/mantenimiento";
  it("el barrido existente purga los consumos vencidos y reporta cuantos; con la 038 pendiente no falla", async () => {
    const base = await buildTestDeps();
    const security = new InMemoryStaffSecurityRepository(base.deps.coreRepo as InMemoryCoreRepository);
    const ahora = Date.now();
    security.now = () => ahora;
    await security.consumeStepUpToken(null, { jti: "vencido-1", userId: "u", organizationId: "o", scope: "s", expiresAt: new Date(ahora - 3 * 3_600_000).toISOString() });
    await security.consumeStepUpToken(null, { jti: "vivo-001", userId: "u", organizationId: "o", scope: "s", expiresAt: new Date(ahora + 60_000).toISOString() });
    const app = buildApp({ ...base.deps, staffSecurityRepo: security });
    const res = await app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { consumosStepUpPurgados: number }).consumosStepUpPurgados).toBe(1);
    // el vivo sigue consumido: reusarlo sigue dando false
    expect(await security.consumeStepUpToken(null, { jti: "vivo-001", userId: "u", organizationId: "o", scope: "s", expiresAt: new Date(ahora + 60_000).toISOString() })).toBe(false);
    security.stepUpConsumptionAvailable = false;
    const sin038 = await app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(sin038.status).toBe(200);
    expect(((await sin038.json()) as { consumosStepUpPurgados: number | null }).consumosStepUpPurgados).toBeNull();
  });
});
