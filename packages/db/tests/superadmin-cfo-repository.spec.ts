// Adaptador Postgres del dashboard CFO: base sin migrar (42883/42P01/42703) con una sesion que
// reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession), mapeo de filas
// (bigint/numeric llegan como string del driver) y semantica del adaptador en memoria.
import { describe, expect, it } from "vitest";
import { InMemoryCfoRepository, PostgresCfoRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = (name: string) => pgError("42883", `function core.${name}(uuid, date) does not exist`);
const FUNCIONES = ["get_cfo_dashboard_for_superadmin", "list_billing_snapshots_for_superadmin", "get_cfo_alert_inputs_for_system", "snapshot_billing_monthly_for_system"];

describe("PostgresCfoRepository -- base sin migrar", () => {
  it("cada metodo devuelve not_migrated con datos vacios Y deja la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      ...FUNCIONES.map((f) => ({ match: new RegExp(f), respond: () => missingFn(f) })),
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresCfoRepository(session);
    await expect(repo.getDashboardRows("u1", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", rows: [] });
    await expect(repo.listSnapshots("u1", "2026-08-01", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", snapshots: [] });
    await expect(repo.getAlertInputsForSystem(null)).resolves.toEqual({ availability: "not_migrated", rows: [] });
    await expect(repo.snapshotForSystem()).resolves.toEqual({ availability: "not_migrated", filas: null });
    // Si algun metodo hubiera dejado la transaccion abortada, esta consulta lanzaria 25P02.
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(4);
  });

  it("un 42883 de tipos (bug real, no migracion pendiente) NO se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_cfo_dashboard_for_superadmin/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresCfoRepository(session).getDashboardRows("u1", null)).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresCfoRepository -- mapeo", () => {
  it("convierte bigint/numeric en string a numero y fechas a texto", async () => {
    const fila = {
      organization_id: "o1", organization_name: "Org", organization_slug: "org", vertical: "restaurantes", org_status: "active",
      plan_id: "restaurantes-estandar", plan_nombre: "Plan", precio_base_mxn_centavos: "0", precio_asiento_mxn_centavos: "79900", asientos_incluidos: 1,
      billing_status: "pago_pendiente", billing_seats: 2, billing_period_end: "2026-09-01T00:00:00.000Z", sucursales_activas: 3,
      llm_micro_usd: "6000000", voz_micro_usd: "3000000", whatsapp_micro_usd: "400000", telefonia_micro_usd: "0", otros_micro_usd: "0",
      eventos_total: "3", eventos_estimados: "2", minutos_voz: "5.000", mensajes: "100", llm_cap_micro_usd: "100000000", llm_alert_pct: "80",
      limites: [{ metrica: "minutos_voz_mes", limite: "3", accion: "avisar" }], mxn_por_usd: "18.0000", fx_fecha: "2026-03-10", fx_fuente: "Banxico FIX",
    };
    const session = new AbortAwareFakeSession([{ match: /get_cfo_dashboard_for_superadmin/, respond: () => [fila] }]);
    const { availability, rows } = await new PostgresCfoRepository(session).getDashboardRows("u1", "2026-03-01");
    expect(availability).toBe("available");
    expect(rows[0]).toMatchObject({
      organizationId: "o1", llmMicroUsd: 6_000_000, vozMicroUsd: 3_000_000, minutosVoz: 5, mensajes: 100, billingPeriodEndMs: Date.parse("2026-09-01T00:00:00Z"),
      limites: [{ metrica: "minutos_voz_mes", limite: 3, accion: "avisar" }], mxnPorUsd: 18, fxFecha: "2026-03-10", fxFuente: "Banxico FIX",
    });
  });

  it("organizacion sin cobranza ni tipo de cambio: nulls, no ceros", async () => {
    const fila = {
      organization_id: "o2", organization_name: "Org2", organization_slug: "org2", vertical: "citas", org_status: "active",
      plan_id: null, plan_nombre: null, precio_base_mxn_centavos: null, precio_asiento_mxn_centavos: null, asientos_incluidos: null,
      billing_status: null, billing_seats: null, billing_period_end: null, sucursales_activas: 0,
      llm_micro_usd: 0, voz_micro_usd: 0, whatsapp_micro_usd: 0, telefonia_micro_usd: 0, otros_micro_usd: 0,
      eventos_total: 0, eventos_estimados: 0, minutos_voz: 0, mensajes: 0, llm_cap_micro_usd: 100000000, llm_alert_pct: 80,
      limites: null, mxn_por_usd: null, fx_fecha: null, fx_fuente: null,
    };
    const session = new AbortAwareFakeSession([{ match: /get_cfo_alert_inputs_for_system/, respond: () => [fila] }]);
    const { rows } = await new PostgresCfoRepository(session).getAlertInputsForSystem("2026-03-01");
    expect(rows[0]).toMatchObject({ billingPeriodEndMs: null, limites: [], mxnPorUsd: null, fxFecha: null, planId: null });
  });

  it("snapshots: centavos a numero, null se conserva con su razon", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_billing_snapshots_for_superadmin/, respond: () => [
        { organization_id: "o1", mes: "2026-08-01", vertical: "citas", org_status: "active", plan_id: "citas-estandar", billing_status: "activa", mrr_mxn_centavos: "59900", mrr_razon: null },
        { organization_id: "o2", mes: "2026-08-01", vertical: "rentas", org_status: "active", plan_id: null, billing_status: null, mrr_mxn_centavos: null, mrr_razon: "sin_plan" },
      ] },
    ]);
    const { snapshots } = await new PostgresCfoRepository(session).listSnapshots("u1", "2026-08-01", "2026-08-01");
    expect(snapshots.map((s) => [s.organizationId, s.mrrCentavos, s.mrrRazon])).toEqual([["o1", 59900, null], ["o2", null, "sin_plan"]]);
  });
});

describe("InMemoryCfoRepository", () => {
  it("un no-superadmin recibe cero filas; el sistema lee todo", async () => {
    const repo = new InMemoryCfoRepository();
    repo.seedSuperadmin("sa");
    repo.seedRows([{ organizationId: "o1" } as never]);
    expect((await repo.getDashboardRows("otro", null)).rows).toEqual([]);
    expect((await repo.getDashboardRows("sa", null)).rows).toHaveLength(1);
    expect((await repo.getAlertInputsForSystem(null)).rows).toHaveLength(1);
  });
});
