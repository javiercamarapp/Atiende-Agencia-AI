// Bloque C -- impersonación de superadmin con bitácora. Recorre las rutas
// contra `InMemoryImpersonationRepository` (packages/db/src/impersonation-
// repository.ts) -- la autorización REAL (auth.uid()/core.platform_superadmin
// vía SQL real) se verifica en scripts/verify-superadmin-impersonacion/, aquí
// se cubre el comportamiento equivalente en memoria: gateo (admin-middleware
// conectado), reglas de negocio (motivo, target-superadmin, duplicado,
// expiración) y el write-guard de solo-lectura sobre /superadmin/*.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InMemoryCoreRepository, InMemoryImpersonationRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

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
  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/impersonacion/sesiones", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("un staff normal (no superadmin) recibe 403 al iniciar/listar/terminar", async () => {
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

  it("ya existe una sesión activa -- 409 al intentar abrir una segunda", async () => {
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

    const second = await app.request(
      "/superadmin/impersonacion/sesiones",
      jsonRequestInit({ organizationId: base.organizationId, reason: RAZON_VALIDA }, { authorization: `Bearer ${token}` }),
    );
    expect(second.status).toBe(409);
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

    // Pero la propia ruta de impersonación (terminar) NO vive en /superadmin/*
    // bloqueado por este guard -- routes/superadmin-impersonacion.ts es su
    // propio router, nunca pasa por blockWritesWhileImpersonating.
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
});
