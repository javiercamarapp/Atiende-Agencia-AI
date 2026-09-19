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
import type { BreakGlassRentasDataRepository } from "@atiende/domain-rentas";
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

  // Fase 10c -- los 6 lectores restantes comparten la ruta `registrarLectorTenant`
  // con `reservas` (ya probada arriba de punta a punta) -- este bloque cubre lo
  // que es específico de esa fase: (1) sin sesión activa, CUALQUIERA de los 6
  // da 403 (representativo, finanzas), (2) camino feliz con datos reales + el
  // filtro `?propertyId=` SÍ excluye lo que no matchea, (3) la clave JSON de
  // respuesta es la que cada ruta documenta (`finanzas`/`payouts`/`pricing`/
  // `mensajeria`/`limpieza`/`syncIcal`).
  it("Fase 10c -- sin sesión activa, /finanzas también da 403 (mismo gate que /reservas)", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(base.deps, superadminId, "superadmin@example.com");
    const app = buildApp(base.deps);

    const res = await app.request(`/superadmin/break-glass/organizaciones/${randomUUID()}/finanzas`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("Fase 10c -- camino feliz de los 6 lectores nuevos: cada uno responde 200 con su clave JSON, registrado en la bitácora con su resourceType", async () => {
    const orgId = randomUUID();
    const propertyIdBuscado = randomUUID();
    const finanzasFalsa = { id: randomUUID(), ocupacionId: randomUUID(), propertyId: propertyIdBuscado, moneda: "MXN", montoBrutoCentavos: 500000, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 450000, createdAtMs: Date.now() };
    const finanzasDeOtraPropiedad = { ...finanzasFalsa, id: randomUUID(), propertyId: randomUUID() };
    const payoutFalso = { id: randomUUID(), propertyId: randomUUID(), canalId: randomUUID(), referenciaExterna: "lote-1", moneda: "MXN", montoTotalCentavos: 100000, fechaPayout: "2026-09-01", creadoEnMs: Date.now() };
    const pricingFalso = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), precioNocheCentavos: 150000, moneda: "MXN", vigenteDesde: "2026-01-01" };
    const mensajeriaFalsa = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), canalCodigo: "airbnb", huespedNombre: "Ana", fechaCheckIn: "2026-10-01", fechaCheckOut: "2026-10-05", reservaConfirmada: true, creadoEnMs: Date.now() };
    const limpiezaFalsa = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), tipo: "limpieza", estado: "pendiente", prioridad: "media", programadaPara: "2026-09-22", completadaEnMs: null, creadoEnMs: Date.now() };
    const syncIcalFalso = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), canalId: randomUUID(), urlImportacionEnmascarada: "https://www.airbnb.com/***", activo: true, ultimaSincronizacionExitosaEnMs: Date.now(), enCuarentenaDesdeMs: null, intentosFallidosConsecutivos: 0, motivoCuarentena: null };

    const base = await buildTestDeps();
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(
      new Map(),
      new Map([[orgId, [finanzasFalsa, finanzasDeOtraPropiedad]]]),
      new Map([[orgId, [payoutFalso]]]),
      new Map([[orgId, [pricingFalso]]]),
      new Map([[orgId, [mensajeriaFalsa]]]),
      new Map([[orgId, [limpiezaFalsa]]]),
      new Map([[orgId, [syncIcalFalso]]]),
    );
    const deps = { ...base.deps, rentasBreakGlassDataRepo: (_db: unknown) => dataRepo } as typeof base.deps;
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(deps, superadminId, "superadmin@example.com");
    const app = buildApp(deps);

    const resOpen = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: orgId, reason: RAZON_VALIDA, durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(resOpen.status).toBe(201);

    // Filtro por propiedad: SOLO la fila de propertyIdBuscado, nunca la de otra propiedad.
    const resFinanzas = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/finanzas?propertyId=${propertyIdBuscado}`, { headers: { authorization: `Bearer ${token}` } });
    expect(resFinanzas.status).toBe(200);
    const finanzas = (await resFinanzas.json()) as { finanzas: Array<{ id: string }> };
    expect(finanzas.finanzas).toHaveLength(1);
    expect(finanzas.finanzas[0]!.id).toBe(finanzasFalsa.id);

    const rutas: Array<[string, string]> = [
      ["payouts", "payouts"],
      ["pricing", "pricing"],
      ["mensajeria", "mensajeria"],
      ["limpieza", "limpieza"],
      ["sync-ical", "syncIcal"],
    ];
    for (const [path, jsonKey] of rutas) {
      const res = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown[]>;
      expect(body[jsonKey]).toHaveLength(1);
    }

    // Las 6 lecturas nuevas + la de finanzas filtrada quedan en la bitácora.
    const resBitacora = await app.request("/superadmin/break-glass/bitacora", { headers: { authorization: `Bearer ${token}` } });
    const bitacora = (await resBitacora.json()) as { entries: Array<{ resourceType: string }> };
    const tipos = bitacora.entries.map((e) => e.resourceType).sort();
    expect(tipos).toEqual(["finanzas", "limpieza", "mensajeria", "payouts", "pricing", "sync_ical"].sort());
  });

  // Bloqueante 3 de la revisión real del PR #155: `disponible: false` debe
  // llegar hasta la respuesta HTTP -- distinto de un `200` con lista vacía por
  // datos reales -- y NO debe generar fila de bitácora (acceso.ts nunca audita
  // una lectura que no ocurrió). Doble mínimo del puerto (no
  // `InMemoryBreakGlassRentasDataRepository`, que siempre está disponible) que
  // simula el estado real de `PostgresBreakGlassRentasDataRepository` cuando
  // la migración 020 todavía no está aplicada.
  it("Fase 10c -- lector NO disponible (disponible: false): 200 con lista vacía Y disponible:false, SIN fila nueva en la bitácora", async () => {
    const orgId = randomUUID();
    const base = await buildTestDeps();
    const dataRepoNoDisponible: BreakGlassRentasDataRepository = {
      listReservasTenant: async () => [],
      listFinanzasTenant: async () => ({ disponible: false, datos: [] }),
      listPayoutsTenant: async () => ({ disponible: true, datos: [] }),
      listPricingTenant: async () => ({ disponible: true, datos: [] }),
      listMensajeriaTenant: async () => ({ disponible: true, datos: [] }),
      listLimpiezaTenant: async () => ({ disponible: true, datos: [] }),
      listSyncIcalTenant: async () => ({ disponible: true, datos: [] }),
    };
    const deps = { ...base.deps, rentasBreakGlassDataRepo: (_db: unknown) => dataRepoNoDisponible } as typeof base.deps;
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await tokenFor(deps, superadminId, "superadmin@example.com");
    const app = buildApp(deps);

    const resOpen = await app.request("/superadmin/break-glass/sesiones", jsonRequestInit({ organizationId: orgId, reason: RAZON_VALIDA, durationMinutes: 30 }, { authorization: `Bearer ${token}` }));
    expect(resOpen.status).toBe(201);

    const resFinanzas = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/finanzas`, { headers: { authorization: `Bearer ${token}` } });
    expect(resFinanzas.status).toBe(200);
    const finanzas = (await resFinanzas.json()) as { finanzas: unknown[]; disponible: boolean };
    expect(finanzas.finanzas).toEqual([]);
    expect(finanzas.disponible).toBe(false);

    // Un lector SÍ disponible en la MISMA sesión sigue devolviendo disponible:true.
    const resPayouts = await app.request(`/superadmin/break-glass/organizaciones/${orgId}/payouts`, { headers: { authorization: `Bearer ${token}` } });
    const payouts = (await resPayouts.json()) as { payouts: unknown[]; disponible: boolean };
    expect(payouts.disponible).toBe(true);

    // La lectura NO disponible no dejó fila en la bitácora (fail-closed al
    // revés: nunca se audita un uso que no ocurrió).
    const resBitacora = await app.request("/superadmin/break-glass/bitacora", { headers: { authorization: `Bearer ${token}` } });
    const bitacora = (await resBitacora.json()) as { entries: Array<{ resourceType: string }> };
    expect(bitacora.entries.map((e) => e.resourceType)).toEqual(["payouts"]);
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
