// L-P3-17 -- bitacora de escrituras de licitaciones (REQ-083/084/171): quien cambio que, con antes y despues y un `correlation_id` que une la
// ingesta, la version de la convocatoria, la aprobacion y el manifiesto. SQL en migrations/038_licitaciones_stepup_un_solo_uso_y_bitacora_escrituras.sql
// (tabla `licitaciones.audit_trail`, de SOLO ADICION: `authenticated` solo tiene SELECT y la unica escritura es `licitaciones.append_audit`).
//
// Misma transaccion que la escritura de negocio: `appendAuditoria` NO traga errores reales (un fallo de permisos revierte la escritura: nada queda
// sin rastro). Compatibilidad con la base sin migrar: 42883/42P01/42703 (la 038 aun no esta aplicada) se recuperan con SAVEPOINT -- la transaccion
// compartida NO queda abortada (25P02) -- y la escritura sigue como antes, sin renglon de bitacora (devuelve `false`).
import { randomUUID } from "node:crypto";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";

/** Entidades que escriben en la bitacora (cerradas: nunca una cadena libre en una ruta). */
export const AUDIT_ENTITIES = [
  "documento_empresa",
  "tarifa",
  "capacidad",
  "experiencia",
  "firmante",
  "perfil_empresa",
  "producto_servicio",
  "ubicacion_empresa",
  "restriccion_empresa",
  "socio_empresa",
  "configuracion",
  "perfil_matching",
  "staff_invitacion",
  "staff_miembro",
  "convocatoria",
  "expediente",
  "paquete",
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export function isAuditEntity(value: unknown): value is AuditEntity {
  return typeof value === "string" && (AUDIT_ENTITIES as readonly string[]).includes(value);
}

export interface AuditTrailInput {
  readonly entity: AuditEntity;
  readonly entityId: string | null;
  /** `<entidad>.<verbo>` (ej. `tarifa.editada`). */
  readonly action: string;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  /** `null` = sesion de sistema (ingesta automatica). Para staff SIEMPRE es `c.get("userId")`, nunca del cuerpo. */
  readonly actorId: string | null;
  readonly correlationId: string | null;
}

export interface AuditTrailEntry {
  readonly id: string;
  /** Llave de paginacion (bigint como cadena). */
  readonly seq: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface AuditTrailFilters {
  readonly entity?: string;
  readonly entityId?: string;
  readonly actorId?: string;
  /** ISO inclusivo. */
  readonly desde?: string;
  /** ISO inclusivo. */
  readonly hasta?: string;
  readonly correlationId?: string;
  /** Traza de punta a punta de UNA convocatoria: sus renglones (`entity_id`) y los de cualquier otra entidad que comparta su correlacion de origen. */
  readonly tenderId?: string;
}

export interface AuditTrailPage {
  readonly items: readonly AuditTrailEntry[];
  /** `seq` del ultimo renglon devuelto si hay mas (paginacion por llave); `null` al final. */
  readonly nextCursor: string | null;
  /** `false` = la migracion 038 aun no esta aplicada (estado honesto "no disponible aun"; nunca una lista vacia fingiendo "sin cambios"). */
  readonly available: boolean;
}

export const AUDIT_DEFAULT_LIMIT = 25;
export const AUDIT_MAX_LIMIT = 100;
const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,64}$/u;

/** Sanea un `X-Correlation-Id` entrante: solo largo 1..64 y [A-Za-z0-9._:-]; cualquier otra cosa -> `null` (se descarta, nunca se recorta ni se interpreta). */
export function sanitizeCorrelationId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return CORRELATION_RE.test(v) ? v : null;
}

export function newCorrelationId(): string {
  return `c-${randomUUID()}`;
}

const SECRETISH = /token|secret|password|passwd|hash|ciphertext|api[_-]?key|authorization/iu;

/**
 * Arma el `antes`/`despues` con una LISTA CERRADA de campos de la entidad: lo que no esta en `allowed` no entra; ademas se descartan los
 * nombres que parecen secreto aun si alguien los agregara a la lista, y los valores que no son escalares ni listas de escalares (nada de objetos anidados).
 */
export function pickAuditFields(source: object | null | undefined, allowed: readonly string[]): Record<string, string | number | boolean | null | (string | number)[]> | null {
  if (source === null || source === undefined) return null;
  const out: Record<string, string | number | boolean | null | (string | number)[]> = {};
  const rec = source as Record<string, unknown>;
  for (const key of allowed) {
    if (SECRETISH.test(key) || !(key in rec)) continue;
    const v = rec[key];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (v instanceof Date) out[key] = v.toISOString();
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      // Una lista larga se recorta a 100 elementos y deja `<campo>Total` con el tamano real: el cambio no queda sin rastro.
      out[key] = v.slice(0, 100) as (string | number)[];
      if (v.length > 100) out[`${key}Total`] = v.length;
    }
  }
  return out;
}

/** Anota UNA escritura. `true` = quedo el renglon; `false` = la migracion 038 aun no esta aplicada (compatibilidad). */
export async function appendAuditoria(db: TenantDbSession, organizationId: string, entry: AuditTrailInput): Promise<boolean> {
  return runWithSavepointFallback<boolean>({
    session: db,
    savepointName: "sp_licitaciones_append_audit",
    primary: async () => {
      await db.query(`select licitaciones.append_audit($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8);`, [
        entry.actorId,
        organizationId,
        entry.entity,
        entry.entityId,
        entry.action,
        entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        entry.correlationId,
      ]);
      return true;
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => false,
  });
}

interface AuditRaw {
  id: string;
  seq: string | number;
  entity: string;
  entity_id: string | null;
  action: string;
  before: unknown;
  after: unknown;
  actor_id: string | null;
  correlation_id: string | null;
  created_at: string | Date;
}

function mapRow(r: AuditRaw): AuditTrailEntry {
  return {
    id: r.id,
    seq: String(r.seq),
    entity: r.entity,
    entityId: r.entity_id,
    action: r.action,
    before: r.before ?? null,
    after: r.after ?? null,
    actorId: r.actor_id,
    correlationId: r.correlation_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  };
}

/**
 * Lee la bitacora (RLS: solo owner/admin de la organizacion). Paginacion por llave (`seq` descendente): `cursor` = `nextCursor` de la pagina previa.
 * Con `orden = "asc"` (traza de una convocatoria/correlacion) devuelve el orden cronologico, tambien con cursor (seq > cursor).
 */
export async function listAuditoria(
  db: TenantDbSession,
  organizationId: string,
  filters: AuditTrailFilters,
  opts: { readonly limit?: number; readonly cursor?: string | null; readonly orden?: "asc" | "desc" } = {},
): Promise<AuditTrailPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
  const asc = opts.orden === "asc";
  const where: string[] = ["organization_id = $1"];
  const params: unknown[] = [organizationId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.entity) add("entity = ?", filters.entity);
  if (filters.entityId) add("entity_id = ?", filters.entityId);
  if (filters.actorId) add("actor_id = ?::uuid", filters.actorId);
  if (filters.correlationId) add("correlation_id = ?", filters.correlationId);
  if (filters.tenderId) {
    params.push(filters.tenderId);
    const t = `$${params.length}`;
    where.push(
      `(entity_id = ${t} or correlation_id in (select a2.correlation_id from licitaciones.audit_trail a2 where a2.organization_id = $1 and a2.entity = 'convocatoria' and a2.entity_id = ${t} and a2.correlation_id is not null))`,
    );
  }
  if (filters.desde) add("created_at >= ?::timestamptz", filters.desde);
  if (filters.hasta) add("created_at <= ?::timestamptz", filters.hasta);
  if (opts.cursor && /^\d{1,18}$/u.test(opts.cursor)) add(asc ? "seq > ?::bigint" : "seq < ?::bigint", opts.cursor);
  params.push(limit + 1);
  return runWithSavepointFallback<AuditTrailPage>({
    session: db,
    savepointName: "sp_licitaciones_list_audit",
    primary: async () => {
      const { rows } = await db.query<AuditRaw>(
        `select id, seq, entity, entity_id, action, before, after, actor_id, correlation_id, created_at
           from licitaciones.audit_trail where ${where.join(" and ")} order by seq ${asc ? "asc" : "desc"} limit $${params.length};`,
        params,
      );
      const hayMas = rows.length > limit;
      const items = rows.slice(0, limit).map(mapRow);
      return { items, nextCursor: hayMas ? (items[items.length - 1]?.seq ?? null) : null, available: true };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ items: [], nextCursor: null, available: false }),
  });
}

/** `correlation_id` con que nacio la convocatoria (para heredarlo). `null` si no hay renglon o la 038 aun no esta aplicada. */
export async function tenderCorrelationId(db: TenantDbSession, organizationId: string, tenderId: string): Promise<string | null> {
  return runWithSavepointFallback<string | null>({
    session: db,
    savepointName: "sp_licitaciones_tender_corr",
    primary: async () => {
      const { rows } = await db.query<{ c: string | null }>(`select licitaciones.tender_correlation_id($1, $2) as c;`, [organizationId, tenderId]);
      return sanitizeCorrelationId(rows[0]?.c ?? null);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => null,
  });
}
