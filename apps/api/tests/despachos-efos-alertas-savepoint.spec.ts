// D-04: GET /efos/alertas ejecuta dos metodos con SAVEPOINT sobre la MISMA sesion de request.
// Este doble modela una conexion Postgres real: pila de savepoints (RELEASE de uno libera tambien
// los posteriores; RELEASE/ROLLBACK TO de uno inexistente -> 3B001), estado abortado (25P02) y
// cede el turno en cada llamada para que cualquier ejecucion concurrente se intercale.
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

class StrictSavepointSession implements TenantDbSession {
  private stack: string[] = [];
  private aborted = false;
  readonly calls: string[] = [];
  constructor(private readonly migrated: boolean) {}

  private async tick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    await this.tick();
    this.calls.push(sql.trim().split("\n")[0]!.toLowerCase());
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    if (!this.migrated) {
      this.aborted = true;
      throw pgError("42883", "function despachos.efos_estado() does not exist");
    }
    if (/efos_invoices_afectados/i.test(sql)) return { rows: [] as T[] };
    return { rows: [{ out_periodo: "2026-07", out_filas: 4, out_ingestado_en: "2026-07-01 10:00:00+00" }] as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.tick();
    const s = sql.trim().toLowerCase();
    this.calls.push(s);
    const name = s.split(/\s+/).pop()!;
    if (s.startsWith("rollback to savepoint")) {
      const i = this.stack.indexOf(name);
      if (i < 0) throw pgError("3B001", `savepoint "${name}" does not exist`);
      this.stack = this.stack.slice(0, i + 1);
      this.aborted = false;
      return;
    }
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    if (s.startsWith("savepoint")) {
      this.stack.push(name);
      return;
    }
    if (s.startsWith("release savepoint")) {
      const i = this.stack.indexOf(name);
      if (i < 0) throw pgError("3B001", `savepoint "${name}" does not exist`);
      this.stack = this.stack.slice(0, i);
    }
  }

  get openSavepoints(): number {
    return this.stack.length;
  }
}

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

async function getAlertas(session: StrictSavepointSession) {
  const deps = { ...ctx.deps, despachosRepo: (_db: TenantDbSession) => new PostgresDespachosRepository(session) };
  return buildApp(deps).request(`/despachos/${ctx.propertyId}/efos/alertas`, authedJson(ctx.staff.auditor.token));
}

describe("GET /despachos/:propertyId/efos/alertas sobre una sola conexion con SAVEPOINT", () => {
  it("base migrada: 200 y savepoints anidados sin intercalar (sin 3B001)", async () => {
    const session = new StrictSavepointSession(true);
    const res = await getAlertas(session);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lista: { estado: "disponible", periodo: "2026-07" }, estado: "disponible", alertas: [] });
    expect(session.openSavepoints).toBe(0);
    // Un savepoint se libera antes de abrir el siguiente.
    const sp = session.calls.filter((c) => c.includes("savepoint"));
    expect(sp.indexOf("release savepoint sp_despachos_efos_estado")).toBeLessThan(sp.indexOf("savepoint sp_despachos_efos_afectados"));
  });

  it("base SIN migrar (42883): 200 con no_disponible en ambos y sesion no abortada", async () => {
    const session = new StrictSavepointSession(false);
    const res = await getAlertas(session);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lista: { estado: "no_disponible" }, estado: "no_disponible", alertas: [] });
    expect(session.openSavepoints).toBe(0);
  });
});
