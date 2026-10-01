// L-04 -- barrido de recordatorios de la fecha limite de envio de preguntas a la junta de
// aclaraciones (mismo cron que los recordatorios de plazo de presentacion).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySalaGuerraRepository, SalaGuerraNotAvailableError } from "@atiende/domain-licitaciones";
import type { SalaGuerraRepository } from "@atiende/domain-licitaciones";
import { runJuntaQuestionReminderSweep } from "../src/jobs/licitaciones/junta-question-reminders.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ACTOR = randomUUID();

async function seed(repo: InMemorySalaGuerraRepository, organizationId: string, deadlineIso: string, withQuestion = true): Promise<string> {
  const tenderId = randomUUID();
  await repo.upsertJuntaConfig(organizationId, tenderId, { questionsDeadlineAt: deadlineIso, meetingAt: null, actaReference: null }, ACTOR);
  if (withQuestion) {
    await repo.createQuestion(organizationId, tenderId, { questionText: "Cual es el plazo de entrega de los bienes?", baseReference: null, topic: "otro", priority: "media", dedupeKey: `k-${tenderId}`, origin: "manual", draftMissingData: [] }, ACTOR);
  }
  return tenderId;
}

describe("runJuntaQuestionReminderSweep", () => {
  it("crea un recordatorio por convocatoria con preguntas sin enviar dentro de la ventana, y no duplica al reescanear", async () => {
    const repo = new InMemorySalaGuerraRepository({ now: () => NOW });
    const org = randomUUID();
    await seed(repo, org, "2026-10-03T12:00:00.000Z");
    await seed(repo, org, "2026-10-03T12:00:00.000Z", false); // sin preguntas: nada que recordar
    await seed(repo, org, "2026-12-30T12:00:00.000Z"); // fuera de la ventana
    const first = await runJuntaQuestionReminderSweep([org], async (fn) => fn(repo), { now: () => NOW });
    expect(first).toEqual([{ organizationId: org, created: 1 }]);
    const second = await runJuntaQuestionReminderSweep([org], async (fn) => fn(repo), { now: () => new Date(NOW.getTime() + 60_000) });
    expect(second).toEqual([{ organizationId: org, created: 0 }]);
    expect(await repo.listQuestionReminders(org)).toHaveLength(1);
  });

  it("base sin migrar (SalaGuerraNotAvailableError) -> unavailable:true, NO es un fallo", async () => {
    const unavailable = new Proxy({} as SalaGuerraRepository, {
      get: () => async () => {
        throw new SalaGuerraNotAvailableError();
      },
    });
    const org = randomUUID();
    expect(await runJuntaQuestionReminderSweep([org], async (fn) => fn(unavailable))).toEqual([{ organizationId: org, created: 0, unavailable: true }]);
  });

  it("un fallo real en UNA organizacion no detiene a las demas", async () => {
    const repo = new InMemorySalaGuerraRepository({ now: () => NOW });
    const bad = randomUUID();
    const good = randomUUID();
    await seed(repo, good, "2026-10-03T12:00:00.000Z");
    const results = await runJuntaQuestionReminderSweep(
      [bad, good],
      async (fn) =>
        fn({
          scanJuntaQuestionReminders: async (orgId: string, input?: Parameters<SalaGuerraRepository["scanJuntaQuestionReminders"]>[1]) => {
            if (orgId === bad) throw new Error("fallo simulado");
            return repo.scanJuntaQuestionReminders(orgId, input);
          },
        } as unknown as SalaGuerraRepository),
      { now: () => NOW },
    );
    expect(results.find((r) => r.organizationId === bad)).toMatchObject({ error: "fallo simulado", created: 0 });
    expect(results.find((r) => r.organizationId === good)).toEqual({ organizationId: good, created: 1 });
  });
});
