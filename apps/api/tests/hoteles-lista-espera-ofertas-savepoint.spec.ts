// H-12 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar (041) para el wrapper
// `ofrecerListaEsperaTrasLiberacion` (SAVEPOINT externo + catch), con los adaptadores Postgres REALES (no los repos en memoria, que
// nunca abortan una sesion) y un doble LOCAL de `TenantDbSession` que reproduce el estado ABORTADO de Postgres: tras un error,
// toda consulta posterior lanza 25P02 salvo un `ROLLBACK TO SAVEPOINT`. Cubre dos caminos: base sin migrar (42P01) y un fallo
// que NO es de migracion en mitad de la oferta. En ambos la cancelacion/el acortamiento ya hecho sigue valido: el wrapper
// devuelve 0 y la MISMA sesion sigue utilizable (si el SAVEPOINT faltara, la consulta final lanzaria 25P02).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../src/deps.ts";
import { ofrecerListaEsperaTrasLiberacion } from "../src/routes/verticals/hoteles/lista-espera-ofertas.ts";

const ORG = "00000000-0000-0000-0000-0000000000o1";
const P = "00000000-0000-0000-0000-0000000000a1";
const T = "00000000-0000-0000-0000-0000000000c1";
const E = "00000000-0000-0000-0000-0000000000e1";

interface Regla {
  readonly match: RegExp;
  readonly respond: () => unknown;
}

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

class AbortAwareFakeSession implements TenantDbSession {
  private aborted = false;
  readonly calls: string[] = [];
  constructor(private readonly reglas: readonly Regla[]) {}

  private abortedError(): Error & { code: string } {
    return pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.calls.push(sql.trim().toLowerCase().split("\n")[0]!);
    if (this.aborted) throw this.abortedError();
    for (const r of this.reglas) {
      if (r.match.test(sql)) {
        const out = r.respond();
        if (out instanceof Error) {
          this.aborted = true;
          throw out;
        }
        return { rows: out as T[] };
      }
    }
    throw new Error(`sin regla para: ${sql}`);
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.calls.push(n);
    if (n.startsWith("rollback to savepoint") || n === "rollback") {
      this.aborted = false;
      return;
    }
    if (this.aborted) throw this.abortedError();
  }
}

const deps = {} as AppDeps; // sin repos inyectados: el wrapper usa los adaptadores Postgres reales
const lib = { organizationId: ORG, propertyId: P, roomTypeId: T, noches: ["2031-07-04", "2031-07-03"] };
const siguiente: Regla = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const despues = (s: AbortAwareFakeSession) => expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });

const entrada = {
  id: E, property_id: P, room_type_id: T, check_in_date: "2031-07-03", check_out_date: "2031-07-05", guests: 2, guest_name: "Ana",
  contact_phone: "5511112222", contact_email: null, notes: null, status: "activa", offered_at: null, offer_expires_at: null,
  reservation_id: null, created_at: "2031-06-01T00:00:00.000Z",
};

describe("ofrecerListaEsperaTrasLiberacion contra una sesion con estado abortado real", () => {
  it("base sin la migracion 041 (42P01): devuelve 0, no lanza y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /waitlist_entry/i, respond: () => pgError("42P01", 'relation "hoteles.waitlist_entry" does not exist') }, siguiente]);
    await expect(ofrecerListaEsperaTrasLiberacion(deps, s, lib)).resolves.toBe(0);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await despues(s);
  });

  it("sin noches liberadas no toca la base", async () => {
    const s = new AbortAwareFakeSession([]);
    await expect(ofrecerListaEsperaTrasLiberacion(deps, s, { ...lib, noches: [] })).resolves.toBe(0);
    expect(s.calls).toEqual([]);
  });

  it("fallo que NO es de migracion en mitad de la oferta (la funcion/trigger rechaza con 22023): devuelve 0 y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /set status = 'expirada'/i, respond: () => [] },
      { match: /from hoteles\.waitlist_entry/i, respond: () => [entrada] },
      { match: /from hoteles\.availability/i, respond: () => [{ date: "2031-07-03", total_rooms: 3, booked_rooms: 0 }, { date: "2031-07-04", total_rooms: 3, booked_rooms: 0 }] },
      { match: /from hoteles\.room_type/i, respond: () => [{ max_overbook_rooms: 0, overbooking_occupancy_threshold_pct: "95" }] },
      { match: /set status = 'ofrecida'/i, respond: () => pgError("22023", "la oferta debe vencer entre ahora y 7 dias") },
      siguiente,
    ]);
    await expect(ofrecerListaEsperaTrasLiberacion(deps, s, lib)).resolves.toBe(0);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await despues(s);
  });

  it("fallo inesperado (statement timeout 57014) al leer candidatas: devuelve 0 y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /set status = 'expirada'/i, respond: () => [] },
      { match: /from hoteles\.waitlist_entry/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      siguiente,
    ]);
    await expect(ofrecerListaEsperaTrasLiberacion(deps, s, lib)).resolves.toBe(0);
    await despues(s);
  });
});
