// Adaptador minimo de un cliente `pg` a `TenantDbSession` para que los scripts de operador (seed de volumen) usen el MISMO
// repositorio Postgres de la aplicacion. Solo lectura de catalogo/politica: la escritura va por SQL idempotente aparte.
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface PgLikeClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function sesionDesdePg(client: PgLikeClient): TenantDbSession {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}
