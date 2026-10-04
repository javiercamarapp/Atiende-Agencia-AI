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
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";

/**
 * P0 de disponibilidad (PM, cuenta real): no hubo conexion del pool disponible para abrir la sesion dentro del tiempo de
 * admision. Es una condicion de SOBRECARGA transitoria (reintentable), no un fallo de la base: la API la traduce a 503 con
 * `Retry-After` (ver `apps/api/src/app.ts`) en vez de dejar que el request espere hasta el timeout del pool y devuelva 500.
 */
export class DatabaseBusyError extends Error {
  readonly code = "DB_BUSY";
  constructor(readonly depth: number, readonly waitedMs: number) {
    super(`withAppSession: sin conexion disponible tras ${waitedMs} ms (nivel ${depth}); el pool esta saturado por sesiones en curso`);
    this.name = "DatabaseBusyError";
  }
}

/** Semaforo FIFO con espera acotada (admision de sesiones por nivel de anidamiento). */
class AdmissionGate {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];
  constructor(private readonly limit: number) {}

  acquire(timeoutMs: number, depth: number): Promise<() => void> {
    const release = () => {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        this.active += 1;
        next.grant();
      }
    };
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve, reject) => {
      const startedAt = Date.now();
      const waiter = { grant: () => { clearTimeout(timer); resolve(release); } };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new DatabaseBusyError(depth, Date.now() - startedAt));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

/**
 * Limites de admision por nivel de anidamiento para un pool de `poolMax` conexiones.
 *
 * CAUSA RAIZ del P0 (6+ mensajes simultaneos al webhook de WhatsApp -> HTTP 500 tras 10 s; 10 de 10 con 10 concurrentes): cada
 * turno del agente retiene VARIAS conexiones del MISMO pool durante toda la espera del LLM -- la sesion del webhook (nivel 0), la
 * sesion propia del turn handler (nivel 1, ver `buildRealRestaurantesTurnHandler`) y, por llamada al gateway de LLM, sesiones
 * cortas de presupuesto/uso/bitacora (nivel 2, hojas). Con N turnos en curso el pool se llena de sesiones de nivel 0 y 1 y las de
 * nivel 1 y 2 esperan una conexion que solo liberaria quien las espera: interbloqueo hasta `connectionTimeoutMillis` (5 s), dos
 * veces por turno -> 500 a los 10 s. Medido en un arnes con la API real y Postgres real (pool de 10; la tabla de la PR #412 usa un LLM simulado de 600 ms,
 * esta primera medicion usaba 3 s: son corridas distintas con el mismo patron): 6 concurrentes -> parte con 500; 10 concurrentes ->
 * todas con 500; picos de 10 conexiones activas.
 *
 * REMEDIO (sin interbloqueo SIEMPRE QUE el nivel 2 sea hoja y el contexto de AsyncLocalStorage se propague; ninguna de las dos cosas
 * se impone en codigo, solo se registra un warn si la profundidad llega a 3): el nivel 0 no puede ocupar mas de `outer` conexiones y el nivel 1 mas de `inner`,
 * con `outer + inner < poolMax`: siempre queda al menos una conexion para el nivel 2 (hoja: no espera a nadie, termina en
 * milisegundos), asi que todo nivel 1 termina, luego todo nivel 0. Lo que excede los limites hace FILA con espera acotada
 * (`DatabaseBusyError` -> 503 reintentable) en vez de interbloquearse. La capacidad de turnos simultaneos pasa a ser `inner`
 * (4 con el pool por omision de 10): un `poolMax` mayor la sube de forma proporcional.
 *
 * EFECTO GLOBAL: la admision aplica a TODAS las verticales y rutas, no solo a WhatsApp. Con el pool por omision de 10, el trafico de
 * nivel 0 (panel, storefront, hoteles, citas, crons) queda limitado a `outer` = 5 sesiones simultaneas por instancia (antes 10); lo
 * que excede espera hasta el timeout de admision y luego recibe 503. Vigilar la metrica `apps_api_db_ocupada`.
 *
 * Exige `poolMax >= 3` (nivel 0 + nivel 1 + una conexion libre para el nivel 2); con menos lanza en vez de admitir un limite que
 * dejaria al nivel 2 sin conexion.
 */
export function admissionLimits(poolMax: number): { outer: number; inner: number } {
  if (!Number.isInteger(poolMax) || poolMax < 3) {
    throw new Error(`admissionLimits: poolMax debe ser un entero >= 3 (recibido ${poolMax}); con menos no queda conexion para el nivel 2`);
  }
  const inner = Math.max(1, Math.floor((poolMax - 1) / 2));
  const outer = Math.max(1, poolMax - 1 - inner);
  return { outer, inner };
}

const sessionDepth = new AsyncLocalStorage<number>();

/**
 * Hallazgo CRÍTICO de auditoría (a1, r3) — defensa de último recurso EN EL MOTOR.
 * En Postgres real, un `COMMIT` sobre una transacción ABORTADA (cualquier error
 * dentro del bloque que un `catch` haya atrapado sin `SAVEPOINT`, ver `../savepoint-
 * fallback.ts` para el mecanismo completo) NO lanza error: el servidor lo trata como
 * un `ROLLBACK` implícito y devuelve ese mismo tag de comando (`"ROLLBACK"`, nunca
 * `"COMMIT"`) — sin esta defensa, `withAppSession` de abajo devolvería `result`
 * normalmente y el handler HTTP respondería 200/201 con TODO lo escrito en el
 * request revertido en silencio.
 */
export class AbortedTransactionCommitError extends Error {
  constructor(commandTag: string) {
    super(
      `withAppSession: la transacción terminó ABORTADA pero fn() no lanzó ningún error -- ` +
        `COMMIT devolvió el tag de comando "${commandTag}" en vez de "COMMIT" (Postgres trata un ` +
        `COMMIT sobre una transacción abortada como ROLLBACK implícito, sin lanzar error). Esto ` +
        `significa que algún catch dentro de fn() atrapó un error de Postgres SIN usar ` +
        `runWithSavepointFallback (@atiende/db) -- revisa los catches de SQLSTATE (42883/42P01/` +
        `42703/23514/...) en el camino que se acaba de ejecutar; sin SAVEPOINT, este request habría ` +
        `respondido 200/201 con todo revertido en silencio.`,
    );
    this.name = "AbortedTransactionCommitError";
  }
}

export interface ManagedPostgresConfig {
  /** Cadena de conexión completa (la que Supabase muestra en Project Settings →
   *  Database → Connection string). Si se pasa, tiene prioridad sobre host/port/etc. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** `true` (default) exige TLS pero SIN validar la cadena de certificado completa
   *  (`rejectUnauthorized: false`) — verificado en producción real: el pooler de
   *  Supabase (Supavisor, tanto "Session" como "Transaction") presenta un certificado
   *  autofirmado/sin cadena completa por diseño (multiplexa muchos proyectos detrás de
   *  un solo proceso), así que `rejectUnauthorized: true` falla SIEMPRE contra él con
   *  `SELF_SIGNED_CERT_IN_CHAIN` -- no es una conexión mal configurada, es el
   *  comportamiento documentado del pooler. La conexión sigue siendo TLS real
   *  (cifrado en tránsito genuino), solo no se valida el certificado del servidor
   *  contra una CA pública -- mismo patrón que la documentación/tutoriales oficiales
   *  de Supabase recomiendan para conexiones serverless a través del pooler. Poner en
   *  `false` (deshabilita TLS por completo) únicamente para un túnel local de un solo
   *  uso (nunca en producción real). */
  ssl?: boolean;
  poolMax?: number;
  /** Espera maxima (ms) por un cupo de admision antes de lanzar `DatabaseBusyError`. Default 10 000: cabe en `maxDuration` (30 s) junto a un turno. */
  admissionTimeoutMs?: number;
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

  const poolMax = config.poolMax ?? 10;
  const limits = admissionLimits(poolMax);
  const admissionTimeoutMs = config.admissionTimeoutMs ?? 10_000;
  const outerGate = new AdmissionGate(limits.outer);
  const innerGate = new AdmissionGate(limits.inner);

  const pool = new pg.Pool({
    ...poolConfig,
    max: poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5000,
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    ssl: config.ssl === false ? undefined : { rejectUnauthorized: false },
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
      // Admision por nivel de anidamiento (ver `admissionLimits`): nivel 0 y 1 acotados, nivel >= 2 solo por el pool.
      const depth = sessionDepth.getStore() ?? 0;
      if (depth >= 3) {
        // Invariante de `admissionLimits`: el nivel 2 es hoja. Una cadena de 4 sesiones anidadas podria interbloquear el pool.
        console.warn(JSON.stringify({ level: "warn", event: "db_session_anidada_profunda", depth: depth + 1, timestamp: new Date().toISOString() }));
      }
      const gate = depth === 0 ? outerGate : depth === 1 ? innerGate : null;
      const releaseGate = gate ? await gate.acquire(admissionTimeoutMs, depth) : null;
      try {
        return await sessionDepth.run(depth + 1, () => runSession(claims, fn));
      } finally {
        releaseGate?.();
      }
    },
    async stop() {
      await pool.end();
    },
  };

  async function runSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin;");
      await client.query("set local role authenticated;");
      await client.query("select set_config('request.jwt.claim.sub', $1, true);", [claims.userId ?? ""]);
      const session = wrapPgClient(client);
      const result = await fn(session);
      const commitResult = await client.query("commit;");
      client.release();
      if (commitResult.command !== "COMMIT") {
        // La transacción ya terminó (Postgres ya hizo el ROLLBACK implícito al
        // procesar el COMMIT) -- no queda nada que revertir ni un cliente que
        // liberar de nuevo, por eso este throw vive DENTRO del try, después de
        // `client.release()`, y el catch de abajo lo distingue explícitamente
        // para no repetir `rollback;`/`release` sobre un cliente ya devuelto al
        // pool.
        throw new AbortedTransactionCommitError(commitResult.command);
      }
      return result;
    } catch (err) {
      if (err instanceof AbortedTransactionCommitError) throw err;
      await client.query("rollback;").catch(() => undefined);
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
}
