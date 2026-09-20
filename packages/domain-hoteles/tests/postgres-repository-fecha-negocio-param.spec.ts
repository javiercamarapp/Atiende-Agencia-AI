// Bloqueante de revisión (PR #182, r1 -- 20-sep-2026): la suite nueva de
// `f2-current-date-fecha-negocio` cubría el fix de `findDueNoShowReservations`
// SOLO contra `InMemoryHotelesRepository` (ver `apps/api/tests/hoteles-reservas.spec.ts`,
// que usa `buildHotelesTestContext` -- repo en memoria). Producción SIEMPRE usa
// `PostgresHotelesRepository` (`apps/api/src/production/deps.ts`), y nada corría el
// SQL real del método con reloj falso: revertir `hoyFechaNegocio()` a
// `new Date().toISOString().slice(0,10)`, o reintroducir `current_date` dentro del
// propio SQL, habría dejado toda esa suite en verde. Este archivo instancia
// `PostgresHotelesRepository` REAL (nunca el repo en memoria) con una sesión falsa
// que CAPTURA los parámetros que de verdad se le pasan a `db.query`, para que una
// regresión en el call site truene aquí sin necesitar Postgres real.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresHotelesRepository } from "../src/postgres-repository.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface CapturedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Sesión falsa que registra CADA llamada (SQL + params tal cual se pasan) y
 *  devuelve una fila vacía para cualquier `query` -- suficiente porque estos tests
 *  solo verifican qué se le manda a Postgres, no el mapeo del resultado (ese mapeo
 *  ya está cubierto por otros tests del paquete). */
function capturingSession(): { session: TenantDbSession; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const session: TenantDbSession = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as T[] };
    },
    async exec() {},
  };
  return { session, calls };
}

// 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo) --
// mismo instante de reloj falso que `apps/api/tests/hoteles-reservas.spec.ts` y el
// resto de la ronda `f2-current-date-fecha-negocio`.
const INSTANTE_1930_CDMX_DIA_1 = "2026-01-02T01:30:00.000Z";

describe("PostgresHotelesRepository.findDueNoShowReservations -- el parámetro real que llega al SQL usa el día de NEGOCIO", () => {
  it("con asOfDate=null (camino real de STAFF, ver reservas.ts) a las 19:30 CDMX, el 2do parámetro ($2) es '2026-01-01' (día de negocio), NO '2026-01-02' (día UTC)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const { session, calls } = capturingSession();
    const repo = new PostgresHotelesRepository(session);

    await repo.findDueNoShowReservations("property-1", null);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.params[0]).toBe("property-1");
    expect(call.params[1]).toBe("2026-01-01");
    expect(call.params[1]).not.toBe("2026-01-02");

    // Guard de deriva: si alguien reintroduce `current_date` en el propio SQL (en
    // vez de pasar la fecha como parámetro), este test debe tronar aunque el
    // parámetro capturado arriba siguiera "viéndose bien" por coincidencia de
    // reloj -- ver hallazgo no-bloqueante 1 (assertions.sql no detecta esto).
    expect(call.sql).not.toMatch(/current_date/i);
    expect(call.sql).not.toMatch(/now\(\)/i);
  });

  it("con un asOfDate explícito (camino de night-audit), ese valor se usa tal cual -- nunca se recalcula con hoyFechaNegocio()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const { session, calls } = capturingSession();
    const repo = new PostgresHotelesRepository(session);

    await repo.findDueNoShowReservations("property-1", "2025-05-10");

    expect(calls[0]!.params[1]).toBe("2025-05-10");
  });
});
