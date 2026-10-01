// MFA TOTP del superadmin + step-up de acciones sensibles, de punta a punta contra
// los repos en memoria (la autorizacion real en SQL se verifica en
// scripts/verify-superadmin-mfa-switches-orgs/). Reloj controlado con `Date` falso
// para generar el codigo del paso siguiente.
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import type { MfaRepository } from "@atiende/db";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { SENSITIVE_ROUTES, isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";

afterEach(() => vi.useRealTimers());

const MOTIVO = "Corte preventivo del agente por incidente verificado en produccion.";
const T0 = new Date("2026-09-30T12:00:00.000Z").getTime();

function fakeTime(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function post(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, jsonRequestInit(body, headers));
}

/** Enrola y activa el factor de `sa`; devuelve el secreto y el instante del ultimo paso usado. */
async function enrolarYActivar(s: Awaited<ReturnType<typeof seguridadSetup>>, sa: { token: string }) {
  const enr = await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
  expect(enr.status).toBe(201);
  const { secreto, otpauthUri } = (await enr.json()) as { secreto: string; otpauthUri: string };
  const ver = await post(s.app, "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
  expect(ver.status).toBe(200);
  const body = (await ver.json()) as { activado: boolean; stepUpToken: string };
  return { secreto, otpauthUri, activado: body.activado, stepUpToken: body.stepUpToken };
}

describe("MFA del superadmin -- gateo y estado", () => {
  it("un staff normal recibe 403 en todas las rutas de MFA y de bitacora", async () => {
    const s = await seguridadSetup();
    const st = await s.staff();
    for (const [method, path] of [["GET", "/superadmin/mfa/estado"], ["POST", "/superadmin/mfa/enrolar"], ["POST", "/superadmin/mfa/verificar"], ["POST", "/superadmin/mfa/reset"], ["GET", "/superadmin/seguridad/bitacora"]] as const) {
      const res = await s.app.request(path, method === "GET" ? { headers: bearer(st.token) } : jsonRequestInit({}, bearer(st.token)));
      expect(res.status, path).toBe(403);
    }
  });

  it("sin token, 401", async () => {
    const s = await seguridadSetup();
    expect((await s.app.request("/superadmin/mfa/estado")).status).toBe(401);
  });

  it("estado: sin factor -> disponible, no inscrito", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const res = await s.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) });
    expect(await res.json()).toEqual({ disponible: true, obligatoria: false, inscrito: false, pendiente: false, bloqueadoHastaMs: null });
  });

  it("sin mfaRepo (deps sin cablear) las rutas responden 503 honesto y estado.disponible=false", async () => {
    const s = await seguridadSetup({ sinRepos: true });
    const sa = await s.superadmin();
    expect(await (await s.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false });
    expect((await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token))).status).toBe(503);
    expect((await post(s.app, "/superadmin/mfa/verificar", { codigo: "123456" }, bearer(sa.token))).status).toBe(503);
  });
});

describe("MFA del superadmin -- enrolar y verificar", () => {
  it("enrolar devuelve secreto + otpauth, queda pendiente, y el primer codigo correcto lo ACTIVA y emite step-up", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin("ana@atiende.ai");
    const { secreto, otpauthUri, activado, stepUpToken } = await enrolarYActivar(s, sa);
    expect(secreto).toMatch(/^[A-Z2-7]{32}$/u);
    expect(otpauthUri).toContain(`secret=${secreto}`);
    expect(otpauthUri).toContain("issuer=Atiende");
    expect(otpauthUri).toContain("ana%40atiende.ai");
    expect(activado).toBe(true);
    expect(stepUpToken.split(".")).toHaveLength(3);
    const estado = await (await s.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) })).json();
    expect(estado).toMatchObject({ inscrito: true, pendiente: false });
  });

  it("el secreto se guarda CIFRADO (el ciphertext no contiene el secreto en claro)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const enr = await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const { factor } = await s.mfa.getFactor(sa.id);
    expect(factor!.secretCiphertext.startsWith("v1.")).toBe(true);
    expect(factor!.secretCiphertext).not.toContain(secreto);
  });

  it("enrolar otra vez con un factor ACTIVO -> 409 (no se puede reemplazar sin reset)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await enrolarYActivar(s, sa);
    expect((await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token))).status).toBe(409);
  });

  it("verificar sin factor -> 409; codigo mal formado -> 400; codigo incorrecto -> 401 mfa_codigo_invalido", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    expect((await post(s.app, "/superadmin/mfa/verificar", { codigo: "123456" }, bearer(sa.token))).status).toBe(409);
    await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    for (const codigo of ["", "12345", "1234567", "abcdef", 123456]) {
      expect((await post(s.app, "/superadmin/mfa/verificar", { codigo }, bearer(sa.token))).status, String(codigo)).toBe(400);
    }
    const mal = await post(s.app, "/superadmin/mfa/verificar", { codigo: "000000" }, bearer(sa.token));
    expect(mal.status).toBe(401);
    expect(await mal.json()).toMatchObject({ code: "mfa_codigo_invalido" });
  });

  it("5 codigos incorrectos bloquean (429); con el factor bloqueado ni un codigo correcto pasa, y el contador sobrevive a la respuesta de error", async () => {
    fakeTime(T0);
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const enr = await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(s.app, "/superadmin/mfa/verificar", { codigo: "000000" }, bearer(sa.token))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const bueno = await post(s.app, "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    expect(bueno.status).toBe(429);
    expect(await bueno.json()).toMatchObject({ code: "mfa_bloqueado" });
    expect(bueno.headers.get("retry-after")).toBeTruthy();
    const estado = (await (await s.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) })).json()) as { bloqueadoHastaMs: number | null };
    expect(estado.bloqueadoHastaMs).toBeGreaterThan(Date.now());
    // pasado el bloqueo (15 min) el codigo correcto vuelve a funcionar
    fakeTime(T0 + 16 * 60_000);
    const { signAccessToken } = await import("@atiende/core-auth"); // el access token de 15 min ya vencio
    const fresco = await signAccessToken({ sub: sa.id, org_id: "", vertical: "restaurantes", property_ids: null, email: sa.email }, s.deps.env.jwtSecret, 900);
    const ok = await post(s.app, "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(fresco));
    expect(ok.status).toBe(200);
  });

  it("los intentos fallidos se CONFIRMAN (commit) antes de responder el 401: con una sola transaccion por request se revertirian y el bloqueo no existiria", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { buildApp } = await import("../src/app.ts");
    let commits = 0;
    let rollbacks = 0;
    const rastreo = {
      async withAppSession<T>(claims: { userId: string | null }, fn: Parameters<typeof s.deps.engine.withAppSession<T>>[1]): Promise<T> {
        try {
          const r = await s.deps.engine.withAppSession(claims, fn);
          commits += 1;
          return r;
        } catch (err) {
          rollbacks += 1;
          throw err;
        }
      },
    };
    const app = buildApp({ ...s.deps, engine: rastreo });
    const antes = commits;
    const res = await post(app, "/superadmin/mfa/verificar", { codigo: "000000" }, bearer(sa.token));
    expect(res.status).toBe(401);
    expect(rollbacks).toBe(0);
    expect(commits).toBeGreaterThan(antes);
    // el intento quedo registrado
    expect((await s.mfa.listEvents(sa.id, "mfa")).events.map((e) => e.event)).toContain("mfa_failed");
  });

  it("un codigo ya usado se rechaza (401 mfa_codigo_reusado); el del paso siguiente funciona", async () => {
    fakeTime(T0);
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const { secreto } = await enrolarYActivar(s, sa);
    const reuso = await post(s.app, "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    expect(reuso.status).toBe(401);
    expect(await reuso.json()).toMatchObject({ code: "mfa_codigo_reusado" });
    fakeTime(T0 + 30_000);
    const siguiente = await post(s.app, "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    expect(siguiente.status).toBe(200);
    expect(await siguiente.json()).toMatchObject({ activado: false });
  });

  it("si el secreto no se puede descifrar con la llave actual del servidor -> 409 accionable (no 500)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await post(s.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    // misma base, pero se roto JWT_SECRET sin definir SUPERADMIN_MFA_ENCRYPTION_KEY
    const { buildApp } = await import("../src/app.ts");
    const { signAccessToken } = await import("@atiende/core-auth");
    const rotado = { ...s.deps, env: { ...s.deps.env, jwtSecret: "jwt-secret-rotado-0123456789abcdef" } };
    const token = await signAccessToken({ sub: sa.id, org_id: "", vertical: "restaurantes", property_ids: null, email: sa.email }, rotado.env.jwtSecret, 900);
    const res = await post(buildApp(rotado), "/superadmin/mfa/verificar", { codigo: "123456" }, bearer(token));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict" });
  });
});

describe("step-up de acciones sensibles", () => {
  const setPayload = { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: MOTIVO };

  it("la lista de rutas sensibles reconoce metodo+ruta exactos y nada mas", () => {
    expect(isSensitiveRoute("PUT", "/superadmin/interruptores")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/interruptores")).toBe(false);
    expect(isSensitiveRoute("POST", "/superadmin/impersonacion/sesiones")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/impersonacion/sesiones/abc/terminar")).toBe(false);
    expect(isSensitiveRoute("POST", "/superadmin/acciones/intents/abc/confirmar")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/acciones/intents/abc/cancelar")).toBe(false);
    expect(isSensitiveRoute("PUT", "/superadmin/gasto-api/plataforma/tope")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/organizaciones/acciones")).toBe(false);
    expect(isSensitiveRoute("POST", "/superadmin/organizaciones/acciones/x/confirmar")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/organizaciones/acciones/x/aprobar")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/organizaciones/acciones/x/cancelar")).toBe(false);
    expect(SENSITIVE_ROUTES.length).toBeGreaterThanOrEqual(9);
  });

  it("sin factor y MFA no obligatoria: la accion sensible pasa como hoy (nada se rompe antes de enrolar)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const res = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(sa.token)), method: "PUT" });
    expect(res.status).toBe(200);
  });

  it("con factor ACTIVO: sin token 403 stepup_required; con token valido 200; token de OTRO access token 403; token vencido 403", async () => {
    fakeTime(T0);
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const { stepUpToken } = await enrolarYActivar(s, sa);
    const put = (headers: Record<string, string>) => s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, headers), method: "PUT" });

    const sin = await put(bearer(sa.token));
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });

    expect((await put(bearer(sa.token, { "x-stepup-token": stepUpToken }))).status).toBe(200);

    // el mismo step-up NO sirve con otro access token del mismo usuario (atadura ath)
    const { signAccessToken } = await import("@atiende/core-auth");
    const otroAccess = await signAccessToken({ sub: sa.id, org_id: "", vertical: "restaurantes", property_ids: null, email: sa.email }, s.deps.env.jwtSecret, 901);
    expect((await put(bearer(otroAccess, { "x-stepup-token": stepUpToken }))).status).toBe(403);

    // token basura
    expect((await put(bearer(sa.token, { "x-stepup-token": "no.es.un-jwt" }))).status).toBe(403);

    // vencido (> 5 min); el access token (15 min) sigue vigente
    fakeTime(T0 + 6 * 60_000);
    const vencido = await put(bearer(sa.token, { "x-stepup-token": stepUpToken }));
    expect(vencido.status).toBe(403);
    expect(await vencido.json()).toMatchObject({ code: "stepup_required" });
  });

  it("no hay forma de esquivar el step-up con variantes de ruta (barra final, percent-encoding, mayusculas)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await enrolarYActivar(s, sa);
    const intentar = (path: string) => s.app.request(path, { ...jsonRequestInit(setPayload, bearer(sa.token)), method: "PUT" });
    // Hono es estricto con la barra final: otra ruta distinta -> 404, nunca el handler real
    expect((await intentar("/superadmin/interruptores/")).status).toBe(404);
    // percent-encoding: Hono decodifica antes de rutear, y el middleware lee la misma ruta decodificada
    expect((await intentar("/superadmin/%69nterruptores")).status).toBe(403);
    // el routing distingue mayusculas -> 404
    expect((await intentar("/superadmin/Interruptores")).status).toBe(404);
    // y sin step-up el estado NO cambio
    expect((await s.switches.getBlocked()).blocked).toEqual([]);
  });

  it("el step-up de OTRO superadmin no sirve (atado al usuario)", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    await enrolarYActivar(s, beto);
    const { stepUpToken: deAna } = await enrolarYActivar(s, ana);
    const res = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(beto.token, { "x-stepup-token": deAna })), method: "PUT" });
    expect(res.status).toBe(403);
  });

  it("las rutas NO sensibles no piden step-up aunque haya factor activo", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await enrolarYActivar(s, sa);
    expect((await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).status).toBe(200);
    expect((await s.app.request("/superadmin/organizaciones/acciones", { headers: bearer(sa.token) })).status).toBe(200);
  });

  it("SUPERADMIN_MFA_REQUIRED sin factor -> 403 mfa_enrollment_required", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const sa = await s.superadmin();
    const res = await s.app.request("/superadmin/interruptores", { ...jsonRequestInit(setPayload, bearer(sa.token)), method: "PUT" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "mfa_enrollment_required" });
  });

  it("SUPERADMIN_MFA_REQUIRED sin mfaRepo cableado -> 503 (fail-closed, no degrada a 'sin MFA')", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true }, sinRepos: true });
    const sa = await s.superadmin();
    const res = await s.app.request("/superadmin/impersonacion/sesiones", jsonRequestInit({ organizationId: "x", reason: "y".repeat(25) }, bearer(sa.token)));
    expect(res.status).toBe(503);
  });

  it("BASE SIN MIGRAR: el repo reporta not_migrated -> sin MFA obligatoria el flujo existente sigue; con obligatoria, 503", async () => {
    const notMigrated: MfaRepository = {
      getFactor: async () => ({ availability: "not_migrated", factor: null }),
      beginEnrollment: async () => ({ availability: "not_migrated" }),
      recordAttempt: async () => ({ availability: "not_migrated", result: null }),
      reset: async () => ({ availability: "not_migrated" }),
      listEvents: async () => ({ availability: "not_migrated", events: [] }),
    };
    const blando = await seguridadSetup({ mfaRepo: () => notMigrated });
    const sa = await blando.superadmin();
    // un endpoint sensible EXISTENTE (confirmar una accion sugerida) sigue su camino normal: 404/409 del propio handler, nunca el step-up ni un 500
    const res = await blando.app.request("/superadmin/acciones/intents/no-existe/confirmar", jsonRequestInit({}, bearer(sa.token)));
    expect([404, 409]).toContain(res.status);
    expect(await (await blando.app.request("/superadmin/mfa/estado", { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false });
    expect((await post(blando.app, "/superadmin/mfa/enrolar", {}, bearer(sa.token))).status).toBe(503);

    const duro = await seguridadSetup({ mfaRepo: () => notMigrated, env: { superadminMfaRequired: true } });
    const sa2 = await duro.superadmin();
    expect((await duro.app.request("/superadmin/acciones/intents/no-existe/confirmar", jsonRequestInit({}, bearer(sa2.token)))).status).toBe(503);
  });
});

describe("reset de MFA por otro superadmin y bitacora", () => {
  it("otro superadmin resetea con step-up y motivo; el propio factor no; sin step-up 403; queda en la bitacora", async () => {
    const s = await seguridadSetup();
    const ana = await s.superadmin();
    const beto = await s.superadmin();
    await enrolarYActivar(s, ana);
    const { stepUpToken } = await enrolarYActivar(s, beto);
    const motivo = "Dispositivo perdido de Ana, verificado por videollamada.";

    const sinStepUp = await post(s.app, "/superadmin/mfa/reset", { usuarioId: ana.id, motivo }, bearer(beto.token));
    expect(sinStepUp.status).toBe(403);

    const propio = await post(s.app, "/superadmin/mfa/reset", { usuarioId: beto.id, motivo }, bearer(beto.token, { "x-stepup-token": stepUpToken }));
    expect(propio.status).toBe(403);

    const corto = await post(s.app, "/superadmin/mfa/reset", { usuarioId: ana.id, motivo: "corto" }, bearer(beto.token, { "x-stepup-token": stepUpToken }));
    expect(corto.status).toBe(400);

    const ok = await post(s.app, "/superadmin/mfa/reset", { usuarioId: ana.id, motivo }, bearer(beto.token, { "x-stepup-token": stepUpToken }));
    expect(ok.status).toBe(200);
    expect((await s.mfa.getFactor(ana.id)).factor).toBeNull();

    const bit = (await (await s.app.request("/superadmin/seguridad/bitacora?area=mfa", { headers: bearer(beto.token) })).json()) as { disponible: boolean; eventos: Array<{ evento: string }> };
    expect(bit.disponible).toBe(true);
    expect(bit.eventos.map((e) => e.evento)).toContain("mfa_reset");
    expect(bit.eventos.map((e) => e.evento)).toContain("mfa_activated");
  });

  it("bitacora valida area y limit", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    expect((await s.app.request("/superadmin/seguridad/bitacora?area=otra", { headers: bearer(sa.token) })).status).toBe(400);
    expect((await s.app.request("/superadmin/seguridad/bitacora?limit=0", { headers: bearer(sa.token) })).status).toBe(400);
    expect((await s.app.request("/superadmin/seguridad/bitacora?limit=9999", { headers: bearer(sa.token) })).status).toBe(400);
  });
});
