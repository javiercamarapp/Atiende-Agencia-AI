// Bloque C -- impersonación de superadmin con bitácora. Recorre las rutas
// contra `InMemoryImpersonationRepository` (packages/db/src/impersonation-
// repository.ts) -- la autorización REAL (auth.uid()/core.platform_superadmin
// vía SQL real) se verifica en scripts/verify-superadmin-impersonacion/, aquí
// se cubre el comportamiento equivalente en memoria: gateo (admin-middleware
// conectado), reglas de negocio (motivo, target-superadmin, duplicado,
// expiración) y el write-guard de solo-lectura sobre /superadmin/*.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImpersonationRepository, InMemoryCoreRepository, InMemoryImpersonationRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { superadminAdminAccessAudit } from "../src/routes/superadmin.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

/** Doble de prueba que SIEMPRE reporta `availability: "not_migrated"` --
 *  `InMemoryImpersonationRepository` (packages/db) documenta explícitamente
 *  que NUNCA simula este estado (es el caso real de "la migración 0020 no
 *  se ha aplicado todavía", que solo el adaptador Postgres puede alcanzar
 *  vía SAVEPOINT/SQLSTATE 42883 -- ver packages/db/tests/impersonation-
 *  repository.spec.ts). Este doble cubre el requisito de la revisión
 *  (Bloqueante 5) de probar el comportamiento a nivel de RUTA HTTP: POST ->
 *  503 honesto, GET -> `available: false` con listas vacías, y el
 *  write-guard dejando pasar la escritura (nunca puede haber una sesión
 *  activa sin la tabla, así que bloquear sería un falso "estás
 *  impersonando"). */
class NotMigratedImpersonationRepository implements ImpersonationRepository {
  async startSession() {
    return { availability: "not_migrated" as const, session: null };
  }
  async endSession() {
    return { availability: "not_migrated" as const, entry: null };
  }
  async getActiveSession() {
    return { availability: "not_migrated" as const, session: null };
  }
  async isActiveForOrganization(): Promise<boolean> {
    return false;
  }
  async listSessions() {
    return { availability: "not_migrated" as const, sessions: [] };
  }
  async listAuditLog() {
    return { availability: "not_migrated" as const, entries: [] };
  }
}

async function tokenFor(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], userId: string, email: string) {
  return signAccessToken({ sub: userId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
}

const RAZON_VALIDA = "Ticket SOP-9001: el tenant reporta que su checkout público falla, necesito revisar su configuración.";

async function seedSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>) {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const impersonationRepo = base.deps.impersonationRepo({} as never) as InMemoryImpersonationRepository;
  const superadminId = randomUUID();
  const email = "superadmin@atiende.ai";
  coreRepo.addStaff({ id: superadminId, email, passwordHash: null, fullName: "Superadmin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
  impersonationRepo.seedPlatformSuperadmin(superadminId, email);
  return { superadminId, email, coreRepo, impersonationRepo };
}

describe("superadmin-impersonacion", () => {
  // El audit sink de `requireAdminAccess` (routes/superadmin.ts) es un
  // singleton de MÓDULO compartido por toda la superficie `/superadmin/*` de
  // este archivo de test (ver ese archivo) -- se limpia antes de cada test
  // para que las aserciones de abajo cuenten SOLO las denegaciones de SU
  // propio test.
  beforeEach(() => {
    superadminAdminAccessAudit.clear();
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/impersonacion/sesiones", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("un staff normal (no superadmin) recibe 403 al iniciar/listar/terminar -- Y queda auditado por requireAdminAccess (Bloqueante 2: la rama de denegación de audit-on-denial+rate-limit es ALCANZABLE de verdad, no código muerto)", async () => {
    const base = await buildTestDeps();
    const token = await tokenFor(base.deps, randomUUID(), "staff@example.com");
    const app = buildApp(base.deps);

    const resStart = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(resStart.status).toBe(403);

    const resList = await app.request("/superadmin/impersonacion/sesiones", { headers: { authorization: `Bearer ${token}` } });
    expect(resList.status).toBe(403);

    // Distingue QUÉ middleware produjo el 403: antes de esta corrección, el
    // 403 plano de `routes/superadmin.ts` cortaba la cadena antes de que
    // `requireAdminAccess` (montado, antes de esta revisión, en
    // `superadmin-impersonacion.ts`) pudiera ejecutarse -- un test que solo
    // comprobaba el status 403 no lo distinguía. Ahora `requireAdminAccess`
    // ES el único gate (montado una vez en `superadmin.ts`, cubre TODA
    // `/superadmin/*`), así que cada denegación queda auditada de verdad.
    const denied = superadminAdminAccessAudit.denied();
    expect(denied.length).toBe(2);
    expect(denied.every((e) => e.route === "/superadmin/impersonacion/sesiones" && e.reason === "no_membership")).toBe(true);
  });

  it("camino feliz: iniciar -> activa -> bitácora -> terminar", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);

    const resStart = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(resStart.status).toBe(201);
    const { session } = (await resStart.json()) as { session: { id: string; activa: boolean } };
    expect(session.activa).toBe(true);

    const resActiva = await app.request("/superadmin/impersonacion/activa", { headers: { authorization: `Bearer ${token}` } });
    expect(resActiva.status).toBe(200);
    const activaBody = (await resActiva.json()) as { available: boolean; session: { id: string } | null };
    expect(activaBody.available).toBe(true);
    expect(activaBody.session?.id).toBe(session.id);

    const resBitacoraAntes = await app.request("/superadmin/impersonacion/bitacora", { headers: { authorization: `Bearer ${token}` } });
    const bitacoraAntes = (await resBitacoraAntes.json()) as { entries: { eventType: string }[] };
    expect(bitacoraAntes.entries.some((e) => e.eventType === "start")).toBe(true);

    const resTerminar = await app.request(`/superadmin/impersonacion/sesiones/${session.id}/terminar`, jsonRequestInit({}, { authorization: `Bearer ${token}` }));
    expect(resTerminar.status).toBe(200);

    const resBitacoraDespues = await app.request("/superadmin/impersonacion/bitacora", { headers: { authorization: `Bearer ${token}` } });
    const bitacoraDespues = (await resBitacoraDespues.json()) as { entries: { eventType: string }[] };
    expect(bitacoraDespues.entries.some((e) => e.eventType === "end")).toBe(true);

    const resActivaDespues = await app.request("/superadmin/impersonacion/activa", { headers: { authorization: `Bearer ${token}` } });
    const activaDespues = (await resActivaDespues.json()) as { session: unknown };
    expect(activaDespues.session).toBeNull();
  });

  it("motivo corto -- 400", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);

    const res = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: "muy corto" }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  it("organización con OTRO superadmin como miembro -- 403 (nunca impersonar a otro superadmin)", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    const orgConSuperadmin = randomUUID();
    impersonationRepo.seedOrganization(orgConSuperadmin);
    impersonationRepo.seedOrganizationHasSuperadminMember(orgConSuperadmin);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);

    const res = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: orgConSuperadmin, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(403);
  });

  it("ya existe una sesión activa -- el propio write-guard fail-closed la bloquea con 403 ANTES de llegar a la regla de negocio (409) de la función SQL", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);

    const first = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(first.status).toBe(201);

    // Corrección de esta revisión (Bloqueante 1): el write-guard fail-closed
    // cubre TODA `/superadmin/*`, incluida esta MISMA ruta -- POST /sesiones
    // es una escritura como cualquier otra mientras hay una impersonación
    // activa, así que el segundo intento queda bloqueado con 403 (write-
    // guard) ANTES de que el handler llegue a invocar
    // `start_impersonation_session` -- nunca ve el 409 de "ya existe una
    // sesión activa" que la función SQL lanzaría si se alcanzara. Ver el
    // siguiente `it` para la prueba de que esa regla de negocio (409/
    // `ImpersonationConflictError`) SIGUE viva a nivel de repositorio (y
    // contra Postgres real en scripts/verify-superadmin-impersonacion,
    // escenario 7) -- solo dejó de ser observable por esta ruta HTTP en
    // concreto porque el guard, correctamente, gana primero.
    const second = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(second.status).toBe(403);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  it("la regla de negocio 'una sola sesión activa por actor' (ImpersonationConflictError/409) sigue viva a nivel de repositorio, independiente del write-guard de la ruta HTTP", async () => {
    const base = await buildTestDeps();
    const { superadminId, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);

    await impersonationRepo.startSession(superadminId, base.organizationId, RAZON_VALIDA);
    await expect(impersonationRepo.startSession(superadminId, base.organizationId, RAZON_VALIDA)).rejects.toMatchObject({
      code: "impersonation_conflict",
    });
  });

  it("write-guard: bloquea una escritura existente de /superadmin/* mientras hay impersonación activa", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);

    const resStart = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(resStart.status).toBe(201);

    // POST /superadmin/prospectos es una escritura REAL preexistente de
    // /superadmin/* -- debe quedar bloqueada mientras la sesión sigue activa.
    const resProspecto = await app.request(
      "/superadmin/prospectos",
      jsonRequestInit({ empresa: "Cliente de prueba", vertical: "restaurantes" }, { authorization: `Bearer ${token}` }),
    );
    expect(resProspecto.status).toBe(403);
    const body = (await resProspecto.json()) as { code: string; message: string };
    // routes/superadmin.ts traduce ImpersonationWriteBlockedError (core-authz,
    // no un ApiError) a Errors.forbidden -- ver comentario en ese archivo.
    expect(body.code).toBe("forbidden");
    expect(body.message).toContain("sesión de impersonación de superadmin activa");

    // Terminar la PROPIA sesión es la ÚNICA escritura exenta mientras hay
    // impersonación activa (`exemptPathPatterns`, ver routes/superadmin.ts) --
    // a diferencia de las demás rutas mutantes de /superadmin/*, esta SÍ debe
    // pasar.
    const { session } = (await resStart.json()) as { session: { id: string } };
    const resTerminar = await app.request(`/superadmin/impersonacion/sesiones/${session.id}/terminar`, jsonRequestInit({}, { authorization: `Bearer ${token}` }));
    expect(resTerminar.status).toBe(200);

    // Una vez terminada, la escritura vuelve a funcionar.
    const resProspectoDespues = await app.request(
      "/superadmin/prospectos",
      jsonRequestInit({ empresa: "Cliente de prueba", vertical: "restaurantes" }, { authorization: `Bearer ${token}` }),
    );
    expect(resProspectoDespues.status).toBe(201);
  });

  it("write-guard fail-closed (Bloqueante 1): bloquea TODA la superficie mutante de /superadmin/*, no solo prospectos/paneles -- acciones, gasto-api, resumen, facturación, break-glass", async () => {
    const base = await buildTestDeps();
    const { superadminId, email, impersonationRepo } = await seedSuperadmin(base);
    impersonationRepo.seedOrganization(base.organizationId);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp(base.deps);
    const auth = { authorization: `Bearer ${token}` };

    const resStart = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, auth),
    );
    expect(resStart.status).toBe(201);

    // Antes de esta corrección, estas 6 rutas mutantes de /superadmin/* NO
    // tenían el write-guard montado (era una allowlist de solo 3 rutas
    // exactas) -- quedaban accesibles con normalidad mientras había una
    // impersonación activa, pese al requisito "toda escritura se rechaza".
    const rutasMutantesSinGuardAntes: ReadonlyArray<{ method: string; path: string; body?: unknown }> = [
      { method: "POST", path: "/superadmin/acciones/intents", body: {} },
      { method: "PUT", path: "/superadmin/gasto-api/organizaciones/org-x/tope", body: {} },
      { method: "PUT", path: "/superadmin/gasto-api/plataforma/tope", body: {} },
      { method: "POST", path: "/superadmin/resumen/generar", body: {} },
      { method: "POST", path: "/superadmin/facturacion/organizaciones/org-x/checkout", body: {} },
      { method: "POST", path: "/superadmin/break-glass/sesiones", body: {} },
    ];

    for (const ruta of rutasMutantesSinGuardAntes) {
      const res = await app.request(ruta.path, {
        method: ruta.method,
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(ruta.body ?? {}),
      });
      expect(res.status, `${ruta.method} ${ruta.path} debería quedar bloqueada (403) mientras hay impersonación activa`).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("forbidden");
    }
  });
});

describe("superadmin-impersonacion -- base SIN MIGRAR (Bloqueante 5)", () => {
  beforeEach(() => {
    superadminAdminAccessAudit.clear();
  });

  it("POST /sesiones -- 503 honesto (nunca 500, nunca simula una sesión) cuando la migración 0020 no se ha aplicado", async () => {
    const base = await buildTestDeps();
    const { superadminId, email } = await seedSuperadmin(base);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp({ ...base.deps, impersonationRepo: () => new NotMigratedImpersonationRepository() });

    const res = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(503);
  });

  it("GET /sesiones, /activa y /bitacora -- available:false con listas/valores vacíos, nunca un error", async () => {
    const base = await buildTestDeps();
    const { superadminId, email } = await seedSuperadmin(base);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp({ ...base.deps, impersonationRepo: () => new NotMigratedImpersonationRepository() });
    const auth = { headers: { authorization: `Bearer ${token}` } };

    const resActiva = await app.request("/superadmin/impersonacion/activa", auth);
    expect(resActiva.status).toBe(200);
    expect(await resActiva.json()).toEqual({ available: false, session: null });

    const resSesiones = await app.request("/superadmin/impersonacion/sesiones", auth);
    expect(resSesiones.status).toBe(200);
    expect(await resSesiones.json()).toEqual({ available: false, sessions: [] });

    const resBitacora = await app.request("/superadmin/impersonacion/bitacora", auth);
    expect(resBitacora.status).toBe(200);
    expect(await resBitacora.json()).toEqual({ available: false, entries: [] });
  });

  it("write-guard: sin migración no puede existir ninguna sesión activa -- una escritura de /superadmin/* pasa normal, nunca un falso 'estás impersonando'", async () => {
    const base = await buildTestDeps();
    const { superadminId, email } = await seedSuperadmin(base);
    const token = await tokenFor(base.deps, superadminId, email);
    const app = buildApp({ ...base.deps, impersonationRepo: () => new NotMigratedImpersonationRepository() });

    const res = await app.request(
      "/superadmin/prospectos",
      jsonRequestInit({ empresa: "Cliente de prueba", vertical: "restaurantes" }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(201);
  });
});
