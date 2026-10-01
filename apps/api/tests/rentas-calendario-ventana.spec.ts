// Rn-06 -- calendario visual: `GET /rentas/:propertyId/calendario?desde&hasta` (lectura por ventana de la property) y la
// ventana `?desde&hasta` de `GET /rentas/:propertyId/tareas`. HTTP real vía app.request sobre los repos en memoria.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface VentanaBody {
  zona_horaria: string;
  hoy: string;
  desde: string;
  hasta: string;
  total: number;
  truncado: boolean;
  ocupaciones: Array<{ id: string; unidadId: string; capa: string; razon: string; estado: string; rango: { inicio: string; fin: string }; canalCodigo: string | null; huespedNombre: string | null; huespedContacto?: unknown }>;
}

async function sembrar(ctx: Awaited<ReturnType<typeof buildRentasTestContext>>, app: ReturnType<typeof buildApp>) {
  const token = ctx.staff.adminGestora.token;
  const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}`;
  const reserva = async (inicio: string, fin: string, huespedNombre?: string) => {
    const res = await app.request(`${base}/reservas`, authedJson(token, { rango: { inicio, fin }, huespedNombre, huespedContacto: huespedNombre ? "+52 55 0000 0000" : undefined }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const lejos = await reserva("2026-09-20", "2026-09-25"); // totalmente antes de la ventana
  const cruzaInicio = await reserva("2026-09-28", "2026-10-03"); // cruza el borde inicial de [10-01, 11-03) y termina justo en el de [10-03, ...)
  const dentro = await reserva("2026-10-10", "2026-10-12", "Ana Pérez");
  const cancelada = await reserva("2026-10-15", "2026-10-17");
  expect((await app.request(`${base}/reservas/${cancelada}/cancelar`, authedJson(token, {}))).status).toBe(200);
  const bloqueo = await app.request(`${base}/bloqueos`, authedJson(token, { rango: { inicio: "2026-10-20", fin: "2026-10-22" }, razon: "MANTENIMIENTO" }));
  expect(bloqueo.status).toBe(201);
  const cruzaFin = await reserva("2026-10-30", "2026-11-03"); // termina justo en el borde final de la ventana
  const despues = await reserva("2026-11-03", "2026-11-05"); // empieza justo en el borde final: contigua, NO la toca
  return { lejos, cruzaInicio, dentro, cancelada, bloqueoId: ((await bloqueo.json()) as { id: string }).id, cruzaFin, despues };
}

describe("GET /rentas/:propertyId/calendario", () => {
  it("devuelve solo lo ACTIVO que toca la ventana [desde, hasta): cruces de borde incluidos, contiguas y canceladas fuera", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ids = await sembrar(ctx, app);

    const res = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as VentanaBody;
    expect(body.ocupaciones.map((o) => o.id)).toEqual([ids.cruzaInicio, ids.dentro, ids.bloqueoId, ids.cruzaFin]);
    expect(body.total).toBe(4);
    expect(body.truncado).toBe(false);
    expect(body.ocupaciones[2]).toMatchObject({ capa: "bloqueo", razon: "MANTENIMIENTO", canalCodigo: null });
    expect(body.ocupaciones[1]).toMatchObject({ capa: "reserva", canalCodigo: "manual", huespedNombre: "Ana Pérez" });

    // Ventana que abre justo cuando termina una estancia (check-out = desde): esa noche ya no es suya.
    const contigua = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-03&hasta=2026-11-03`, authedJson(ctx.staff.adminGestora.token));
    expect(((await contigua.json()) as VentanaBody).ocupaciones.map((o) => o.id)).toEqual([ids.dentro, ids.bloqueoId, ids.cruzaFin]);
  });

  it("no expone el contacto del huésped (minimización)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await sembrar(ctx, app);
    const res = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03`, authedJson(ctx.staff.adminGestora.token));
    const texto = await res.text();
    expect(texto).not.toContain("+52 55 0000 0000");
    expect(texto).not.toContain("huespedContacto");
  });

  it("`limit` acota las filas pero `total` y `truncado` dicen la verdad", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await sembrar(ctx, app);
    const res = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03&limit=2`, authedJson(ctx.staff.adminGestora.token));
    const body = (await res.json()) as VentanaBody;
    expect(body.ocupaciones).toHaveLength(2);
    expect(body.total).toBe(4);
    expect(body.truncado).toBe(true);
  });

  it("el filtro unidadId acota a una unidad y una unidad ajena responde 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await sembrar(ctx, app);
    const propia = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03&unidadId=${ctx.unidadId}`, authedJson(ctx.staff.adminGestora.token));
    expect(((await propia.json()) as VentanaBody).ocupaciones).toHaveLength(4);
    const ajena = await app.request(`/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03&unidadId=00000000-0000-4000-8000-000000000000`, authedJson(ctx.staff.adminGestora.token));
    expect(ajena.status).toBe(404);
  });

  it("rechaza fechas imposibles, ventana invertida o vacía y ventana de más de 100 días con 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const token = ctx.staff.adminGestora.token;
    for (const qs of ["desde=2026-02-30&hasta=2026-03-10", "desde=2026-10-10&hasta=2026-10-01", "desde=2026-10-10&hasta=2026-10-10", "desde=2026-10-01", "hasta=2026-10-01", "desde=2026-01-01&hasta=2026-06-01"]) {
      const res = await app.request(`/rentas/${ctx.propertyId}/calendario?${qs}`, authedJson(token));
      expect(res.status, qs).toBe(400);
    }
  });

  it("sin token 401; un rol de solo calendario y limpieza (lectura) pueden leer", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03`;
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, authedJson(ctx.staff.operadorSoloCalendario.token))).status).toBe(200);
    expect((await app.request(url, authedJson(ctx.staff.limpieza.token))).status).toBe(200);
  });

  it("no filtra otra property: un staff sin membresía en la property recibe 403/404, no sus ocupaciones", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await sembrar(ctx, app);
    const res = await app.request(`/rentas/00000000-0000-4000-8000-0000000000aa/calendario?desde=2026-10-01&hasta=2026-11-03`, authedJson(ctx.staff.adminGestora.token));
    expect([403, 404]).toContain(res.status);
  });

  it("'hoy' sale de la zona de la property (Cancún), no del día UTC ni del de CDMX, y cruza la medianoche local", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/rentas/${ctx.propertyId}/calendario?desde=2026-10-01&hasta=2026-11-03`;
    // 05:30 UTC = 00:30 del 2 de enero en Cancún (UTC-5) = 23:30 del 1 de enero en CDMX (UTC-6).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T05:30:00Z"));
    const a = (await (await app.request(url, authedJson(ctx.staff.adminGestora.token))).json()) as VentanaBody;
    expect(a.zona_horaria).toBe("America/Cancun");
    expect(a.hoy).toBe("2026-01-02");
    // 04:59 UTC = 23:59 del 1 de enero en Cancún: todavía es el día 1 (aunque el día UTC ya sea el 2).
    vi.setSystemTime(new Date("2026-01-02T04:59:00Z"));
    const b = (await (await app.request(url, authedJson(ctx.staff.adminGestora.token))).json()) as VentanaBody;
    expect(b.hoy).toBe("2026-01-01");
  });
});

describe("GET /rentas/:propertyId/tareas con ventana desde/hasta", () => {
  it("filtra por programadaPara con ambos extremos inclusivos y valida las fechas", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sembrada = (programadaPara: string) => ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara }).id;
    sembrada("2026-09-30");
    const a = sembrada("2026-10-01");
    const b = sembrada("2026-10-31");
    sembrada("2026-11-01");

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas?desde=2026-10-01&hasta=2026-10-31`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: Array<{ id: string }> };
    expect(body.tareas.map((t) => t.id)).toEqual([a, b]);

    const sinTope = await app.request(`/rentas/${ctx.propertyId}/tareas?desde=2026-10-31`, authedJson(ctx.staff.adminGestora.token));
    expect(((await sinTope.json()) as { tareas: unknown[] }).tareas).toHaveLength(2);

    for (const qs of ["desde=2026-02-30", "hasta=oct", "desde=2026-10-31&hasta=2026-10-01"]) {
      expect((await app.request(`/rentas/${ctx.propertyId}/tareas?${qs}`, authedJson(ctx.staff.adminGestora.token))).status, qs).toBe(400);
    }
  });

  it("sin ventana la respuesta es la de siempre (compatibilidad)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-09-30" });
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas`, authedJson(ctx.staff.adminGestora.token));
    expect(((await res.json()) as { tareas: unknown[] }).tareas).toHaveLength(1);
  });
});
