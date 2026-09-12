// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) de Fase 4 -- exposición de `crearBloqueo` (motor puro desde Fase 1, nunca
// alcanzable por HTTP hasta ahora). Ejercita el comportamiento REAL del motor, no una
// suposición de "bloquea disponibilidad": un bloqueo NUNCA rechaza la creación de una
// reserva de canal que se solape (ni viceversa) -- el solape se registra como
// `conflicto_calendario` (capa_cruzada) para revisión humana, nunca como rechazo.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("POST /rentas/:propertyId/unidades/:unidadId/bloqueos", () => {
  it("crea un bloqueo de mantenimiento real, sin conflicto", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-03" }, razon: "MANTENIMIENTO" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; conflictosCapaCruzada: number };
    expect(body.id).toBeTruthy();
    expect(body.conflictosCapaCruzada).toBe(0);
  });

  it("un bloqueo que se solapa con una reserva de canal existente SE CREA IGUAL (nunca rechaza) y registra el conflicto capa_cruzada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const reserva = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-08-01", fin: "2026-08-05" } }),
    );
    expect(reserva.status).toBe(201);

    const bloqueo = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-08-03", fin: "2026-08-04" }, razon: "BUFFER_LIMPIEZA" }),
    );
    expect(bloqueo.status).toBe(201);
    const body = (await bloqueo.json()) as { id: string; conflictosCapaCruzada: number };
    // El bloqueo del origen solo detecta conflicto contra OTROS bloqueos (ver
    // detectarYRegistrarConflictosCapaCruzada en crearReservaConfirmada, dirección
    // inversa) -- crearBloqueo mismo registra conflicto contra CUALQUIER ocupación
    // solapada (reserva o bloqueo), ver aplicacion/reservas.ts::crearBloqueo.
    expect(body.conflictosCapaCruzada).toBe(1);
  });

  it("razon fuera del catálogo (RESERVA_CANAL, exclusiva de capa='reserva') -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-03" }, razon: "RESERVA_CANAL" }),
    );
    expect(res.status).toBe(400);
  });

  it("un rol de SOLO calendario (lectura) no puede crear bloqueos -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.operadorSoloCalendario.token, { rango: { inicio: "2026-07-01", fin: "2026-07-02" }, razon: "MANTENIMIENTO" }),
    );
    expect(res.status).toBe(403);
  });

  it("una unidad que no pertenece a esta property -> 404 (defensa en profundidad)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-02" }, razon: "MANTENIMIENTO" }),
    );
    expect(res.status).toBe(404);
  });

  it("un rango con formato inválido -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "01/07/2026", fin: "2026-07-02" }, razon: "MANTENIMIENTO" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /rentas/:propertyId/unidades/:unidadId/bloqueos", () => {
  it("lista solo bloqueos (nunca reservas de canal) de la unidad, ordenados por fecha de inicio", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-01", fin: "2026-09-02" } }));
    await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-20", fin: "2026-09-21" }, razon: "BLOQUEO_PROPIETARIO" }),
    );
    await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-10", fin: "2026-09-11" }, razon: "MANTENIMIENTO" }),
    );

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bloqueos: Array<{ razon: string; rango: { inicio: string; fin: string } }> };
    expect(body.bloqueos).toHaveLength(2);
    expect(body.bloqueos[0]!.razon).toBe("MANTENIMIENTO");
    expect(body.bloqueos[0]!.rango.inicio).toBe("2026-09-10");
    expect(body.bloqueos[1]!.razon).toBe("BLOQUEO_PROPIETARIO");
  });

  it("una unidad que no pertenece a esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/bloqueos`,
      authedJson(ctx.staff.adminGestora.token),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/bloqueos/:ocupacionId/cancelar", () => {
  it("libera (cancela) un bloqueo existente", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creado = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-05" }, razon: "MANTENIMIENTO" }),
    );
    const { id } = (await creado.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; estadoAnterior: string };
    expect(body.estado).toBe("cancelado");
    expect(body.estadoAnterior).toBe("confirmado");

    const listado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`, authedJson(ctx.staff.adminGestora.token));
    const listadoBody = (await listado.json()) as { bloqueos: Array<{ id: string; estado: string }> };
    expect(listadoBody.bloqueos.find((b) => b.id === id)!.estado).toBe("cancelado");
  });

  it("cancelar exige el rol más estricto: operador:solo_calendario NO puede cancelar -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creado = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-05" }, razon: "MANTENIMIENTO" }),
    );
    const { id } = (await creado.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos/${id}/cancelar`, authedJson(ctx.staff.operadorSoloCalendario.token, {}));
    expect(res.status).toBe(403);
  });

  it("nunca cancela una reserva de canal por esta ruta -- 400 (usa /reservas/:id/cancelar)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-08-01", fin: "2026-08-05" } }),
    );
    const { id } = (await reserva.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(400);
  });

  it("cancelar un bloqueo ya cancelado -> 409", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creado = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-05" }, razon: "MANTENIMIENTO" }),
    );
    const { id } = (await creado.json()) as { id: string };
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(409);
  });
});
