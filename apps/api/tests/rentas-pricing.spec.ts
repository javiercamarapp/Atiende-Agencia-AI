// Test de integración end-to-end del flujo 4 (Fase 2) — CRUD de configuración de
// pricing, HTTP real: tarifa-base, temporadas, descuentos-duracion, min-stay,
// reglas-canal. Ver diseño Fase 2 rentas §3.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("POST /rentas/:propertyId/unidades/:unidadId/tarifa-base", () => {
  it("admin_gestora crea una tarifa base nueva y la cotización posterior la usa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 200000, moneda: "MXN" }),
    );
    expect(res.status).toBe(201);

    const cot = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02`, authedJson(ctx.staff.adminGestora.token));
    const body = (await cot.json()) as { totalCentavos: number };
    expect(body.totalCentavos).toBe(200000); // la tarifa nueva (vigente hoy) gana sobre la sembrada (vigente 2000-01-01)
  });

  it("operador (no admin_gestora) recibe 403 -- PRICING_ESCRITURA_ROLES = admin_gestora únicamente", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.operadorAccesoTotal.token, { precioNocheCentavos: 200000, moneda: "MXN" }),
    );
    expect(res.status).toBe(403);
  });

  it("contador (lectura financiera) tampoco puede escribir pricing", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.contador.token, { precioNocheCentavos: 200000, moneda: "MXN" }));
    expect(res.status).toBe(403);
  });

  it("rechaza mezclar monedas dentro de la misma unidad -- 400 pricing_moneda_inconsistente", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // La unidad ya tiene pricing sembrado en MXN (fixture) -- USD en otra fecha debe rechazarse.
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 5000, moneda: "USD", vigenteDesde: "2026-01-01" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pricing_moneda_inconsistente");
  });

  it("un precioNocheCentavos decimal se rechaza -- nunca flotante", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100.5, moneda: "MXN" }));
    expect(res.status).toBe(400);
  });

  it("una unidad fuera de esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000099/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 100000, moneda: "MXN" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/temporadas", () => {
  it("crea una temporada válida (sin traslape)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/temporadas`,
      authedJson(ctx.staff.adminGestora.token, { nombre: "Verano", rango: { inicio: "2026-07-01", fin: "2026-08-01" }, precioNocheCentavos: 250000, moneda: "MXN" }),
    );
    expect(res.status).toBe(201);
  });

  it("rechaza una temporada que se traslapa con una ya existente -- 409 pricing_solapado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/temporadas`,
      authedJson(ctx.staff.adminGestora.token, { nombre: "Verano", rango: { inicio: "2026-07-01", fin: "2026-08-01" }, precioNocheCentavos: 250000, moneda: "MXN" }),
    );
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/temporadas`,
      authedJson(ctx.staff.adminGestora.token, { nombre: "Verano tardío", rango: { inicio: "2026-07-15", fin: "2026-07-20" }, precioNocheCentavos: 300000, moneda: "MXN" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pricing_solapado");
  });

  it("un rango invertido (fin <= inicio) se rechaza -- 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/temporadas`,
      authedJson(ctx.staff.adminGestora.token, { nombre: "Inválida", rango: { inicio: "2026-08-01", fin: "2026-07-01" }, precioNocheCentavos: 100000, moneda: "MXN" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/descuentos-duracion", () => {
  it("crea un descuento con fuente obligatoria", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 2000, fuente: "Política mensual del gestor" }),
    );
    expect(res.status).toBe(201);
  });

  it("fuente vacía se rechaza -- nunca un porcentaje mudo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 2000, fuente: "" }),
    );
    expect(res.status).toBe(400);
  });

  it("porcentajeDescuentoBasisPoints > 10000 se rechaza", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 10001, fuente: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("el mismo nochesMinimas dos veces actualiza en vez de duplicar (ON CONFLICT DO UPDATE)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 14, porcentajeDescuentoBasisPoints: 500, fuente: "primera versión" }),
    );
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/descuentos-duracion`,
      authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 14, porcentajeDescuentoBasisPoints: 1500, fuente: "corrección" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { porcentajeDescuentoBasisPoints: number };
    expect(body.porcentajeDescuentoBasisPoints).toBe(1500);
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/min-stay", () => {
  it("dos reglas traslapadas con el MISMO día de check-in (null=todos) -> 409", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: null, nochesMinimas: 5 }),
    );
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: null, nochesMinimas: 7 }),
    );
    expect(res.status).toBe(409);
  });

  it("dos reglas traslapadas en rango pero con DISTINTO día de check-in -> ambas se crean (no es conflicto real)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const a = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: null, nochesMinimas: 5 }),
    );
    const b = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: 6, nochesMinimas: 3 }),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("diaSemanaCheckIn fuera de rango (0-6) se rechaza", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/min-stay`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: 7, nochesMinimas: 5 }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/reglas-canal", () => {
  it("crea una regla de canal, activo=false por defecto -- nunca implícitamente true", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reglas-canal`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", markupBasisPoints: 1500 }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { activo: boolean };
    expect(body.activo).toBe(false);
  });

  it("un canal desconocido -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reglas-canal`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "channel-que-no-existe", markupBasisPoints: 1000 }),
    );
    expect(res.status).toBe(404);
  });

  it("activo=true explícito se respeta, y la cotización con ese canal aplica el markup", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reglas-canal`, authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", markupBasisPoints: 1000, activo: true }));

    const cot = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02&canal=airbnb`, authedJson(ctx.staff.adminGestora.token));
    expect(cot.status).toBe(200);
    const body = (await cot.json()) as { markupCanalCentavos: number };
    expect(body.markupCanalCentavos).toBe(15000); // 10% de 150000 (tarifa sembrada)
  });
});
