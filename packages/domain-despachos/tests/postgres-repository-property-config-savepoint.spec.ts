// FASE 3 (producto) — zona horaria por negocio (migración 012,
// `despachos.property_config`). `findPropertyConfig`/`upsertPropertyConfigZonaHoraria`
// corren SIEMPRE dentro de la transacción del request que sigue con más queries
// (ver `vencimientos.ts`/`cobranza.ts`/`cierre-mensual.ts`, cada uno resuelve la zona
// horaria ANTES de sus escrituras de negocio reales) -- REGLA DURA de compatibilidad
// del repo: un `try/catch` simple sobre 42P01/42703 dejaría la transacción ABORTADA
// (25P02) para esas queries posteriores. `AbortAwareFakeSession`
// (packages/domain-despachos/tests/support) reproduce ese estado real de Postgres,
// que una sesión falsa plana no reproduciría -- mismo criterio EXACTO que
// `postgres-repository-create-deadline-savepoint.spec.ts` (leído primero como
// plantilla).
import { describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { DespachosConfigUnavailableError } from "../src/errors.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";
const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000o1";

const SELECT_RE = /select property_id, organization_id, zona_horaria from despachos\.property_config where property_id = \$1/i;
const UPSERT_RE = /insert into despachos\.property_config/i;

function undefinedTableError(): Error & { code: string } {
  const err = new Error('relation "despachos.property_config" does not exist') as Error & { code: string };
  err.code = "42P01";
  return err;
}

function undefinedColumnError(): Error & { code: string } {
  const err = new Error('column "zona_horaria" of relation "property_config" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

describe("PostgresDespachosRepository.findPropertyConfig", () => {
  it("fila existente -- mapea zona_horaria real", async () => {
    const session = new AbortAwareFakeSession([{ match: SELECT_RE, respond: () => [{ property_id: PROPERTY_ID, organization_id: ORGANIZATION_ID, zona_horaria: "America/Cancun" }] }]);
    const repo = new PostgresDespachosRepository(session);

    const config = await repo.findPropertyConfig(PROPERTY_ID);

    expect(config).toEqual({ propertyId: PROPERTY_ID, organizationId: ORGANIZATION_ID, zonaHoraria: "America/Cancun" });
  });

  it("sin fila todavía (property nunca configuró zona horaria) -- null, nunca un error", async () => {
    const session = new AbortAwareFakeSession([{ match: SELECT_RE, respond: () => [] }]);
    const repo = new PostgresDespachosRepository(session);

    expect(await repo.findPropertyConfig(PROPERTY_ID)).toBeNull();
  });

  it("REGLA DURA de compatibilidad (42P01, migración 012 sin aplicar todavía) -- degrada a null, el SAVEPOINT recupera la sesión para lo que siga en el mismo request", async () => {
    const session = new AbortAwareFakeSession([
      { match: SELECT_RE, respond: () => undefinedTableError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    expect(await repo.findPropertyConfig(PROPERTY_ID)).toBeNull();
    // La prueba real del SAVEPOINT: una consulta POSTERIOR sobre la MISMA sesión
    // (aquí, `vencimientos.ts::listDeadlines` que corre en la MISMA transacción,
    // ver `Promise.all` de esa ruta) resuelve en vez de lanzar 25P02
    // (AbortedTransactionCommitError). Contra un `try/catch` sin SAVEPOINT esta
    // aserción falla: la sesión queda abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("cualquier otro error de Postgres (nunca 42P01/42703/42883) se repropaga tal cual -- nunca enmascara un fallo real", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: SELECT_RE,
        respond: () => {
          const err = new Error("connection terminated") as Error & { code: string };
          err.code = "57P01";
          return err;
        },
      },
    ]);
    const repo = new PostgresDespachosRepository(session);

    await expect(repo.findPropertyConfig(PROPERTY_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("PostgresDespachosRepository.upsertPropertyConfigZonaHoraria", () => {
  it("éxito real: upsert devuelve la fila persistida", async () => {
    const session = new AbortAwareFakeSession([{ match: UPSERT_RE, respond: () => [{ property_id: PROPERTY_ID, organization_id: ORGANIZATION_ID, zona_horaria: "America/Tijuana" }] }]);
    const repo = new PostgresDespachosRepository(session);

    const updated = await repo.upsertPropertyConfigZonaHoraria(PROPERTY_ID, ORGANIZATION_ID, "America/Tijuana");

    expect(updated).toEqual({ propertyId: PROPERTY_ID, organizationId: ORGANIZATION_ID, zonaHoraria: "America/Tijuana" });
  });

  it("zonaHoraria: null -- upsert real, borra la configuración explícita", async () => {
    const session = new AbortAwareFakeSession([{ match: UPSERT_RE, respond: () => [{ property_id: PROPERTY_ID, organization_id: ORGANIZATION_ID, zona_horaria: null }] }]);
    const repo = new PostgresDespachosRepository(session);

    expect(await repo.upsertPropertyConfigZonaHoraria(PROPERTY_ID, ORGANIZATION_ID, null)).toEqual({ propertyId: PROPERTY_ID, organizationId: ORGANIZATION_ID, zonaHoraria: null });
  });

  it("REGLA DURA de compatibilidad (42703, migración 012 sin aplicar) -- lanza DespachosConfigUnavailableError (503 honesto vía la ruta), el SAVEPOINT recupera la sesión", async () => {
    const session = new AbortAwareFakeSession([
      { match: UPSERT_RE, respond: () => undefinedColumnError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    await expect(repo.upsertPropertyConfigZonaHoraria(PROPERTY_ID, ORGANIZATION_ID, "America/Mexico_City")).rejects.toBeInstanceOf(DespachosConfigUnavailableError);
    // Nunca deja la transacción abortada -- una consulta posterior de la MISMA
    // sesión (p. ej. la ruta HTTP registrando su propia respuesta de error, o el
    // `commit;` real de managed-postgres-engine.ts) sigue resolviendo.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("cualquier otro error de Postgres (nunca 42883/42P01/42703) se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: UPSERT_RE,
        respond: () => {
          const err = new Error('new row for relation "property_config" violates check constraint') as Error & { code: string };
          err.code = "23514";
          return err;
        },
      },
    ]);
    const repo = new PostgresDespachosRepository(session);

    await expect(repo.upsertPropertyConfigZonaHoraria(PROPERTY_ID, ORGANIZATION_ID, "")).rejects.toMatchObject({ code: "23514" });
  });
});
