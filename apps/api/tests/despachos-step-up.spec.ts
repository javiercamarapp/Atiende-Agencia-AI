// D-30 -- acciones sensibles de despachos exigen step-up (TOTP, alcance `despachos_sensitive`) cuando la base tiene la migracion
// de 2FA; con la base sin migrar (o sin puerto de seguridad) caen al control por rol de siempre. Mismo patron que
// licitaciones-contract-stepup.spec.ts. El token vive 5 minutos y se ata a usuario + organizacion + alcance.
import { describe, expect, it } from "vitest";
import { computeTotp, signContractStepUpToken } from "@atiende/core-auth";
import { InMemoryPortalClienteRepository } from "@atiende/domain-despachos";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const ctx = await buildDespachosTestContext(buildApp);
  const security = new InMemoryStaffSecurityRepository(ctx.deps.coreRepo as InMemoryCoreRepository);
  const portalRepo = new InMemoryPortalClienteRepository();
  portalRepo.sembrarCliente({ propertyId: ctx.propertyId, clienteNombre: "Cliente A SA de CV", despachoNombre: "Despacho de Prueba SC", obligaciones: [], cierres: [] });
  const deps = { ...ctx.deps, portalClienteRepo: () => portalRepo };
  const app = buildApp({ ...deps, staffSecurityRepo: security });
  const p = `/despachos/${ctx.propertyId}`;
  const acciones: ReadonlyArray<{ nombre: string; method: string; path: string; body?: unknown }> = [
    { nombre: "cerrar periodo", method: "POST", path: `${p}/cierre-mensual/periodos/${UUID}/cerrar`, body: { confirmacion: "x" } },
    { nombre: "crear enlace del portal", method: "POST", path: `${p}/portal-cliente/enlaces`, body: { etiqueta: "Cliente", dias: 7 } },
    { nombre: "revocar enlace del portal", method: "POST", path: `${p}/portal-cliente/enlaces/${UUID}/revocar`, body: {} },
    { nombre: "paquete de contabilidad electronica", method: "POST", path: `${p}/contabilidad-electronica/paquete`, body: {} },
    { nombre: "libro: exportacion de contabilidad electronica", method: "GET", path: `${p}/libro/contabilidad-electronica` },
    { nombre: "invitar staff", method: "POST", path: `${p}/admin/staff/invitaciones`, body: { email: "nuevo@despacho-de-prueba.mx", verticalRole: "contador" } },
    { nombre: "revocar invitacion", method: "DELETE", path: `${p}/admin/staff/invitaciones/${UUID}` },
    { nombre: "cambiar rol de un miembro", method: "PATCH", path: `${p}/admin/staff/miembros/${UUID}`, body: { verticalRole: "auditor" } },
  ];
  return { ctx, deps, security, app, acciones };
}
type Accion = Awaited<ReturnType<typeof setup>>["acciones"][number];

const llamar = (app: ReturnType<typeof buildApp>, a: Accion, token: string, headers: Record<string, string> = {}) =>
  app.request(a.path, a.method === "GET" || a.method === "DELETE" ? { method: a.method, headers: { authorization: `Bearer ${token}`, ...headers } } : { ...authedJson(token, a.body, headers), method: a.method });

async function enrolarYObtenerToken(app: ReturnType<typeof buildApp>, token: string, scope = "despachos_sensitive"): Promise<string> {
  const setup = await app.request("/auth/2fa/setup", authedJson(token, {}));
  const { secret } = (await setup.json()) as { secret: string };
  expect((await app.request("/auth/2fa/confirm", authedJson(token, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
  const res = await app.request("/auth/step-up", authedJson(token, { scope, code: computeTotp(secret, Date.now() + 30_000) }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { stepUpToken: string }).stepUpToken;
}
const codigo = async (res: Response) => ((await res.json()) as { code: string }).code;

describe("step-up en acciones sensibles de despachos (D-30)", () => {
  it("sin TOTP dado de alta: toda accion sensible -> 403 step_up_enrollment_required (sin bypass)", async () => {
    const { ctx, app, acciones } = await setup();
    for (const a of acciones) {
      const res = await llamar(app, a, ctx.staff.admin.token);
      expect(res.status, a.nombre).toBe(403);
      expect(await codigo(res), a.nombre).toBe("step_up_enrollment_required");
    }
  });

  it("con TOTP pero sin token: 403 step_up_required; con token valido la guardia deja pasar (el resto lo decide la validacion de cada ruta, nunca 403)", async () => {
    const { ctx, app, acciones } = await setup();
    await enrolarYObtenerToken(app, ctx.staff.admin.token);
    for (const a of acciones) {
      const sin = await llamar(app, a, ctx.staff.admin.token);
      expect(sin.status, a.nombre).toBe(403);
      expect(await codigo(sin), a.nombre).toBe("step_up_required");
      // Un token NUEVO por accion (el step-up es de un solo uso).
      const token = await signContractStepUpToken({ userId: ctx.staff.admin.id, organizationId: ctx.organizationId, scope: "despachos_sensitive" }, TEST_ENV.jwtSecret);
      const con = await llamar(app, a, ctx.staff.admin.token, { "x-step-up-token": token });
      expect(con.status, `${a.nombre} con token`).not.toBe(403);
      expect(con.status, `${a.nombre} con token`).toBeLessThan(500);
    }
  });

  it("crear enlace del portal con token valido -> 201 y sin token no se crea nada", async () => {
    const { ctx, app, acciones } = await setup();
    const crear = acciones.find((a) => a.nombre === "crear enlace del portal")!;
    const token = await enrolarYObtenerToken(app, ctx.staff.admin.token);
    expect((await llamar(app, crear, ctx.staff.admin.token)).status).toBe(403);
    const ok = await llamar(app, crear, ctx.staff.admin.token, { "x-step-up-token": token });
    expect(ok.status).toBe(201);
  });

  it("token de otro usuario, de otra organizacion, de otro alcance, vencido o basura -> 403 step_up_required", async () => {
    const { ctx, app, acciones } = await setup();
    await enrolarYObtenerToken(app, ctx.staff.admin.token);
    const firmar = (userId: string, organizationId: string, scope: "contract_sensitive" | "despachos_sensitive", ttl?: number) =>
      signContractStepUpToken({ userId, organizationId, scope }, TEST_ENV.jwtSecret, ttl);
    const malos = [
      await firmar(ctx.staff.contador.id, ctx.organizationId, "despachos_sensitive"),
      await firmar(ctx.staff.admin.id, "00000000-0000-0000-0000-000000000000", "despachos_sensitive"),
      await firmar(ctx.staff.admin.id, ctx.organizationId, "contract_sensitive"),
      await firmar(ctx.staff.admin.id, ctx.organizationId, "despachos_sensitive", -5),
      "basura",
      ctx.staff.admin.token,
    ];
    const crear = acciones.find((a) => a.nombre === "crear enlace del portal")!;
    const cerrar = acciones.find((a) => a.nombre === "cerrar periodo")!;
    for (const t of malos) for (const a of [crear, cerrar]) {
      const res = await llamar(app, a, ctx.staff.admin.token, { "x-step-up-token": t });
      expect(res.status, a.nombre).toBe(403);
      expect(await codigo(res), a.nombre).toBe("step_up_required");
    }
  });

  it("el rol va primero: un contador o auditor sin permiso recibe 403 forbidden aunque tenga TOTP y token, y sin TOTP no aprende nada del 2FA", async () => {
    const { ctx, app, acciones } = await setup();
    const cerrar = acciones.find((a) => a.nombre === "cerrar periodo")!;
    const invitar = acciones.find((a) => a.nombre === "invitar staff")!;
    const sinTotp = await llamar(app, cerrar, ctx.staff.contador.token);
    expect(sinTotp.status).toBe(403);
    expect(await codigo(sinTotp)).toBe("forbidden");
    const token = await enrolarYObtenerToken(app, ctx.staff.auditor.token);
    const res = await llamar(app, invitar, ctx.staff.auditor.token, { "x-step-up-token": token });
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden");
  });

  it("COMPATIBILIDAD base sin migrar: migracion de 2FA pendiente -> solo rige el rol, nunca 500", async () => {
    const { ctx, deps, security, acciones } = await setup();
    security.available = false;
    const pendiente = buildApp({ ...deps, staffSecurityRepo: security });
    for (const a of acciones) {
      const res = await llamar(pendiente, a, ctx.staff.admin.token);
      expect(res.status, a.nombre).not.toBe(403);
      expect(res.status, a.nombre).toBeLessThan(500);
    }
  });

  it("COMPATIBILIDAD: sin puerto de seguridad el comportamiento es el previo (solo rol)", async () => {
    const { ctx, deps, acciones } = await setup();
    const sinPuerto = buildApp(deps);
    const crear = acciones.find((a) => a.nombre === "crear enlace del portal")!;
    const res = await llamar(sinPuerto, crear, ctx.staff.admin.token);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});
