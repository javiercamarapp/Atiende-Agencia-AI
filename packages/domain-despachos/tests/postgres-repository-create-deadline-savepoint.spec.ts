// f2-despachos-fiscal-deadline-unique — regresión para `createDeadline`
// (`postgres-repository.ts`), llamado 4 veces (ISR/IVA/DIOT/Nómina) EN LA MISMA
// transacción de staff por `POST .../vencimientos/calcular`
// (apps/api/src/routes/verticals/despachos/vencimientos.ts). Antes de este fix era un
// INSERT plano: `despachos.fiscal_deadline` YA tiene `unique (property_id, tipo,
// periodo)` desde la migración ORIGINAL de la Fase 1 (verificado con `git log -S`,
// nunca se agregó ni se quitó después -- no hacía falta una migración nueva para
// AGREGARLO, ver el cuerpo del PR), así que pulsar "Calcular vencimientos" dos veces
// para el mismo periodo no duplicaba filas -- las impedía el índice -- pero SÍ lanzaba
// un `unique_violation` (23505) crudo que abortaba TODA la transacción del lote de 4
// inserts (el staff veía un 500 en vez de un resultado idempotente). El mirror en
// memoria (`in-memory-repository.ts::createDeadline`) ya hacía este dedup a mano; a
// esto adaptador real de Postgres le faltaba la paridad.
//
// Cada test de este archivo FALLA contra el código anterior (INSERT plano sin `ON
// CONFLICT`): la segunda llamada para el mismo (property_id, tipo, periodo) habría
// lanzado el 23505 crudo en vez de devolver la fila existente.
//
// `AbortAwareFakeSession` (packages/domain-despachos/tests/support) -- mismo doble,
// mismo criterio, que `vencimientos-email-notifications-savepoint.spec.ts`: reproduce
// el estado "transacción abortada" (25P02) real de Postgres, que una sesión falsa
// plana no reproduciría.
import { describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { NewFiscalDeadlineInput } from "../src/types.ts";

const INPUT: NewFiscalDeadlineInput = {
  organizationId: "00000000-0000-0000-0000-0000000000o1",
  propertyId: "00000000-0000-0000-0000-0000000000p1",
  tipo: "ISR",
  periodo: "2026-06",
  fechaLimite: "2026-07-17",
  prioridad: "media",
};

const EXISTING_ROW = {
  id: "00000000-0000-0000-0000-0000000000d1",
  organization_id: INPUT.organizationId,
  property_id: INPUT.propertyId,
  tipo: INPUT.tipo,
  periodo: INPUT.periodo,
  fecha_limite: INPUT.fechaLimite,
  prioridad: INPUT.prioridad,
  estado: "pendiente",
  fecha_presentacion: null,
  comprobante_url: null,
  created_at: "2026-06-01T00:00:00.000Z",
};

const ON_CONFLICT_INSERT_RE = /on conflict \(property_id, tipo, periodo\) do nothing/i;
const SELECT_BY_PERIODO_RE = /select .* from despachos\.fiscal_deadline where property_id = \$1 and tipo = \$2 and periodo = \$3/i;
const PLAIN_INSERT_RE = /insert into despachos\.fiscal_deadline/i;

function noUniqueOrExclusionConstraintError(): Error & { code: string } {
  const err = new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification") as Error & { code: string };
  err.code = "42P10";
  return err;
}

describe("PostgresDespachosRepository.createDeadline — idempotente (f2-despachos-fiscal-deadline-unique)", () => {
  it("éxito real: la PRIMERA llamada inserta y devuelve la fila nueva, libera el SAVEPOINT sin rastro de rollback", async () => {
    const session = new AbortAwareFakeSession([{ match: ON_CONFLICT_INSERT_RE, respond: () => [EXISTING_ROW] }]);
    const repo = new PostgresDespachosRepository(session);

    const created = await repo.createDeadline(INPUT);

    expect(created.id).toBe(EXISTING_ROW.id);
    expect(created.tipo).toBe("ISR");
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });

  it("EFECTO real (hallazgo de auditoría 'Calcular vencimientos duplica filas si se pulsa dos veces'): la SEGUNDA llamada para el MISMO (property_id, tipo, periodo) no crea una segunda fila -- devuelve la existente, sin lanzar", async () => {
    let onConflictInserts = 0;
    const session = new AbortAwareFakeSession([
      {
        match: ON_CONFLICT_INSERT_RE,
        respond: () => {
          onConflictInserts += 1;
          // Postgres real: la 1a llamada SÍ inserta y devuelve la fila (`returning`);
          // la 2a choca contra `unique (property_id, tipo, periodo)`, `DO NOTHING` la
          // descarta EN SILENCIO -- cero filas devueltas, sin lanzar 23505.
          return onConflictInserts === 1 ? [EXISTING_ROW] : [];
        },
      },
      { match: SELECT_BY_PERIODO_RE, respond: () => [EXISTING_ROW] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    const first = await repo.createDeadline(INPUT);
    const second = await repo.createDeadline(INPUT); // "Calcular vencimientos" pulsado dos veces para el mismo periodo.

    expect(onConflictInserts).toBe(2); // Las DOS llamadas intentan el INSERT -- la idempotencia es de Postgres (ON CONFLICT), no de un "revisar antes" en el cliente.
    expect(second.id).toBe(first.id); // Nunca una segunda fila.
    expect(second).toEqual(first);
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(0); // ON CONFLICT DO NOTHING nunca es un error -- nunca aborta la transacción.
  });

  it("42P10 (REGLA DURA de compatibilidad: el índice unique, aunque original de la Fase 1, todavía no existiera en esta base) -- se degrada al INSERT plano de antes de este fix, el SAVEPOINT recupera la sesión para lo que siga en el mismo request", async () => {
    const session = new AbortAwareFakeSession([
      { match: ON_CONFLICT_INSERT_RE, respond: () => noUniqueOrExclusionConstraintError() },
      { match: PLAIN_INSERT_RE, respond: () => [EXISTING_ROW] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    const created = await repo.createDeadline(INPUT);

    expect(created.id).toBe(EXISTING_ROW.id);
    // La prueba real del SAVEPOINT: una consulta POSTERIOR sobre la MISMA sesión
    // (aquí, la que haría el `commit;` real de managed-postgres-engine.ts) resuelve en
    // vez de lanzar 25P02 (AbortedTransactionCommitError). Contra un `try/catch` sin
    // SAVEPOINT esta aserción falla: la sesión queda abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("cualquier otro error de Postgres (nunca 42P10) se repropaga tal cual -- este fix nunca enmascara un fallo real", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: ON_CONFLICT_INSERT_RE,
        respond: () => {
          const err = new Error('insert or update on table "fiscal_deadline" violates foreign key constraint') as Error & { code: string };
          err.code = "23503";
          return err;
        },
      },
    ]);
    const repo = new PostgresDespachosRepository(session);

    await expect(repo.createDeadline(INPUT)).rejects.toMatchObject({ code: "23503" });
  });
});
