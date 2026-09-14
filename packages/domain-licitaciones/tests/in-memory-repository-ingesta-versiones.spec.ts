// Fase 5 — pruebas de integración del repositorio in-memory contra el
// andamiaje de ingesta (source_run, REQ-004/005/146..150) y el historial de
// versiones de convocatoria + cascada de invalidación (REQ-017/041/151..155).
// Mismo repositorio real (no mock) que usan los tests HTTP (fixtures.ts).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import type { TenderUpsertInput } from "../src/repository.ts";

const ORG = "org-1";

function baseInput(overrides: Partial<TenderUpsertInput> = {}): TenderUpsertInput {
  return {
    title: "Adquisición de equipo de cómputo",
    submissionDeadline: "2026-12-15T18:00:00-06:00",
    externalId: "LA-01/2026",
    contractingBody: "Secretaría de prueba",
    cpvCodes: ["30200000"],
    budgetAmount: 250_000,
    currency: "MXN",
    state: "CDMX",
    procedureTypeRaw: "licitacion_publica",
    actorId: "user-1",
    ...overrides,
  };
}

describe("InMemoryLicitacionesRepository -- andamiaje de ingesta (REQ-004/005/146..150)", () => {
  it("cada alta manual registra automáticamente una corrida 'ok' del conector 'manual' (REQ-147)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.upsertTenderManual(ORG, baseInput());
    const runs = await repo.listSourceRuns(ORG);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.source).toBe("manual");
    expect(runs[0]!.state).toBe("ok");
    expect(runs[0]!.evidence.coverage).toEqual({ expected: 1, obtained: 1 });
  });

  it("cada actualización manual TAMBIÉN registra su propia corrida -- el historial reconstruye TODAS las corridas, no solo la última", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.upsertTenderManual(ORG, baseInput());
    await repo.upsertTenderManual(ORG, baseInput({ title: "Título actualizado" }));
    const runs = await repo.listSourceRuns(ORG, { source: "manual" });
    expect(runs).toHaveLength(2);
  });

  it("listSourceRuns filtra por fuente y respeta limit", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.upsertTenderManual(ORG, baseInput());
    await repo.upsertTenderManual(ORG, baseInput({ externalId: "LA-02/2026" }));
    expect(await repo.listSourceRuns(ORG, { source: "comprasmx" })).toHaveLength(0);
    expect(await repo.listSourceRuns(ORG, { limit: 1 })).toHaveLength(1);
  });

  it("sourceFreshness incluye las 7 fuentes registradas aunque 6 nunca hayan corrido (REQ-149: nunca se oculta la obsolescencia)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.upsertTenderManual(ORG, baseInput());
    const freshness = await repo.sourceFreshness(ORG);
    expect(freshness).toHaveLength(7);
    const manual = freshness.find((f) => f.source === "manual")!;
    expect(manual.stale).toBe(false);
    expect(manual.lastSuccessAt).not.toBeNull();
    const comprasmx = freshness.find((f) => f.source === "comprasmx")!;
    expect(comprasmx.stale).toBe(true); // nunca corrió -> obsoleto explícito, nunca "0 de antigüedad".
    expect(comprasmx.lastSuccessAt).toBeNull();
  });

  it("recordSourceRun preserva estados explícitos no-'ok' (REQ-148: nunca se traduce un fallo a silencio)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.recordSourceRun(ORG, {
      source: "comprasmx",
      state: "captcha_detected",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:05Z",
      evidence: { message: "reCAPTCHA detectado", httpStatus: 200 },
      correlationId: null,
    });
    const runs = await repo.listSourceRuns(ORG, { source: "comprasmx" });
    expect(runs[0]!.state).toBe("captcha_detected");
    const freshness = (await repo.sourceFreshness(ORG)).find((f) => f.source === "comprasmx")!;
    expect(freshness.lastRunState).toBe("captcha_detected");
    expect(freshness.lastSuccessAt).toBeNull(); // un captcha detectado NUNCA cuenta como éxito.
  });
});

describe("InMemoryLicitacionesRepository -- historial de versiones de convocatoria (REQ-017/041/151..155)", () => {
  it("el alta manual crea la versión 1 (convocatoria_nueva), sin cascada (no hay propuesta todavía)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual(ORG, baseInput());
    const versions = await repo.listTenderVersions(ORG, tender.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    const notifications = await repo.listTenderChangeNotifications(ORG, tender.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.reason).toBe("convocatoria_nueva");
    expect(notifications[0]!.notifiedRoles).toContain("owner");
  });

  it("reingestar el MISMO externalId sin cambios reales -> no crea versión nueva ni notificación (REQ-152/154: dedupe + idempotencia)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const input = baseInput();
    await repo.upsertTenderManual(ORG, input);
    const { tender } = await repo.upsertTenderManual(ORG, input); // MISMO input exacto.
    const versions = await repo.listTenderVersions(ORG, tender.id);
    expect(versions).toHaveLength(1); // sigue siendo solo la versión 1.
    expect(await repo.listTenderChangeNotifications(ORG, tender.id)).toHaveLength(1);
  });

  it("cambiar un campo de bases crea la versión 2 con el diff correcto y una notificación de actualización", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual(ORG, baseInput());
    await repo.upsertTenderManual(ORG, baseInput({ budgetAmount: 500_000 }));
    const versions = await repo.listTenderVersions(ORG, tender.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.diff.changedFieldNames).toEqual(["budgetAmount"]);
    const notifications = await repo.listTenderChangeNotifications(ORG, tender.id);
    expect(notifications[0]!.reason).toBe("convocatoria_actualizada:v2"); // más reciente primero.
  });

  it("REQ-155: cambiar el presupuesto invalida la aprobación 'expediente' vigente de la propuesta abierta", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual(ORG, baseInput());
    const proposal = await repo.getOrCreateProposal(ORG, tender.id, "user-1", "Propuesta");
    // Aprobar requiere un HashedInputs sellado real -- se construye vía sealInputs para no violar el guardia EX-EXP-17.
    const { sealInputs } = await import("../src/sealed-inputs.ts");
    const realSealed = sealInputs({ tenderVersionHash: "x", companyProfileHash: "y", companyDocuments: [], rates: [], templates: [] });
    await repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "owner-1", actorRole: "owner", inputsHash: realSealed });
    expect(await repo.activeApprovalsCovering(ORG, proposal.id, "expediente")).toHaveLength(1);

    await repo.upsertTenderManual(ORG, baseInput({ budgetAmount: 999_999 }));

    expect(await repo.activeApprovalsCovering(ORG, proposal.id, "expediente")).toHaveLength(0);
  });

  it("recordTenderVersion es idempotente: llamarlo dos veces seguidas sin cambios reales entre medio no duplica cascada/notificación (REQ-154)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual(ORG, baseInput());
    const first = await repo.recordTenderVersion(ORG, tender.id, "user-1");
    expect(first.created).toBe(false); // ya se creó la v1 dentro de upsertTenderManual; nada cambió desde entonces.
    const second = await repo.recordTenderVersion(ORG, tender.id, "user-1");
    expect(second.created).toBe(false);
    expect(await repo.listTenderVersions(ORG, tender.id)).toHaveLength(1);
  });

  it("acknowledgeTenderChangeNotification marca la notificación como reconocida", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const { tender } = await repo.upsertTenderManual(ORG, baseInput());
    const [notification] = await repo.listTenderChangeNotifications(ORG, tender.id);
    const acknowledged = await repo.acknowledgeTenderChangeNotification(ORG, notification!.id, "owner-1");
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    expect(acknowledged.acknowledgedBy).toBe("owner-1");
  });

  it("acknowledgeTenderChangeNotification lanza si la notificación no existe", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await expect(repo.acknowledgeTenderChangeNotification(ORG, randomUUID(), "owner-1")).rejects.toThrow(/no encontrada/);
  });

  it("listTenderChangeNotifications sin tenderId lista TODAS las de la organización", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.upsertTenderManual(ORG, baseInput());
    await repo.upsertTenderManual(ORG, baseInput({ externalId: "LA-02/2026" }));
    expect(await repo.listTenderChangeNotifications(ORG)).toHaveLength(2);
  });
});
