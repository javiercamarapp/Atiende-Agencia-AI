// Test de integración end-to-end del flujo 5 (Fase 2) — owner statement: generación
// (con idempotencia H-062), lectura de lista y detalle. Ver diseño Fase 2 rentas §4.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

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

describe("POST /rentas/:propertyId/owners/:ownerId/statements", () => {
  it("genera un statement nuevo (versión 1) a partir de las reservas del periodo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; version: number; creado: boolean; totales: { netoCentavos: number } };
    expect(body.version).toBe(1);
    expect(body.creado).toBe(true);
    expect(body.totales.netoCentavos).toBe(600000 - 120000); // 20% comisión de gestor, sin comisión de canal (manual)
  });

  it("idempotencia H-062: re-generar sin cambios reusa la misma versión (200, creado:false) -- nunca crea una fila nueva", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);

    const primero = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(primero.status).toBe(201);
    const primeroBody = (await primero.json()) as { id: string; version: number };

    const segundo = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(segundo.status).toBe(200);
    const segundoBody = (await segundo.json()) as { id: string; version: number; creado: boolean };
    expect(segundoBody.creado).toBe(false);
    expect(segundoBody.id).toBe(primeroBody.id);
    expect(segundoBody.version).toBe(primeroBody.version);

    const lista = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/statements`, authedJson(ctx.staff.adminGestora.token));
    const listaBody = (await lista.json()) as { statements: unknown[] };
    expect(listaBody.statements).toHaveLength(1); // nunca una segunda fila para el mismo periodo sin cambios
  });

  it("un cambio real de contenido (una reserva nueva en el mismo periodo) exige motivoVersion y crea la versión 2", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);

    const v1 = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/statements`, authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }));
    expect(v1.status).toBe(201);

    // Segunda reserva en el mismo periodo -> el contenido del statement cambia.
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-10", fin: "2026-06-12" }, 200000);

    const sinMotivo = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(sinMotivo.status).toBe(400); // motivoVersion obligatorio para una corrección de un statement ya existente

    const conMotivo = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01", motivoVersion: "Se capturó una reserva que faltaba" }),
    );
    expect(conMotivo.status).toBe(201);
    const body = (await conMotivo.json()) as { version: number; creado: boolean };
    expect(body.version).toBe(2);
    expect(body.creado).toBe(true);
  });

  it("sin movimientos financieros en el periodo -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId } = await crearOwnerConUnidad(ctx);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(res.status).toBe(400);
  });

  it("un owner sin ninguna unidad en esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ownerId = randomUUID();
    ctx.rentasRepo.seedOwner({ id: ownerId, name: "Owner sin unidades aquí" });
    const res = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(res.status).toBe(404);
  });

  it("contador (solo-lectura financiera) recibe 403 al generar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.contador.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /rentas/:propertyId/owners/:ownerId/statements y GET /rentas/:propertyId/statements/:id", () => {
  it("admin_gestora y contador pueden leer la lista y el detalle; operador NO", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ownerId, unidadId } = await crearOwnerConUnidad(ctx);
    await crearReservaYMovimiento(app, ctx, unidadId, { inicio: "2026-06-01", fin: "2026-06-05" }, 600000);
    const generado = await app.request(
      `/rentas/${ctx.propertyId}/owners/${ownerId}/statements`,
      authedJson(ctx.staff.adminGestora.token, { periodoInicio: "2026-06-01", periodoFin: "2026-07-01" }),
    );
    const { id } = (await generado.json()) as { id: string };

    const listaContador = await app.request(`/rentas/${ctx.propertyId}/owners/${ownerId}/statements`, authedJson(ctx.staff.contador.token));
    expect(listaContador.status).toBe(200);

    const detalleAdmin = await app.request(`/rentas/${ctx.propertyId}/statements/${id}`, authedJson(ctx.staff.adminGestora.token));
    expect(detalleAdmin.status).toBe(200);
    const detalleBody = (await detalleAdmin.json()) as { lineas: unknown[]; totales: { netoCentavos: number } };
    expect(detalleBody.lineas.length).toBeGreaterThan(0);

    const detalleOperador = await app.request(`/rentas/${ctx.propertyId}/statements/${id}`, authedJson(ctx.staff.operadorAccesoTotal.token));
    expect(detalleOperador.status).toBe(403);
  });

  it("un id de statement inexistente -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/statements/00000000-0000-4000-8000-000000000000`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
  });
});
