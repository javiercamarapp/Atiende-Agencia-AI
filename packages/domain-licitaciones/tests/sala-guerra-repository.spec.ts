// L-04 -- repositorio de la sala de guerra: (1) compatibilidad con la base SIN MIGRAR sobre una sesion
// que reproduce el estado ABORTADO real de Postgres (AbortAwareFakeSession: una sesion falsa plana NO
// sirve), y (2) semantica de la version en memoria (unicidad de huella, estados y sellos).
import { describe, expect, it } from "vitest";
import { JuntaQuestionDuplicateError, JuntaQuestionRejectedError, questionDedupeKey } from "../src/junta-aclaraciones.ts";
import { InMemorySalaGuerraRepository, PostgresSalaGuerraRepository } from "../src/sala-guerra-repository.ts";
import { SalaGuerraNotAvailableError } from "../src/sala-guerra.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const TENDER = "00000000-0000-0000-0000-0000000000b1";
const ACTOR = "00000000-0000-0000-0000-0000000000c1";

function pgError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedTable = (t: string) => pgError(`relation "licitaciones.${t}" does not exist`, "42P01");
const undefinedFn = () => pgError("function licitaciones.system_record_junta_question_reminders(uuid, timestamp with time zone, timestamp with time zone) does not exist", "42883");
const undefinedColumn = () => pgError('column "responsible_user_id" does not exist', "42703");
const NEXT_QUERY = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

async function nextQueryWorks(session: AbortAwareFakeSession): Promise<void> {
  const { rows } = await session.query<{ ok: boolean }>("select 1 as siguiente_query_del_request;");
  expect(rows[0]?.ok).toBe(true);
}

describe("PostgresSalaGuerraRepository sobre una base sin la migracion 029", () => {
  it.each([
    ["listItems", (r: PostgresSalaGuerraRepository) => r.listItems(ORG, TENDER), /from licitaciones\.war_room_item/, undefinedTable("war_room_item")],
    ["listEntries", (r: PostgresSalaGuerraRepository) => r.listEntries(ORG, TENDER), /from licitaciones\.war_room_entry/, undefinedTable("war_room_entry")],
    ["getJuntaConfig", (r: PostgresSalaGuerraRepository) => r.getJuntaConfig(ORG, TENDER), /from licitaciones\.junta_aclaraciones/, undefinedTable("junta_aclaraciones")],
    ["listQuestions", (r: PostgresSalaGuerraRepository) => r.listQuestions(ORG, TENDER), /from licitaciones\.junta_question /, undefinedTable("junta_question")],
    ["listQuestionReminders", (r: PostgresSalaGuerraRepository) => r.listQuestionReminders(ORG, TENDER), /from licitaciones\.junta_question_reminder/, undefinedTable("junta_question_reminder")],
    ["scanJuntaQuestionReminders", (r: PostgresSalaGuerraRepository) => r.scanJuntaQuestionReminders(ORG), /system_record_junta_question_reminders/, undefinedFn()],
    ["createItem (42703)", (r: PostgresSalaGuerraRepository) => r.createItem(ORG, TENDER, { kind: "tarea", title: "Tarea de prueba" }, ACTOR), /insert into licitaciones\.war_room_item/, undefinedColumn()],
  ])("%s: 42P01/42703/42883 -> SalaGuerraNotAvailableError y la transaccion queda utilizable (sin 25P02)", async (_name, call, match, error) => {
    const session = new AbortAwareFakeSession([{ match, respond: () => error }, NEXT_QUERY]);
    const repo = new PostgresSalaGuerraRepository(session);
    await expect(call(repo)).rejects.toThrow(SalaGuerraNotAvailableError);
    expect(session.calls.some((c) => c.startsWith("savepoint"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await nextQueryWorks(session);
  });

  it("un error que NO es de migracion pendiente se repropaga tal cual (nunca se enmascara) y la sesion queda recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from licitaciones\.war_room_item/, respond: () => pgError("deadlock detected", "40P01") }, NEXT_QUERY]);
    const repo = new PostgresSalaGuerraRepository(session);
    await expect(repo.listItems(ORG, TENDER)).rejects.toMatchObject({ code: "40P01" });
    await nextQueryWorks(session);
  });

  it("createQuestion: 23505 (huella viva repetida) -> JuntaQuestionDuplicateError con la existente, sesion utilizable", async () => {
    const existing = {
      id: "q-existente",
      organization_id: ORG,
      tender_id: TENDER,
      question_text: "Pregunta original",
      base_reference: null,
      topic: "otro",
      priority: "media",
      dedupe_key: "pregunta original",
      origin: "manual",
      draft_missing_data: [],
      status: "borrador",
      created_by: ACTOR,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      approved_by: null,
      approved_at: null,
      sent_at: null,
      sent_by: null,
      sent_reference: null,
      answer_text: null,
      answer_acta_reference: null,
      answered_at: null,
      answered_by: null,
      discard_reason: null,
    };
    const session = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.junta_question /, respond: () => pgError("duplicate key value violates unique constraint", "23505") },
      { match: /from licitaciones\.junta_question where organization_id/, respond: () => [existing] },
      NEXT_QUERY,
    ]);
    const repo = new PostgresSalaGuerraRepository(session);
    const err = await repo
      .createQuestion(ORG, TENDER, { questionText: "Pregunta original duplicada", baseReference: null, topic: "otro", priority: "media", dedupeKey: "pregunta original", origin: "manual", draftMissingData: [] }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JuntaQuestionDuplicateError);
    expect((err as JuntaQuestionDuplicateError).existing?.id).toBe("q-existente");
    await nextQueryWorks(session);
  });

  it("createQuestion contra base sin migrar -> SalaGuerraNotAvailableError (no se confunde con un duplicado)", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into licitaciones\.junta_question /, respond: () => undefinedTable("junta_question") }, NEXT_QUERY]);
    const repo = new PostgresSalaGuerraRepository(session);
    await expect(repo.createQuestion(ORG, TENDER, { questionText: "Pregunta de prueba larga", baseReference: null, topic: "otro", priority: "media", dedupeKey: "k", origin: "manual", draftMissingData: [] }, ACTOR)).rejects.toThrow(SalaGuerraNotAvailableError);
    await nextQueryWorks(session);
  });
});

describe("InMemorySalaGuerraRepository", () => {
  const input = (text: string) => ({ questionText: text, baseReference: null, topic: "otro" as const, priority: "media" as const, dedupeKey: questionDedupeKey(text), origin: "manual" as const, draftMissingData: [] });

  it("no permite dos preguntas vivas con la misma huella, pero si tras descartar la primera", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const first = await repo.createQuestion(ORG, TENDER, input("Cual es el plazo de entrega de los bienes?"), ACTOR);
    await expect(repo.createQuestion(ORG, TENDER, input("cual es el PLAZO de entrega de los bienes"), ACTOR)).rejects.toThrow(JuntaQuestionDuplicateError);
    await repo.transitionQuestion(ORG, TENDER, first.id, { to: "descartada", discardReason: "duplicada" }, ACTOR);
    await expect(repo.createQuestion(ORG, TENDER, input("Cual es el plazo de entrega de los bienes?"), ACTOR)).resolves.toMatchObject({ status: "borrador" });
  });

  it("restaurar una descartada cuando ya hay otra viva equivalente -> duplicado", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const first = await repo.createQuestion(ORG, TENDER, input("Cual es el plazo de entrega de los bienes?"), ACTOR);
    await repo.transitionQuestion(ORG, TENDER, first.id, { to: "descartada", discardReason: "x" }, ACTOR);
    await repo.createQuestion(ORG, TENDER, input("Cual es el plazo de entrega de los bienes?"), ACTOR);
    await expect(repo.transitionQuestion(ORG, TENDER, first.id, { to: "borrador" }, ACTOR)).rejects.toThrow(JuntaQuestionDuplicateError);
  });

  it("aislamiento por organizacion y convocatoria", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const q = await repo.createQuestion(ORG, TENDER, input("Pregunta de la organizacion A"), ACTOR);
    expect(await repo.findQuestion("otra-org", TENDER, q.id)).toBeNull();
    expect(await repo.findQuestion(ORG, "otra-convocatoria", q.id)).toBeNull();
    expect(await repo.listQuestions("otra-org", TENDER)).toEqual([]);
  });

  it("ciclo completo: sellos de aprobacion/envio/respuesta y vinculo al acta; el grafo se hace cumplir", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const q = await repo.createQuestion(ORG, TENDER, input("Se requiere fianza de cumplimiento?"), ACTOR);
    await expect(repo.transitionQuestion(ORG, TENDER, q.id, { to: "enviada" }, ACTOR)).rejects.toThrow(JuntaQuestionRejectedError);
    const aprobada = await repo.transitionQuestion(ORG, TENDER, q.id, { to: "aprobada" }, "aprobador");
    expect(aprobada).toMatchObject({ status: "aprobada", approvedBy: "aprobador" });
    expect(aprobada!.approvedAt).not.toBeNull();
    const enviada = await repo.transitionQuestion(ORG, TENDER, q.id, { to: "enviada", sentReference: "Acuse 77" }, "quien-envia");
    expect(enviada).toMatchObject({ status: "enviada", sentBy: "quien-envia", sentReference: "Acuse 77" });
    const respondida = await repo.transitionQuestion(ORG, TENDER, q.id, { to: "respondida", answerText: "Si, del 10%.", answerActaReference: "Acta pregunta 3" }, "registrador");
    expect(respondida).toMatchObject({ status: "respondida", answerText: "Si, del 10%.", answerActaReference: "Acta pregunta 3", answeredBy: "registrador" });
    await expect(repo.transitionQuestion(ORG, TENDER, q.id, { to: "borrador" }, ACTOR)).rejects.toThrow(JuntaQuestionRejectedError);
  });

  it("devolver una aprobada a borrador invalida la aprobacion", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const q = await repo.createQuestion(ORG, TENDER, input("Pregunta para devolver a borrador"), ACTOR);
    await repo.transitionQuestion(ORG, TENDER, q.id, { to: "aprobada" }, ACTOR);
    const back = await repo.transitionQuestion(ORG, TENDER, q.id, { to: "borrador" }, ACTOR);
    expect(back).toMatchObject({ status: "borrador", approvedBy: null, approvedAt: null });
  });

  it("barrido de recordatorios: uno por convocatoria y dia, solo con preguntas sin enviar dentro de la ventana", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const repo = new InMemorySalaGuerraRepository({ now: () => now });
    await repo.upsertJuntaConfig(ORG, TENDER, { questionsDeadlineAt: "2026-10-03T12:00:00.000Z", meetingAt: null, actaReference: null }, ACTOR);
    expect((await repo.scanJuntaQuestionReminders(ORG, { nowIso: now.toISOString() })).created).toBe(0); // sin preguntas pendientes
    await repo.createQuestion(ORG, TENDER, input("Pregunta pendiente antes del limite"), ACTOR);
    const first = await repo.scanJuntaQuestionReminders(ORG, { nowIso: now.toISOString() });
    expect(first.created).toBe(1);
    expect(first.reminders[0]).toMatchObject({ pendingCount: 1, daysRemaining: 2 });
    expect((await repo.scanJuntaQuestionReminders(ORG, { nowIso: now.toISOString() })).created).toBe(0); // dedupe
    expect((await repo.scanJuntaQuestionReminders(ORG, { nowIso: now.toISOString(), windowDays: 1 })).created).toBe(0);
  });

  it("estado de un item: cerrar fija completedAt, reabrir lo limpia", async () => {
    const repo = new InMemorySalaGuerraRepository();
    const item = await repo.createItem(ORG, TENDER, { kind: "tarea", title: "Tarea de prueba" }, ACTOR);
    const done = await repo.updateItem(ORG, TENDER, item.id, { status: "listo" }, ACTOR);
    expect(done!.completedAt).not.toBeNull();
    const reopened = await repo.updateItem(ORG, TENDER, item.id, { status: "en_curso" }, ACTOR);
    expect(reopened!.completedAt).toBeNull();
  });
});
