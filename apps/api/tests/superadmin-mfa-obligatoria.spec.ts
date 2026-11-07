// MFA obligatoria del superadmin: con `superadminMfaRequired` (por omision en produccion) ninguna
// ruta `/superadmin/*` responde a un superadmin sin factor TOTP activo, salvo el camino de
// enrolamiento (estado, enrolar, verificar). Repos en memoria; la autorizacion SQL del factor se
// verifica en scripts/verify-superadmin-mfa-switches-orgs/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { ENROLLMENT_ROUTES, isEnrollmentRoute, isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { resolverMfaObligatoria } from "../src/env.ts";

afterEach(() => vi.useRealTimers());

const MOTIVO = "Corte preventivo del agente por incidente verificado en produccion.";
const setPayload = { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: MOTIVO };

describe("resolverMfaObligatoria", () => {
  it("en produccion es obligatoria por omision", () => {
    expect(resolverMfaObligatoria(undefined, true)).toBe(true);
    expect(resolverMfaObligatoria("", true)).toBe(true);
    expect(resolverMfaObligatoria("si", true)).toBe(true);
  });
  it("fuera de produccion es opcional por omision", () => {
    expect(resolverMfaObligatoria(undefined, false)).toBe(false);
    expect(resolverMfaObligatoria("", false)).toBe(false);
  });
  it("1/true la activan y 0/false la apagan en cualquier ambiente (escape de emergencia explicito)", () => {
    for (const prod of [true, false]) {
      expect(resolverMfaObligatoria("1", prod)).toBe(true);
      expect(resolverMfaObligatoria(" TRUE ", prod)).toBe(true);
      expect(resolverMfaObligatoria("0", prod)).toBe(false);
      expect(resolverMfaObligatoria("False", prod)).toBe(false);
    }
  });
});

describe("rutas de enrolamiento", () => {
  it("son exactamente estado, enrolar y verificar, y ninguna es sensible", () => {
    expect(ENROLLMENT_ROUTES).toHaveLength(3);
    expect(isEnrollmentRoute("GET", "/superadmin/mfa/estado")).toBe(true);
    expect(isEnrollmentRoute("post", "/superadmin/mfa/enrolar")).toBe(true);
    expect(isEnrollmentRoute("POST", "/superadmin/mfa/verificar")).toBe(true);
    expect(isEnrollmentRoute("POST", "/superadmin/mfa/reset")).toBe(false);
    expect(isEnrollmentRoute("GET", "/superadmin/mfa/estado/")).toBe(false);
    expect(isEnrollmentRoute("POST", "/superadmin/mfa/estado")).toBe(false);
    for (const r of [["GET", "/superadmin/mfa/estado"], ["POST", "/superadmin/mfa/enrolar"], ["POST", "/superadmin/mfa/verificar"]] as const) {
      expect(isSensitiveRoute(r[0], r[1])).toBe(false);
    }
  });
});

describe("MFA obligatoria -- compuerta de enrolamiento en /superadmin/*", () => {
  it("sin factor: lecturas y escrituras de superadmin responden 403 mfa_enrollment_required", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const sa = await s.superadmin();
    for (const path of ["/superadmin/organizations", "/superadmin/interruptores", "/superadmin/organizaciones/acciones", "/superadmin/seguridad/bitacora"]) {
      const res = await s.app.request(path, { headers: bearer(sa.token) });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: "mfa_enrollment_required" });
    }
    const put = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(sa.token)), method: "PUT" });
    expect(put.status).toBe(403);
    expect((await s.switches.getBlocked()).blocked).toEqual([]);
  });

  it("camino seguro: sin factor puede ver su estado, enrolar y activar; despues las lecturas responden y lo sensible pide step-up", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const sa = await s.superadmin();

    const estado = await s.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) });
    expect(estado.status).toBe(200);
    expect(await estado.json()).toMatchObject({ disponible: true, obligatoria: true, inscrito: false });

    const enr = await s.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)));
    expect(enr.status).toBe(201);
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await s.app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(secreto, Date.now()) }, bearer(sa.token)));
    expect(ver.status).toBe(200);
    const { activado, stepUpToken } = (await ver.json()) as { activado: boolean; stepUpToken: string };
    expect(activado).toBe(true);

    expect((await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).status).toBe(200);
    const sinStepUp = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(sa.token)), method: "PUT" });
    expect(sinStepUp.status).toBe(403);
    expect(await sinStepUp.json()).toMatchObject({ code: "stepup_required" });
    const conStepUp = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(sa.token, { "x-stepup-token": stepUpToken })), method: "PUT" });
    expect(conStepUp.status).toBe(200);
  });

  it("un factor solo PENDIENTE (enrolado sin activar) no abre las rutas", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const sa = await s.superadmin();
    expect((await s.app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)))).status).toBe(201);
    const res = await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "mfa_enrollment_required" });
  });

  it("sin repositorio MFA cableado falla cerrado (503) tambien en lecturas", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true }, sinRepos: true });
    const sa = await s.superadmin();
    expect((await s.app.request("/superadmin/organizations", { headers: bearer(sa.token) })).status).toBe(503);
  });

  it("un staff que no es superadmin sigue recibiendo el 403 del gateo de superadmin, sin tocar la compuerta", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const st = await s.staff();
    const res = await s.app.request("/superadmin/organizations", { headers: bearer(st.token) });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toMatchObject({ code: "mfa_enrollment_required" });
  });

  it("sin MFA obligatoria nada cambia: el superadmin sin factor sigue leyendo", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    expect((await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).status).toBe(200);
  });
});
