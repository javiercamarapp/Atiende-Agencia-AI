// Valoraciones del Copiloto («Pregúntale a tus datos»): «Útil» / «No fue útil» con motivo opcional de una lista cerrada (migracion 0076).
//
//   PUT <base>/conversaciones/:conversationId/mensajes/:seq/valoracion   { util, motivo? } -> { util, motivo }
//   GET <base>/valoraciones/resumen?dias=30                              -> { disponible, dias, utiles, noUtiles, motivos }
//
// `<base>` es la ruta de chat de cada vertical: la cadena de autorizacion (JWT -> sesion RLS -> membresia verificada) y el rol ya los
// puso quien monta esto (`mountConversacionesRoutes`), asi que TODAS las verticales que guardan conversaciones lo tienen.
//
// Reglas:
//   * Solo el AUTOR valora, solo respuestas del ASISTENTE de una conversacion propia, de su organizacion y vertical. La RLS de 0076 lo
//     impone; aqui ademas se comprueba antes (defensa en profundidad) y un mensaje ajeno, de otra organizacion o inexistente responde 404.
//   * Sin texto libre: el motivo es de una lista cerrada (cero PII). La organizacion y la vertical salen de la sesion, nunca del cuerpo.
//   * El resumen es solo conteos y solo owner/admin de la organizacion (la funcion SQL lo exige; 42501 -> 403).
//   * Base SIN migrar (0076 pendiente): SAVEPOINT + 42P01/42883/42703 -> PUT 503 «no disponible aun», resumen `disponible: false`. Nunca 500.
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { logEvent } from "../logger.ts";
import type { ConversacionScope, ConversacionVertical } from "./conversaciones.ts";

export const MOTIVOS_VALORACION = ["dato_incorrecto", "incompleta", "no_entendio", "otro"] as const;
export type MotivoValoracion = (typeof MOTIVOS_VALORACION)[number];

export interface Valoracion {
  readonly util: boolean;
  readonly motivo: MotivoValoracion | null;
}

export const VALORACIONES_NO_DISPONIBLE = "Las valoraciones todavía no están disponibles: falta aplicar la actualización de base de datos (0076).";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIAS_RESUMEN_POR_OMISION = 30;
const MAX_DIAS_RESUMEN = 365;

/** Cuerpo estricto: `{ util: boolean, motivo?: <lista cerrada> | null }`; el motivo solo con `util: false`. */
export function parseValoracion(raw: unknown): Valoracion {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (key !== "util" && key !== "motivo") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  if (typeof body["util"] !== "boolean") throw Errors.validation("util: se esperaba true o false.");
  const m = body["motivo"];
  if (m === undefined || m === null) return { util: body["util"], motivo: null };
  if (typeof m !== "string" || !(MOTIVOS_VALORACION as readonly string[]).includes(m)) throw Errors.validation(`motivo: se esperaba uno de ${MOTIVOS_VALORACION.join("|")}.`);
  if (body["util"]) throw Errors.validation("motivo: solo acompaña a «No fue útil».");
  return { util: false, motivo: m as MotivoValoracion };
}

export function parseDiasResumen(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DIAS_RESUMEN_POR_OMISION;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DIAS_RESUMEN) throw Errors.validation(`dias: se esperaba un entero de 1 a ${MAX_DIAS_RESUMEN}.`);
  return Number(raw);
}

export type ResultadoValoracion = "ok" | "no_encontrado" | "no_disponible";

export interface ResumenValoraciones {
  readonly disponible: boolean;
  readonly utiles: number;
  readonly noUtiles: number;
  /** Conteo de «No fue útil» por motivo (`sin_motivo` = no eligio uno). */
  readonly motivos: Readonly<Record<MotivoValoracion | "sin_motivo", number>>;
}

export interface FilaResumenSql {
  readonly util: boolean;
  readonly motivo: string | null;
  readonly total: number | string;
}

/** Junta filas `(util, motivo, total)` del SQL en el resumen (conteos enteros; un motivo desconocido cuenta como `otro`). */
export function sumarFilas(filas: readonly FilaResumenSql[]): Omit<ResumenValoraciones, "disponible"> {
  const motivos: Record<MotivoValoracion | "sin_motivo", number> = { dato_incorrecto: 0, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 0 };
  let utiles = 0;
  let noUtiles = 0;
  for (const f of filas) {
    const n = Number(f.total);
    if (!Number.isFinite(n)) continue;
    if (f.util) {
      utiles += n;
      continue;
    }
    noUtiles += n;
    const k = f.motivo === null ? "sin_motivo" : (MOTIVOS_VALORACION as readonly string[]).includes(f.motivo) ? (f.motivo as MotivoValoracion) : "otro";
    motivos[k] += n;
  }
  return { utiles, noUtiles, motivos };
}

const codigo = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined);

export interface ValoracionesRepository {
  guardar(scope: ConversacionScope, conversationId: string, seq: number, v: Valoracion): Promise<ResultadoValoracion>;
  /** null = sin permiso (no es owner/admin de la organizacion). */
  resumen(organizationId: string, dias: number): Promise<ResumenValoraciones | null>;
}

export class PostgresValoracionesRepository implements ValoracionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  async guardar(scope: ConversacionScope, conversationId: string, seq: number, v: Valoracion): Promise<ResultadoValoracion> {
    return runWithSavepointFallback<ResultadoValoracion>({
      session: this.db,
      primary: async () => {
        // Defensa en profundidad (la RLS de 0076 ya lo exige): el mensaje es del asistente, de una conversacion PROPIA de esta organizacion y vertical.
        const { rows } = await this.db.query<{ ok: number }>(
          `select 1 as ok
             from core.data_chat_message m
             join core.data_chat_conversation c on c.id = m.conversation_id
            where m.conversation_id = $1::uuid and m.seq = $2::int and m.role = 'assistant'
              and c.user_id = $3::uuid and c.organization_id is not distinct from $4::uuid and c.vertical = $5::text
            limit 1;`,
          [conversationId, seq, scope.userId, scope.organizationId, scope.vertical],
        );
        if (rows.length === 0) return "no_encontrado";
        await this.db.query(
          `insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util, motivo)
           values ($1::uuid, $2::int, $3::uuid, $4::uuid, $5::text, $6::boolean, $7::text)
           on conflict (conversation_id, seq, user_id) do update set util = excluded.util, motivo = excluded.motivo, updated_at = now();`,
          [conversationId, seq, scope.userId, scope.organizationId, scope.vertical, v.util, v.motivo],
        );
        return "ok";
      },
      // 42501 = la RLS rechazo la fila (mensaje ajeno visto de otra forma): se responde como «no existe», igual que una conversacion ajena.
      isRecoverable: (err) => isMigrationPendingError(err) || codigo(err) === "42501",
      fallback: async (err) => (codigo(err) === "42501" ? "no_encontrado" : "no_disponible"),
    });
  }

  async resumen(organizationId: string, dias: number): Promise<ResumenValoraciones | null> {
    return runWithSavepointFallback<ResumenValoraciones | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<FilaResumenSql>(
          `select util, motivo, total from core.data_chat_feedback_resumen($1::uuid, now() - make_interval(days => $2::int));`,
          [organizationId, dias],
        );
        return { disponible: true, ...sumarFilas(rows) };
      },
      isRecoverable: (err) => isMigrationPendingError(err) || codigo(err) === "42501",
      fallback: async (err) => (codigo(err) === "42501" ? null : { disponible: false, ...sumarFilas([]) }),
    });
  }
}

export function valoracionesRepo(deps: AppDeps, db: TenantDbSession): ValoracionesRepository {
  return deps.dataChat?.valoraciones?.(db) ?? new PostgresValoracionesRepository(db);
}

export interface ValoracionesRoutesConfig {
  readonly base: string;
  readonly vertical: ConversacionVertical;
  readonly roles: readonly string[];
}

function seqParam(c: Context<CoreAuthHonoEnv>): number {
  const raw = c.req.param("seq") ?? "";
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw Errors.notFound("Mensaje no encontrado.");
  return Number(raw);
}

/** Monta el PUT de la valoracion y el resumen de la organizacion bajo la ruta de chat de una vertical. */
export function mountValoracionesRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, cfg: ValoracionesRoutesConfig): void {
  app.put(`${cfg.base}/conversaciones/:conversationId/mensajes/:seq/valoracion`, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = c.req.param("conversationId") ?? "";
    // Un id mal formado jamas llega a la base y es indistinguible de uno inexistente.
    if (!UUID_RE.test(id)) throw Errors.notFound("Mensaje no encontrado.");
    const seq = seqParam(c);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const v = parseValoracion(raw);
    const scope: ConversacionScope = { organizationId: c.get("organizationId"), userId: c.get("userId"), vertical: cfg.vertical };
    const r = await valoracionesRepo(deps, c.get("db")).guardar(scope, id.toLowerCase(), seq, v);
    if (r === "no_encontrado") throw Errors.notFound("Mensaje no encontrado.");
    if (r === "no_disponible") throw Errors.serviceUnavailable(VALORACIONES_NO_DISPONIBLE);
    // Bitacora operativa: sin pregunta, respuesta ni ids de mensaje (solo lo necesario para medir).
    logEvent(c, "info", "data_chat_valoracion", { vertical: cfg.vertical, util: v.util, motivo: v.motivo ?? "ninguno" });
    return c.json({ util: v.util, motivo: v.motivo });
  });

  app.get(`${cfg.base}/valoraciones/resumen`, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const dias = parseDiasResumen(c.req.query("dias"));
    const r = await valoracionesRepo(deps, c.get("db")).resumen(c.get("organizationId"), dias);
    if (r === null) throw Errors.forbidden("Solo el dueño o un administrador ven el resumen de valoraciones.");
    return c.json({ ...r, dias });
  });
}
