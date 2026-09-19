// r5 -- bitácora de auditoría del staff. Dos frentes, ambos HTTP real (vía
// app.request, sin mockear el repo -- mismo criterio que el resto de tests de este
// vertical):
//
//   1. Cada ruta de escritura sensible (pricing, reservas, payouts, owner statement,
//      ical-sync) registra la fila esperada en `ctx.rentasRepo.auditLog` -- inspección
//      directa del doble en memoria (más barato y más preciso que re-verificar cada
//      flujo de negocio completo, que ya tiene su propio spec).
//   2. GET /v1/rentas/:orgSlug/admin/auditoria: paginado, filtro por tipo/fechas,
//      solo admin_gestora, cross-tenant siempre rechazado.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";

// Mismo setup que apps/api/tests/rentas-statements.spec.ts -- se repite aquí (en vez
// de importarlo) porque ese archivo no exporta sus helpers y este spec no necesita el
// resto de sus escenarios, solo un owner+unidad+movimiento real para llegar a
// registrarAuditoria en finanzas-statements.ts.
async function crearOwnerConUnidad(ctx: Awaited<ReturnType<typeof buildRentasTestContext>>) {
  const ownerId = randomUUID();
  const unidadId = randomUUID();
  ctx.rentasRepo.seedOwner({ id: ownerId, name: "Propietario de prueba" });
  ctx.rentasRepo.seedUnidad({ id: unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, ownerId });
  return { ownerId, unidadId };
}

async function crearReservaYMovimiento(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof buildRentasTestContext>>, unidadId: string, rango: { inicio: string; fin: string }, montoBrutoCentavos: number) {
  const resReserva = await app.request(`/rentas/${ctx.propertyId}/unidades/${unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango }));
  expect(resReserva.status).toBe(201);
  const { id: ocupacionId } = (await resReserva.json()) as { id: string };

  const resMov = await app.request(
    `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
    authedJson(ctx.staff.adminGestora.token, { moneda: "MXN", montoBrutoCentavos, comisionGestorBasisPoints: 2000, comisionGestorBase: "neto_de_canal", gastos: [], impuestos: [] }),
  );
  expect(resMov.status).toBe(201);
  return ocupacionId;
}

describe("r5 — registro de auditoría en las rutas de escritura reales", () => {
  it("POST .../tarifa-base registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 250000, moneda: "MXN" }));
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.tarifa_base.actualizada", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("250000 MXN");
  });

  // No bloqueante #5 de revisión r5: de los 5 POST de pricing solo tarifa-base tenía
  // test de auditoría (temporadas/descuentos-duracion/min-stay/reglas-canal ya
  // estaban instrumentados desde el commit b3d927b, pero sin cobertura). Payloads
  // copiados literal de apps/api/tests/rentas-pricing.spec.ts (casos "happy path" de
  // cada endpoint).
  it("POST .../temporadas registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/temporadas`,
      authedJson(ctx.staff.adminGestora.token, { nombre: "Verano", rango: { inicio: "2026-07-01", fin: "2026-08-01" }, precioNocheCentavos: 250000, moneda: "MXN" }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.temporada.creada", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("Verano");
  });

  it("POST .../descuentos-duracion registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 2000, fuente: "Política mensual del gestor" }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.descuento_duracion.actualizado", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("Política mensual del gestor");
  });

  it("POST .../min-stay registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: null, nochesMinimas: 5 }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.min_stay.creada", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("5 noches");
  });

  it("POST .../reglas-canal registra una fila de auditoría entityType=pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reglas-canal`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", markupBasisPoints: 1500 }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "pricing", action: "pricing.regla_canal.actualizada", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.despues).toContain("airbnb");
  });

  // No bloqueante #5 de revisión r5: PATCH de reserva (modificación de fechas)
  // estaba instrumentado desde el commit b3d927b, pero sin ningún test de auditoría.
  it("PATCH .../reservas/:id registra una fila de auditoría entityType=reserva con el rango nuevo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const antes = ctx.rentasRepo.auditLog.length;
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-02", fin: "2026-06-06" } }, {}, "PATCH"),
    );
    expect(res.status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "reserva", action: "reserva.modificada", entityId: id, campo: "rango_fechas" });
    expect(nuevas[0]!.despues).toContain("2026-06-02");
  });

  it("POST .../reservas/:id/cancelar registra una fila de auditoría entityType=reserva con antes/despues del estado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const antes = ctx.rentasRepo.auditLog.length;
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "reserva", action: "reserva.cancelada", entityId: id, campo: "estado", antes: "confirmado", despues: "cancelado" });
  });

  it("POST .../payouts registra una fila de auditoría entityType=payout", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "manual", moneda: "MXN", fechaPayout: "2026-06-10", lineas: [{ referenciaExternaReserva: null, montoCentavos: 1000 }] }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "payout", action: "payout.registrado" });
  });

  it("POST .../owners/:ownerId/statements registra una fila de auditoría entityType=owner_statement", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);
    const antes = ctx.rentasRepo.auditLog.length;

    const res = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(res.status).toBe(201);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "owner_statement", action: "owner_statement.generado", campo: "version", antes: null });
    expect(nuevas[0]!.despues).toContain("v1 (");
  });

  // r5 -- corrección de revisión (bloqueante 1): `motivoVersion` admite hasta 500
  // caracteres en la ruta HTTP (`requireOptionalString(raw.motivoVersion,
  // "motivoVersion", 500)`), y se concatena dentro de `despues` con ~26 caracteres
  // de envoltura (`v${version} (${neto} ${moneda}, motivo: ${motivo})`) -- un
  // motivo de 500 caracteres exactos hace que `despues` supere los 500 del CHECK de
  // `rentas.audit_log`. Contra Postgres real, `rentas.record_audit_log` ahora trunca
  // con `left(..., 500)` ANTES del INSERT (ver migrations/021_rentas_audit_log.sql)
  // así que la fila SIEMPRE se escribe -- este test corre contra el repositorio en
  // memoria, que ahora reproduce el MISMO truncamiento (ver
  // InMemoryRentasRepository.registrarAuditoria) para que este escenario sea
  // detectable sin necesitar Postgres real. El escenario equivalente contra
  // Postgres real vive en scripts/verify-rentas-bitacora-auditoria/assertions.sql.
  it("un motivoVersion de 500 caracteres NUNCA hace que se pierda la fila de auditoría -- despues queda truncado, nunca descartado en silencio", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);

    const v1 = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/statements`, authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }));
    expect(v1.status).toBe(201);

    // Segunda reserva en el mismo periodo -> el contenido cambia -> exige motivoVersion.
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-10", fin: "2026-06-12" }, 200000);
    const motivoLargo = "x".repeat(500);
    const antes = ctx.rentasRepo.auditLog.length;

    const v2 = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01", motivoVersion: motivoLargo }),
    );
    expect(v2.status).toBe(201); // la acción de negocio nunca se ve afectada por el largo del motivo

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1); // la fila SIEMPRE se escribe -- antes de este fix, se perdía en silencio
    expect(nuevas[0]).toMatchObject({ entityType: "owner_statement", action: "owner_statement.nueva_version" });
    expect(nuevas[0]!.despues).not.toBeNull();
    expect(nuevas[0]!.despues!.length).toBeLessThanOrEqual(500);
  });

  it("POST .../canales/:canal/ical-sync (conectar) y DELETE (desconectar) registran ambas filas entityType=canal", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;
    const antes = ctx.rentasRepo.auditLog.length;

    const conectar = await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    expect(conectar.status).toBe(201);
    const desconectar = await app.request(base, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.adminGestora.token}` } });
    expect(desconectar.status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(2);
    expect(nuevas[0]).toMatchObject({ entityType: "canal", action: "canal.ical_conectado" });
    expect(nuevas[1]).toMatchObject({ entityType: "canal", action: "canal.ical_desconectado" });
  });
});

describe("GET /v1/rentas/:orgSlug/admin/auditoria", () => {
  it("admin_gestora lee la bitácora paginada, más reciente primero", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 200000, moneda: "MXN", vigenteDesde: "2026-07-01" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; total: number; items: { action: string; despues: string | null }[] };
    expect(body.disponible).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // más reciente primero -- la última tarifa creada (200000) debe aparecer antes.
    expect(body.items[0]!.despues).toContain("200000");
  });

  it("filtra por tipo (?tipo=pricing) y por fechas", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));

    const soloPricing = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?tipo=pricing", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const bodyPricing = (await soloPricing.json()) as { items: { entityType: string }[] };
    expect(bodyPricing.items.length).toBeGreaterThan(0);
    expect(bodyPricing.items.every((i) => i.entityType === "pricing")).toBe(true);

    const futuro = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?desde=2099-01-01", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const bodyFuturo = (await futuro.json()) as { items: unknown[]; total: number };
    expect(bodyFuturo.total).toBe(0);
  });

  it("un tipo inválido en el query -- 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria?tipo=lo-que-sea", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(400);
  });

  it("un staff sin rol admin_gestora (contador) recibe 403, nunca una lista vacía silenciosa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.contador.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("operador (acceso total, pero sin admin_gestora) también recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(ctx.staff.operadorAccesoTotal.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("cross-tenant: un staff con token de OTRO contexto (sin membership conocida aquí) nunca ve esta bitácora -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const otherCtx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }));

    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", authedJson(otherCtx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria");
    expect(res.status).toBe(401);
  });

  it("slug inexistente -- 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/esta-gestora-no-existe/admin/auditoria", authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(404);
  });
});
