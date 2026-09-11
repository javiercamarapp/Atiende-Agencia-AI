// ManagedPostgresEngine — motor de PRODUCCIÓN contra un Postgres GESTIONADO (Supabase
// u otro proveedor equivalente). Port literal (mismo comportamiento, mismo patrón
// `set local role authenticated` + `set_config('request.jwt.claim.sub', ...)` por
// TRANSACCIÓN) de `openManagedPostgres`/`ManagedPostgresEngine` de
// `hoteles/packages/db/src/engines.ts` (H12b · LAUNCH-009/D-001, ya operado en
// producción para el vertical hoteles standalone) — adaptado aquí a la interfaz
// genérica `TenancyEngine`/`TenantDbSession` de `@atiende/core-tenancy` en vez de al
// `DbClient` propio de ese repo (misma forma exacta: `query<T>(sql, params?)` +
// `exec(sql)`).
//
// Nunca spawnea un servidor propio (a diferencia de un motor embebido de
// desarrollo/pruebas, que este paquete no porta: `InMemoryTenancyEngine` ya cubre
// tests). DELIBERADAMENTE sin superusuario: el rol de conexión (`atiende_app` o el
// que se configure) es el MISMO rol de mínimo privilegio para `admin` y para
// `withAppSession` — nunca una credencial de superusuario embebida en el runtime de
// la API. Las migraciones contra el proyecto gestionado se aplican por fuera
// (`supabase db push`), este motor nunca las corre.
import pg from "pg";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";

export interface ManagedPostgresConfig {
  /** Cadena de conexión completa (la que Supabase muestra en Project Settings →
   *  Database → Connection string). Si se pasa, tiene prioridad sobre host/port/etc. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** `true` (default) exige TLS con verificación de certificado — el patrón estándar
   *  para conectar a Supabase/cualquier Postgres gestionado por red pública. Poner en
   *  `false` únicamente para un túnel local de un solo uso (nunca en producción real). */
  ssl?: boolean;
  poolMax?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  onPoolError?: (err: unknown) => void;
}

export interface ManagedPostgresEngine extends TenancyEngine {
  /** Cliente de mínimo privilegio (mismo rol que `withAppSession`, sin claims de
   *  sesión aplicados) — solo lectura de lo que las políticas RLS ya permiten fuera de
   *  una sesión de usuario (en la práctica: prácticamente nada de negocio). Útil para
   *  health checks (`/health`, `/ready`) contra la base real. */
  admin: TenantDbSession;
  getPoolErrorCount(): number;
  stop(): Promise<void>;
}

function wrapPgClient(client: pg.PoolClient): TenantDbSession {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export function openManagedPostgres(config: ManagedPostgresConfig): ManagedPostgresEngine {
  if (!config.connectionString && !(config.host && config.user && config.password)) {
    throw new Error(
      "openManagedPostgres: falta connectionString o host+user+password — ver ManagedPostgresConfig.",
    );
  }

  const poolConfig: pg.PoolConfig = config.connectionString
    ? { connectionString: config.connectionString }
    : {
        host: config.host,
        port: config.port ?? 5432,
        database: config.database ?? "postgres",
        user: config.user,
        password: config.password,
      };

  const pool = new pg.Pool({
    ...poolConfig,
    max: config.poolMax ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5000,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    ssl: config.ssl === false ? undefined : { rejectUnauthorized: true },
  });

  let poolErrorCount = 0;
  pool.on("error", (err) => {
    // La siguiente pool.connect() simplemente abre una conexión nueva — nunca se
    // relanza — pero sí se cuenta y se deja rastro estructurado en stderr (mismo
    // criterio que `hoteles/packages/db/src/engines.ts`).
    poolErrorCount += 1;
    console.error(
      JSON.stringify({
        level: "error",
        event: "db_pool_error",
        message: err instanceof Error ? err.message : String(err),
        pool_error_count: poolErrorCount,
        timestamp: new Date().toISOString(),
      }),
    );
    config.onPoolError?.(err);
  });

  const admin: TenantDbSession = {
    async query<T>(sql: string, params?: unknown[]) {
      const client = await pool.connect();
      try {
        const res = await client.query(sql, params as unknown[] | undefined);
        return { rows: res.rows as T[] };
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },
  };

  return {
    admin,
    getPoolErrorCount: () => poolErrorCount,
    async withAppSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin;");
        await client.query("set local role authenticated;");
        await client.query("select set_config('request.jwt.claim.sub', $1, true);", [claims.userId ?? ""]);
        const session = wrapPgClient(client);
        const result = await fn(session);
        await client.query("commit;");
        client.release();
        return result;
      } catch (err) {
        await client.query("rollback;").catch(() => undefined);
        client.release(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    async stop() {
      await pool.end();
    },
  };
}
