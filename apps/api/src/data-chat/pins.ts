// CHAT-15 -- Fijados del Copiloto ("Fijar en el tablero"). Un fijado NO guarda cifras: guarda la herramienta del catalogo
// cerrado y sus argumentos tipados (periodo incluido). Al abrir el tablero cada fijado se RE-EJECUTA por la ruta directa
// (sin modelo, con cache) con el alcance y el rol ACTUALES del usuario: si le quitan una sucursal deja de ver sus cifras, y las
// cifras nunca quedan viejas ni se ven fuera de alcance. El alta deriva herramienta y argumentos del mensaje guardado del propio
// autor (el cliente solo manda conversacion + posicion), asi que no puede fijar argumentos inventados.
//
//   GET    <base>/pins                 -> { disponible, pins: PinDto[] }
//   POST   <base>/pins                 { conversationId, seq, bloque } -> 201 { id }
//   PATCH  <base>/pins/:pinId          { compartido?, titulo? }
//   DELETE <base>/pins/:pinId          -> 204
//   GET    <base>/pins/:pinId/resultado -> { id, titulo, status, text, blocks, sources } (re-ejecucion directa)
//
// Privacidad (RLS, migracion 0045): el autor ve los suyos; los compartidos los ve la organizacion SOLO si el autor es owner/admin
// (y solo owner/admin pueden compartir). Un rol sin acceso al Copiloto recibe 403 como en el resto del chat.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (0045 pendiente): cada acceso corre en SAVEPOINT sobre la MISMA sesion del request
// (`runWithSavepointFallback`; nunca Promise.all). Si falta tabla o funcion (42P01/42883/42703) la lista responde
// `{ disponible: false, pins: [] }`, el alta 503 honesto y borrar/editar 404 -- nunca un 500 ni una transaccion abortada (25P02).
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { parseArgs, redactPii, runDataChatTurn } from "@atiende/agent-core/data-chat";
import type { DataChatAnswer, DataChatCatalog, DataChatScope } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import type { ConversacionVertical } from "./conversaciones.ts";
import { NO_LLM_COMPLETION } from "./turno.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITULO = 80;
const MAX_LISTA = 100;

export interface PinScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly vertical: ConversacionVertical;
}

export type PinArgs = Readonly<Record<string, string | number>>;

export interface PinDto {
  readonly id: string;
  readonly titulo: string;
  readonly herramienta: string;
  readonly args: PinArgs;
  readonly compartido: boolean;
  /** true = el usuario actual es el autor (puede editar/borrar). */
  readonly propio: boolean;
  /** ISO 8601. */
  readonly creadoEn: string;
}

export interface PinOrigen {
  readonly tool: string;
  readonly args: PinArgs;
  readonly title: string;
}

export type ResultadoAltaPin =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly motivo: "no_disponible" | "limite" | "sin_acceso" | "conversacion_no_encontrada" | "error" };

export type ResultadoEdicionPin = "ok" | "no_encontrado" | "sin_permiso";

export interface PinsRepository {
  list(scope: PinScope): Promise<{ readonly disponible: boolean; readonly items: readonly PinDto[] }>;
  get(scope: PinScope, id: string): Promise<PinDto | null>;
  /** Herramienta, argumentos y titulo del bloque `bloque` del mensaje `seq` de una conversacion PROPIA; null si no existe. */
  origin(scope: PinScope, conversationId: string, seq: number, bloque: number): Promise<PinOrigen | null>;
  create(scope: PinScope, input: { conversationId: string; seq: number; bloque: number; origin: PinOrigen }): Promise<ResultadoAltaPin>;
  update(scope: PinScope, id: string, cambios: { compartido?: boolean; titulo?: string }): Promise<ResultadoEdicionPin>;
  remove(scope: PinScope, id: string): Promise<boolean>;
}

interface PinRow {
  id: string;
  title: string;
  tool: string;
  args: unknown;
  shared: boolean;
  propio: boolean;
  created_at: Date | string;
}

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Solo objetos planos de texto/numeros (lo unico que los parametros del catalogo admiten). */
export function plainArgs(raw: unknown): PinArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

function toDto(r: PinRow): PinDto {
  return { id: r.id, titulo: r.title, herramienta: r.tool, args: plainArgs(r.args), compartido: Boolean(r.shared), propio: Boolean(r.propio), creadoEn: iso(r.created_at) };
}

export function cleanPinTitle(raw: string): string {
  const flat = redactPii(raw.replace(/\s+/g, " ").trim());
  return flat.length > MAX_TITULO ? `${flat.slice(0, MAX_TITULO - 1)}…` : flat;
}

export class PostgresPinsRepository implements PinsRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

  async list(scope: PinScope): Promise<{ disponible: boolean; items: PinDto[] }> {
    return runWithSavepointFallback<{ disponible: boolean; items: PinDto[] }>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<PinRow>(
          `select p.id, p.title, p.tool, p.args, p.shared, (p.author_id = $1::uuid) as propio, p.created_at
             from core.copiloto_pin p
            where p.organization_id = $2::uuid and p.vertical = $3::text
            order by p.created_at desc, p.id desc
            limit ${MAX_LISTA};`,
          [scope.userId, scope.organizationId, scope.vertical],
        );
        return { disponible: true, items: rows.map(toDto) };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => ({ disponible: false, items: [] }),
    });
  }

  async get(scope: PinScope, id: string): Promise<PinDto | null> {
    return runWithSavepointFallback<PinDto | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<PinRow>(
          `select p.id, p.title, p.tool, p.args, p.shared, (p.author_id = $1::uuid) as propio, p.created_at
             from core.copiloto_pin p
            where p.id = $2::uuid and p.organization_id = $3::uuid and p.vertical = $4::text;`,
          [scope.userId, id, scope.organizationId, scope.vertical],
        );
        return rows[0] ? toDto(rows[0]) : null;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async origin(scope: PinScope, conversationId: string, seq: number, bloque: number): Promise<PinOrigen | null> {
    return runWithSavepointFallback<PinOrigen | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ blocks: unknown; tool_calls: unknown }>(
          `select m.blocks, m.tool_calls
             from core.data_chat_message m
             join core.data_chat_conversation c on c.id = m.conversation_id
            where c.id = $1::uuid and c.user_id = $2::uuid and c.organization_id = $3::uuid and c.vertical = $4::text
              and m.seq = $5::int and m.role = 'assistant';`,
          [conversationId, scope.userId, scope.organizationId, scope.vertical, seq],
        );
        const row = rows[0];
        if (!row || !Array.isArray(row.blocks)) return null;
        const block = row.blocks[bloque] as { tool?: unknown; title?: unknown } | undefined;
        if (!block || typeof block.tool !== "string") return null;
        const calls = Array.isArray(row.tool_calls) ? (row.tool_calls as { tool?: unknown; args?: unknown }[]) : [];
        const call = calls.find((c) => c && c.tool === block.tool);
        if (!call) return null;
        const title = cleanPinTitle(typeof block.title === "string" && block.title.trim() ? block.title : block.tool);
        return { tool: block.tool, args: plainArgs(call.args), title };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async create(scope: PinScope, input: { conversationId: string; seq: number; bloque: number; origin: PinOrigen }): Promise<ResultadoAltaPin> {
    return runWithSavepointFallback<ResultadoAltaPin>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `select core.copiloto_pin_create($1::uuid, $2::uuid, $3::int, $4::int, $5::text, $6::jsonb, $7::text) as id;`,
          [scope.organizationId, input.conversationId, input.seq, input.bloque, input.origin.tool, JSON.stringify(input.origin.args), input.origin.title],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("core.copiloto_pin_create no devolvio id.");
        return { ok: true, id } satisfies ResultadoAltaPin;
      },
      // El usuario ya tiene su respuesta: ningun fallo de escritura es un 500. La sesion queda utilizable (ROLLBACK TO SAVEPOINT).
      isRecoverable: () => true,
      fallback: async (err) => {
        if (isMigrationPendingError(err)) return { ok: false, motivo: "no_disponible" };
        const code = errorCode(err);
        if (code === "54000") return { ok: false, motivo: "limite" };
        if (code === "P0002") return { ok: false, motivo: "conversacion_no_encontrada" };
        if (code === "42501") return { ok: false, motivo: "sin_acceso" };
        this.log(JSON.stringify({ level: "error", event: "copiloto_pin_error", code: code ?? null, message: err instanceof Error ? err.message.slice(0, 200) : "error" }));
        return { ok: false, motivo: "error" };
      },
    });
  }

  async update(scope: PinScope, id: string, cambios: { compartido?: boolean; titulo?: string }): Promise<ResultadoEdicionPin> {
    return runWithSavepointFallback<ResultadoEdicionPin>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `update core.copiloto_pin
              set shared = coalesce($3::boolean, shared), title = coalesce($4::text, title)
            where id = $1::uuid and author_id = $2::uuid and organization_id = $5::uuid and vertical = $6::text
        returning id;`,
          [id, scope.userId, cambios.compartido ?? null, cambios.titulo ?? null, scope.organizationId, scope.vertical],
        );
        return rows.length > 0 ? "ok" : "no_encontrado";
      },
      // 42501 = la policy WITH CHECK rechazo compartir (el autor no es owner/admin): se traduce a 403, no a 500.
      isRecoverable: (err) => isMigrationPendingError(err) || errorCode(err) === "42501",
      fallback: async (err) => (isMigrationPendingError(err) ? "no_encontrado" : "sin_permiso"),
    });
  }

  async remove(scope: PinScope, id: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `delete from core.copiloto_pin where id = $1::uuid and author_id = $2::uuid and organization_id = $3::uuid and vertical = $4::text returning id;`,
          [id, scope.userId, scope.organizationId, scope.vertical],
        );
        return rows.length > 0;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => false,
    });
  }
}

export function pinsRepo(deps: AppDeps, db: TenantDbSession): PinsRepository {
  return deps.dataChat?.pins?.(db) ?? new PostgresPinsRepository(db);
}

// ---------------------------------------------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------------------------------------------

/** Contexto de un turno ya autorizado: el catalogo ligado a una sesion y el alcance que fija el SERVIDOR. */
export interface PinsTurnContext {
  readonly catalogFor: (db: TenantDbSession) => DataChatCatalog | undefined;
  readonly scope: DataChatScope;
}

export interface PinsRoutesConfig {
  /** Ruta base del chat de la vertical, p.ej. `/hoteles/:propertyId/chat-datos`. */
  readonly base: string;
  readonly vertical: ConversacionVertical;
  /** Roles de la vertical que pueden usar el chat (los mismos de la ruta POST). */
  readonly roles: readonly string[];
  /** Resuelve alcance y catalogo con la membership verificada del request (misma logica que el POST del chat). */
  readonly turnContext: (c: Context<CoreAuthHonoEnv>) => Promise<PinsTurnContext | undefined>;
}

function pinIdParam(c: Context<CoreAuthHonoEnv>): string {
  const id = c.req.param("pinId") ?? "";
  // Un id mal formado jamas llega a la base (22P02) y es indistinguible de uno inexistente.
  if (!UUID_RE.test(id)) throw Errors.notFound("Fijado no encontrado.");
  return id.toLowerCase();
}

async function jsonBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
  const raw: unknown = await c.req.json().catch(() => {
    throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
  });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  return raw as Record<string, unknown>;
}

export function parseCreatePin(raw: Record<string, unknown>): { conversationId: string; seq: number; bloque: number } {
  for (const key of Object.keys(raw)) if (key !== "conversationId" && key !== "seq" && key !== "bloque") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  const { conversationId, seq, bloque } = raw;
  if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) throw Errors.validation("conversationId: se esperaba el id de una conversación.");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > 100) throw Errors.validation("seq: se esperaba un entero entre 1 y 100.");
  if (typeof bloque !== "number" || !Number.isInteger(bloque) || bloque < 0 || bloque > 20) throw Errors.validation("bloque: se esperaba un entero entre 0 y 20.");
  return { conversationId: conversationId.toLowerCase(), seq, bloque };
}

export function parsePatchPin(raw: Record<string, unknown>): { compartido?: boolean; titulo?: string } {
  for (const key of Object.keys(raw)) if (key !== "compartido" && key !== "titulo") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  const out: { compartido?: boolean; titulo?: string } = {};
  if (raw["compartido"] !== undefined) {
    if (typeof raw["compartido"] !== "boolean") throw Errors.validation("compartido: se esperaba verdadero o falso.");
    out.compartido = raw["compartido"];
  }
  if (raw["titulo"] !== undefined) {
    if (typeof raw["titulo"] !== "string") throw Errors.validation("titulo: se esperaba texto.");
    const titulo = cleanPinTitle(raw["titulo"]);
    if (titulo.length === 0) throw Errors.validation("titulo: no puede estar vacío.");
    out.titulo = titulo;
  }
  if (out.compartido === undefined && out.titulo === undefined) throw Errors.validation("Nada que cambiar: manda 'compartido' o 'titulo'.");
  return out;
}

const UNAVAILABLE_ANSWER = {
  status: "unavailable",
  text: "El tablero de fijados todavía no está activado para tu cuenta.",
  blocks: [],
  sources: [],
  toolsUsed: [],
} satisfies DataChatAnswer;

export function mountPinsRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, cfg: PinsRoutesConfig): void {
  const list = `${cfg.base}/pins`;
  const one = `${cfg.base}/pins/:pinId`;
  const result = `${cfg.base}/pins/:pinId/resultado`;
  const scopeOf = (c: Context<CoreAuthHonoEnv>): PinScope => ({ organizationId: c.get("organizationId"), userId: c.get("userId"), vertical: cfg.vertical });

  app.get(list, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const { disponible, items } = await pinsRepo(deps, c.get("db")).list(scopeOf(c));
    return c.json({ disponible, pins: items });
  });

  app.post(list, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const input = parseCreatePin(await jsonBody(c));
    const repo = pinsRepo(deps, c.get("db"));
    const scope = scopeOf(c);
    const origin = await repo.origin(scope, input.conversationId, input.seq, input.bloque);
    if (!origin) throw Errors.notFound("No encontré ese resultado para fijarlo.");
    // La herramienta y sus argumentos deben seguir siendo validos en el catalogo ACTUAL de la vertical.
    const turn = await cfg.turnContext(c);
    const tool = turn?.catalogFor(c.get("db"))?.tools.find((t) => t.name === origin.tool);
    if (!tool || !parseArgs(tool.params, origin.args).ok) throw Errors.notFound("Esa consulta ya no se puede fijar.");
    const created = await repo.create(scope, { ...input, origin });
    if (created.ok) return c.json({ id: created.id }, 201);
    switch (created.motivo) {
      case "limite":
        throw Errors.conflict("Llegaste al límite de 50 fijados. Quita alguno para fijar otro.");
      case "no_disponible":
        throw Errors.serviceUnavailable("Los fijados todavía no están disponibles en este ambiente (migración pendiente).");
      case "sin_acceso":
        throw Errors.forbidden();
      case "conversacion_no_encontrada":
        throw Errors.notFound("No encontré ese resultado para fijarlo.");
      default:
        throw Errors.serviceUnavailable("No pude fijar el resultado en este momento. Inténtalo de nuevo.");
    }
  });

  app.patch(one, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = pinIdParam(c);
    const cambios = parsePatchPin(await jsonBody(c));
    const res = await pinsRepo(deps, c.get("db")).update(scopeOf(c), id, cambios);
    if (res === "no_encontrado") throw Errors.notFound("Fijado no encontrado.");
    if (res === "sin_permiso") throw Errors.forbidden("Solo el dueño o un administrador pueden compartir fijados con la organización.");
    return c.json({ id, ...(cambios.compartido !== undefined ? { compartido: cambios.compartido } : {}), ...(cambios.titulo !== undefined ? { titulo: cambios.titulo } : {}) });
  });

  app.delete(one, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = pinIdParam(c);
    if (!(await pinsRepo(deps, c.get("db")).remove(scopeOf(c), id))) throw Errors.notFound("Fijado no encontrado.");
    return c.body(null, 204);
  });

  // Re-ejecucion SIN modelo (ruta directa, con cache) bajo el alcance y rol ACTUALES del usuario.
  app.get(result, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = pinIdParam(c);
    const db = c.get("db");
    const pin = await pinsRepo(deps, db).get(scopeOf(c), id);
    if (!pin) throw Errors.notFound("Fijado no encontrado.");
    const dataChat = deps.dataChat;
    const turn = dataChat ? await cfg.turnContext(c) : undefined;
    const catalog = turn?.catalogFor(db);
    if (!dataChat || !turn || !catalog) return c.json({ id: pin.id, titulo: pin.titulo, ...UNAVAILABLE_ANSWER });
    const answer = await runDataChatTurn({
      catalog,
      scope: turn.scope,
      question: "",
      directTool: pin.herramienta,
      directArgs: pin.args,
      complete: NO_LLM_COMPLETION,
      // Sin limitador de preguntas: no hay costo de modelo; el tablero abre varios fijados a la vez y la cache absorbe la repeticion.
      ...(dataChat.cache ? { cache: dataChat.cache } : {}),
      audit: dataChat.audit(db),
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "copiloto_pin_run_error", vertical: cfg.vertical, where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json({ id: pin.id, titulo: pin.titulo, status: answer.status, text: answer.text, blocks: answer.blocks, sources: answer.sources });
  });
}
