// L-04 -- almacenamiento de la sala de guerra y de las preguntas de junta de
// aclaraciones (tablas de la migracion 029). Modulo APARTE de `repository.ts`/
// `postgres-repository.ts` a proposito: son ~13k lineas compartidas por varias
// ramas en paralelo y este vertical nuevo no necesita tocarlas.
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que
// la migracion 029. Cada operacion de `PostgresSalaGuerraRepository` corre dentro
// de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque
// `dbSession` es UNA sola transaccion por request: un 42P01/42703/42883 sin
// savepoint la dejaria abortada (25P02) y el COMMIT revertiria todo en silencio.
// Si las tablas no existen se lanza `SalaGuerraNotAvailableError` (la ruta lo
// traduce a "no disponible aun" en lecturas y a 503 en escrituras), nunca un 500.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  JuntaQuestionDuplicateError,
  JuntaQuestionRejectedError,
  canTransitionQuestion,
  questionDedupeKey,
} from "./junta-aclaraciones.ts";
import type {
  JuntaConfigInput,
  JuntaConfigRecord,
  JuntaQuestionCreateInput,
  JuntaQuestionPatch,
  JuntaQuestionRecord,
  JuntaQuestionReminderRecord,
  JuntaTransitionRequest,
} from "./junta-aclaraciones.ts";
import { SalaGuerraNotAvailableError, SalaGuerraValidationError } from "./sala-guerra.ts";
import type { WarRoomEntryKind, WarRoomEntryRecord, WarRoomItemCreateInput, WarRoomItemPatch, WarRoomItemRecord } from "./sala-guerra.ts";

export interface ScanJuntaRemindersInput {
  readonly windowDays?: number;
  readonly nowIso?: string;
}

export interface ScanJuntaRemindersResult {
  readonly created: number;
  readonly reminders: readonly JuntaQuestionReminderRecord[];
}

export interface SalaGuerraRepository {
  listItems(organizationId: string, tenderId: string): Promise<readonly WarRoomItemRecord[]>;
  createItem(organizationId: string, tenderId: string, input: WarRoomItemCreateInput, actorId: string): Promise<WarRoomItemRecord>;
  updateItem(organizationId: string, tenderId: string, itemId: string, patch: WarRoomItemPatch, actorId: string): Promise<WarRoomItemRecord | null>;
  findItem(organizationId: string, tenderId: string, itemId: string): Promise<WarRoomItemRecord | null>;

  listEntries(organizationId: string, tenderId: string, limit?: number): Promise<readonly WarRoomEntryRecord[]>;
  addEntry(organizationId: string, tenderId: string, input: { entryKind: WarRoomEntryKind; body: string; itemId: string | null }, actorId: string): Promise<WarRoomEntryRecord>;

  getJuntaConfig(organizationId: string, tenderId: string): Promise<JuntaConfigRecord | null>;
  upsertJuntaConfig(organizationId: string, tenderId: string, input: JuntaConfigInput, actorId: string): Promise<JuntaConfigRecord>;

  listQuestions(organizationId: string, tenderId: string): Promise<readonly JuntaQuestionRecord[]>;
  findQuestion(organizationId: string, tenderId: string, questionId: string): Promise<JuntaQuestionRecord | null>;
  /** Lanza `JuntaQuestionDuplicateError` si ya hay una pregunta viva con la misma huella. */
  createQuestion(organizationId: string, tenderId: string, input: JuntaQuestionCreateInput, actorId: string): Promise<JuntaQuestionRecord>;
  /** Edita texto/referencia/tema/prioridad (la huella se recalcula si cambia el texto). `null` si no existe. */
  updateQuestion(organizationId: string, tenderId: string, questionId: string, patch: JuntaQuestionPatch): Promise<JuntaQuestionRecord | null>;
  transitionQuestion(organizationId: string, tenderId: string, questionId: string, request: JuntaTransitionRequest, actorId: string): Promise<JuntaQuestionRecord | null>;

  listQuestionReminders(organizationId: string, tenderId?: string): Promise<readonly JuntaQuestionReminderRecord[]>;
  acknowledgeQuestionReminder(organizationId: string, reminderId: string, actorId: string): Promise<JuntaQuestionReminderRecord | null>;
  /** Barrido de SISTEMA (cron de recordatorios de plazo, `auth.uid()` NULL). */
  scanJuntaQuestionReminders(organizationId: string, input?: ScanJuntaRemindersInput): Promise<ScanJuntaRemindersResult>;
}

// ===========================================================================
// Postgres
// ===========================================================================

const TS = (col: string, alias = col): string => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${alias}`;

const ITEM_COLS = `id, organization_id, tender_id, kind, title, description, status, severity, responsible_user_id, ${TS("due_at")}, requirement_item_id, created_by, ${TS("created_at")}, updated_by, ${TS("updated_at")}, ${TS("completed_at")}`;

interface ItemRow {
  id: string;
  organization_id: string;
  tender_id: string;
  kind: WarRoomItemRecord["kind"];
  title: string;
  description: string | null;
  status: WarRoomItemRecord["status"];
  severity: WarRoomItemRecord["severity"];
  responsible_user_id: string | null;
  due_at: string | null;
  requirement_item_id: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  completed_at: string | null;
}

function mapItem(r: ItemRow): WarRoomItemRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    tenderId: r.tender_id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    status: r.status,
    severity: r.severity,
    responsibleUserId: r.responsible_user_id,
    dueAt: r.due_at,
    requirementItemId: r.requirement_item_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

const ENTRY_COLS = `id, organization_id, tender_id, item_id, entry_kind, body, author_id, ${TS("created_at")}`;

interface EntryRow {
  id: string;
  organization_id: string;
  tender_id: string;
  item_id: string | null;
  entry_kind: WarRoomEntryKind;
  body: string;
  author_id: string;
  created_at: string;
}

function mapEntry(r: EntryRow): WarRoomEntryRecord {
  return { id: r.id, organizationId: r.organization_id, tenderId: r.tender_id, itemId: r.item_id, entryKind: r.entry_kind, body: r.body, authorId: r.author_id, createdAt: r.created_at };
}

const CONFIG_COLS = `tender_id, organization_id, ${TS("questions_deadline_at")}, ${TS("meeting_at")}, acta_reference, updated_by, ${TS("updated_at")}`;

interface ConfigRow {
  tender_id: string;
  organization_id: string;
  questions_deadline_at: string | null;
  meeting_at: string | null;
  acta_reference: string | null;
  updated_by: string | null;
  updated_at: string;
}

function mapConfig(r: ConfigRow): JuntaConfigRecord {
  return { tenderId: r.tender_id, organizationId: r.organization_id, questionsDeadlineAt: r.questions_deadline_at, meetingAt: r.meeting_at, actaReference: r.acta_reference, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

const QUESTION_COLS = `id, organization_id, tender_id, question_text, base_reference, topic, priority, dedupe_key, origin, draft_missing_data, status, created_by, ${TS("created_at")}, ${TS("updated_at")}, approved_by, ${TS("approved_at")}, ${TS("sent_at")}, sent_by, sent_reference, answer_text, answer_acta_reference, ${TS("answered_at")}, answered_by, discard_reason`;

interface QuestionRow {
  id: string;
  organization_id: string;
  tender_id: string;
  question_text: string;
  base_reference: string | null;
  topic: JuntaQuestionRecord["topic"];
  priority: JuntaQuestionRecord["priority"];
  dedupe_key: string;
  origin: JuntaQuestionRecord["origin"];
  draft_missing_data: string[] | null;
  status: JuntaQuestionRecord["status"];
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  sent_by: string | null;
  sent_reference: string | null;
  answer_text: string | null;
  answer_acta_reference: string | null;
  answered_at: string | null;
  answered_by: string | null;
  discard_reason: string | null;
}

function mapQuestion(r: QuestionRow): JuntaQuestionRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    tenderId: r.tender_id,
    questionText: r.question_text,
    baseReference: r.base_reference,
    topic: r.topic,
    priority: r.priority,
    dedupeKey: r.dedupe_key,
    origin: r.origin,
    draftMissingData: r.draft_missing_data ?? [],
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    sentBy: r.sent_by,
    sentReference: r.sent_reference,
    answerText: r.answer_text,
    answerActaReference: r.answer_acta_reference,
    answeredAt: r.answered_at,
    answeredBy: r.answered_by,
    discardReason: r.discard_reason,
  };
}

const REMINDER_COLS = `id, organization_id, tender_id, ${TS("questions_deadline_at")}, days_remaining, pending_count, message, ${TS("created_at")}, ${TS("acknowledged_at")}, acknowledged_by`;

interface ReminderRow {
  id: string;
  organization_id: string;
  tender_id: string;
  questions_deadline_at: string;
  days_remaining: number;
  pending_count: number;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

function mapReminder(r: ReminderRow): JuntaQuestionReminderRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    tenderId: r.tender_id,
    questionsDeadlineAt: r.questions_deadline_at,
    daysRemaining: r.days_remaining,
    pendingCount: r.pending_count,
    message: r.message,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

export class PostgresSalaGuerraRepository implements SalaGuerraRepository {
  constructor(private readonly db: TenantDbSession) {}

  /**
   * Corre `primary` en un SAVEPOINT. Base sin migrar (42P01/42703/42883) -> `SalaGuerraNotAvailableError`
   * con la sesion ya recuperada. Con `onUnique`, una violacion de unicidad (23505) se recupera igual y
   * `onUnique` corre con la sesion utilizable (para consultar la fila existente).
   */
  private guarded<T>(primary: () => Promise<T>, onUnique?: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: (err) => isMigrationPendingError(err) || (onUnique !== undefined && pgCode(err) === "23505"),
      fallback: async (err) => {
        if (isMigrationPendingError(err)) throw new SalaGuerraNotAvailableError();
        return onUnique!();
      },
    });
  }

  // ---- tablero ----

  async listItems(organizationId: string, tenderId: string): Promise<readonly WarRoomItemRecord[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ItemRow>(`select ${ITEM_COLS} from licitaciones.war_room_item where organization_id = $1 and tender_id = $2 order by created_at asc, id asc;`, [organizationId, tenderId]);
      return rows.map(mapItem);
    });
  }

  async findItem(organizationId: string, tenderId: string, itemId: string): Promise<WarRoomItemRecord | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ItemRow>(`select ${ITEM_COLS} from licitaciones.war_room_item where organization_id = $1 and tender_id = $2 and id = $3;`, [organizationId, tenderId, itemId]);
      return rows[0] ? mapItem(rows[0]) : null;
    });
  }

  async createItem(organizationId: string, tenderId: string, input: WarRoomItemCreateInput, actorId: string): Promise<WarRoomItemRecord> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ItemRow>(
        `insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, description, severity, responsible_user_id, due_at, requirement_item_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)
         returning ${ITEM_COLS};`,
        [organizationId, tenderId, input.kind, input.title, input.description ?? null, input.severity ?? null, input.responsibleUserId ?? null, input.dueAt ?? null, input.requirementItemId ?? null, actorId],
      );
      return mapItem(rows[0]!);
    },
    async () => {
      throw new SalaGuerraValidationError("requirementItemId: ese requisito ya esta en el tablero de esta convocatoria.");
    });
  }

  async updateItem(organizationId: string, tenderId: string, itemId: string, patch: WarRoomItemPatch, _actorId: string): Promise<WarRoomItemRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [organizationId, tenderId, itemId];
    const add = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.description !== undefined) add("description", patch.description);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.severity !== undefined) add("severity", patch.severity);
    if (patch.responsibleUserId !== undefined) add("responsible_user_id", patch.responsibleUserId);
    if (patch.dueAt !== undefined) add("due_at", patch.dueAt, "::timestamptz");
    if (sets.length === 0) return this.findItem(organizationId, tenderId, itemId);
    return this.guarded(async () => {
      const { rows } = await this.db.query<ItemRow>(`update licitaciones.war_room_item set ${sets.join(", ")} where organization_id = $1 and tender_id = $2 and id = $3 returning ${ITEM_COLS};`, params);
      return rows[0] ? mapItem(rows[0]) : null;
    });
  }

  async listEntries(organizationId: string, tenderId: string, limit = 200): Promise<readonly WarRoomEntryRecord[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<EntryRow>(`select ${ENTRY_COLS} from licitaciones.war_room_entry where organization_id = $1 and tender_id = $2 order by created_at desc, id desc limit $3;`, [organizationId, tenderId, limit]);
      return rows.map(mapEntry);
    });
  }

  async addEntry(organizationId: string, tenderId: string, input: { entryKind: WarRoomEntryKind; body: string; itemId: string | null }, actorId: string): Promise<WarRoomEntryRecord> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<EntryRow>(
        `insert into licitaciones.war_room_entry (organization_id, tender_id, item_id, entry_kind, body, author_id) values ($1, $2, $3, $4, $5, $6) returning ${ENTRY_COLS};`,
        [organizationId, tenderId, input.itemId, input.entryKind, input.body, actorId],
      );
      return mapEntry(rows[0]!);
    });
  }

  // ---- junta de aclaraciones ----

  async getJuntaConfig(organizationId: string, tenderId: string): Promise<JuntaConfigRecord | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ConfigRow>(`select ${CONFIG_COLS} from licitaciones.junta_aclaraciones where organization_id = $1 and tender_id = $2;`, [organizationId, tenderId]);
      return rows[0] ? mapConfig(rows[0]) : null;
    });
  }

  async upsertJuntaConfig(organizationId: string, tenderId: string, input: JuntaConfigInput, actorId: string): Promise<JuntaConfigRecord> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ConfigRow>(
        `insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, acta_reference, updated_by)
         values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
         on conflict (tender_id) do update set questions_deadline_at = excluded.questions_deadline_at, meeting_at = excluded.meeting_at,
           acta_reference = excluded.acta_reference, updated_by = excluded.updated_by, updated_at = now()
         returning ${CONFIG_COLS};`,
        [tenderId, organizationId, input.questionsDeadlineAt, input.meetingAt, input.actaReference, actorId],
      );
      return mapConfig(rows[0]!);
    });
  }

  async listQuestions(organizationId: string, tenderId: string): Promise<readonly JuntaQuestionRecord[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<QuestionRow>(`select ${QUESTION_COLS} from licitaciones.junta_question where organization_id = $1 and tender_id = $2 order by created_at asc, id asc;`, [organizationId, tenderId]);
      return rows.map(mapQuestion);
    });
  }

  async findQuestion(organizationId: string, tenderId: string, questionId: string): Promise<JuntaQuestionRecord | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<QuestionRow>(`select ${QUESTION_COLS} from licitaciones.junta_question where organization_id = $1 and tender_id = $2 and id = $3;`, [organizationId, tenderId, questionId]);
      return rows[0] ? mapQuestion(rows[0]) : null;
    });
  }

  private async findLiveByDedupeKey(organizationId: string, tenderId: string, dedupeKey: string): Promise<JuntaQuestionRecord | null> {
    const { rows } = await this.db.query<QuestionRow>(
      `select ${QUESTION_COLS} from licitaciones.junta_question where organization_id = $1 and tender_id = $2 and dedupe_key = $3 and status <> 'descartada' limit 1;`,
      [organizationId, tenderId, dedupeKey],
    );
    return rows[0] ? mapQuestion(rows[0]) : null;
  }

  async createQuestion(organizationId: string, tenderId: string, input: JuntaQuestionCreateInput, actorId: string): Promise<JuntaQuestionRecord> {
    return this.guarded(
      async () => {
        const { rows } = await this.db.query<QuestionRow>(
          `insert into licitaciones.junta_question (organization_id, tender_id, question_text, base_reference, topic, priority, dedupe_key, origin, draft_missing_data, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)
           returning ${QUESTION_COLS};`,
          [organizationId, tenderId, input.questionText, input.baseReference, input.topic, input.priority, input.dedupeKey, input.origin, [...input.draftMissingData], actorId],
        );
        return mapQuestion(rows[0]!);
      },
      async () => {
        throw new JuntaQuestionDuplicateError(await this.findLiveByDedupeKey(organizationId, tenderId, input.dedupeKey));
      },
    );
  }

  async updateQuestion(organizationId: string, tenderId: string, questionId: string, patch: JuntaQuestionPatch): Promise<JuntaQuestionRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [organizationId, tenderId, questionId];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.questionText !== undefined) {
      add("question_text", patch.questionText);
      add("dedupe_key", questionDedupeKey(patch.questionText));
    }
    if (patch.baseReference !== undefined) add("base_reference", patch.baseReference);
    if (patch.topic !== undefined) add("topic", patch.topic);
    if (patch.priority !== undefined) add("priority", patch.priority);
    if (sets.length === 0) return this.findQuestion(organizationId, tenderId, questionId);
    return this.guarded(
      async () => {
        const { rows } = await this.db.query<QuestionRow>(`update licitaciones.junta_question set ${sets.join(", ")} where organization_id = $1 and tender_id = $2 and id = $3 returning ${QUESTION_COLS};`, params);
        return rows[0] ? mapQuestion(rows[0]) : null;
      },
      async () => {
        const key = patch.questionText !== undefined ? questionDedupeKey(patch.questionText) : "";
        throw new JuntaQuestionDuplicateError(await this.findLiveByDedupeKey(organizationId, tenderId, key));
      },
    );
  }

  async transitionQuestion(organizationId: string, tenderId: string, questionId: string, request: JuntaTransitionRequest, _actorId: string): Promise<JuntaQuestionRecord | null> {
    // Los sellos (approved_*/sent_*/answered_*) los fija el trigger de la base desde `auth.uid()`;
    // aqui solo se envian los campos que el cliente SI puede escribir (GRANT por columna).
    const sets = ["status = $4"];
    const params: unknown[] = [organizationId, tenderId, questionId, request.to];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (request.to === "enviada" && request.sentReference !== undefined) add("sent_reference", request.sentReference ?? null);
    if (request.to === "respondida") {
      add("answer_text", request.answerText ?? null);
      add("answer_acta_reference", request.answerActaReference ?? null);
    }
    if (request.to === "descartada") add("discard_reason", request.discardReason ?? null);
    return this.guarded(
      async () => {
        const { rows } = await this.db.query<QuestionRow>(`update licitaciones.junta_question set ${sets.join(", ")} where organization_id = $1 and tender_id = $2 and id = $3 returning ${QUESTION_COLS};`, params);
        return rows[0] ? mapQuestion(rows[0]) : null;
      },
      // 23505 al volver de descartada a borrador: ya hay otra pregunta viva equivalente.
      async () => {
        const current = await this.findQuestion(organizationId, tenderId, questionId);
        throw new JuntaQuestionDuplicateError(current ? await this.findLiveByDedupeKey(organizationId, tenderId, current.dedupeKey) : null);
      },
    );
  }

  // ---- recordatorios ----

  async listQuestionReminders(organizationId: string, tenderId?: string): Promise<readonly JuntaQuestionReminderRecord[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ReminderRow>(
        tenderId
          ? `select ${REMINDER_COLS} from licitaciones.junta_question_reminder where organization_id = $1 and tender_id = $2 order by created_at desc;`
          : `select ${REMINDER_COLS} from licitaciones.junta_question_reminder where organization_id = $1 order by created_at desc;`,
        tenderId ? [organizationId, tenderId] : [organizationId],
      );
      return rows.map(mapReminder);
    });
  }

  async acknowledgeQuestionReminder(organizationId: string, reminderId: string, actorId: string): Promise<JuntaQuestionReminderRecord | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ReminderRow>(
        `update licitaciones.junta_question_reminder set acknowledged_at = now(), acknowledged_by = $3 where organization_id = $1 and id = $2 returning ${REMINDER_COLS};`,
        [organizationId, reminderId, actorId],
      );
      return rows[0] ? mapReminder(rows[0]) : null;
    });
  }

  async scanJuntaQuestionReminders(organizationId: string, input: ScanJuntaRemindersInput = {}): Promise<ScanJuntaRemindersResult> {
    const windowDays = input.windowDays ?? 3;
    const now = input.nowIso ? new Date(input.nowIso) : new Date();
    const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    return this.guarded(async () => {
      const { rows } = await this.db.query<{
        out_id: string;
        out_tender_id: string;
        out_questions_deadline_at: string;
        out_days_remaining: number;
        out_pending_count: number;
        out_message: string;
        out_created_at: string;
      }>(`select * from licitaciones.system_record_junta_question_reminders($1, $2, $3);`, [organizationId, now.toISOString(), windowEnd.toISOString()]);
      const reminders = rows.map(
        (r): JuntaQuestionReminderRecord => ({
          id: r.out_id,
          organizationId,
          tenderId: r.out_tender_id,
          questionsDeadlineAt: new Date(r.out_questions_deadline_at).toISOString(),
          daysRemaining: r.out_days_remaining,
          pendingCount: r.out_pending_count,
          message: r.out_message,
          createdAt: new Date(r.out_created_at).toISOString(),
          acknowledgedAt: null,
          acknowledgedBy: null,
        }),
      );
      return { created: reminders.length, reminders };
    });
  }
}

// ===========================================================================
// En memoria (pruebas y desarrollo sin base) -- misma semantica que la base:
// unicidad de huella viva, maquina de estados y sellos.
// ===========================================================================

export interface InMemorySalaGuerraOptions {
  readonly now?: () => Date;
}

export class InMemorySalaGuerraRepository implements SalaGuerraRepository {
  private readonly items = new Map<string, WarRoomItemRecord>();
  private readonly entries: WarRoomEntryRecord[] = [];
  private readonly configs = new Map<string, JuntaConfigRecord>();
  private readonly questions = new Map<string, JuntaQuestionRecord>();
  private readonly reminders = new Map<string, JuntaQuestionReminderRecord>();
  private readonly reminderKeys = new Set<string>();
  private readonly now: () => Date;

  constructor(options: InMemorySalaGuerraOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  async listItems(organizationId: string, tenderId: string): Promise<readonly WarRoomItemRecord[]> {
    return [...this.items.values()].filter((i) => i.organizationId === organizationId && i.tenderId === tenderId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findItem(organizationId: string, tenderId: string, itemId: string): Promise<WarRoomItemRecord | null> {
    const item = this.items.get(itemId);
    return item && item.organizationId === organizationId && item.tenderId === tenderId ? item : null;
  }

  async createItem(organizationId: string, tenderId: string, input: WarRoomItemCreateInput, actorId: string): Promise<WarRoomItemRecord> {
    if (input.requirementItemId) {
      const dup = [...this.items.values()].some((i) => i.tenderId === tenderId && i.requirementItemId === input.requirementItemId);
      if (dup) throw new SalaGuerraValidationError("requirementItemId: ese requisito ya esta en el tablero de esta convocatoria.");
    }
    const stamp = this.iso();
    const record: WarRoomItemRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      status: "pendiente",
      severity: input.severity ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      dueAt: input.dueAt ?? null,
      requirementItemId: input.requirementItemId ?? null,
      createdBy: actorId,
      createdAt: stamp,
      updatedBy: null,
      updatedAt: stamp,
      completedAt: null,
    };
    this.items.set(record.id, record);
    return record;
  }

  async updateItem(organizationId: string, tenderId: string, itemId: string, patch: WarRoomItemPatch, actorId: string): Promise<WarRoomItemRecord | null> {
    const current = await this.findItem(organizationId, tenderId, itemId);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const stamp = this.iso();
    const updated: WarRoomItemRecord = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.responsibleUserId !== undefined ? { responsibleUserId: patch.responsibleUserId } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      status,
      updatedBy: actorId,
      updatedAt: stamp,
      completedAt: status === "listo" ? (current.status === "listo" ? current.completedAt : stamp) : null,
    };
    this.items.set(itemId, updated);
    return updated;
  }

  async listEntries(organizationId: string, tenderId: string, limit = 200): Promise<readonly WarRoomEntryRecord[]> {
    return this.entries
      .filter((e) => e.organizationId === organizationId && e.tenderId === tenderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async addEntry(organizationId: string, tenderId: string, input: { entryKind: WarRoomEntryKind; body: string; itemId: string | null }, actorId: string): Promise<WarRoomEntryRecord> {
    const record: WarRoomEntryRecord = { id: randomUUID(), organizationId, tenderId, itemId: input.itemId, entryKind: input.entryKind, body: input.body, authorId: actorId, createdAt: this.iso() };
    this.entries.push(record);
    return record;
  }

  async getJuntaConfig(organizationId: string, tenderId: string): Promise<JuntaConfigRecord | null> {
    const config = this.configs.get(tenderId);
    return config && config.organizationId === organizationId ? config : null;
  }

  async upsertJuntaConfig(organizationId: string, tenderId: string, input: JuntaConfigInput, actorId: string): Promise<JuntaConfigRecord> {
    const record: JuntaConfigRecord = { tenderId, organizationId, questionsDeadlineAt: input.questionsDeadlineAt, meetingAt: input.meetingAt, actaReference: input.actaReference, updatedBy: actorId, updatedAt: this.iso() };
    this.configs.set(tenderId, record);
    return record;
  }

  async listQuestions(organizationId: string, tenderId: string): Promise<readonly JuntaQuestionRecord[]> {
    return [...this.questions.values()].filter((q) => q.organizationId === organizationId && q.tenderId === tenderId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findQuestion(organizationId: string, tenderId: string, questionId: string): Promise<JuntaQuestionRecord | null> {
    const q = this.questions.get(questionId);
    return q && q.organizationId === organizationId && q.tenderId === tenderId ? q : null;
  }

  private liveByKey(organizationId: string, tenderId: string, dedupeKey: string, exceptId?: string): JuntaQuestionRecord | null {
    for (const q of this.questions.values()) {
      if (q.organizationId === organizationId && q.tenderId === tenderId && q.dedupeKey === dedupeKey && q.status !== "descartada" && q.id !== exceptId) return q;
    }
    return null;
  }

  async createQuestion(organizationId: string, tenderId: string, input: JuntaQuestionCreateInput, actorId: string): Promise<JuntaQuestionRecord> {
    const existing = this.liveByKey(organizationId, tenderId, input.dedupeKey);
    if (existing) throw new JuntaQuestionDuplicateError(existing);
    const stamp = this.iso();
    const record: JuntaQuestionRecord = {
      id: randomUUID(),
      organizationId,
      tenderId,
      questionText: input.questionText,
      baseReference: input.baseReference,
      topic: input.topic,
      priority: input.priority,
      dedupeKey: input.dedupeKey,
      origin: input.origin,
      draftMissingData: [...input.draftMissingData],
      status: "borrador",
      createdBy: actorId,
      createdAt: stamp,
      updatedAt: stamp,
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      sentBy: null,
      sentReference: null,
      answerText: null,
      answerActaReference: null,
      answeredAt: null,
      answeredBy: null,
      discardReason: null,
    };
    this.questions.set(record.id, record);
    return record;
  }

  async updateQuestion(organizationId: string, tenderId: string, questionId: string, patch: JuntaQuestionPatch): Promise<JuntaQuestionRecord | null> {
    const current = await this.findQuestion(organizationId, tenderId, questionId);
    if (!current) return null;
    const dedupeKey = patch.questionText !== undefined ? questionDedupeKey(patch.questionText) : current.dedupeKey;
    if (dedupeKey !== current.dedupeKey) {
      const existing = this.liveByKey(organizationId, tenderId, dedupeKey, questionId);
      if (existing) throw new JuntaQuestionDuplicateError(existing);
    }
    const updated: JuntaQuestionRecord = {
      ...current,
      ...(patch.questionText !== undefined ? { questionText: patch.questionText } : {}),
      ...(patch.baseReference !== undefined ? { baseReference: patch.baseReference } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      dedupeKey,
      updatedAt: this.iso(),
    };
    this.questions.set(questionId, updated);
    return updated;
  }

  async transitionQuestion(organizationId: string, tenderId: string, questionId: string, request: JuntaTransitionRequest, actorId: string): Promise<JuntaQuestionRecord | null> {
    const current = await this.findQuestion(organizationId, tenderId, questionId);
    if (!current) return null;
    if (!canTransitionQuestion(current.status, request.to)) {
      throw new JuntaQuestionRejectedError("transicion_no_permitida", `Una pregunta "${current.status}" no puede pasar a "${request.to}".`);
    }
    if (current.status === "descartada" && request.to === "borrador") {
      const existing = this.liveByKey(organizationId, tenderId, current.dedupeKey, questionId);
      if (existing) throw new JuntaQuestionDuplicateError(existing);
    }
    const stamp = this.iso();
    let next: JuntaQuestionRecord = { ...current, status: request.to, updatedAt: stamp };
    if (request.to === "aprobada") next = { ...next, approvedBy: actorId, approvedAt: stamp };
    if (request.to === "borrador") next = { ...next, approvedBy: null, approvedAt: null, discardReason: null };
    if (request.to === "enviada") next = { ...next, sentAt: stamp, sentBy: actorId, sentReference: request.sentReference ?? current.sentReference };
    if (request.to === "respondida") next = { ...next, answeredAt: stamp, answeredBy: actorId, answerText: request.answerText ?? null, answerActaReference: request.answerActaReference ?? null };
    if (request.to === "descartada") next = { ...next, discardReason: request.discardReason ?? null };
    this.questions.set(questionId, next);
    return next;
  }

  async listQuestionReminders(organizationId: string, tenderId?: string): Promise<readonly JuntaQuestionReminderRecord[]> {
    return [...this.reminders.values()]
      .filter((r) => r.organizationId === organizationId && (tenderId === undefined || r.tenderId === tenderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async acknowledgeQuestionReminder(organizationId: string, reminderId: string, actorId: string): Promise<JuntaQuestionReminderRecord | null> {
    const current = this.reminders.get(reminderId);
    if (!current || current.organizationId !== organizationId) return null;
    const updated: JuntaQuestionReminderRecord = { ...current, acknowledgedAt: this.iso(), acknowledgedBy: actorId };
    this.reminders.set(reminderId, updated);
    return updated;
  }

  async scanJuntaQuestionReminders(organizationId: string, input: ScanJuntaRemindersInput = {}): Promise<ScanJuntaRemindersResult> {
    const windowDays = input.windowDays ?? 3;
    const now = input.nowIso ? new Date(input.nowIso) : this.now();
    const windowEndMs = now.getTime() + windowDays * 24 * 60 * 60 * 1000;
    const created: JuntaQuestionReminderRecord[] = [];
    for (const config of this.configs.values()) {
      if (config.organizationId !== organizationId || !config.questionsDeadlineAt) continue;
      const deadlineMs = Date.parse(config.questionsDeadlineAt);
      if (deadlineMs <= now.getTime() || deadlineMs > windowEndMs) continue;
      const pending = [...this.questions.values()].filter((q) => q.tenderId === config.tenderId && (q.status === "borrador" || q.status === "aprobada")).length;
      if (pending < 1) continue;
      const key = `${config.tenderId}:${config.questionsDeadlineAt.slice(0, 10)}`;
      if (this.reminderKeys.has(key)) continue;
      this.reminderKeys.add(key);
      const record: JuntaQuestionReminderRecord = {
        id: randomUUID(),
        organizationId,
        tenderId: config.tenderId,
        questionsDeadlineAt: config.questionsDeadlineAt,
        daysRemaining: Math.ceil((deadlineMs - now.getTime()) / (24 * 60 * 60 * 1000)),
        pendingCount: pending,
        message: `El plazo para enviar preguntas a la junta de aclaraciones vence el ${config.questionsDeadlineAt}; hay ${pending} pregunta(s) sin enviar.`,
        createdAt: this.iso(),
        acknowledgedAt: null,
        acknowledgedBy: null,
      };
      this.reminders.set(record.id, record);
      created.push(record);
    }
    return { created: created.length, reminders: created };
  }
}
