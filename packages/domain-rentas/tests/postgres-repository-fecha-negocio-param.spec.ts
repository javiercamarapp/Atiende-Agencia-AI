// Bloqueante de revisión (PR #182, r1 -- 20-sep-2026): la suite nueva de
// `f2-current-date-fecha-negocio` cubría el fix de `loadPricingContext` SOLO contra
// `InMemoryRentasRepository` (ver `apps/api/tests/rentas-cotizacion-servidor-hoy.spec.ts`,
// que usa `buildRentasTestContext` -- repo en memoria vía HTTP). Producción SIEMPRE
// usa `PostgresRentasRepository` (`apps/api/src/production/deps.ts`), y nada corría
// el SQL real del método con reloj falso: revertir `hoyFechaNegocio()` a
// `new Date().toISOString().slice(0,10)`, o reintroducir `current_date` dentro del
// propio SQL, habría dejado toda esa suite en verde. Este archivo instancia
// `PostgresRentasRepository` REAL (nunca el repo en memoria) con una sesión falsa
// que CAPTURA los parámetros que de verdad se le pasan a `db.query`, para que una
// regresión en el call site truene aquí sin necesitar Postgres real.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface CapturedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Sesión falsa que registra CADA llamada (SQL + params) y responde según el
 *  ORDEN en el que `loadPricingContext` las emite: 1) `rentas.unidad` (para que el
 *  método no corte temprano con `null`), 2) `rentas.tarifa_base` (la query bajo
 *  prueba -- aquí es donde llega el parámetro de "hoy"), 3-5) las tres queries en
 *  paralelo (`Promise.all`) de temporadas/descuentos/min-stay, que no importan para
 *  este test y responden vacío. */
function capturingSession(unidadId: string): { session: TenantDbSession; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const session: TenantDbSession = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select id from rentas.unidad")) {
        return { rows: [{ id: unidadId }] as T[] };
      }
      if (normalized.includes("from rentas.tarifa_base")) {
        return { rows: [{ precio_noche_centavos: "150000", moneda: "MXN" }] as T[] };
      }
      return { rows: [] as T[] };
    },
    async exec() {},
  };
  return { session, calls };
}

// 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo) --
// mismo instante de reloj falso que `apps/api/tests/rentas-cotizacion-servidor-hoy.spec.ts`.
const INSTANTE_1930_CDMX_DIA_1 = "2026-01-02T01:30:00.000Z";

describe("PostgresRentasRepository.loadPricingContext -- el parámetro real que llega al SQL de tarifa_base usa el día de NEGOCIO", () => {
  it("a las 19:30 CDMX, el parámetro '$2' de la query a rentas.tarifa_base es '2026-01-01' (día de negocio), NO '2026-01-02' (día UTC)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const { session, calls } = capturingSession("unidad-1");
    const repo = new PostgresRentasRepository(session);

    const resultado = await repo.loadPricingContext("property-1", "unidad-1");
    expect(resultado).not.toBeNull();

    const tarifaBaseCall = calls.find((c) => c.sql.toLowerCase().includes("from rentas.tarifa_base"));
    expect(tarifaBaseCall).toBeDefined();
    expect(tarifaBaseCall!.params[0]).toBe("unidad-1");
    expect(tarifaBaseCall!.params[1]).toBe("2026-01-01");
    expect(tarifaBaseCall!.params[1]).not.toBe("2026-01-02");

    // Guard de deriva: si alguien reintroduce `current_date` en el propio SQL (en
    // vez de pasar la fecha como parámetro), este test debe tronar aunque el
    // parámetro capturado arriba siguiera "viéndose bien" por coincidencia de
    // reloj -- ver hallazgo no-bloqueante 1 (assertions.sql no detecta esto).
    for (const call of calls) {
      expect(call.sql).not.toMatch(/current_date/i);
      expect(call.sql).not.toMatch(/now\(\)/i);
    }
  });
});
