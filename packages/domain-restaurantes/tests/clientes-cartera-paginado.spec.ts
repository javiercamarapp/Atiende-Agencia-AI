// La funcion SQL restaurantes.clientes_cartera (054) rechaza p_limit > 200 con 22023. La exportacion de clientes pide paginas de 500:
// `listCustomers` debe partirlas en bloques <= 200 y recomponer la pagina, sin lanzar 22023 (que no es un error recuperable).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { TenantDbSession } from "@atiende/core-tenancy";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const TOTAL = 650;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Doble de la funcion SQL: mismos topes y keyset por id que la migracion 054 (el doble generico no expone los parametros). */
function sesionCartera(calls: number[]): TenantDbSession {
  return {
    async exec() {},
    async query<T>(_sql: string, params: unknown[] = []) {
      const limit = params[6] as number;
      const cursor = params[7] as string | null;
      if (limit < 1 || limit > 200) {
        const err = new Error("clientes_cartera: limite invalido") as Error & { code: string };
        err.code = "22023";
        throw err;
      }
      calls.push(limit);
      const desde = cursor ? Number(cursor.slice(-12)) : 0;
      const rows = [];
      for (let n = desde + 1; n <= Math.min(TOTAL, desde + limit); n++) {
        rows.push({ customer_id: uuid(n), phone: `+5215500${String(n).padStart(6, "0")}`, name: `C${n}`, order_count: 1, last_order_at: null, tier: null });
      }
      return { rows: rows as T[] };
    },
  } as TenantDbSession;
}

describe("listCustomers pagina clientes_cartera en bloques de <= 200 (tope SQL)", () => {
  it("limit 500 (exportaciones): no lanza 22023, devuelve 500 y cursor", async () => {
    const calls: number[] = [];
    const repo = new PostgresRestaurantesRepository(sesionCartera(calls));
    const page = await repo.listCustomers(ORG, { limit: 500 });
    expect(page.customers).toHaveLength(500);
    expect(page.nextCursor).toBe(uuid(500));
    expect(calls).toEqual([200, 200, 101]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(200);
  });

  it("segunda pagina desde el cursor devuelve el resto y termina sin cursor", async () => {
    const repo = new PostgresRestaurantesRepository(sesionCartera([]));
    const page = await repo.listCustomers(ORG, { limit: 500, cursor: uuid(500) });
    expect(page.customers).toHaveLength(150);
    expect(page.nextCursor).toBeNull();
  });

  it("limit chico: una sola llamada", async () => {
    const calls: number[] = [];
    const page = await new PostgresRestaurantesRepository(sesionCartera(calls)).listCustomers(ORG, { limit: 50 });
    expect(page.customers).toHaveLength(50);
    expect(calls).toEqual([51]);
  });
});
