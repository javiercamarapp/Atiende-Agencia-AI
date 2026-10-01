// Adaptador Postgres de la infra compartida del P&L (SA-29): base sin migrar (42883/42P01/42703) con
// una sesion que reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession), tipado
// de errores de negocio, mapeo de filas y semantica del adaptador en memoria.
import { describe, expect, it } from "vitest";
import { InMemoryPylRepository, PostgresCfoRepository, PostgresPylRepository, SuperadminSeguridadError } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresPylRepository -- base sin migrar", () => {
  it("ambos metodos devuelven not_migrated Y dejan la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_infra_costs_for_superadmin/, respond: () => pgError("42883", "function core.list_infra_costs_for_superadmin(uuid, date, date) does not exist") },
      { match: /superadmin_set_infra_cost/, respond: () => pgError("42883", "function core.superadmin_set_infra_cost(uuid, date, text, bigint, text) does not exist") },
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresPylRepository(session);
    await expect(repo.listInfraCosts("u1", "2026-08-01", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", costs: [] });
    await expect(repo.setInfraCost("u1", "2026-09-01", "Vercel", 1000, null)).resolves.toEqual({ availability: "not_migrated" });
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(2);
  });

  it("MISMA transaccion que la ruta del P&L: 0030 aplicada y 0032 sin aplicar -> la lectura del CFO anterior y la posterior siguen vivas", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_infra_costs_for_superadmin/, respond: () => pgError("42883", "function core.list_infra_costs_for_superadmin(uuid, date, date) does not exist") },
      { match: /list_billing_snapshots_for_superadmin/, respond: () => [] },
    ]);
    const cfo = new PostgresCfoRepository(session);
    const pyl = new PostgresPylRepository(session);
    await expect(cfo.listSnapshots("u1", "2026-08-01", "2026-09-01")).resolves.toMatchObject({ availability: "available" });
    await expect(pyl.listInfraCosts("u1", "2026-08-01", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", costs: [] });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK.
    await expect(cfo.listSnapshots("u1", "2026-08-01", "2026-09-01")).resolves.toMatchObject({ availability: "available" });
  });

  it("tabla inexistente (42P01) tambien cae a not_migrated; un 42883 de tipos NO se enmascara", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /list_infra_costs/, respond: () => pgError("42P01", 'relation "core.infra_cost_monthly" does not exist') }]);
    await expect(new PostgresPylRepository(s1).listInfraCosts("u1", "2026-09-01", "2026-09-01")).resolves.toMatchObject({ availability: "not_migrated" });
    const s2 = new AbortAwareFakeSession([{ match: /list_infra_costs/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresPylRepository(s2).listInfraCosts("u1", "2026-09-01", "2026-09-01")).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresPylRepository -- errores de negocio y mapeo", () => {
  it("42501 -> forbidden y 22023 -> invalid (tipados, no 500)", async () => {
    const forbidden = new AbortAwareFakeSession([{ match: /superadmin_set_infra_cost/, respond: () => pgError("42501", "caller binding invalido") }]);
    await expect(new PostgresPylRepository(forbidden).setInfraCost("u1", "2026-09-01", "Vercel", 1, null)).rejects.toMatchObject({ name: "SuperadminSeguridadError", code: "forbidden" });
    const invalid = new AbortAwareFakeSession([{ match: /superadmin_set_infra_cost/, respond: () => pgError("22023", "el mes no puede ser futuro") }]);
    await expect(new PostgresPylRepository(invalid).setInfraCost("u1", "2099-01-01", "Vercel", 1, null)).rejects.toBeInstanceOf(SuperadminSeguridadError);
  });

  it("convierte bigint en string a numero y deja el mes como texto", async () => {
    const session = new AbortAwareFakeSession([{ match: /list_infra_costs/, respond: () => [{ mes: "2026-03-01", concepto: "Vercel Pro", monto_mxn_centavos: "150000", nota: null }] }]);
    await expect(new PostgresPylRepository(session).listInfraCosts("u1", "2026-03-01", "2026-03-31")).resolves.toEqual({
      availability: "available",
      costs: [{ mes: "2026-03-01", concepto: "Vercel Pro", montoMxnCentavos: 150000, nota: null }],
    });
  });
});

describe("InMemoryPylRepository", () => {
  const NOW = Date.parse("2026-09-30T12:00:00Z");
  it("solo el superadmin lee y escribe; el resto recibe cero filas / forbidden", async () => {
    const repo = new InMemoryPylRepository({ now: () => NOW });
    repo.seedSuperadmin("sa");
    await repo.setInfraCost("sa", "2026-09-15", "Vercel", 1000, null);
    await expect(repo.listInfraCosts("sa", "2026-09-01", "2026-09-01")).resolves.toMatchObject({ costs: [{ mes: "2026-09-01", montoMxnCentavos: 1000 }] });
    await expect(repo.listInfraCosts("otro", "2026-09-01", "2026-09-01")).resolves.toEqual({ availability: "available", costs: [] });
    await expect(repo.setInfraCost("otro", "2026-09-01", "Vercel", 1, null)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("mismo concepto en otras mayusculas actualiza; valida mes futuro, monto y concepto", async () => {
    const repo = new InMemoryPylRepository({ now: () => NOW });
    repo.seedSuperadmin("sa");
    await repo.setInfraCost("sa", "2026-09-01", "Vercel", 1000, null);
    await repo.setInfraCost("sa", "2026-09-01", " vercel ", 2000, "nota");
    const { costs } = await repo.listInfraCosts("sa", "2026-09-01", "2026-09-01");
    expect(costs).toEqual([{ mes: "2026-09-01", concepto: "vercel", montoMxnCentavos: 2000, nota: "nota" }]);
    await expect(repo.setInfraCost("sa", "2026-10-01", "x1", 1, null)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.setInfraCost("sa", "2026-09-01", "x1", -1, null)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.setInfraCost("sa", "2026-09-01", "x1", 1.5, null)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.setInfraCost("sa", "2026-09-01", " ", 1, null)).rejects.toMatchObject({ code: "invalid" });
  });
  it("sin migrar: not_migrated en lectura y escritura", async () => {
    const repo = new InMemoryPylRepository({ migrado: false });
    await expect(repo.listInfraCosts("sa", "2026-09-01", "2026-09-01")).resolves.toEqual({ availability: "not_migrated", costs: [] });
    await expect(repo.setInfraCost("sa", "2026-09-01", "Vercel", 1, null)).resolves.toEqual({ availability: "not_migrated" });
  });
});
