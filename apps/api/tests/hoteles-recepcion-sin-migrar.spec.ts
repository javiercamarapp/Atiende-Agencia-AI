// H-28 -- el tablero /recepcion contra la base SIN migrar el housekeeping completo (033 ausente: 42P01) por la ruta HTTP
// COMPLETA, con UNA sola sesion transaccional compartida entre `getBoard` (que degrada con SAVEPOINT/ROLLBACK TO) y `listRooms`.
// Una sola transaccion de Postgres: un error la aborta (25P02) y un ROLLBACK TO SAVEPOINT destruye los savepoints posteriores.
// Si el handler lanzara ambas lecturas en paralelo (Promise.all), el SELECT de listRooms se intercalaria entre SAVEPOINT y
// ROLLBACK TO y la ruta acabaria en 500. Este doble modela esa pila y cede el turno entre instrucciones para que se note.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRecepcionRepository, PostgresHotelesRepository, PostgresHousekeepingRepository } from "@atiende/domain-hoteles";
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
  constructor(private readonly handlers: readonly { match: RegExp; respond: () => unknown; ticks?: number }[]) {}

  private async tick(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
  }
  private assertLive(): void {
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
  }
  async exec(sql: string): Promise<void> {
    await this.tick();
    const s = sql.trim().toLowerCase();
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
    const h = this.handlers.find((x) => x.match.test(sql));
    // Cada consulta cede el turno `ticks` veces (red/planificador reales): las lecturas lentas se intercalan con las rapidas.
    for (let i = 0; i < (h?.ticks ?? 1); i++) await this.tick();
    this.assertLive();
    {
      if (h) {
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

describe("GET /hoteles/:propertyId/recepcion contra la base sin migrar (033 ausente)", () => {
  it("responde 200 degradado (tareasDisponibles=false) y deja la transaccion utilizable, sin intercalar listRooms con el SAVEPOINT", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const roomId = "00000000-0000-4000-8000-0000000000a1";
    const session = new StrictTxSession([
      // tablero completo (join a housekeeping_task): la migracion 033 no existe.
      { match: /housekeeping_task/i, respond: () => pgError("42P01", "no existe housekeeping_task") },
      // degradado del tablero (sin tareas ni fuera de servicio).
      { match: /from hoteles\.room r join hoteles\.room_type rt/i, respond: () => [{ room_id: roomId, code: "101", room_status: "disponible", room_type_name: "Doble" }] },
      // listRooms.
      { match: /select id, code, status, room_type_id from hoteles\.room where property_id/i, respond: () => [{ id: roomId, code: "101", status: "disponible", room_type_id: ctx.roomTypeId }], ticks: 2 },
    ]);
    const recep = new InMemoryRecepcionRepository(ctx.hotelesRepo, {});
    const app = buildApp({
      ...ctx.deps,
      hotelesHousekeepingRepo: () => new PostgresHousekeepingRepository(session),
      hotelesRecepcionRepo: () => recep,
      hotelesRepo: () => new PostgresHotelesRepository(session),
    });
    const res = await app.request(`/hoteles/${ctx.propertyId}/recepcion?fecha=2026-12-02`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareasDisponibles: boolean; rack: { roomId: string; tipoHabitacionId: string | null; limpieza: unknown }[] };
    expect(body.tareasDisponibles).toBe(false);
    expect(body.rack).toHaveLength(1);
    expect(body.rack[0]).toMatchObject({ roomId, tipoHabitacionId: ctx.roomTypeId, limpieza: null });
    expect(session.aborted).toBe(false);
    expect(session.stack).toEqual([]);
  });
});
