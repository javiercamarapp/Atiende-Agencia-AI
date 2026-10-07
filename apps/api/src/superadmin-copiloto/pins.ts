// Fijados del Copiloto de PLATAFORMA ("Fijar en el tablero"), seguimiento de CHAT-17. Mismo contrato que los fijados de las verticales (data-chat/pins.ts):
// un fijado NO guarda cifras, guarda la herramienta del catalogo cerrado y sus argumentos tipados, y se RE-EJECUTA por la ruta directa (sin modelo) con el rol y el
// step-up ACTUALES de su autor. Diferencias: sin organizacion (core.copiloto_pin con vertical 'plataforma', migracion 0056), nunca compartido (el tablero es
// personal) y solo para el superadmin completo (el alta SQL exige core.cfo_zone_resolve_role = 'superadmin'; la zona CFO tampoco expone /pins).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (0056 pendiente): cada acceso corre en SAVEPOINT sobre la MISMA sesion del request (`runWithSavepointFallback`, nunca
// Promise.all). Sin la tabla (42P01/42703) la lista responde `{ disponible: false, pins: [] }`; con la 0045 aplicada y la 0056 NO, la tabla existe y la lista responde
// `disponible: true` y vacia (la consulta no depende de la 0056), y el alta falla con 42883 (funcion) o 23514 (CHECK de vertical viejo) -> 503 honesto
// `no_disponible`; editar/borrar 404. Nunca un 500 ni una transaccion abortada (25P02).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { cleanPinTitle, plainArgs, type PinDto, type PinOrigen, type ResultadoAltaPin, type ResultadoEdicionPin } from "../data-chat/pins.ts";
import { PLATAFORMA_VERTICAL } from "./alcance.ts";

export type { PinDto, PinOrigen, ResultadoAltaPin, ResultadoEdicionPin };

export interface PinsPlataformaRepository {
  list(userId: string): Promise<{ readonly disponible: boolean; readonly items: readonly PinDto[] }>;
  get(userId: string, id: string): Promise<PinDto | null>;
  /** Herramienta, argumentos y titulo del bloque `bloque` del mensaje `seq` de una conversacion de plataforma PROPIA; null si no existe. */
  origin(userId: string, conversationId: string, seq: number, bloque: number): Promise<PinOrigen | null>;
  create(input: { conversationId: string; seq: number; bloque: number; origin: PinOrigen }): Promise<ResultadoAltaPin>;
  rename(userId: string, id: string, titulo: string): Promise<ResultadoEdicionPin>;
  remove(userId: string, id: string): Promise<boolean>;
}

interface PinRow {
  id: string;
  title: string;
  tool: string;
  args: unknown;
  created_at: Date | string;
}

const MAX_LISTA = 100;

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const codigo = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined);
/** Falta algo de la 0056: tabla, funcion, columna, o el CHECK de vertical anterior (23514 al crear). */
const sinMigrar = (err: unknown): boolean => isMigrationPendingError(err) || codigo(err) === "23514";

function aDto(r: PinRow): PinDto {
  return { id: r.id, titulo: r.title, herramienta: r.tool, args: plainArgs(r.args), compartido: false, propio: true, creadoEn: iso(r.created_at) };
}

export class PostgresPinsPlataformaRepository implements PinsPlataformaRepository {
  constructor(
    private readonly db: TenantDbSession,
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

  async list(userId: string): Promise<{ disponible: boolean; items: PinDto[] }> {
    return runWithSavepointFallback<{ disponible: boolean; items: PinDto[] }>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<PinRow>(
          `select p.id, p.title, p.tool, p.args, p.created_at
             from core.copiloto_pin p
            where p.vertical = $2::text and p.author_id = $1::uuid
            order by p.created_at desc, p.id desc
            limit ${MAX_LISTA};`,
          [userId, PLATAFORMA_VERTICAL],
        );
        return { disponible: true, items: rows.map(aDto) };
      },
      isRecoverable: sinMigrar,
      fallback: async () => ({ disponible: false, items: [] }),
    });
  }

  async get(userId: string, id: string): Promise<PinDto | null> {
    return runWithSavepointFallback<PinDto | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<PinRow>(
          `select p.id, p.title, p.tool, p.args, p.created_at from core.copiloto_pin p where p.id = $2::uuid and p.vertical = $3::text and p.author_id = $1::uuid;`,
          [userId, id, PLATAFORMA_VERTICAL],
        );
        return rows[0] ? aDto(rows[0]) : null;
      },
      isRecoverable: sinMigrar,
      fallback: async () => null,
    });
  }

  async origin(userId: string, conversationId: string, seq: number, bloque: number): Promise<PinOrigen | null> {
    return runWithSavepointFallback<PinOrigen | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ blocks: unknown; tool_calls: unknown }>(
          `select m.blocks, m.tool_calls
             from core.data_chat_message m
             join core.data_chat_conversation c on c.id = m.conversation_id
            where c.id = $1::uuid and c.user_id = $2::uuid and c.scope = 'plataforma' and m.seq = $3::int and m.role = 'assistant';`,
          [conversationId, userId, seq],
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
      isRecoverable: sinMigrar,
      fallback: async () => null,
    });
  }

  async create(input: { conversationId: string; seq: number; bloque: number; origin: PinOrigen }): Promise<ResultadoAltaPin> {
    return runWithSavepointFallback<ResultadoAltaPin>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`select core.copiloto_pin_create_plataforma($1::uuid, $2::int, $3::int, $4::text, $5::jsonb, $6::text) as id;`, [
          input.conversationId,
          input.seq,
          input.bloque,
          input.origin.tool,
          JSON.stringify(input.origin.args),
          input.origin.title,
        ]);
        const id = rows[0]?.id;
        if (!id) throw new Error("core.copiloto_pin_create_plataforma no devolvio id.");
        return { ok: true, id } satisfies ResultadoAltaPin;
      },
      // El usuario ya tiene su respuesta: ningun fallo de escritura es un 500. La sesion queda utilizable (ROLLBACK TO SAVEPOINT).
      isRecoverable: () => true,
      fallback: async (err) => {
        if (sinMigrar(err)) return { ok: false, motivo: "no_disponible" };
        const c = codigo(err);
        if (c === "54000") return { ok: false, motivo: "limite" };
        if (c === "P0002") return { ok: false, motivo: "conversacion_no_encontrada" };
        if (c === "42501") return { ok: false, motivo: "sin_acceso" };
        this.log(JSON.stringify({ level: "error", event: "copiloto_pin_plataforma_error", code: c ?? null, message: err instanceof Error ? err.message.slice(0, 200) : "error" }));
        return { ok: false, motivo: "error" };
      },
    });
  }

  async rename(userId: string, id: string, titulo: string): Promise<ResultadoEdicionPin> {
    return runWithSavepointFallback<ResultadoEdicionPin>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `update core.copiloto_pin set title = $3::text where id = $1::uuid and author_id = $2::uuid and vertical = $4::text returning id;`,
          [id, userId, titulo, PLATAFORMA_VERTICAL],
        );
        return rows.length > 0 ? "ok" : "no_encontrado";
      },
      isRecoverable: sinMigrar,
      fallback: async () => "no_encontrado",
    });
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`delete from core.copiloto_pin where id = $1::uuid and author_id = $2::uuid and vertical = $3::text returning id;`, [id, userId, PLATAFORMA_VERTICAL]);
        return rows.length > 0;
      },
      isRecoverable: sinMigrar,
      fallback: async () => false,
    });
  }
}
