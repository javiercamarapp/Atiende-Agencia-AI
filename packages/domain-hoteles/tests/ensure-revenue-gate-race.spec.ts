// Corrector w0 (H-22): `ensureRevenueGate` hacia SELECT + INSERT plano; dos POST
// concurrentes a /revenue/gate (cada uno en su propia transaccion) podian pasar ambos
// el SELECT y el segundo INSERT chocaba con `unique (property_id)` (23505 -> 500).
// Ahora el INSERT lleva `on conflict (property_id) do nothing` y, si no devuelve fila,
// se relee la que gano la carrera. Estos tests instancian el repositorio REAL con una
// sesion falsa que simula la carrera (SELECT vacio, INSERT sin fila, relectura con fila).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresHotelesRepository } from "../src/postgres-repository.ts";

const GATE_ROW = {
  id: "gate-1",
  organization_id: "org-1",
  property_id: "prop-1",
  gate: "shadow",
  shadow_started_at: "2026-09-20T10:00:00.000Z",
  propone_started_at: null,
  autopilot_started_at: null,
  propone_max_variation_pct: "0.10",
  owner_approved_autopilot_at: null,
  updated_by: null,
  updated_at: "2026-09-20T10:00:00.000Z",
  created_at: "2026-09-20T10:00:00.000Z",
};

function sessionWith(selects: Array<unknown[]>, insertRows: unknown[]) {
  const sqls: string[] = [];
  const session: TenantDbSession = {
    async query<T>(sql: string) {
      sqls.push(sql);
      if (/^\s*insert into hoteles\.revenue_engine_gate/i.test(sql)) return { rows: insertRows as T[] };
      if (/from hoteles\.revenue_engine_gate/i.test(sql)) return { rows: (selects.shift() ?? []) as T[] };
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async exec() {},
  };
  return { session, sqls };
}

describe("PostgresHotelesRepository.ensureRevenueGate -- carrera entre dos POST concurrentes", () => {
  it("INSERT usa on conflict (property_id) do nothing", async () => {
    const { session, sqls } = sessionWith([[]], [GATE_ROW]);
    const gate = await new PostgresHotelesRepository(session).ensureRevenueGate("prop-1", "org-1", "user-1");
    expect(gate.id).toBe("gate-1");
    expect(sqls.find((s) => /insert into/i.test(s))).toMatch(/on conflict \(property_id\) do nothing/i);
  });

  it("si otra transaccion gano la carrera (INSERT sin fila), relee y devuelve la fila existente sin lanzar", async () => {
    const { session, sqls } = sessionWith([[], [GATE_ROW]], []);
    const gate = await new PostgresHotelesRepository(session).ensureRevenueGate("prop-1", "org-1", "user-1");
    expect(gate.id).toBe("gate-1");
    expect(gate.gate).toBe("shadow");
    expect(sqls.filter((s) => /^\s*select/i.test(s))).toHaveLength(2);
  });

  it("si ya existe, no inserta", async () => {
    const { session, sqls } = sessionWith([[GATE_ROW]], []);
    await new PostgresHotelesRepository(session).ensureRevenueGate("prop-1", "org-1", "user-1");
    expect(sqls.some((s) => /insert into/i.test(s))).toBe(false);
  });

  it("si el INSERT no devuelve fila y la relectura tampoco encuentra nada, falla con error explicito", async () => {
    const { session } = sessionWith([[], []], []);
    await expect(new PostgresHotelesRepository(session).ensureRevenueGate("prop-1", "org-1", "user-1")).rejects.toThrow(/ensureRevenueGate/);
  });
});
