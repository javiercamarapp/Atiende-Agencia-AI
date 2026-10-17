// QA R1 automatizacion 07 -- PostgresCitasRepository.purgeRetentionBatch contra una base SIN la migracion 033 (AbortAwareFakeSession reproduce
// el estado abortado de Postgres: una sesion falsa plana no serviria) y contra una base migrada.
import { describe, expect, it, vi } from "vitest";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const pg42883 = Object.assign(new Error("function citas.system_purge_retencion(integer, boolean) does not exist"), { code: "42883" });

describe("PostgresCitasRepository.purgeRetentionBatch", () => {
  it("base sin migrar (42883): responde disponible:false y la transaccion sigue utilizable (SAVEPOINT / ROLLBACK TO SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_purge_retencion/, respond: () => pg42883 },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresCitasRepository(session);
    expect(await repo.purgeRetentionBatch(500, false)).toEqual({ disponible: false, conversacionesVaciadas: 0, escalacionesBorradas: 0, notasBorradas: 0, protegidas: 0 });
    // Sin el SAVEPOINT la sesion quedaria abortada (25P02) y esta consulta fallaria.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error real (no de migracion pendiente) se propaga y tambien deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_purge_retencion/, respond: () => Object.assign(new Error("deadlock detected"), { code: "40P01" }) },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresCitasRepository(session).purgeRetentionBatch(500, false)).rejects.toMatchObject({ code: "40P01" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("base migrada: mapea solo conteos y manda limite y simulacion como parametros", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.system_purge_retencion/, respond: () => [{ out_conversaciones: 3, out_escalaciones: "2", out_notas: 1, out_protegidas: 4 }] }]);
    const spy = vi.spyOn(session, "query");
    const repo = new PostgresCitasRepository(session);
    expect(await repo.purgeRetentionBatch(500, true)).toEqual({ disponible: true, conversacionesVaciadas: 3, escalacionesBorradas: 2, notasBorradas: 1, protegidas: 4 });
    expect(spy.mock.calls.find((c) => String(c[0]).includes("system_purge_retencion"))![1]).toEqual([500, true]);
  });
});

describe("InMemoryCitasRepository.purgeRetentionBatch", () => {
  it("por omision no hay nada vencido; con null simula la base sin migrar", async () => {
    const repo = new InMemoryCitasRepository();
    expect(await repo.purgeRetentionBatch(500, false)).toMatchObject({ disponible: true, conversacionesVaciadas: 0 });
    repo.setRetentionPurgeBatches(null);
    expect(await repo.purgeRetentionBatch(500, false)).toMatchObject({ disponible: false });
  });
});
