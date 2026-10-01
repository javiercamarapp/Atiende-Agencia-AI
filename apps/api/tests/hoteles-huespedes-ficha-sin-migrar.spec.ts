// H-27 -- la ficha de huesped contra la base SIN migrar (031/032/038 ausentes: 42P01/42883) por la ruta HTTP COMPLETA, con la
// misma sesion de request que usa dbSession. Una sola transaccion de Postgres: un error la aborta (25P02) y un ROLLBACK TO
// SAVEPOINT destruye los savepoints posteriores. Si las lecturas de la ficha se lanzaran en paralelo, sus SAVEPOINT/consultas/
// RELEASE/ROLLBACK TO se intercalarian y la ficha acabaria en 500. Este doble modela esa pila de savepoints y cede el turno entre
// instrucciones para que el paralelismo se note.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresHuespedesRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

class StrictTxSession implements TenantDbSession {
  aborted = false;
  readonly stack: string[] = [];
  readonly calls: string[] = [];
  constructor(private readonly handlers: readonly { match: RegExp; respond: () => unknown }[]) {}

  private async tick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
  }
  private assertLive(): void {
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
  }
  async exec(sql: string): Promise<void> {
    await this.tick();
    const s = sql.trim().toLowerCase();
    this.calls.push(s);
    const name = s.split(/\s+/).pop()!;
    if (s.startsWith("rollback to savepoint")) {
      const i = this.stack.lastIndexOf(name);
      if (i < 0) throw pgError("3B001", `no such savepoint: ${name}`);
      this.stack.length = i + 1;
      this.aborted = false;
      return;
    }
    this.assertLive();
    if (s.startsWith("savepoint")) {
      this.stack.push(name);
      return;
    }
    if (s.startsWith("release savepoint")) {
      const i = this.stack.lastIndexOf(name);
      if (i < 0) throw pgError("3B001", `no such savepoint: ${name}`);
      this.stack.length = i;
    }
  }
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    await this.tick();
    this.calls.push(sql.trim().toLowerCase().split("\n")[0]!);
    this.assertLive();
    for (const h of this.handlers) {
      if (h.match.test(sql)) {
        const out = h.respond();
        if (out instanceof Error) {
          this.aborted = true;
          throw out;
        }
        return { rows: out as T[] };
      }
    }
    throw new Error(`StrictTxSession: sin regla para -> ${sql}`);
  }
}

describe("GET /huespedes/:guestId/ficha contra la base sin migrar", () => {
  it("responde 200 con consentimientos/identidad/ARCO null y notas no disponibles, y deja la transaccion utilizable", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const session = new StrictTxSession([
      { match: /rm\.code as room_code/i, respond: () => [] },
      { match: /from hoteles\.contacto_no_operativo/i, respond: () => pgError("42P01", "no existe contacto_no_operativo") },
      { match: /from hoteles\.identity_consent/i, respond: () => pgError("42P01", "no existe identity_consent") },
      { match: /from hoteles\.identity_vault/i, respond: () => pgError("42P01", "no existe identity_vault") },
      { match: /guest_has_arco_restriction/i, respond: () => pgError("42883", "function hoteles.guest_has_arco_restriction(uuid) does not exist") },
      { match: /from hoteles\.guest_note/i, respond: () => pgError("42P01", "no existe guest_note") },
    ]);
    const app = buildApp({ ...ctx.deps, hotelesHuespedesRepo: () => new PostgresHuespedesRepository(session) });
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes/${ctx.guestId}/ficha`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const f = (await res.json()) as { consentimientos: unknown; identidad: unknown; arco: unknown; notas: { disponible: boolean; items: unknown[] }; contactos: unknown[] };
    expect(f.consentimientos).toBeNull();
    expect(f.identidad).toBeNull();
    expect(f.arco).toBeNull();
    expect(f.notas).toEqual({ disponible: false, items: [] });
    expect(f.contactos).toEqual([]);
    expect(session.aborted).toBe(false);
    expect(session.stack).toEqual([]);
  });
});
