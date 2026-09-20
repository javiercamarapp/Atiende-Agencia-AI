// Bloqueante de revisión (PR #182, r1 -- 20-sep-2026): la suite nueva de
// `f2-current-date-fecha-negocio` cubría el fix de `createApprovedRate` SOLO contra
// `InMemoryLicitacionesRepository` (ver `apps/api/tests/licitaciones-rate-servidor-hoy.spec.ts`,
// que usa `buildLicitacionesTestContext` -- repo en memoria vía HTTP). Producción
// SIEMPRE usa `PostgresLicitacionesRepository` (`apps/api/src/production/deps.ts`), y
// nada corría el SQL real del método con reloj falso: revertir `hoyFechaNegocio()` a
// `new Date().toISOString().slice(0,10)`, o reintroducir `current_date` dentro del
// propio SQL, habría dejado toda esa suite en verde. El único test existente que
// llama `createApprovedRate` contra el repo Postgres real
// (`company-data-postgres-date-contract.spec.ts:241`) siempre pasa `validFrom`
// explícito en el input, así que nunca ejercita el default -- este archivo instancia
// `PostgresLicitacionesRepository` REAL con una sesión falsa que CAPTURA los
// parámetros que de verdad se le pasan a `db.query` cuando el caller NO manda
// `validFrom`, mismo patrón (`fakeSessionWithResponses`) que ese archivo, extendido
// para capturar params.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface CapturedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Variante de `fakeSessionWithResponses` (company-data-postgres-date-contract.spec.ts)
 *  que además CAPTURA los params de cada llamada, en orden. `createApprovedRate`
 *  emite, cuando el caller NO manda `validFrom` explícito: 1) el `select` de
 *  duplicados, 2) FASE 3 (producto) -- el `select timezone` de
 *  `findTenantConfig` (dentro de `resolveOrganizationTimezoneForToday`, protegido
 *  por `SAVEPOINT`/`RELEASE SAVEPOINT` vía `runWithSavepointFallback` -- `exec` es
 *  un no-op aquí, no consume la cola de `query`), 3) el `insert ... returning`
 *  bajo prueba -- aquí es donde llega el parámetro de "hoy" (posición $5). */
function fakeSessionCapturing(responses: ReadonlyArray<{ rows: unknown[] }>): { session: TenantDbSession; calls: CapturedCall[] } {
  const queue = [...responses];
  const calls: CapturedCall[] = [];
  const session: TenantDbSession = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const next = queue.shift();
      if (!next) throw new Error("fakeSessionCapturing: se agotaron las respuestas encoladas");
      return next as { rows: T[] };
    },
    async exec() {},
  };
  return { session, calls };
}

// 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo) --
// mismo instante de reloj falso que `apps/api/tests/licitaciones-rate-servidor-hoy.spec.ts`.
const INSTANTE_1930_CDMX_DIA_1 = "2026-01-02T01:30:00.000Z";

describe("PostgresLicitacionesRepository.createApprovedRate -- el parámetro real que llega al INSERT usa el día de NEGOCIO", () => {
  it("sin validFrom en el input, a las 19:30 CDMX, el parámetro valid_from ($5) es '2026-01-01' (día de negocio), NO '2026-01-02' (día UTC)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const { session, calls } = fakeSessionCapturing([
      { rows: [] }, // select de duplicados: no hay
      { rows: [] }, // FASE 3 (producto): select timezone de tenant_config -- sin fila, cae al default de plataforma (CDMX)
      {
        rows: [
          { id: "rate-1", concept: "consultoria_hora", unit_price: "500.00", approval_status: "pendiente_aprobacion", valid_from: "2026-01-01", valid_until: null },
        ],
      },
    ]);
    const repo = new PostgresLicitacionesRepository(session);

    await repo.createApprovedRate("org-1", { concept: "consultoria_hora", unitPrice: "500.00" });

    expect(calls).toHaveLength(3);
    const insertCall = calls[2]!;
    expect(insertCall.sql.toLowerCase()).toContain("insert into licitaciones.approved_rate");
    // Orden real de params en el insert: [organizationId, concept, unitPrice,
    // approvalStatus, validFrom, validUntil] -- ver postgres-repository.ts.
    expect(insertCall.params[4]).toBe("2026-01-01");
    expect(insertCall.params[4]).not.toBe("2026-01-02");

    // Guard de deriva: si alguien reintroduce `current_date` en el propio SQL (en
    // vez de pasar la fecha como parámetro), este test debe tronar aunque el
    // parámetro capturado arriba siguiera "viéndose bien" por coincidencia de
    // reloj -- ver hallazgo no-bloqueante 1 (assertions.sql no detecta esto).
    for (const call of calls) {
      expect(call.sql).not.toMatch(/current_date/i);
      expect(call.sql).not.toMatch(/now\(\)/i);
    }
  });

  it("con validFrom explícito en el input, ese valor se usa tal cual -- nunca se recalcula con hoyFechaNegocio()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const { session, calls } = fakeSessionCapturing([
      { rows: [] },
      {
        rows: [
          { id: "rate-2", concept: "supervision_obra", unit_price: "1200.00", approval_status: "pendiente_aprobacion", valid_from: "2030-06-15", valid_until: null },
        ],
      },
    ]);
    const repo = new PostgresLicitacionesRepository(session);

    await repo.createApprovedRate("org-1", { concept: "supervision_obra", unitPrice: "1200.00", validFrom: "2030-06-15" });

    expect(calls[1]!.params[4]).toBe("2030-06-15");
  });
});
