// Repositorio de la zona CFO segura (SA-41): rol `finanzas` de solo lectura y bitacora de cada consulta
// financiera -- puerto contra las funciones `security definer` de
// packages/db/migrations/0034_superadmin_zona_cfo.sql.
//
// SESIONES: todos los metodos son caller-bound (`withAppSession({ userId: callerId })`); esta clase no
// elige la sesion, recibe el `TenantDbSession` ya abierto. El API abre una transaccion PROPIA para
// `resolveRole` y otra para `logAccess`, de modo que el registro queda confirmado (COMMIT) antes de
// que el handler corra y sobrevive a un error del handler.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un SQLSTATE
// 42883/42P01/42703 (migracion 0034 sin aplicar) revierte SOLO el savepoint y devuelve
// `availability: "not_migrated"`; nunca un 500 ni un exito simulado. Los errores de negocio de SQL
// (42501, 22023...) se tipan como `SuperadminSeguridadError`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";
import type { CostosAvailability } from "./superadmin-costos-planes-repository.ts";

/** Rol efectivo en la zona CFO: `finanzas` = superadmin restringido a solo lectura. */
export type ZonaCfoRol = "superadmin" | "finanzas";
/** Acciones que registra `logAccess`; los cambios de rol los escribe el propio SQL de `setRole`. */
export type ZonaCfoAccion = "consulta" | "exportacion" | "denegado";

export interface CfoAccessLogRow {
  readonly seq: number;
  readonly actorUserId: string;
  readonly actorRol: ZonaCfoRol;
  readonly accion: ZonaCfoAccion | "rol_asignado" | "rol_retirado";
  readonly recurso: string;
  readonly filtros: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
}

export interface CfoZoneRoleRow {
  readonly staffUserId: string;
  readonly email: string;
  readonly rol: "finanzas";
  readonly assignedBy: string | null;
  readonly reason: string;
  readonly createdAtMs: number;
}

export interface CfoZoneRepository {
  /** CALLER. Rol efectivo (null = no es superadmin o caller-binding invalido). */
  resolveRole(callerId: string): Promise<{ availability: CostosAvailability; rol: ZonaCfoRol | null }>;
  /** CALLER (con rol). Registra una consulta, exportacion o denegacion; devuelve su seq. */
  logAccess(callerId: string, accion: ZonaCfoAccion, recurso: string, filtros: Readonly<Record<string, unknown>>): Promise<{ availability: CostosAvailability; seq: number | null }>;
  /** CALLER (superadmin no restringido). `rol: null` retira el rol. */
  setRole(callerId: string, targetUserId: string, rol: "finanzas" | null, motivo: string): Promise<{ availability: CostosAvailability }>;
  /** CALLER (superadmin no restringido). */
  listAccessLog(callerId: string, limit: number, beforeSeq: number | null): Promise<{ availability: CostosAvailability; entries: readonly CfoAccessLogRow[] }>;
  /** CALLER (superadmin no restringido). */
  listRoles(callerId: string): Promise<{ availability: CostosAvailability; roles: readonly CfoZoneRoleRow[] }>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-zona-cfo-repository: las funciones/tablas de 0034_superadmin_zona_cfo.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'zona CFO sin rol ni bitacora' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar el rol finanzas y la bitacora de consultas.",
  );
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function toTypedError(err: unknown): SuperadminSeguridadError | null {
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case "42501":
      return new SuperadminSeguridadError(message, "forbidden");
    case "22023":
    case "23514":
    case "22P02":
      return new SuperadminSeguridadError(message, "invalid");
    default:
      return null;
  }
}

async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

export class PostgresCfoZoneRepository implements CfoZoneRepository {
  constructor(private readonly db: TenantDbSession) {}

  resolveRole(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ rol: string | null }>(`select core.cfo_zone_resolve_role($1) as rol;`, [callerId]);
        const raw = rows[0]?.rol ?? null;
        const rol: ZonaCfoRol | null = raw === "superadmin" || raw === "finanzas" ? raw : null;
        return { availability: "available" as const, rol };
      },
      () => ({ availability: "not_migrated" as const, rol: null as ZonaCfoRol | null }),
    );
  }

  logAccess(callerId: string, accion: ZonaCfoAccion, recurso: string, filtros: Readonly<Record<string, unknown>>) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ seq: string | number }>(`select core.cfo_zone_log_access($1, $2, $3, $4::jsonb) as seq;`, [callerId, accion, recurso, JSON.stringify(filtros)]);
        return { availability: "available" as const, seq: rows[0] ? Number(rows[0].seq) : null };
      },
      () => ({ availability: "not_migrated" as const, seq: null as number | null }),
    );
  }

  setRole(callerId: string, targetUserId: string, rol: "finanzas" | null, motivo: string) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.cfo_zone_set_role($1, $2, $3, $4);`, [callerId, targetUserId, rol, motivo]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  listAccessLog(callerId: string, limit: number, beforeSeq: number | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          seq: string | number;
          actor_user_id: string;
          actor_rol: ZonaCfoRol;
          accion: CfoAccessLogRow["accion"];
          recurso: string;
          filtros: Record<string, unknown> | null;
          occurred_at: string | Date;
        }>(
          `select seq, actor_user_id, actor_rol, accion, recurso, filtros, occurred_at
             from core.list_cfo_access_log_for_superadmin($1, $2::int, $3::bigint);`,
          [callerId, limit, beforeSeq],
        );
        return {
          availability: "available" as const,
          entries: rows.map(
            (r): CfoAccessLogRow => ({
              seq: Number(r.seq),
              actorUserId: r.actor_user_id,
              actorRol: r.actor_rol,
              accion: r.accion,
              recurso: r.recurso,
              filtros: r.filtros ?? {},
              occurredAtMs: new Date(r.occurred_at).getTime(),
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, entries: [] as readonly CfoAccessLogRow[] }),
    );
  }

  listRoles(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ staff_user_id: string; email: string; rol: "finanzas"; assigned_by: string | null; reason: string; created_at: string | Date }>(
          `select staff_user_id, email, rol, assigned_by, reason, created_at from core.list_cfo_zone_roles_for_superadmin($1);`,
          [callerId],
        );
        return {
          availability: "available" as const,
          roles: rows.map((r): CfoZoneRoleRow => ({ staffUserId: r.staff_user_id, email: r.email, rol: r.rol, assignedBy: r.assigned_by, reason: r.reason, createdAtMs: new Date(r.created_at).getTime() })),
        };
      },
      () => ({ availability: "not_migrated" as const, roles: [] as readonly CfoZoneRoleRow[] }),
    );
  }
}

/** Adaptador en memoria para los tests de rutas (misma semantica de acceso y validacion que el SQL). */
export class InMemoryCfoZoneRepository implements CfoZoneRepository {
  private readonly superadmins = new Map<string, string>();
  private readonly restringidos = new Map<string, CfoZoneRoleRow>();
  private readonly log: CfoAccessLogRow[] = [];
  private seq = 0;
  /** Cuando es true, `logAccess` falla como si la base se hubiera caido (para probar el cierre en falso). */
  fallarAlRegistrar = false;
  /** Cuando es true, `resolveRole` falla con un error NO de migracion. */
  fallarAlResolver = false;

  constructor(private readonly opciones: { readonly migrado?: boolean; readonly now?: () => number } = {}) {}

  seedSuperadmin(userId: string, email = `${userId}@example.com`): void {
    this.superadmins.set(userId, email);
  }
  seedRole(userId: string): void {
    this.restringidos.set(userId, { staffUserId: userId, email: this.superadmins.get(userId) ?? "", rol: "finanzas", assignedBy: null, reason: "sembrado por una prueba", createdAtMs: this.now() });
  }
  /** Copia de la bitacora, para aserciones. */
  entries(): readonly CfoAccessLogRow[] {
    return [...this.log];
  }

  private get migrado(): boolean {
    return this.opciones.migrado ?? true;
  }
  private now(): number {
    return this.opciones.now ? this.opciones.now() : Date.now();
  }
  private rolDe(callerId: string): ZonaCfoRol | null {
    if (!this.superadmins.has(callerId)) return null;
    return this.restringidos.has(callerId) ? "finanzas" : "superadmin";
  }

  async resolveRole(callerId: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, rol: null as ZonaCfoRol | null };
    if (this.fallarAlResolver) throw new Error("fallo simulado al resolver el rol");
    return { availability: "available" as const, rol: this.rolDe(callerId) };
  }

  async logAccess(callerId: string, accion: ZonaCfoAccion, recurso: string, filtros: Readonly<Record<string, unknown>>) {
    if (!this.migrado) return { availability: "not_migrated" as const, seq: null as number | null };
    if (this.fallarAlRegistrar) throw new Error("fallo simulado al registrar la consulta");
    const rol = this.rolDe(callerId);
    if (rol === null) throw new SuperadminSeguridadError("caller binding invalido o sin rol en la zona CFO", "forbidden");
    if (accion !== "consulta" && accion !== "exportacion" && accion !== "denegado") throw new SuperadminSeguridadError("accion invalida", "invalid");
    const r = recurso.trim();
    if (r.length < 1 || r.length > 160) throw new SuperadminSeguridadError("recurso obligatorio (1-160 caracteres)", "invalid");
    if (JSON.stringify(filtros).length > 2000) throw new SuperadminSeguridadError("filtros debe ser un objeto de maximo 2000 caracteres", "invalid");
    this.seq += 1;
    this.log.push({ seq: this.seq, actorUserId: callerId, actorRol: rol, accion, recurso: r, filtros, occurredAtMs: this.now() });
    return { availability: "available" as const, seq: this.seq };
  }

  async setRole(callerId: string, targetUserId: string, rol: "finanzas" | null, motivo: string) {
    if (!this.migrado) return { availability: "not_migrated" as const };
    if (this.rolDe(callerId) !== "superadmin") throw new SuperadminSeguridadError("solo un superadmin sin restriccion cambia roles", "forbidden");
    if (targetUserId === callerId) throw new SuperadminSeguridadError("nadie se asigna ni se quita el rol a si mismo", "invalid");
    const m = motivo.trim();
    if (m.length < 20 || m.length > 500) throw new SuperadminSeguridadError("motivo obligatorio (20-500 caracteres)", "invalid");
    if (!this.superadmins.has(targetUserId)) throw new SuperadminSeguridadError("el destino no es superadmin de plataforma", "invalid");
    if (rol === null) this.restringidos.delete(targetUserId);
    else this.restringidos.set(targetUserId, { staffUserId: targetUserId, email: this.superadmins.get(targetUserId) ?? "", rol, assignedBy: callerId, reason: m, createdAtMs: this.now() });
    this.seq += 1;
    this.log.push({ seq: this.seq, actorUserId: callerId, actorRol: "superadmin", accion: rol === null ? "rol_retirado" : "rol_asignado", recurso: "zona-cfo/roles", filtros: { destino: targetUserId, rol: "finanzas", motivo: m.slice(0, 200) }, occurredAtMs: this.now() });
    return { availability: "available" as const };
  }

  async listAccessLog(callerId: string, limit: number, beforeSeq: number | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, entries: [] as readonly CfoAccessLogRow[] };
    if (this.rolDe(callerId) !== "superadmin") return { availability: "available" as const, entries: [] as readonly CfoAccessLogRow[] };
    const entries = this.log.filter((e) => beforeSeq === null || e.seq < beforeSeq).sort((a, b) => b.seq - a.seq).slice(0, Math.max(1, Math.min(limit, 500)));
    return { availability: "available" as const, entries };
  }

  async listRoles(callerId: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, roles: [] as readonly CfoZoneRoleRow[] };
    if (this.rolDe(callerId) !== "superadmin") return { availability: "available" as const, roles: [] as readonly CfoZoneRoleRow[] };
    return { availability: "available" as const, roles: [...this.restringidos.values()] };
  }
}
