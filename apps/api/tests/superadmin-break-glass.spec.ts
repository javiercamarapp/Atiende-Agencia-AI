// "Romper cristal" (break-glass) de plataforma -- Fase 10b. Recorre las rutas
// contra los repos en memoria de packages/domain-rentas/src/break-glass/*.ts,
// mismo criterio que superadmin.spec.ts/superadmin-llm-usage.spec.ts: la
// autorización REAL (auth.uid()/core.platform_superadmin) se verifica contra
// Postgres real en scripts/verify-rentas-break-glass/, aquí se cubre el
// comportamiento equivalente en memoria (reglas de negocio: motivo, duración,
// ventana vigente, bitácora).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { InMemoryBreakGlassRentasDataRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

async function tokenFor(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], userId: string, email: string) {
  return signAccessToken({ sub: userId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
}

const RAZON_VALIDA = "Ticket SOP-4821: el tenant reporta un cobro duplicado, investigar sus reservas.";

describe("superadmin-break-glass", () => {
  it("un staff normal (no superadmin) recibe 403 en toda la superficie de break-glass", async () => {
    const base = await buildTestDeps();
    const token = await tokenFor(base.deps, randomUUID(), "staff@example.com");
    const app = buildApp(base.deps);

    const orgId = randomUUID();
    const resOpen = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: orgId, reason: RAZON_VALIDA, durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(resOpen.status).toBe(403);

    const resList = await app.request("/superadmin/break-glass/sesiones", { headers: { authorization: `Bearer ${token}` } });
    expect(resList.status).toBe(403);

    const resRead = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/reservas`, { headers: { authorization: `Bearer ${token}` } });
    expect(resRead.status).toBe(403);
  });

  it("un staff SIN NINGUNA membresía ya NO cuenta como superadmin (criterio corregido) -- sigue recibiendo 403", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const staffSinMembresiasId = randomUUID();
    // Staff real, sin ninguna membership, y SIN alta explícita en
    // core.platform_superadmin -- el criterio débil original de
    // `rentas.is_platform_superadmin` (staff existe + cero membership) lo habría
    // contado como superadmin; el criterio corregido (delega en
    // core.platform_superadmin) lo rechaza.
    coreRepo.addStaff({ id: staffSinMembresiasId, email: "sin-membresias@example.com", passwordHash: null, fullName: "Sin Membresías", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });

    const token = await tokenFor(base.deps, staffSinMembresiasId, "sin-membresias@example.com");
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: randomUUID(), reason: RAZON_VALIDA, durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/break-glass/sesiones");
    expect(res.status).toBe(401);
  });

  it("abrir con motivo demasiado corto -- 400, nunca abre la ventana", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: randomUUID(), reason: "urgente", durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(400);
  });

  it("abrir con duración fuera de rango -- 400", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: randomUUID(), reason: RAZON_VALIDA, durationMinutes: 9999 }, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(400);
  });

  it("sin ningún acceso abierto -- leer reservas del tenant da 403", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const res = await app.request(`/superadmin/break-glass/organizaciones/${randomUUID()}/reservas`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("camino feliz: abrir -> listar (activa) -> leer reservas (200, registrado en bitácora) -> cerrar -> leer de nuevo da 403", async () => {
    const orgId = randomUUID();
    const reservaFalsa = {
      ocupacionId: randomUUID(),
      propertyId: randomUUID(),
      unidadId: randomUUID(),
      checkIn: "2026-10-01",
      checkOut: "2026-10-05",
      estado: "confirmado",
      huespedNombre: "Huésped de Prueba",
      huespedContacto: "+52 555 000 0000",
    };
    const base = await buildTestDeps();
    const deps = { ...base.deps, rentasBreakGlassDataRepo: (_db: unknown) => new InMemoryBreakGlassRentasDataRepository(new Map([[orgId, [reservaFalsa]]])) } as typeof base.deps;
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(deps, superadminId, "superadmin@example.com");
    const app = buildApp(deps);

    const resOpen = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: orgId, reason: RAZON_VALIDA, durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(resOpen.status).toBe(201);
    const opened = (await resOpen.json()) as { session: { id: string; activa: boolean; organizationId: string } };
    expect(opened.session.activa).toBe(true);
    expect(opened.session.organizationId).toBe(orgId);

    const resList = await app.request("/superadmin/break-glass/sesiones", { headers: { authorization: `Bearer ${token}` } });
    expect(resList.status).toBe(200);
    const listed = (await resList.json()) as { sessions: Array<{ id: string; activa: boolean }> };
    expect(listed.sessions.some((s) => s.id === opened.session.id && s.activa)).toBe(true);

    const resRead = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/reservas`, { headers: { authorization: `Bearer ${token}` } });
    expect(resRead.status).toBe(200);
    const read = (await resRead.json()) as { reservas: Array<{ ocupacionId: string }> };
    expect(read.reservas).toHaveLength(1);
    expect(read.reservas[0]!.ocupacionId).toBe(reservaFalsa.ocupacionId);

    // Cada lectura queda registrada en la bitácora inmutable.
    const resBitacora = await app.request("/superadmin/break-glass/bitacora", { headers: { authorization: `Bearer ${token}` } });
    expect(resBitacora.status).toBe(200);
    const bitacora = (await resBitacora.json()) as { entries: Array<{ organizationId: string; resourceType: string; resultSummary: { total: number } }> };
    expect(bitacora.entries).toHaveLength(1);
    expect(bitacora.entries[0]!.organizationId).toBe(orgId);
    expect(bitacora.entries[0]!.resourceType).toBe("reservas");
    expect(bitacora.entries[0]!.resultSummary.total).toBe(1);

    const resCerrar = await app.request(`/superadmin/break-glass/sesiones/${opened.session.id}/cerrar`, { headers: { authorization: `Bearer ${token}` }, method: "POST" });
    expect(resCerrar.status).toBe(200);
    const closed = (await resCerrar.json()) as { session: { activa: boolean; closedAtMs: number | null } };
    expect(closed.session.activa).toBe(false);
    expect(closed.session.closedAtMs).not.toBeNull();

    // Con el acceso cerrado, la MISMA organización vuelve a dar 403 -- "SOLO
    // mientras haya un acceso activo y vigente".
    const resReadDespues = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/reservas`, { headers: { authorization: `Bearer ${token}` } });
    expect(resReadDespues.status).toBe(403);
  });

  it("un acceso VENCIDO (expiresAtMs en el pasado, nunca cerrado explícitamente) también da 403 al leer", async () => {
    const orgId = randomUUID();
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const resOpen = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: orgId, reason: RAZON_VALIDA, durationMinutes: 5 }, { authorization: `Bearer ${token}` }));
    expect(resOpen.status).toBe(201);
    const opened = (await resOpen.json()) as { session: { id: string } };

    // Simula el paso del tiempo directamente sobre el repo en memoria compartido
    // (mismo patrón que otros tests de este monorepo que manipulan un adaptador en
    // memoria para forzar un estado -- nunca `sleep()` real).
    const sessionRepo = base.deps.rentasBreakGlassSessionRepo({} as never) as unknown as { sessions: Array<{ id: string; expiresAtMs: number }> };
    const idx = sessionRepo.sessions.findIndex((s) => s.id === opened.session.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    sessionRepo.sessions[idx] = { ...sessionRepo.sessions[idx]!, expiresAtMs: Date.now() - 1000 };

    const resRead = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/reservas`, { headers: { authorization: `Bearer ${token}` } });
    expect(resRead.status).toBe(403);
  });

  it("cerrar una sesión ajena (o inexistente) da 404, nunca cierra a nombre de otro superadmin", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const res = await app.request(`/superadmin/break-glass/sesiones/${randomUUID()}/cerrar`, { headers: { authorization: `Bearer ${token}` }, method: "POST" });
    expect(res.status).toBe(404);
  });
});
