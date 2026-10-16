// P0 (PM, cuenta real): 6+ mensajes simultaneos al webhook de WhatsApp devolvian HTTP 500 tras 10 s (10 de 10 con 10 concurrentes).
// CAUSA RAIZ: cada turno retiene varias conexiones del MISMO pool durante la espera del LLM (webhook = nivel 0, turn handler =
// nivel 1, presupuesto/uso del gateway = nivel 2) y con N turnos el pool se llena de niveles 0/1 que esperan al nivel que los
// desbloquearia (interbloqueo hasta `connectionTimeoutMillis`). Aqui se modela un pool ACOTADO como el de `pg` (espera en fila y
// rechaza tras el timeout de conexion) y se comprueba que la admision por nivel de `ManagedPostgresEngine` lo evita.
import { describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
  max: 10,
  active: 0,
  peak: 0,
  timeouts: 0,
  waiters: [] as Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }>,
}));

vi.mock("pg", () => {
  class FakePoolClient {
    private released = false;
    async query(sql: string): Promise<{ rows: unknown[]; command: string }> {
      const n = sql.trim().toLowerCase();
      if (n.startsWith("commit")) return { rows: [], command: "COMMIT" };
      if (n.startsWith("rollback")) return { rows: [], command: "ROLLBACK" };
      return { rows: [], command: "SELECT" };
    }
    release(): void {
      if (this.released) return;
      this.released = true;
      pool.active -= 1;
      const next = pool.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
      }
    }
  }
  class FakePool {
    private readonly connectionTimeoutMillis: number;
    constructor(cfg: { max: number; connectionTimeoutMillis: number }) {
      pool.max = cfg.max;
      this.connectionTimeoutMillis = cfg.connectionTimeoutMillis;
    }
    connect(): Promise<FakePoolClient> {
      const take = () => {
        pool.active += 1;
        pool.peak = Math.max(pool.peak, pool.active);
        return new FakePoolClient();
      };
      if (pool.active < pool.max) return Promise.resolve(take());
      return new Promise((resolve, reject) => {
        const entry = {
          grant: () => resolve(take()),
          timer: setTimeout(() => {
            const i = pool.waiters.indexOf(entry);
            if (i >= 0) pool.waiters.splice(i, 1);
            pool.timeouts += 1;
            reject(new Error("timeout exceeded when trying to connect"));
          }, this.connectionTimeoutMillis),
        };
        pool.waiters.push(entry);
      });
    }
    on(): void {}
    async end(): Promise<void> {}
  }
  return { default: { Pool: FakePool } };
});

const { openManagedPostgres, DatabaseBusyError, admissionLimits } = await import("../src/managed-postgres-engine.ts");

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function reiniciarPool(): void {
  pool.active = 0;
  pool.peak = 0;
  pool.timeouts = 0;
  pool.waiters.length = 0;
}

/** Un turno como el de produccion: sesion de webhook (0) -> sesion del turn handler (1) que "espera al LLM" -> sesion corta de presupuesto (2). */
async function turno(engine: ReturnType<typeof openManagedPostgres>, esperaLlmMs: number): Promise<string> {
  return engine.withAppSession({ userId: null }, async () =>
    engine.withAppSession({ userId: null }, async () => {
      await dormir(esperaLlmMs);
      await engine.withAppSession({ userId: null }, async () => undefined);
      await engine.withAppSession({ userId: null }, async () => undefined);
      return "ok";
    }),
  );
}

describe("admissionLimits", () => {
  it.each([3, 4, 5, 8, 10, 20, 50, 100])("poolMax=%i: nivel 0 + nivel 1 dejan al menos una conexion al nivel 2 (hoja)", (poolMax) => {
    const { outer, inner } = admissionLimits(poolMax);
    expect(outer).toBeGreaterThanOrEqual(1);
    expect(inner).toBeGreaterThanOrEqual(1);
    expect(outer + inner).toBeLessThan(poolMax);
  });

  it("con el pool por omision de 10: 5 sesiones de nivel 0 y 4 de nivel 1 (capacidad de 4 turnos simultaneos)", () => {
    expect(admissionLimits(10)).toEqual({ outer: 5, inner: 4 });
  });

  it.each([0, 1, 2, 2.5, Number.NaN])("poolMax=%s: falla explicito (no queda conexion para el nivel 2)", (poolMax) => {
    expect(() => admissionLimits(poolMax)).toThrow(/poolMax debe ser un entero >= 3/);
  });
});

describe("ManagedPostgresEngine.withAppSession -- admision por nivel (P0 de 6+ turnos simultaneos)", () => {
  it("10 turnos simultaneos con sesiones anidadas terminan TODOS bien, sin ningun timeout del pool y sin pasar de poolMax", async () => {
    reiniciarPool();
    const engine = openManagedPostgres({ connectionString: "postgres://fake", poolMax: 10, connectionTimeoutMs: 60, admissionTimeoutMs: 5_000 });
    const resultados = await Promise.all(Array.from({ length: 10 }, () => turno(engine, 15)));
    expect(resultados.every((r) => r === "ok")).toBe(true);
    expect(pool.timeouts).toBe(0);
    expect(pool.peak).toBeLessThanOrEqual(10);
    expect(pool.active).toBe(0);
  });

  it("el escenario del P0 sin admision SI interbloquea (control: pool acotado + sesiones anidadas directas)", async () => {
    reiniciarPool();
    // Mismo patron SIN el motor: cada "turno" toma 2 conexiones de nivel 0/1 y luego pide una tercera para el presupuesto.
    const { default: pg } = await import("pg");
    const p = new pg.Pool({ max: 10, connectionTimeoutMillis: 40 } as never);
    const turnoCrudo = async () => {
      const a = await p.connect();
      const b = await p.connect();
      await dormir(10);
      const c = await p.connect();
      c.release();
      b.release();
      a.release();
    };
    const res = await Promise.allSettled(Array.from({ length: 6 }, turnoCrudo));
    expect(res.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
    expect(pool.timeouts).toBeGreaterThan(0);
  });

  it("mas turnos que la capacidad hacen fila: nunca mas de `inner` sesiones de nivel 1 a la vez, y todos terminan", async () => {
    reiniciarPool();
    const engine = openManagedPostgres({ connectionString: "postgres://fake", poolMax: 10, connectionTimeoutMs: 60, admissionTimeoutMs: 5_000 });
    let nivel1 = 0;
    let picoNivel1 = 0;
    const turnoMedido = () =>
      engine.withAppSession({ userId: null }, async () =>
        engine.withAppSession({ userId: null }, async () => {
          nivel1 += 1;
          picoNivel1 = Math.max(picoNivel1, nivel1);
          await dormir(20);
          nivel1 -= 1;
          return "ok";
        }),
      );
    const resultados = await Promise.all(Array.from({ length: 20 }, turnoMedido));
    expect(resultados).toHaveLength(20);
    expect(picoNivel1).toBeLessThanOrEqual(admissionLimits(10).inner);
    expect(pool.timeouts).toBe(0);
  });

  it("sobrecarga: pasado el tiempo de admision lanza DatabaseBusyError (reintentable) y NO deja el cupo tomado", async () => {
    reiniciarPool();
    const engine = openManagedPostgres({ connectionString: "postgres://fake", poolMax: 4, connectionTimeoutMs: 60, admissionTimeoutMs: 30 });
    const { outer } = admissionLimits(4);
    let soltar!: () => void;
    const retenida = new Promise<void>((r) => (soltar = r));
    const ocupadas = Array.from({ length: outer }, () => engine.withAppSession({ userId: null }, async () => retenida));
    await dormir(5);
    const inicio = Date.now();
    await expect(engine.withAppSession({ userId: null }, async () => "no debe correr")).rejects.toMatchObject({ code: "DB_BUSY", depth: 0 });
    await expect(engine.withAppSession({ userId: null }, async () => "no debe correr")).rejects.toBeInstanceOf(DatabaseBusyError);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(25);
    soltar();
    await Promise.all(ocupadas);
    // Tras liberar, el motor vuelve a admitir sesiones: el timeout no filtro cupos.
    await expect(engine.withAppSession({ userId: null }, async () => "ok")).resolves.toBe("ok");
    expect(pool.active).toBe(0);
  });

  it("una sesion que lanza libera su cupo de admision (el siguiente turno de la fila avanza)", async () => {
    reiniciarPool();
    const engine = openManagedPostgres({ connectionString: "postgres://fake", poolMax: 3, connectionTimeoutMs: 60, admissionTimeoutMs: 500 });
    const fallidas = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        engine.withAppSession({ userId: null }, async () => {
          await dormir(5);
          if (i % 2 === 0) throw new Error(`falla ${i}`);
          return i;
        }),
      ),
    );
    expect(fallidas.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(fallidas.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(pool.active).toBe(0);
    await expect(engine.withAppSession({ userId: null }, async () => "ok")).resolves.toBe("ok");
  });
});
