// Test de integración end-to-end del portal de propietario (Fase 3 rentas, diseño
// §3/§4/§5): invitación (staff) -> activación (propietario) -> login -> /me ->
// /unidades -> /statements -> /statements/:id. Incluye el test crítico del diseño §0:
// "un owner NUNCA puede ver datos de una organización donde no tiene presencia real",
// ejercitado de punta a punta vía HTTP real (JWT + middleware + rutas), no solo a
// nivel de repositorio (ver además packages/domain-rentas/tests/owner-portal/
// in-memory-repository.spec.ts para la misma invariante probada en la capa de dominio).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

type Ctx = Awaited<ReturnType<typeof buildRentasTestContext>>;

/** Owner A: presencia real (unidad + statement) SOLO en la organización/property de
 *  `ctx` (la que arma `buildRentasTestContext`). Se aprovisiona por el flujo REAL de
 *  staff (POST .../portal-invite) -- nunca se le fija un password_hash a mano. */
async function crearYActivarOwnerA(app: ReturnType<typeof buildApp>, ctx: Ctx) {
  const ownerId = randomUUID();
  const unidadId = randomUUID();
  ctx.rentasRepo.seedOwner({ id: ownerId, name: "Propietario A" });
  ctx.rentasRepo.seedUnidad({ id: unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, ownerId });

  const email = "propietario-a@ejemplo.mx";
  ctx.rentasOwnerPortalRepo.seedOwner({ id: ownerId, name: "Propietario A", email });
  ctx.rentasOwnerPortalRepo.seedOwnerOrganizacion(ownerId, ctx.organizationId);
  ctx.rentasOwnerPortalRepo.seedUnidad({ id: unidadId, name: "Depa Centro 301", propertyId: ctx.propertyId, organizationId: ctx.organizationId, ownerId });
  const statementId = randomUUID();
  ctx.rentasOwnerPortalRepo.seedOwnerStatement({
    id: statementId,
    ownerId,
    propertyId: ctx.propertyId,
    organizationId: ctx.organizationId,
    periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
    version: 1,
    moneda: "MXN",
    totales: { ingresosBrutosCentavos: 600000, comisionCanalCentavos: 0, comisionGestorCentavos: 120000, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 480000 },
    lineas: [{ ocupacionId: "ocup-a1", tipo: "ingreso", descripcion: "Reserva A1", montoCentavos: 600000 }],
    motivoVersion: null,
    generadoEn: new Date().toISOString(),
  });

  // Flujo real de staff: emite la invitación.
  const invite = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/portal-invite`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "POST"));
  expect(invite.status).toBe(201);
  const { inviteToken } = (await invite.json()) as { inviteToken: string };

  // Flujo real del propietario: activa su cuenta con el token recibido.
  const setPassword = await app.request("/rentas/owner-portal/auth/set-password", jsonRequestInit({ token: inviteToken, password: "clave-super-segura-1" }));
  expect(setPassword.status).toBe(200);

  // Flujo real de login.
  const login = await app.request("/rentas/owner-portal/auth/login", jsonRequestInit({ email, password: "clave-super-segura-1" }));
  expect(login.status).toBe(200);
  const loginBody = (await login.json()) as { token: string; refreshToken: string };

  return { ownerId, unidadId, statementId, email, token: loginBody.token, refreshToken: loginBody.refreshToken };
}

/** Owner B: presencia real en una organización/property COMPLETAMENTE DISTINTA, sin
 *  ningún vínculo con la de `ctx` -- seedeado directo (sin pasar por el flujo de
 *  invitación, que ya se prueba con Owner A) para tener un segundo tenant real contra
 *  el que probar el aislamiento. */
function crearOwnerBEnOtraOrganizacion(ctx: Ctx) {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const ownerId = randomUUID();
  const unidadId = randomUUID();
  const statementId = randomUUID();

  ctx.rentasOwnerPortalRepo.seedOrganization({ id: organizationId, name: "Otra Gestora Completamente Distinta", slug: "otra-gestora" });
  ctx.rentasOwnerPortalRepo.seedOwner({ id: ownerId, name: "Propietario B", email: "propietario-b@ejemplo.mx" });
  ctx.rentasOwnerPortalRepo.seedOwnerOrganizacion(ownerId, organizationId);
  ctx.rentasOwnerPortalRepo.seedUnidad({ id: unidadId, name: "Loft Roma Norte", propertyId, organizationId, ownerId });
  ctx.rentasOwnerPortalRepo.seedOwnerStatement({
    id: statementId,
    ownerId,
    propertyId,
    organizationId,
    periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
    version: 1,
    moneda: "MXN",
    totales: { ingresosBrutosCentavos: 300000, comisionCanalCentavos: 0, comisionGestorCentavos: 60000, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 240000 },
    lineas: [{ ocupacionId: "ocup-b1", tipo: "ingreso", descripcion: "Reserva B1", montoCentavos: 300000 }],
    motivoVersion: null,
    generadoEn: new Date().toISOString(),
  });

  return { organizationId, propertyId, ownerId, unidadId, statementId };
}

describe("Portal de propietario -- flujo real invitación -> activación -> login -> lectura", () => {
  it("owner activa su cuenta con la invitación de staff, inicia sesión, y ve su perfil/unidades/statements", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = await crearYActivarOwnerA(app, ctx);

    const me = await app.request("/rentas/owner-portal/me", authedJson(owner.token, undefined, {}, "GET"));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { id: string; name: string; email: string; organizaciones: { organizationId: string }[] };
    expect(meBody.id).toBe(owner.ownerId);
    expect(meBody.organizaciones.map((o) => o.organizationId)).toEqual([ctx.organizationId]);

    const unidades = await app.request("/rentas/owner-portal/unidades", authedJson(owner.token, undefined, {}, "GET"));
    expect(unidades.status).toBe(200);
    const unidadesBody = (await unidades.json()) as { unidades: { id: string; organizationName: string }[] };
    expect(unidadesBody.unidades).toHaveLength(1);
    expect(unidadesBody.unidades[0]!.id).toBe(owner.unidadId);
    expect(unidadesBody.unidades[0]!.organizationName).toBe("Rentas de Prueba");

    const statements = await app.request("/rentas/owner-portal/statements", authedJson(owner.token, undefined, {}, "GET"));
    expect(statements.status).toBe(200);
    const statementsBody = (await statements.json()) as { statements: { id: string }[] };
    expect(statementsBody.statements.map((s) => s.id)).toEqual([owner.statementId]);

    const detalle = await app.request(`/rentas/owner-portal/statements/${owner.statementId}`, authedJson(owner.token, undefined, {}, "GET"));
    expect(detalle.status).toBe(200);
    const detalleBody = (await detalle.json()) as { lineas: unknown[]; totales: { netoCentavos: number } };
    expect(detalleBody.totales.netoCentavos).toBe(480000);
    expect(detalleBody.lineas).toHaveLength(1);
  });

  it("refresh: un refresh token de propietario emite un nuevo access token válido", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = await crearYActivarOwnerA(app, ctx);

    const refresh = await app.request("/rentas/owner-portal/auth/refresh", jsonRequestInit({ refreshToken: owner.refreshToken }));
    expect(refresh.status).toBe(200);
    const { token: nuevoToken } = (await refresh.json()) as { token: string };

    const me = await app.request("/rentas/owner-portal/me", authedJson(nuevoToken, undefined, {}, "GET"));
    expect(me.status).toBe(200);
  });

  it("login con contraseña incorrecta -> 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = await crearYActivarOwnerA(app, ctx);

    const res = await app.request("/rentas/owner-portal/auth/login", jsonRequestInit({ email: owner.email, password: "contraseña-equivocada" }));
    expect(res.status).toBe(401);
  });

  it("set-password con un token de invitación inválido/inexistente -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/rentas/owner-portal/auth/set-password", jsonRequestInit({ token: "token-que-nunca-existio", password: "clave-super-segura-1" }));
    expect(res.status).toBe(400);
  });

  it("sin token en el header -> 401 en cualquier ruta autenticada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/rentas/owner-portal/me");
    expect(res.status).toBe(401);
  });
});

describe("Portal de propietario -- invitación (staff): autorización", () => {
  it("un operador (sin rol de lectura financiera) NO puede invitar -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerId = randomUUID();
    const unidadId = randomUUID();
    ctx.rentasRepo.seedOwner({ id: ownerId, name: "Propietario" });
    ctx.rentasRepo.seedUnidad({ id: unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, ownerId });

    const res = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/portal-invite`, authedJson(ctx.staff.operadorAccesoTotal.token, undefined, {}, "POST"));
    expect(res.status).toBe(403);
  });

  it("contador (lectura financiera) SÍ puede invitar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerId = randomUUID();
    const unidadId = randomUUID();
    ctx.rentasRepo.seedOwner({ id: ownerId, name: "Propietario" });
    ctx.rentasRepo.seedUnidad({ id: unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, ownerId });

    const res = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/portal-invite`, authedJson(ctx.staff.contador.token, undefined, {}, "POST"));
    expect(res.status).toBe(201);
  });

  it("invitar a un owner sin ninguna unidad en esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerId = randomUUID();
    ctx.rentasRepo.seedOwner({ id: ownerId, name: "Owner sin unidades aquí" });

    const res = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/portal-invite`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "POST"));
    expect(res.status).toBe(404);
  });

  it("un token de STAFF (secreto/claims distintos) nunca abre una sesión de propietario -- 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // ctx.staff.adminGestora.token es un JWT de staff real, firmado con deps.env.jwtSecret
    // -- verificarlo como token de propietario (secreto/claims/discriminador distintos)
    // debe fallar SIEMPRE, no solo "no encontrar" al owner.
    const res = await app.request("/rentas/owner-portal/me", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(401);
  });

  it("un token de PROPIETARIO nunca abre una sesión de staff -- 401 en una ruta de staff", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = await crearYActivarOwnerA(app, ctx);

    const res = await app.request(`/rentas/${ctx.propertyId}/statements/${owner.statementId}`, authedJson(owner.token, undefined, {}, "GET"));
    expect(res.status).toBe(401);
  });
});

describe("Portal de propietario -- AISLAMIENTO: un owner nunca ve datos de una organización donde no tiene presencia real", () => {
  it("GET /unidades de Owner A nunca incluye unidades de Owner B/otra organización", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerA = await crearYActivarOwnerA(app, ctx);
    const ownerB = crearOwnerBEnOtraOrganizacion(ctx);

    const res = await app.request("/rentas/owner-portal/unidades", authedJson(ownerA.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unidades: { id: string; organizationId: string }[] };
    expect(body.unidades.map((u) => u.id)).toEqual([ownerA.unidadId]);
    expect(body.unidades.map((u) => u.id)).not.toContain(ownerB.unidadId);
    expect(body.unidades.map((u) => u.organizationId)).not.toContain(ownerB.organizationId);
  });

  it("GET /statements de Owner A nunca incluye statements de Owner B/otra organización", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerA = await crearYActivarOwnerA(app, ctx);
    const ownerB = crearOwnerBEnOtraOrganizacion(ctx);

    const res = await app.request("/rentas/owner-portal/statements", authedJson(ownerA.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { statements: { id: string }[] };
    expect(body.statements.map((s) => s.id)).toEqual([ownerA.statementId]);
    expect(body.statements.map((s) => s.id)).not.toContain(ownerB.statementId);
  });

  it("GET /statements/:id -- Owner A NUNCA puede leer el detalle de un statement de Owner B, aunque conozca su id exacto (nunca hay parámetro ownerId que manipular)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerA = await crearYActivarOwnerA(app, ctx);
    const ownerB = crearOwnerBEnOtraOrganizacion(ctx);

    const res = await app.request(`/rentas/owner-portal/statements/${ownerB.statementId}`, authedJson(ownerA.token, undefined, {}, "GET"));
    expect(res.status).toBe(404);

    // Y viceversa: Owner A sí puede leer el SUYO.
    const propio = await app.request(`/rentas/owner-portal/statements/${ownerA.statementId}`, authedJson(ownerA.token, undefined, {}, "GET"));
    expect(propio.status).toBe(200);
  });

  it("GET /me de Owner A nunca informa la organización de Owner B", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerA = await crearYActivarOwnerA(app, ctx);
    const ownerB = crearOwnerBEnOtraOrganizacion(ctx);

    const res = await app.request("/rentas/owner-portal/me", authedJson(ownerA.token, undefined, {}, "GET"));
    const body = (await res.json()) as { organizaciones: { organizationId: string }[] };
    expect(body.organizaciones.map((o) => o.organizationId)).toEqual([ctx.organizationId]);
    expect(body.organizaciones.map((o) => o.organizationId)).not.toContain(ownerB.organizationId);
  });

  it("el filtro ?propertyId= de GET /statements acota, pero nunca puede usarse para ver la property de OTRO owner", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerA = await crearYActivarOwnerA(app, ctx);
    const ownerB = crearOwnerBEnOtraOrganizacion(ctx);

    // Owner A intenta filtrar explícitamente por la property de Owner B -- el ownerId
    // real sigue siendo el de la sesión (JWT), nunca algo que la query string decida.
    const res = await app.request(`/rentas/owner-portal/statements?propertyId=${ownerB.propertyId}`, authedJson(ownerA.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { statements: unknown[] };
    expect(body.statements).toHaveLength(0); // Owner A no tiene NADA en la property de Owner B
  });
});
