// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) de Fase 13 -- calendario visual del panel de staff: cierra el hallazgo de
// auditoría "Calendario de reservas y bloqueos: backend completo sin UI". Ejercita el
// listado unificado real de ocupaciones (reserva de canal Y bloqueo, activa Y
// cancelada) más el descubrimiento de unidades de una property -- ambos GET nuevos de
// esta fase (apps/api/src/routes/verticals/rentas/calendario.ts).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("GET /rentas/:propertyId/unidades", () => {
  it("lista las unidades reales de la property", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unidades: Array<{ id: string; nombre: string }> };
    expect(body.unidades).toHaveLength(1);
    expect(body.unidades[0]!.id).toBe(ctx.unidadId);
    expect(body.unidades[0]!.nombre).toBe("Depa de Prueba");
  });

  it("un rol de SOLO calendario (lectura) SÍ puede listar unidades -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades`, authedJson(ctx.staff.operadorSoloCalendario.token));
    expect(res.status).toBe(200);
  });

  // Hallazgo de auditoría: `contador` y `limpieza` tienen pantallas construidas
  // específicamente para ellos (Finanzas.tsx "Movimiento por reserva" y MisTareas.tsx
  // "Reportar incidencia") que dependían de este mismo GET y no podían usarlas.
  // CALENDARIO_LECTURA_ROLES ahora los incluye (ver roles.ts) -- comportamiento
  // cambiado intencionalmente respecto al test anterior ("contador ... no puede
  // listar unidades -- 403").
  it("contador (agregado a CALENDARIO_LECTURA_ROLES) SÍ puede listar unidades -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unidades: Array<{ id: string; nombre: string }> };
    expect(body.unidades).toHaveLength(1);
  });

  it("limpieza (agregado a CALENDARIO_LECTURA_ROLES) SÍ puede listar unidades -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades`, authedJson(ctx.staff.limpieza.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unidades: Array<{ id: string; nombre: string }> };
    expect(body.unidades).toHaveLength(1);
  });

  it("sin token -- 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades`);
    expect(res.status).toBe(401);
  });
});

describe("GET /rentas/:propertyId/unidades/:unidadId/ocupaciones", () => {
  it("lista reservas Y bloqueos juntos, ordenados por fecha de inicio, con datos de huésped/canal", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const reserva = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-10-10", fin: "2026-10-12" }, huespedNombre: "Ana Pérez", huespedContacto: "+52 55 1234 5678" }),
    );
    expect(reserva.status).toBe(201);

    const bloqueo = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-10-01", fin: "2026-10-02" }, razon: "MANTENIMIENTO" }),
    );
    expect(bloqueo.status).toBe(201);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ocupaciones: Array<{
        capa: string;
        razon: string;
        estado: string;
        rango: { inicio: string; fin: string };
        canalCodigo: string | null;
        huespedNombre: string | null;
      }>;
    };
    expect(body.ocupaciones).toHaveLength(2);
    // Ordenado por fecha de inicio: el bloqueo de mantenimiento (01-oct) antes que la
    // reserva (10-oct).
    expect(body.ocupaciones[0]!.capa).toBe("bloqueo");
    expect(body.ocupaciones[0]!.razon).toBe("MANTENIMIENTO");
    expect(body.ocupaciones[0]!.canalCodigo).toBeNull();
    expect(body.ocupaciones[1]!.capa).toBe("reserva");
    expect(body.ocupaciones[1]!.razon).toBe("RESERVA_CANAL");
    expect(body.ocupaciones[1]!.canalCodigo).toBe("manual");
    expect(body.ocupaciones[1]!.huespedNombre).toBe("Ana Pérez");
    expect(body.ocupaciones[1]!.estado).toBe("confirmado");
  });

  it("una reserva cancelada sigue apareciendo en el listado, con estado='cancelado'", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const creada = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-11-01", fin: "2026-11-03" } }),
    );
    const { id } = (await creada.json()) as { id: string };
    const cancelada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(cancelada.status).toBe(200);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.adminGestora.token));
    const body = (await res.json()) as { ocupaciones: Array<{ id: string; estado: string }> };
    expect(body.ocupaciones.find((o) => o.id === id)!.estado).toBe("cancelado");
  });

  it("una unidad sin ninguna ocupación -> lista vacía, nunca un error", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ocupaciones: unknown[] };
    expect(body.ocupaciones).toHaveLength(0);
  });

  it("un rol de SOLO calendario (lectura) SÍ puede leer el listado de ocupaciones -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.operadorSoloCalendario.token));
    expect(res.status).toBe(200);
  });

  // Mismo hallazgo que el describe de arriba (GET .../unidades): CALENDARIO_LECTURA_ROLES
  // es el Set que gatea ambas rutas de calendario.ts, así que `contador` y `limpieza`
  // quedan igualmente desbloqueados aquí -- comportamiento cambiado intencionalmente
  // respecto al test anterior ("contador ... no puede leer el listado -- 403").
  it("contador (agregado a CALENDARIO_LECTURA_ROLES) SÍ puede leer el listado de ocupaciones -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
  });

  it("limpieza (agregado a CALENDARIO_LECTURA_ROLES) SÍ puede leer el listado de ocupaciones -- 200", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(ctx.staff.limpieza.token));
    expect(res.status).toBe(200);
  });

  it("una unidad que no pertenece a esta property -> 404 (defensa en profundidad)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/ocupaciones`,
      authedJson(ctx.staff.adminGestora.token),
    );
    expect(res.status).toBe(404);
  });
});
