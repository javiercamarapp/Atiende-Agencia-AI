// Regresion de revision sobre PR #319: la medicion del checklist de `conAvisoOnboardingListo` (onboarding-aviso.ts) corre en la MISMA
// transaccion del request que la escritura de negocio. Un try/catch sin SAVEPOINT dejaba la transaccion abortada (25P02 en la escritura,
// o ROLLBACK silencioso en el COMMIT si el fallo era en la medicion posterior). Aqui las lecturas reales de `cargarOnboarding` lanzan un
// error de Postgres sobre un doble que reproduce el estado ABORTADO; la escritura debe resolver y la sesion quedar viva.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { conAvisoOnboardingListo } from "../src/routes/verticals/restaurantes/onboarding-aviso.ts";

const ORG = "00000000-0000-0000-0000-0000000000o1";

class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  private savepointTaken = false;
  readonly execCalls: string[] = [];

  private throwAborted(): never {
    throw Object.assign(new Error("current transaction is aborted, commands ignored until end of transaction block"), { code: "25P02" });
  }

  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) this.throwAborted();
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);
    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepointTaken) throw new Error(`ROLLBACK TO SAVEPOINT sin savepoint previo (${sql})`);
      this.aborted = false;
      this.savepointTaken = false;
      return;
    }
    if (this.aborted) this.throwAborted();
    if (n.startsWith("savepoint")) {
      this.savepointTaken = true;
      return;
    }
    if (n.startsWith("release savepoint")) {
      this.savepointTaken = false;
      return;
    }
    throw new Error(`exec no soportado: ${sql}`);
  }
}

// Repo minimo: solo lo que lee cargarOnboarding. `fallar` decide en que medicion (1 = antes, 2 = despues) lanza el 57014 real.
function montar(fallarEnMedicion: number | null) {
  const session = new AbortAwareFakeSession();
  let medicion = 0;
  const repo = {
    async listBranchesForOrganizationAdmin() {
      medicion += 1;
      if (medicion === fallarEnMedicion) {
        session.aborted = true;
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
      return [];
    },
    async listWhatsappBranchChannels() {
      return [];
    },
    async getWhatsappChannelConfig() {
      return { phoneNumberId: null };
    },
    async findWhatsAppAgentConfigExacta() {
      return null;
    },
    async listOrders() {
      return { orders: [] };
    },
  };
  const deps = {
    coreRepo: { findMembershipsByUserId: async () => [{ organizationId: ORG, propertyIds: null }] },
    restaurantesRepo: () => repo,
  };
  const c = { get: (k: string) => (k === "db" ? session : k === "userId" ? "u1" : undefined), req: { param: () => "p1" } };
  return { session, deps, c };
}

describe("conAvisoOnboardingListo: la medicion no aborta la transaccion compartida", () => {
  it.each([
    ["antes de escribir", 1],
    ["despues de escribir", 2],
  ])("un error de Postgres en la medicion %s no cambia la escritura de negocio y deja la sesion viva", async (_n, fallarEn) => {
    const { session, deps, c } = montar(fallarEn);
    let escrituras = 0;
    const resultado = await conAvisoOnboardingListo(deps as never, c as never, ORG, async () => {
      // La escritura de negocio usa la MISMA sesion: sobre una transaccion abortada lanzaria 25P02.
      await session.query();
      escrituras += 1;
      return "ok";
    });
    expect(resultado).toBe("ok");
    expect(escrituras).toBe(1);
    expect(session.aborted).toBe(false);
    await expect(session.query()).resolves.toEqual({ rows: [] });
    expect(session.execCalls.some((x) => x.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("sin fallos la medicion libera su savepoint y no deja la sesion abortada", async () => {
    const { session, deps, c } = montar(null);
    await conAvisoOnboardingListo(deps as never, c as never, ORG, async () => "ok");
    expect(session.execCalls.some((x) => x.startsWith("rollback to savepoint"))).toBe(false);
    expect(session.execCalls.some((x) => x.startsWith("release savepoint"))).toBe(true);
  });
});
