// Copiloto de superadmin (CHAT-16): varias fuentes de SESION dentro de una misma herramienta. La sesion del turno es UNA transaccion y el cliente pg encola en
// orden FIFO: si dos SAVEPOINT se lanzan a la vez (Promise.all) se intercalan SP A, SP B, QA, QB, RELEASE A (destruye tambien B), RELEASE B (3B001) y la
// transaccion queda abortada (25P02 para todo lo demas, COMMIT = ROLLBACK). Este doble modela esa pila de savepoints y ese orden; `AbortAwareFakeSession` solo
// modela el estado abortado y por eso no detecta el defecto.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../src/deps.ts";
import { buildCatalogoPlataforma } from "../src/superadmin-copiloto/catalogo.ts";
import { fuentesDeProduccion } from "../src/superadmin-copiloto/fuentes.ts";
import { SCOPE_SUPERADMIN, ctxHerramienta, ok } from "./superadmin-copiloto-fixtures.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Sesion que reproduce la pila de SAVEPOINT de Postgres y la cola FIFO (cada operacion cede el turno antes de aplicarse). */
class SesionPgFifo implements TenantDbSession {
  private abortada = false;
  private readonly pila: string[] = [];
  readonly consultas: string[] = [];
  private cola: Promise<unknown> = Promise.resolve();

  private encolar<T>(op: () => T): Promise<T> {
    const r = this.cola.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return op();
    });
    this.cola = r.catch(() => undefined);
    return r;
  }

  get estaAbortada(): boolean {
    return this.abortada;
  }

  async exec(sql: string): Promise<void> {
    return this.encolar(() => {
      const t = sql.trim().toLowerCase();
      const nombre = t.split(/\s+/).pop()!;
      if (t.startsWith("rollback to savepoint")) {
        const i = this.pila.lastIndexOf(nombre);
        if (i < 0) throw pgError("3B001", `savepoint "${nombre}" does not exist`);
        this.pila.length = i + 1;
        this.abortada = false;
        return;
      }
      if (this.abortada) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
      if (t.startsWith("savepoint")) {
        this.pila.push(nombre);
        return;
      }
      if (t.startsWith("release savepoint")) {
        const i = this.pila.lastIndexOf(nombre);
        if (i < 0) {
          this.abortada = true;
          throw pgError("3B001", `savepoint "${nombre}" does not exist`);
        }
        this.pila.length = i; // RELEASE destruye tambien los savepoints abiertos despues
      }
    });
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    return this.encolar(() => {
      if (this.abortada) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
      this.consultas.push(sql);
      return { rows: [] as T[] };
    });
  }
}

/** Repositorio de consola cuyas lecturas usan la sesion del turno (como el real). */
function depsConConsola(db: TenantDbSession, fallaOperaciones = false): AppDeps {
  const leer = async <T>(data: T, falla = false) => {
    await db.query("select 1;");
    if (falla) throw pgError("42883", "function core.consola_operaciones(uuid) does not exist");
    return ok(data);
  };
  return {
    consolaRepo: () => ({
      organizaciones: () => leer([]),
      operaciones: () => leer([], fallaOperaciones),
      conversacionesWa: () => leer([]),
      agentesActividad: () => leer([]),
    }),
  } as unknown as AppDeps;
}

describe("fuentes de sesion: varias en la misma herramienta", () => {
  it("uso_por_vertical (4 lecturas de sesion lanzadas con Promise.all) deja la transaccion SANA: sin 3B001 ni 25P02 y con la sesion utilizable despues", async () => {
    const db = new SesionPgFifo();
    const f = fuentesDeProduccion(depsConConsola(db), db, USER);
    const tool = buildCatalogoPlataforma(f, SCOPE_SUPERADMIN).tools.find((t) => t.name === "uso_por_vertical")!;
    const r = await tool.run(ctxHerramienta(SCOPE_SUPERADMIN), { periodo: "ultimos_7_dias" });
    expect(r.status).toBe("ok");
    expect(db.estaAbortada).toBe(false);
    // la bitacora y el append de la conversacion usan la misma sesion despues de las fuentes
    await expect(db.query("insert into bitacora")).resolves.toBeDefined();
    await expect(db.exec("select 1")).resolves.toBeUndefined();
  });

  it("agentes_interruptores (dos fuentes de sesion) tampoco aborta la transaccion", async () => {
    const db = new SesionPgFifo();
    const deps = {
      ...depsConConsola(db),
      platformSwitchRepo: () => ({
        list: async () => {
          await db.query("select 2;");
          return { availability: "available" as const, switches: [] };
        },
      }),
    } as unknown as AppDeps;
    const f = fuentesDeProduccion(deps, db, USER);
    const tool = buildCatalogoPlataforma(f, SCOPE_SUPERADMIN).tools.find((t) => t.name === "agentes_interruptores")!;
    await tool.run(ctxHerramienta(SCOPE_SUPERADMIN), {});
    expect(db.estaAbortada).toBe(false);
    await expect(db.query("insert into bitacora")).resolves.toBeDefined();
  });

  it("si una de las fuentes concurrentes falla con 42883 (base sin migrar), las demas responden y la sesion sigue sana", async () => {
    const db = new SesionPgFifo();
    const f = fuentesDeProduccion(depsConConsola(db, true), db, USER);
    const [orgs, ops, wa, act] = await Promise.all([f.consolaOrganizaciones(), f.consolaOperaciones("2026-10-01", "2026-10-02"), f.consolaConversacionesWa(), f.consolaAgentesActividad("2026-10-02")]);
    expect(orgs.ok).toBe(true);
    expect(ops).toEqual({ ok: false, razon: "no_migrado" });
    expect(wa.ok).toBe(true);
    expect(act.ok).toBe(true);
    expect(db.estaAbortada).toBe(false);
    await expect(db.query("insert into bitacora")).resolves.toBeDefined();
  });
});
