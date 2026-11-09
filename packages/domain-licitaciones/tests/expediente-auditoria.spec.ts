// paridad3 L-P3-11 -- transiciones del auditor determinista del expediente y su persistencia (en memoria y contra la base sin la 039).
import { describe, expect, it } from "vitest";
import { clasificarExpediente, transicionDeExpediente } from "../src/expediente-auditoria.ts";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

describe("clasificarExpediente", () => {
  it("un checklist que NUNCA corrio es con bloqueos (nunca verde trivial)", () => {
    expect(clasificarExpediente([])).toEqual({ estado: "con_bloqueos", bloqueos: 1 });
  });
  it("solo el rojo bloquea: el ambar es advertencia", () => {
    expect(clasificarExpediente([{ result: "verde" }, { result: "ambar" }])).toEqual({ estado: "sin_bloqueos", bloqueos: 0 });
    expect(clasificarExpediente([{ result: "rojo" }, { result: "verde" }, { result: "rojo" }])).toEqual({ estado: "con_bloqueos", bloqueos: 2 });
  });
});

describe("transicionDeExpediente", () => {
  it("avisa solo al pasar de con bloqueos (o nunca auditado) a sin bloqueos", () => {
    expect(transicionDeExpediente("con_bloqueos", "sin_bloqueos")).toBe("listo_para_aprobar");
    expect(transicionDeExpediente(null, "sin_bloqueos")).toBe("listo_para_aprobar");
    expect(transicionDeExpediente("sin_bloqueos", "sin_bloqueos")).toBe("sin_cambio");
    expect(transicionDeExpediente("sin_bloqueos", "con_bloqueos")).toBe("sin_cambio");
    expect(transicionDeExpediente("con_bloqueos", "con_bloqueos")).toBe("sin_cambio");
    expect(transicionDeExpediente(null, "con_bloqueos")).toBe("sin_cambio");
  });
});

describe("persistencia del ultimo estado auditado", () => {
  it("en memoria: guarda y lee por propuesta; una propuesta ajena se rechaza", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual("org-1", { title: "T", submissionDeadline: null, externalId: "x", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null, actorId: "u" });
    const proposal = await repo.getOrCreateProposal("org-1", tender.id, "u", "P");
    expect(await repo.getExpedienteAuditoria("org-1", proposal.id)).toEqual({ disponible: true, registro: null });
    expect(await repo.saveExpedienteAuditoria("org-1", { proposalId: proposal.id, tenderId: tender.id, estado: "sin_bloqueos", bloqueos: 0, inputsHash: "h" })).toBe(true);
    expect((await repo.getExpedienteAuditoria("org-1", proposal.id)).registro).toMatchObject({ estado: "sin_bloqueos", bloqueos: 0, inputsHash: "h" });
    await expect(repo.getExpedienteAuditoria("org-2", proposal.id)).rejects.toThrow();
  });

  it("base SIN la migracion 039: leer devuelve disponible=false y guardar false, con SAVEPOINT y sesion utilizable", async () => {
    const sinTabla = Object.assign(new Error('relation "licitaciones.expediente_auditoria" does not exist'), { code: "42P01" });
    const session = new AbortAwareFakeSession([
      { match: /expediente_auditoria/, respond: () => sinTabla },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    expect(await repo.getExpedienteAuditoria("org-1", "p-1")).toEqual({ disponible: false, registro: null });
    expect(await repo.saveExpedienteAuditoria("org-1", { proposalId: "p-1", tenderId: "t-1", estado: "con_bloqueos", bloqueos: 1, inputsHash: "h" })).toBe(false);
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(2);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
