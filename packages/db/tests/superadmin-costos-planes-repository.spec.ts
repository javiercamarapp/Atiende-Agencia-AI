// Adaptador Postgres de costos/planes: base sin migrar (42883/42P01/42703) con una sesion que
// reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession) -- una sesion
// falsa plana no distinguiria una implementacion sin SAVEPOINT --, traduccion de SQLSTATE de
// negocio a errores tipados, mapeo de filas (bigint/numeric llegan como string del driver) y
// la semantica del adaptador en memoria que usan los tests de rutas.
import { describe, expect, it } from "vitest";
import { InMemoryCostosPlanesRepository, PostgresCostosPlanesRepository, SuperadminSeguridadError } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = (name: string) => pgError("42883", `function core.${name}(uuid) does not exist`);

describe("PostgresCostosPlanesRepository -- base sin migrar", () => {
  const funciones = [
    "record_usage_cost_event",
    "get_cost_margin_report_for_superadmin",
    "list_usage_cost_events_for_superadmin",
    "list_fx_rates_for_superadmin",
    "superadmin_set_fx_rate",
    "list_plans_for_superadmin",
    "superadmin_upsert_plan",
    "superadmin_set_plan_limit",
    "superadmin_delete_plan_limit",
    "superadmin_request_plan_assignment",
    "superadmin_confirm_plan_assignment",
    "superadmin_cancel_plan_assignment",
    "list_plan_assignments_for_superadmin",
  ];

  it("cada metodo sin migracion devuelve not_migrated con datos vacios Y deja la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      ...funciones.map((f) => ({ match: new RegExp(f), respond: () => missingFn(f) })),
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresCostosPlanesRepository(session);
    const evento = { organizationId: "o1", categoria: "voz" as const, proveedor: "livekit", unidad: "minuto" as const, cantidad: 1, costoMicroUsd: 1, refTipo: "voice_call", refId: "c1" };
    await expect(repo.recordEvent(evento)).resolves.toEqual({ availability: "not_migrated", inserted: null });
    await expect(repo.getReport("u1", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", rows: [] });
    await expect(repo.listEvents("u1", "o1")).resolves.toEqual({ availability: "not_migrated", events: [] });
    await expect(repo.listFxRates("u1")).resolves.toEqual({ availability: "not_migrated", rates: [] });
    await expect(repo.setFxRate("u1", "2026-09-01", 18, "Banxico FIX")).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.listPlans("u1")).resolves.toEqual({ availability: "not_migrated", plans: [] });
    await expect(repo.upsertPlan("u1", { id: "plan-x", nombre: "Plan X", vertical: "citas", precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0, activo: true })).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.setPlanLimit("u1", "plan-x", "mensajes_mes", 5, "avisar")).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.deletePlanLimit("u1", "plan-x", "mensajes_mes")).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.requestAssignment("u1", "o1", "plan-x", "motivo suficientemente largo")).resolves.toEqual({ availability: "not_migrated", assignment: null });
    await expect(repo.confirmAssignment("u1", "r1")).resolves.toEqual({ availability: "not_migrated", assignment: null });
    await expect(repo.cancelAssignment("u1", "r1")).resolves.toEqual({ availability: "not_migrated", assignment: null });
    await expect(repo.listAssignments("u1")).resolves.toEqual({ availability: "not_migrated", assignments: [] });
    // la prueba real: despues de 13 errores la sesion sigue viva (cada uno hizo ROLLBACK TO SAVEPOINT)
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(13);
  });

  it("tabla/columna ausente (42P01/42703) tambien degrada; un 42883 de tipos (bug real) NO se enmascara", async () => {
    const tabla = new AbortAwareFakeSession([{ match: /get_cost_margin_report/, respond: () => pgError("42P01", 'relation "core.usage_cost_event" does not exist') }]);
    await expect(new PostgresCostosPlanesRepository(tabla).getReport("u1", null)).resolves.toEqual({ availability: "not_migrated", rows: [] });
    const columna = new AbortAwareFakeSession([{ match: /list_plans_for_superadmin/, respond: () => pgError("42703", "column x does not exist") }]);
    await expect(new PostgresCostosPlanesRepository(columna).listPlans("u1")).resolves.toEqual({ availability: "not_migrated", plans: [] });
    const tipos = new AbortAwareFakeSession([{ match: /get_cost_margin_report/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresCostosPlanesRepository(tipos).getReport("u1", null)).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresCostosPlanesRepository -- errores de negocio y mapeo", () => {
  const cases: Array<[string, "forbidden" | "invalid" | "not_found" | "conflict"]> = [
    ["42501", "forbidden"],
    ["22023", "invalid"],
    ["23514", "invalid"],
    ["22P02", "invalid"],
    ["P0002", "not_found"],
    ["55006", "conflict"],
    ["23505", "conflict"],
  ];
  for (const [sqlstate, code] of cases) {
    it(`SQLSTATE ${sqlstate} -> ${code} (y la sesion queda usable)`, async () => {
      const session = new AbortAwareFakeSession([
        { match: /superadmin_set_plan_limit/, respond: () => pgError(sqlstate, "falla de negocio") },
        { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
      ]);
      await expect(new PostgresCostosPlanesRepository(session).setPlanLimit("u1", "plan-x", "mensajes_mes", 5, "avisar")).rejects.toMatchObject({ name: "SuperadminSeguridadError", code });
      await expect(session.query("select 1 as sigue_viva")).resolves.toBeDefined();
    });
  }

  it("un error desconocido se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /superadmin_set_plan_limit/, respond: () => pgError("XX000", "boom") }]);
    await expect(new PostgresCostosPlanesRepository(session).setPlanLimit("u1", "plan-x", "mensajes_mes", 5, "avisar")).rejects.toThrow("boom");
  });

  it("mapea el reporte: bigint/numeric del driver (strings) a numeros y null a null", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /get_cost_margin_report/,
        respond: () => [
          {
            organization_id: "o1", organization_name: "Org", organization_slug: "org", vertical: "restaurantes", org_status: "active",
            plan_id: null, plan_nombre: null, precio_base_mxn_centavos: null, precio_asiento_mxn_centavos: null, asientos_incluidos: null,
            billing_status: null, billing_seats: null, sucursales_activas: 2,
            llm_micro_usd: "6000000", voz_micro_usd: "3000000", whatsapp_micro_usd: "400000", telefonia_micro_usd: "0", otros_micro_usd: "0",
            eventos_total: "3", eventos_estimados: "2", minutos_voz: "5.000", mensajes: "100.000", llm_cap_micro_usd: "100000000", llm_alert_pct: "80",
          },
        ],
      },
    ]);
    const { rows } = await new PostgresCostosPlanesRepository(session).getReport("u1", "2026-03-01");
    expect(rows[0]).toMatchObject({ llmMicroUsd: 6_000_000, vozMicroUsd: 3_000_000, minutosVoz: 5, mensajes: 100, llmCapMicroUsd: 100_000_000, llmAlertPct: 80, planId: null, precioBaseCentavos: null, eventosEstimados: 2 });
  });

  it("mapea el catalogo: limites jsonb con limite bigint como string", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /list_plans_for_superadmin/,
        respond: () => [
          { id: "restaurantes-pro", nombre: "Pro", vertical: "restaurantes", precio_base_mxn_centavos: "590000", precio_asiento_mxn_centavos: "79900", asientos_incluidos: 1, activo: true, limites: [{ metrica: "minutos_voz_mes", limite: "10000", accion: "cobrar" }], organizaciones: 2, updated_at: "2026-09-30T00:00:00Z" },
        ],
      },
    ]);
    const { plans } = await new PostgresCostosPlanesRepository(session).listPlans("u1");
    expect(plans[0]).toMatchObject({ precioBaseCentavos: 590_000, limites: [{ metrica: "minutos_voz_mes", limite: 10_000, accion: "cobrar" }], organizaciones: 2 });
  });
});

describe("InMemoryCostosPlanesRepository", () => {
  it("el evento es idempotente por (refTipo, refId) y rechaza categoria invalida / costo negativo / organizacion inexistente", async () => {
    const repo = new InMemoryCostosPlanesRepository();
    repo.seedOrganization("o1", { vertical: "restaurantes", name: "Org", slug: "org" });
    const e = { organizationId: "o1", categoria: "voz" as const, proveedor: "livekit", unidad: "minuto" as const, cantidad: 1, costoMicroUsd: 100, refTipo: "voice_call", refId: "c1" };
    expect((await repo.recordEvent(e)).inserted).toBe(true);
    expect((await repo.recordEvent(e)).inserted).toBe(false);
    await expect(repo.recordEvent({ ...e, refId: "c2", costoMicroUsd: -1 })).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.recordEvent({ ...e, refId: "c3", categoria: "llm" as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.recordEvent({ ...e, organizationId: "nope", refId: "c4" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("solo un superadmin escribe; los no-superadmin leen vacio (contrato 'cero filas')", async () => {
    const repo = new InMemoryCostosPlanesRepository();
    repo.seedOrganization("o1", { vertical: "restaurantes", name: "Org", slug: "org" });
    await expect(repo.setFxRate("intruso", "2026-09-01", 18, "Banxico FIX")).rejects.toBeInstanceOf(SuperadminSeguridadError);
    await expect(repo.upsertPlan("intruso", { id: "plan-x", nombre: "Plan X", vertical: "citas", precioBaseCentavos: 0, precioAsientoCentavos: 0, asientosIncluidos: 0, activo: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await repo.getReport("intruso", null)).rows).toEqual([]);
    expect((await repo.listPlans("intruso")).plans).toEqual([]);
    expect((await repo.listAssignments("intruso")).assignments).toEqual([]);
  });

  it("reporta por mes: un evento de otro mes no cuenta y los minutos en segundos se convierten", async () => {
    const repo = new InMemoryCostosPlanesRepository();
    repo.seedSuperadmin("sa");
    repo.seedOrganization("o1", { vertical: "restaurantes", name: "Org", slug: "org" });
    const base = { organizationId: "o1", categoria: "voz" as const, proveedor: "livekit", costoMicroUsd: 500_000, refTipo: "voice_call" };
    await repo.recordEvent({ ...base, unidad: "segundo", cantidad: 120, refId: "a", occurredAtMs: Date.UTC(2026, 2, 15) });
    await repo.recordEvent({ ...base, unidad: "minuto", cantidad: 9, refId: "b", occurredAtMs: Date.UTC(2026, 3, 2) });
    const marzo = (await repo.getReport("sa", "2026-03-01")).rows[0]!;
    expect(marzo).toMatchObject({ vozMicroUsd: 500_000, minutosVoz: 2, eventosTotal: 1 });
    const abril = (await repo.getReport("sa", "2026-04-20")).rows[0]!;
    expect(abril).toMatchObject({ vozMicroUsd: 500_000, minutosVoz: 9 });
  });

  it("la vertical de un plan con organizaciones asignadas no cambia", async () => {
    const repo = new InMemoryCostosPlanesRepository();
    repo.seedSuperadmin("sa");
    repo.seedOrganization("o1", { vertical: "restaurantes", name: "Org", slug: "org" });
    const sol = await repo.requestAssignment("sa", "o1", "restaurantes-estandar", "Motivo suficientemente largo para la prueba");
    await repo.confirmAssignment("sa", sol.assignment!.id);
    await expect(repo.upsertPlan("sa", { id: "restaurantes-estandar", nombre: "Restaurantes", vertical: "hoteles", precioBaseCentavos: 0, precioAsientoCentavos: 0, asientosIncluidos: 0, activo: true })).rejects.toMatchObject({ code: "conflict" });
  });
});
