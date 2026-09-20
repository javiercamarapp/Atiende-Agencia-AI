// GET/POST /internal/rentas/checkout-sweep: drena `procesarCheckoutsPendientes`
// (packages/domain-rentas/src/limpieza/aplicacion/tareas.ts, Fase 8) contra
// `rentas.ocupacion` real -- mismo patrón/guard que
// rentas-email-dispatch.spec.ts/rentas-ical-sync-cron.spec.ts (leídos primero como
// plantilla) -- hallazgo de auditoría: en rentas no existía ninguna forma de que
// naciera una tarea de limpieza en producción, pese a que el motor transaccional
// completo (crearTareaLimpiezaPorCheckout/procesarCheckoutsPendientes) llevaba desde
// la Fase 8 sin ningún HTTP/cron que lo disparara.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

const AYER = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const EN_UN_ANIO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("GET/POST /internal/rentas/checkout-sweep", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkout-sweep", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("un secreto inválido también responde 401 (nunca revela si el secreto real está cerca)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": "secreto-equivocado" } });
    expect(res.status).toBe(401);
  });

  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkout-sweep", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesados: number };
    expect(body.ok).toBe(true);
    expect(body.procesados).toBe(0);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkout-sweep", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });

  it("crea una tarea de limpieza para una reserva confirmada cuyo checkout ya llegó, visible después por GET .../tareas", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const { id: ocupacionId } = ctx.engine.calendarStore.insertOcupacionReserva({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      inicio: "2020-01-01",
      fin: AYER,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
    });

    const res = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesados: number; tareasCreadas: string[] };
    expect(body.procesados).toBe(1);
    expect(body.tareasCreadas).toHaveLength(1);

    const listado = await app.request(`/rentas/${ctx.propertyId}/tareas`, authedJson(ctx.staff.limpieza.token));
    const listadoBody = (await listado.json()) as { tareas: Array<{ id: string; tipo: string; unidadId: string }> };
    const creada = listadoBody.tareas.find((t) => t.id === body.tareasCreadas[0]);
    expect(creada).toBeDefined();
    expect(creada?.tipo).toBe("limpieza");
    expect(creada?.unidadId).toBe(ctx.unidadId);

    // La reserva ya está vinculada -- ver ejecutarOcupacion en calendar-store.ts.
    const ocupacion = ctx.engine.calendarStore.getOcupacion(ocupacionId);
    expect(ocupacion).not.toBeNull();
  });

  it("es idempotente: una segunda corrida no duplica la tarea de la misma reserva", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.engine.calendarStore.insertOcupacionReserva({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      inicio: "2020-01-01",
      fin: AYER,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
    });

    const primera = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    const primeraBody = (await primera.json()) as { tareasCreadas: string[] };
    expect(primeraBody.tareasCreadas).toHaveLength(1);

    const segunda = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    const segundaBody = (await segunda.json()) as { procesados: number; tareasCreadas: string[] };
    expect(segundaBody.procesados).toBe(0);
    expect(segundaBody.tareasCreadas).toHaveLength(0);
  });

  it("ignora una reserva cuyo checkout todavía no llega", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.engine.calendarStore.insertOcupacionReserva({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      inicio: "2020-01-01",
      fin: EN_UN_ANIO,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
    });

    const res = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    const body = (await res.json()) as { procesados: number };
    expect(body.procesados).toBe(0);
  });

  // REQ-r6/f2-current-date-fecha-negocio: el scheduler (Vercel Cron) SIEMPRE dispara
  // esta ruta sin ningún `asOfDate` -- el default de `procesarCheckoutsPendientes`
  // debe ser el día de NEGOCIO (`hoyFechaNegocio()`), nunca el día UTC crudo de la
  // sesión. A las 19:30 CDMX el día UTC YA es mañana; un checkout que apenas llega
  // MAÑANA (día de negocio) no debe procesarse todavía.
  it("a las 19:30 CDMX, NO procesa un checkout que llega MAÑANA (día de negocio), aunque el día UTC ya sea mañana", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.engine.calendarStore.insertOcupacionReserva({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      inicio: "2026-01-01",
      fin: "2026-01-02",
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
    });

    // 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T01:30:00.000Z"));

    const res = await app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesados: number };
    expect(body.procesados).toBe(0);
  });
});
