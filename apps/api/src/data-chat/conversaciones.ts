// Persistencia de conversaciones del Copiloto ("Chatea con tus datos") -- CHAT-04.
//
//   GET    <base>/conversaciones        -> { disponible, conversaciones: [{ id, titulo, actualizadaEn, mensajes }] }
//   GET    <base>/conversaciones/:id    -> { id, titulo, actualizadaEn, mensajes: [CopilotoMensaje] }
//   PATCH  <base>/conversaciones/:id    { titulo } -> { id, titulo }
//   DELETE <base>/conversaciones/:id    -> 204
//
// `<base>` es la ruta de chat de cada vertical (`/hoteles/:propertyId/chat-datos`, ...): la cadena de autorizacion
// (JWT -> sesion RLS -> membership verificada) y el rol ya los puso la ruta que monta esto. Las formas coinciden con
// el contrato de transporte de `CopilotoTransporte` (packages/ui/src/components/copiloto/tipos.ts): `listar`,
// `abrir`, `renombrar` y `borrar`.
//
// Reglas (spec chat-datos §d/§e.2):
//   * SOLO el autor ve sus conversaciones (el owner tampoco lee las de su staff): la RLS (migracion 0041) lo
//     impone y cada consulta de aqui ademas filtra por usuario y organizacion (defensa en profundidad).
//   * Un id ajeno, de otra organizacion o inexistente responde 404, nunca 403: no confirma que exista.
//   * Con `conversationId` el historial que ve el modelo sale de la BASE, no del cliente: no se pueden falsificar
//     turnos del asistente (el cuerpo no acepta `history` junto a `conversationId`).
//   * Se guarda la pregunta REDACTADA (`redactPii`), el texto y los bloques de la respuesta (celdas de texto
//     redactadas, tope de filas y de bytes) y las herramientas ejecutadas con sus parametros tipados. Nunca prompts,
//     salida cruda del modelo ni adjuntos.
//   * Tope de 200 conversaciones por usuario y organizacion y 100 mensajes por conversacion (continuacion).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (0041 pendiente): cada acceso corre en SAVEPOINT (`runWithSavepointFallback`)
// sobre la MISMA sesion (jamas Promise.all: es una sola transaccion). Si falta la tabla o la funcion
// (42P01/42883/42703) la lista responde `{ disponible: false, conversaciones: [] }`, abrir/renombrar/borrar 404,
// y un turno del chat con `conversationId: "new"` se responde igual pero sin guardar (sin romper el turno).
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { redactPii } from "@atiende/agent-core/data-chat";
import type { DataChatAnswer, DataChatAuditEntry, DataChatAuditSink, DataChatBlock, DataChatHistoryTurn } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

export const MAX_CONVERSACIONES = 200;
export const MAX_MENSAJES_POR_CONVERSACION = 100;
export const MAX_TITULO = 80;
/** Mensajes del historial que el servidor relee de la base para el modelo (el motor ademas recorta a 6 turnos). */
export const HISTORIAL_DESDE_BD = 12;
const MAX_TEXTO = 2000;
const MAX_BLOQUES_JSON = 40_000;
const MAX_TOOL_CALLS = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONVERSACION_NUEVA = "new";

/** Verticales que guardan conversaciones por organizacion (la de plataforma llega con el Copiloto de superadmin). */
export type ConversacionVertical = "restaurantes" | "hoteles" | "rentas" | "despachos" | "licitaciones" | "citas";

export interface ConversacionScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly vertical: ConversacionVertical;
}

export interface ConversacionResumenDto {
  readonly id: string;
  readonly titulo: string;
  /** ISO 8601. */
  readonly actualizadaEn: string;
  readonly mensajes: number;
}

export interface MensajeGuardadoDto {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status?: string;
  readonly blocks?: readonly unknown[];
  readonly sources?: readonly unknown[];
  readonly seq: number;
}

export interface ConversacionDetalleDto {
  readonly id: string;
  readonly titulo: string;
  readonly actualizadaEn: string;
  readonly mensajes: readonly MensajeGuardadoDto[];
}

export interface TurnoAGuardar {
  readonly propertyId: string | null;
  /** null = conversacion nueva. */
  readonly conversationId: string | null;
  readonly userText: string;
  readonly assistantText: string;
  readonly status: string;
  readonly blocks: readonly unknown[];
  readonly sources: readonly unknown[];
  readonly toolCalls: readonly { readonly tool: string; readonly args: Readonly<Record<string, string | number>> }[];
}

export type MotivoNoGuardado = "no_disponible" | "limite_conversaciones" | "conversacion_no_encontrada" | "sin_acceso" | "error";

export type ResultadoGuardado =
  | { readonly guardado: true; readonly conversationId: string; readonly seq: number }
  | { readonly guardado: false; readonly motivo: MotivoNoGuardado };

export interface ConversacionesRepository {
  list(scope: ConversacionScope): Promise<{ readonly disponible: boolean; readonly items: readonly ConversacionResumenDto[] }>;
  get(scope: ConversacionScope, id: string): Promise<ConversacionDetalleDto | null>;
  /** Ultimos mensajes (texto) de una conversacion propia, en orden. `null` = no existe / ajena / base sin migrar. */
  loadHistory(scope: ConversacionScope, id: string, limit: number): Promise<DataChatHistoryTurn[] | null>;
  rename(scope: ConversacionScope, id: string, titulo: string): Promise<boolean>;
  remove(scope: ConversacionScope, id: string): Promise<boolean>;
  append(scope: ConversacionScope, turno: TurnoAGuardar): Promise<ResultadoGuardado>;
  /** CHAT-14: herramientas (con parametros tipados) que produjeron el mensaje `seq` del asistente de una conversacion
   *  propia, para re-ejecutarlas con el alcance actual al generar el reporte PDF. `null` = no existe / ajena / no es un
   *  mensaje del asistente / base sin migrar. OPCIONAL: un repositorio sin el no ofrece reportes (503 honesto). */
  cargarFuenteReporte?(scope: ConversacionScope, id: string, seq: number): Promise<FuenteReporte | null>;
}

export interface FuenteReporte {
  readonly seq: number;
  readonly toolCalls: readonly { readonly tool: string; readonly args: Readonly<Record<string, string | number>> }[];
}

/** `tool_calls` guardado -> lista tipada; descarta cualquier elemento con forma inesperada (nunca confia en el JSON). */
export function parseToolCallsGuardados(raw: unknown): FuenteReporte["toolCalls"] {
  if (!Array.isArray(raw)) return [];
  const out: { tool: string; args: Record<string, string | number> }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o["tool"] !== "string" || o["tool"].length === 0 || o["tool"].length > 80) continue;
    const args: Record<string, string | number> = {};
    if (o["args"] !== null && typeof o["args"] === "object" && !Array.isArray(o["args"])) {
      for (const [k, v] of Object.entries(o["args"] as Record<string, unknown>)) if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) args[k] = v;
    }
    out.push({ tool: o["tool"], args });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Implementacion Postgres (sesion RLS del usuario).
// ---------------------------------------------------------------------------------------------------------------

interface ConversacionRow {
  id: string;
  title: string;
  updated_at: Date | string;
  message_count: number;
}

interface MensajeRow {
  seq: number;
  role: "user" | "assistant";
  text: string;
  status: string | null;
  blocks: unknown;
  sources: unknown;
}

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

export class PostgresConversacionesRepository implements ConversacionesRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

  async list(scope: ConversacionScope): Promise<{ disponible: boolean; items: ConversacionResumenDto[] }> {
    return runWithSavepointFallback<{ disponible: boolean; items: ConversacionResumenDto[] }>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<ConversacionRow>(
          `select c.id, c.title, c.updated_at, c.message_count
             from core.data_chat_conversation c
            where c.user_id = $1::uuid and c.organization_id = $2::uuid and c.vertical = $3::text
            order by c.updated_at desc, c.id desc
            limit ${MAX_CONVERSACIONES};`,
          [scope.userId, scope.organizationId, scope.vertical],
        );
        return { disponible: true, items: rows.map((r) => ({ id: r.id, titulo: r.title, actualizadaEn: iso(r.updated_at), mensajes: Number(r.message_count) })) };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => ({ disponible: false, items: [] }),
    });
  }

  async get(scope: ConversacionScope, id: string): Promise<ConversacionDetalleDto | null> {
    return runWithSavepointFallback<ConversacionDetalleDto | null>({
      session: this.db,
      primary: async () => {
        const conv = await this.db.query<ConversacionRow>(
          `select c.id, c.title, c.updated_at, c.message_count
             from core.data_chat_conversation c
            where c.id = $1::uuid and c.user_id = $2::uuid and c.organization_id = $3::uuid and c.vertical = $4::text;`,
          [id, scope.userId, scope.organizationId, scope.vertical],
        );
        const head = conv.rows[0];
        if (!head) return null;
        // Segunda consulta, secuencial sobre la misma sesion (nunca Promise.all dentro de una transaccion).
        const msgs = await this.db.query<MensajeRow>(
          `select m.seq, m.role, m.text, m.status, m.blocks, m.sources
             from core.data_chat_message m
            where m.conversation_id = $1::uuid
            order by m.seq asc;`,
          [id],
        );
        return {
          id: head.id,
          titulo: head.title,
          actualizadaEn: iso(head.updated_at),
          mensajes: msgs.rows.map((m) => ({
            id: `${head.id}:${m.seq}`,
            role: m.role,
            text: m.text,
            seq: Number(m.seq),
            ...(m.status ? { status: m.status } : {}),
            ...(m.role === "assistant" && Array.isArray(m.blocks) && m.blocks.length > 0 ? { blocks: m.blocks as unknown[] } : {}),
            ...(m.role === "assistant" && Array.isArray(m.sources) && m.sources.length > 0 ? { sources: m.sources as unknown[] } : {}),
          })),
        };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async loadHistory(scope: ConversacionScope, id: string, limit: number): Promise<DataChatHistoryTurn[] | null> {
    return runWithSavepointFallback<DataChatHistoryTurn[] | null>({
      session: this.db,
      primary: async () => {
        const conv = await this.db.query<{ id: string }>(
          `select c.id from core.data_chat_conversation c
            where c.id = $1::uuid and c.user_id = $2::uuid and c.organization_id = $3::uuid and c.vertical = $4::text;`,
          [id, scope.userId, scope.organizationId, scope.vertical],
        );
        if (!conv.rows[0]) return null;
        const msgs = await this.db.query<{ role: "user" | "assistant"; text: string }>(
          `select t.role, t.text from (
             select m.seq, m.role, m.text from core.data_chat_message m where m.conversation_id = $1::uuid order by m.seq desc limit $2::int
           ) t order by t.seq asc;`,
          [id, limit],
        );
        return msgs.rows.map((m) => ({ role: m.role, text: m.text }));
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async rename(scope: ConversacionScope, id: string, titulo: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `update core.data_chat_conversation set title = $1::text
            where id = $2::uuid and user_id = $3::uuid and organization_id = $4::uuid and vertical = $5::text
        returning id;`,
          [titulo, id, scope.userId, scope.organizationId, scope.vertical],
        );
        return rows.length > 0;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => false,
    });
  }

  async remove(scope: ConversacionScope, id: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `delete from core.data_chat_conversation
            where id = $1::uuid and user_id = $2::uuid and organization_id = $3::uuid and vertical = $4::text
        returning id;`,
          [id, scope.userId, scope.organizationId, scope.vertical],
        );
        return rows.length > 0;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => false,
    });
  }

  async cargarFuenteReporte(scope: ConversacionScope, id: string, seq: number): Promise<FuenteReporte | null> {
    return runWithSavepointFallback<FuenteReporte | null>({
      session: this.db,
      primary: async () => {
        const conv = await this.db.query<{ id: string }>(
          `select c.id from core.data_chat_conversation c
            where c.id = $1::uuid and c.user_id = $2::uuid and c.organization_id = $3::uuid and c.vertical = $4::text;`,
          [id, scope.userId, scope.organizationId, scope.vertical],
        );
        if (!conv.rows[0]) return null;
        const msg = await this.db.query<{ tool_calls: unknown }>(
          `select m.tool_calls from core.data_chat_message m
            where m.conversation_id = $1::uuid and m.seq = $2::int and m.role = 'assistant';`,
          [id, seq],
        );
        const row = msg.rows[0];
        return row ? { seq, toolCalls: parseToolCallsGuardados(row.tool_calls) } : null;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async append(scope: ConversacionScope, t: TurnoAGuardar): Promise<ResultadoGuardado> {
    return runWithSavepointFallback<ResultadoGuardado>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ out_conversation_id: string; out_seq: number }>(
          `select out_conversation_id, out_seq from core.append_data_chat_turn($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::jsonb, $8::jsonb, $9::jsonb);`,
          [scope.organizationId, t.propertyId, t.conversationId, t.userText, t.assistantText, t.status, JSON.stringify(t.blocks), JSON.stringify(t.sources), JSON.stringify(t.toolCalls)],
        );
        const row = rows[0];
        if (!row) throw new Error("core.append_data_chat_turn no devolvio fila.");
        return { guardado: true, conversationId: row.out_conversation_id, seq: Number(row.out_seq) } satisfies ResultadoGuardado;
      },
      // El turno ya se respondio (y se pago): ningun fallo de guardado lo tumba. La sesion queda utilizable (ROLLBACK
      // TO SAVEPOINT) y el motivo viaja al cliente para que muestre "no se guardo" en vez de fingir.
      isRecoverable: () => true,
      fallback: async (err) => {
        if (isMigrationPendingError(err)) return { guardado: false, motivo: "no_disponible" };
        const code = errorCode(err);
        if (code === "54000") return { guardado: false, motivo: "limite_conversaciones" };
        if (code === "P0002") return { guardado: false, motivo: "conversacion_no_encontrada" };
        if (code === "42501") return { guardado: false, motivo: "sin_acceso" };
        this.log(JSON.stringify({ level: "error", event: "data_chat_persist_error", code: code ?? null, message: err instanceof Error ? err.message.slice(0, 200) : "error" }));
        return { guardado: false, motivo: "error" };
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Saneado de lo que se guarda.
// ---------------------------------------------------------------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pregunta del usuario tal como se guarda: sin PII y sin controles. */
export function redactQuestionForStorage(question: string, tool?: string): string {
  // Consulta directa (chip): `question` trae el texto del chip si lo mando; si no, el nombre de la herramienta.
  const base = tool ? (question.trim() || `Consulta directa: ${tool}`) : question;
  return clip(redactPii(base.replace(/\s+/g, " ").trim()), 600);
}

/** Bloques para guardar: celdas de texto con `redactPii` (ademas del saneado del motor), tope de filas y de bytes. */
export function sanitizeBlocksForStorage(blocks: readonly DataChatBlock[]): DataChatBlock[] {
  let out: DataChatBlock[] = blocks.map((b) => ({
    ...b,
    rows: b.rows.slice(0, 50).map((row) => {
      const clean: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(row)) clean[k] = typeof v === "string" ? redactPii(v) : v;
      return clean;
    }),
  }));
  // Si no cabe, se recortan filas por igual hasta que quepa: se conserva la forma y `truncated` lo declara.
  while (JSON.stringify(out).length > MAX_BLOQUES_JSON) {
    const maxRows = Math.max(...out.map((b) => b.rows.length));
    if (maxRows <= 1) return [];
    const keep = Math.max(1, Math.floor(maxRows / 2));
    out = out.map((b) => (b.rows.length > keep ? { ...b, rows: b.rows.slice(0, keep), truncated: true } : b));
  }
  return out;
}

const PERSISTABLE_STATUS = new Set<string>(["ok", "no_data", "clarify", "out_of_catalog"]);

/** Una respuesta de transporte (tope, presupuesto, entrada invalida, no disponible) no es parte de la conversacion. */
export function isPersistableAnswer(answer: DataChatAnswer): boolean {
  return PERSISTABLE_STATUS.has(answer.status) && answer.text.trim().length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Cableado de un turno (lo usan las seis rutas de chat).
// ---------------------------------------------------------------------------------------------------------------

export type PersistedDataChatAnswer = DataChatAnswer & {
  /** Conversacion donde quedo el turno (solo si el cliente pidio guardar y se pudo). */
  readonly conversationId?: string;
  /** Posicion del mensaje del asistente en la conversacion (habilita PDF y fijar en CHAT-14/15). */
  readonly seq?: number;
  /** `false` = el cliente pidio guardar y no se pudo (el turno se respondio igual). */
  readonly guardado?: boolean;
  readonly motivoNoGuardado?: MotivoNoGuardado;
};

export interface TurnPersistence {
  /** Historial para el motor: el de la base si hay `conversationId` (el cuerpo no puede aportar el suyo). */
  readonly history: DataChatHistoryTurn[];
  /** Envuelve la bitacora del turno para capturar las herramientas ejecutadas y sus parametros tipados. */
  audit(sink: DataChatAuditSink): DataChatAuditSink;
  /** Guarda el turno (si el cliente lo pidio) y agrega `conversationId`/`seq` a la respuesta. */
  finish(db: TenantDbSession, question: string, tool: string | undefined, answer: DataChatAnswer): Promise<PersistedDataChatAnswer>;
}

export interface BeginTurnInput {
  readonly conversationId: string | undefined;
  readonly history: DataChatHistoryTurn[];
  readonly scope: ConversacionScope;
  readonly propertyId: string | null;
}

export function conversacionesRepo(deps: AppDeps, db: TenantDbSession): ConversacionesRepository {
  return deps.dataChat?.conversaciones?.(db) ?? new PostgresConversacionesRepository(db);
}

/** Sin `conversationId` es transparente (mismo historial del cuerpo, bitacora tal cual, respuesta sin cambios). */
export async function beginTurnPersistence(deps: AppDeps, db: TenantDbSession, input: BeginTurnInput): Promise<TurnPersistence> {
  const { conversationId, scope } = input;
  if (conversationId === undefined) {
    return { history: input.history, audit: (sink) => sink, finish: async (_db, _q, _t, answer) => answer };
  }

  let targetId: string | null = null;
  let history: DataChatHistoryTurn[] = [];
  if (conversationId !== CONVERSACION_NUEVA) {
    const loaded = await conversacionesRepo(deps, db).loadHistory(scope, conversationId, HISTORIAL_DESDE_BD);
    // Ajena, de otra organizacion, borrada o base sin migrar: 404 ANTES de gastar un turno de modelo.
    if (loaded === null) throw Errors.notFound("Conversación no encontrada.");
    targetId = conversationId;
    history = loaded;
  }

  const toolCalls: { tool: string; args: Record<string, string | number> }[] = [];
  return {
    history,
    audit: (sink) => ({
      record: async (entry: DataChatAuditEntry) => {
        if (entry.tool && (entry.outcome === "ok" || entry.outcome === "empty") && toolCalls.length < MAX_TOOL_CALLS) {
          toolCalls.push({ tool: entry.tool, args: { ...entry.params } });
        }
        await sink.record(entry);
      },
    }),
    finish: async (turnDb, question, tool, answer) => {
      // Una respuesta de transporte (tope, presupuesto...) no es parte de la conversacion: se devuelve tal cual.
      if (!isPersistableAnswer(answer)) return answer;
      const result = await conversacionesRepo(deps, turnDb).append(scope, {
        propertyId: input.propertyId,
        conversationId: targetId,
        userText: redactQuestionForStorage(question, tool),
        assistantText: clip(redactPii(answer.text), MAX_TEXTO),
        status: answer.status,
        blocks: sanitizeBlocksForStorage(answer.blocks),
        sources: answer.sources,
        toolCalls,
      });
      return result.guardado ? { ...answer, conversationId: result.conversationId, seq: result.seq, guardado: true } : { ...answer, guardado: false, motivoNoGuardado: result.motivo };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------------------------------------------

export interface ConversacionesRoutesConfig {
  /** Ruta base del chat de la vertical, p.ej. `/hoteles/:propertyId/chat-datos`. */
  readonly base: string;
  readonly vertical: ConversacionVertical;
  /** Roles de la vertical que pueden usar el chat (los mismos de la ruta POST). */
  readonly roles: readonly string[];
}

/** Valida y normaliza un titulo nuevo: sin PII, una sola linea, 1..80 caracteres. */
export function parseTitulo(raw: unknown): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (key !== "titulo") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  if (typeof body["titulo"] !== "string") throw Errors.validation("titulo: se esperaba texto.");
  const titulo = clip(redactPii(body["titulo"].replace(/\s+/g, " ").trim()), MAX_TITULO);
  if (titulo.length === 0) throw Errors.validation("titulo: no puede estar vacío.");
  return titulo;
}

function conversationIdParam(c: Context<CoreAuthHonoEnv>): string {
  const id = c.req.param("conversationId") ?? "";
  // Un id mal formado jamas llega a la base (22P02) y es indistinguible de uno inexistente.
  if (!UUID_RE.test(id)) throw Errors.notFound("Conversación no encontrada.");
  return id.toLowerCase();
}

/** Monta GET/PATCH/DELETE de conversaciones bajo la ruta de chat de una vertical. */
export function mountConversacionesRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, cfg: ConversacionesRoutesConfig): void {
  const list = `${cfg.base}/conversaciones`;
  const one = `${cfg.base}/conversaciones/:conversationId`;
  const scopeOf = (c: Context<CoreAuthHonoEnv>): ConversacionScope => ({
    organizationId: c.get("organizationId"),
    userId: c.get("userId"),
    vertical: cfg.vertical,
  });

  app.get(list, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const { disponible, items } = await conversacionesRepo(deps, c.get("db")).list(scopeOf(c));
    return c.json({ disponible, conversaciones: items });
  });

  app.get(one, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = conversationIdParam(c);
    const found = await conversacionesRepo(deps, c.get("db")).get(scopeOf(c), id);
    if (!found) throw Errors.notFound("Conversación no encontrada.");
    return c.json(found);
  });

  app.patch(one, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = conversationIdParam(c);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const titulo = parseTitulo(raw);
    const ok = await conversacionesRepo(deps, c.get("db")).rename(scopeOf(c), id, titulo);
    if (!ok) throw Errors.notFound("Conversación no encontrada.");
    return c.json({ id, titulo });
  });

  app.delete(one, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = conversationIdParam(c);
    const ok = await conversacionesRepo(deps, c.get("db")).remove(scopeOf(c), id);
    if (!ok) throw Errors.notFound("Conversación no encontrada.");
    return c.body(null, 204);
  });
}
