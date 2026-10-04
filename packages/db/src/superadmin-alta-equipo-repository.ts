// Repositorio del alta del equipo de una organizacion por un superadmin (SA-L-26 minimo, go-live G-07) -- puerto contra las funciones de
// packages/db/migrations/0053_superadmin_alta_equipo.sql.
//
// SESIONES: leer/invitar/reenviar/revocar son caller-bound (`withAppSession({ userId: callerId })`); `aceptacionParaSistema` es de SOLO
// SISTEMA (`withAppSession({ userId: null })`). Esta clase no elige la sesion, recibe el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR:
//   * `leer` y `aceptacionParaSistema` corren bajo `runWithSavepointFallback`: contra la base sin la 0053 (SQLSTATE 42883/42P01/42703)
//     devuelven `{ ok: false, razon: "no_migrado" }` y la transaccion sigue utilizable (nunca 500).
//   * Las mutaciones lanzan `EquipoNoDisponibleError` (la ruta responde 503 honesto). Se lanza hacia AFUERA del callback de
//     `withAppSession`: el motor revierte la transaccion entera y NADA mas corre en ella despues del error de Postgres.
//   * Los rechazos de negocio de la base (SQLSTATE 42501/22023/P0002/23505/55000) se traducen a `EquipoInvitacionError` con un codigo
//     estable; el texto es el de la propia funcion SQL (estatico, sin datos personales).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type EquipoFuente<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: "no_migrado" | "error" };

export interface EquipoMiembro {
  readonly userId: string;
  /** Correo enmascarado por la base (primer caracter + dominio). */
  readonly correo: string;
  readonly rol: string;
  readonly platformRole: string;
  /** null = todas las sucursales. */
  readonly propertyIds: readonly string[] | null;
  readonly altaEn: string;
}

export interface EquipoInvitacionPendiente {
  readonly id: string;
  readonly correo: string;
  readonly rol: string;
  readonly platformRole: string;
  readonly propertyIds: readonly string[] | null;
  readonly creadaEn: string;
  readonly venceEn: string;
  readonly vencida: boolean;
}

export interface EquipoSucursal {
  readonly id: string;
  readonly nombre: string;
  readonly estado: string;
}

export interface OrgEquipo {
  readonly miembros: readonly EquipoMiembro[];
  readonly invitaciones: readonly EquipoInvitacionPendiente[];
  readonly sucursales: readonly EquipoSucursal[];
}

/** Invitacion recien creada/reenviada. `email` va COMPLETO (solo para armar el correo): la ruta nunca lo devuelve sin enmascarar. */
export interface InvitacionEquipo {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: string;
  readonly platformRole: string;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface InvitarEquipoInput {
  readonly organizationId: string;
  readonly email: string;
  readonly verticalRole: string;
  /** null = todas las sucursales. */
  readonly propertyIds: readonly string[] | null;
  readonly tokenHash: string;
  readonly motivo: string;
  readonly confirmarSegundoOwner: boolean;
}

export type EquipoInvitacionCodigo = "forbidden" | "validation" | "not_found" | "conflict" | "segundo_owner";

export class EquipoInvitacionError extends Error {
  constructor(readonly codigo: EquipoInvitacionCodigo, message: string) {
    super(message);
    this.name = "EquipoInvitacionError";
  }
}

/** La migracion 0053 aun no esta aplicada en este despliegue. */
export class EquipoNoDisponibleError extends Error {
  constructor() {
    super("El alta de equipo todavia no esta disponible en este despliegue: falta aplicar la migracion 0053_superadmin_alta_equipo.");
    this.name = "EquipoNoDisponibleError";
  }
}

export interface AceptacionSuperadmin {
  readonly inviteId: string;
  readonly organizationId: string;
}

export interface OrgEquipoRepository {
  /** CALLER. `data = null` = la organizacion no existe o el caller no es superadmin. */
  leer(callerId: string, organizationId: string): Promise<EquipoFuente<OrgEquipo | null>>;
  /** CALLER. Lanza EquipoInvitacionError (rechazo de negocio) o EquipoNoDisponibleError (sin la 0053). */
  invitar(callerId: string, input: InvitarEquipoInput): Promise<InvitacionEquipo>;
  /** CALLER. Token nuevo: el anterior deja de servir. */
  reenviar(callerId: string, organizationId: string, inviteId: string, tokenHash: string, motivo: string): Promise<InvitacionEquipo>;
  /** CALLER. Devuelve el id revocado. */
  revocar(callerId: string, organizationId: string, inviteId: string, motivo: string): Promise<string>;
  /** SISTEMA. `data = null` = la invitacion no existe, no esta aceptada o no la creo un superadmin. */
  aceptacionParaSistema(tokenHash: string): Promise<EquipoFuente<AceptacionSuperadmin | null>>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-alta-equipo-repository: las funciones de 0053_superadmin_alta_equipo.sql no existen todavia (SQLSTATE 42883/42P01/42703) -- " +
      "degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion (o su espejo en supabase/migrations/).",
  );
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

/** Quita el prefijo `nombre_funcion: ` del mensaje de la funcion SQL (los mensajes son estaticos y en espanol). */
function mensajeSql(err: unknown): string {
  const raw = err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
  const i = raw.indexOf(": ");
  return i > 0 && i < 60 ? raw.slice(i + 2) : raw;
}

/** Traduce un error de Postgres de las funciones de la 0053; lo que no reconoce se relanza tal cual. */
export function traducirErrorEquipo(err: unknown): never {
  if (isMigrationPendingError(err)) {
    warnOnce();
    throw new EquipoNoDisponibleError();
  }
  switch (pgCode(err)) {
    case "42501":
      throw new EquipoInvitacionError("forbidden", "Solo un superadmin de plataforma puede gestionar el equipo de una organización.");
    case "22023":
      throw new EquipoInvitacionError("validation", mensajeSql(err));
    case "P0002":
      throw new EquipoInvitacionError("not_found", mensajeSql(err));
    case "23505":
      throw new EquipoInvitacionError("conflict", mensajeSql(err));
    case "55000":
      throw new EquipoInvitacionError("segundo_owner", mensajeSql(err));
    default:
      throw err;
  }
}

interface InvitacionRow {
  id: string;
  email: string;
  vertical_role: string;
  platform_role: string;
  property_ids: string[] | null;
  status: string;
  expires_at: Date | string;
  created_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapInvitacion(r: InvitacionRow): InvitacionEquipo {
  return { id: r.id, email: r.email, verticalRole: r.vertical_role, platformRole: r.platform_role, propertyIds: r.property_ids, status: r.status, expiresAt: iso(r.expires_at), createdAt: iso(r.created_at) };
}

export class PostgresOrgEquipoRepository implements OrgEquipoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async guarded<T>(fuente: string, run: () => Promise<T>): Promise<EquipoFuente<T>> {
    return runWithSavepointFallback<EquipoFuente<T>>({
      session: this.db,
      primary: async () => ({ ok: true as const, data: await run() }),
      isRecoverable: () => true,
      fallback: async (err) => {
        if (isMigrationPendingError(err)) {
          warnOnce();
          return { ok: false as const, razon: "no_migrado" as const };
        }
        console.error(`superadmin-alta-equipo-repository: la fuente '${fuente}' fallo (SQLSTATE ${pgCode(err)}).`);
        return { ok: false as const, razon: "error" as const };
      },
    });
  }

  leer(callerId: string, organizationId: string) {
    return this.guarded("leer", async () => {
      const { rows } = await this.db.query<{ equipo: OrgEquipo | null }>(`select core.list_org_team_for_superadmin($1::uuid, $2::uuid) as equipo;`, [callerId, organizationId]);
      return rows[0]?.equipo ?? null;
    });
  }

  async invitar(callerId: string, input: InvitarEquipoInput): Promise<InvitacionEquipo> {
    try {
      const { rows } = await this.db.query<InvitacionRow>(
        `select * from core.superadmin_invite_staff($1::uuid, $2::uuid, $3, $4, $5::uuid[], $6, $7, $8);`,
        [callerId, input.organizationId, input.email, input.verticalRole, input.propertyIds === null ? null : [...input.propertyIds], input.tokenHash, input.motivo, input.confirmarSegundoOwner],
      );
      const row = rows[0];
      if (!row) throw new Error("superadmin_invite_staff no devolvio la invitacion");
      return mapInvitacion(row);
    } catch (err) {
      return traducirErrorEquipo(err);
    }
  }

  async reenviar(callerId: string, organizationId: string, inviteId: string, tokenHash: string, motivo: string): Promise<InvitacionEquipo> {
    try {
      const { rows } = await this.db.query<InvitacionRow>(`select * from core.superadmin_resend_staff_invite($1::uuid, $2::uuid, $3::uuid, $4, $5);`, [callerId, organizationId, inviteId, tokenHash, motivo]);
      const row = rows[0];
      if (!row) throw new Error("superadmin_resend_staff_invite no devolvio la invitacion");
      return mapInvitacion(row);
    } catch (err) {
      return traducirErrorEquipo(err);
    }
  }

  async revocar(callerId: string, organizationId: string, inviteId: string, motivo: string): Promise<string> {
    try {
      const { rows } = await this.db.query<{ id: string }>(`select core.superadmin_revoke_staff_invite($1::uuid, $2::uuid, $3::uuid, $4) as id;`, [callerId, organizationId, inviteId, motivo]);
      const id = rows[0]?.id;
      if (!id) throw new Error("superadmin_revoke_staff_invite no devolvio el id");
      return id;
    } catch (err) {
      return traducirErrorEquipo(err);
    }
  }

  aceptacionParaSistema(tokenHash: string) {
    return this.guarded("aceptacionParaSistema", async () => {
      const { rows } = await this.db.query<{ invite_id: string; organization_id: string }>(`select invite_id, organization_id from core.superadmin_invite_acceptance_for_system($1);`, [tokenHash]);
      const r = rows[0];
      return r ? { inviteId: r.invite_id, organizationId: r.organization_id } : null;
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// En memoria (tests de las rutas): replica las reglas de la 0053 (lo que valida la base real esta cubierto en
// scripts/verify-superadmin-alta-equipo/, aqui solo se necesita el mismo contrato para probar el cableado HTTP).
// ---------------------------------------------------------------------------------------------------------------------------------
const ROLES_RESTAURANTES: Readonly<Record<string, string>> = { owner: "owner", admin: "admin", staff: "member", repartidor: "member" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

export function enmascararCorreo(email: string): string {
  const arroba = email.indexOf("@");
  if (arroba <= 0) return "***";
  return `${email[0]}***@${email.slice(arroba + 1)}`;
}

interface OrgMem {
  readonly vertical: string;
  readonly sucursales: Map<string, { nombre: string; estado: string }>;
  readonly miembros: Array<{ userId: string; email: string; rol: string; platformRole: string; propertyIds: string[] | null; altaEn: string }>;
}
interface InvMem {
  id: string;
  organizationId: string;
  email: string;
  verticalRole: string;
  platformRole: string;
  propertyIds: string[] | null;
  tokenHash: string;
  status: "pending" | "accepted" | "revoked";
  expiresAt: string;
  createdAt: string;
  porSuperadmin: boolean;
}

export class InMemoryOrgEquipoRepository implements OrgEquipoRepository {
  private readonly superadmins = new Set<string>();
  private readonly orgs = new Map<string, OrgMem>();
  private readonly invitaciones: InvMem[] = [];
  private disponible = true;
  private seq = 0;
  /** Bitacora (solo correo enmascarado y motivo, como la real). */
  readonly bitacora: Array<{ evento: "org_invite_created" | "org_invite_resent" | "org_invite_revoked"; actor: string; organizationId: string; inviteId: string; correo: string; motivo: string }> = [];
  ahora: () => Date = () => new Date();

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  /** Simula la base sin la 0053. */
  seedNoMigrado(): void {
    this.disponible = false;
  }
  seedOrganizacion(id: string, vertical: string, sucursales: ReadonlyArray<{ id: string; nombre: string }> = []): void {
    this.orgs.set(id, { vertical, sucursales: new Map(sucursales.map((s) => [s.id, { nombre: s.nombre, estado: "active" }])), miembros: [] });
  }
  seedMiembro(organizationId: string, m: { userId: string; email: string; rol: string; propertyIds?: string[] | null }): void {
    const org = this.orgs.get(organizationId);
    if (!org) throw new Error("seedMiembro: organizacion desconocida");
    org.miembros.push({ userId: m.userId, email: m.email.toLowerCase(), rol: m.rol, platformRole: ROLES_RESTAURANTES[m.rol] ?? "member", propertyIds: m.propertyIds ?? null, altaEn: this.ahora().toISOString() });
  }
  /** Marca como aceptada la invitacion cuyo hash se indica (lo hace core.accept_staff_invite en la base real). */
  marcarAceptada(tokenHash: string): void {
    const inv = this.invitaciones.find((i) => i.tokenHash === tokenHash);
    if (inv) inv.status = "accepted";
  }
  todas(): readonly InvMem[] {
    return this.invitaciones;
  }

  private exigirSuperadmin(callerId: string): void {
    if (!this.superadmins.has(callerId)) throw new EquipoInvitacionError("forbidden", "Solo un superadmin de plataforma puede gestionar el equipo de una organización.");
  }
  private exigirDisponible(): void {
    if (!this.disponible) throw new EquipoNoDisponibleError();
  }
  private serializar(i: InvMem): InvitacionEquipo {
    return { id: i.id, email: i.email, verticalRole: i.verticalRole, platformRole: i.platformRole, propertyIds: i.propertyIds, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt };
  }
  private motivoValido(motivo: string): void {
    if (motivo.trim().length < 20) throw new EquipoInvitacionError("validation", "motivo obligatorio (minimo 20 caracteres)");
  }

  async leer(callerId: string, organizationId: string): Promise<EquipoFuente<OrgEquipo | null>> {
    if (!this.disponible) return { ok: false, razon: "no_migrado" };
    const org = this.orgs.get(organizationId);
    if (!this.superadmins.has(callerId) || !org) return { ok: true, data: null };
    const ahora = this.ahora().getTime();
    return {
      ok: true,
      data: {
        miembros: org.miembros.map((m) => ({ userId: m.userId, correo: enmascararCorreo(m.email), rol: m.rol, platformRole: m.platformRole, propertyIds: m.propertyIds, altaEn: m.altaEn })),
        invitaciones: this.invitaciones
          .filter((i) => i.organizationId === organizationId && i.status === "pending")
          .map((i) => ({ id: i.id, correo: enmascararCorreo(i.email), rol: i.verticalRole, platformRole: i.platformRole, propertyIds: i.propertyIds, creadaEn: i.createdAt, venceEn: i.expiresAt, vencida: Date.parse(i.expiresAt) <= ahora })),
        sucursales: [...org.sucursales].map(([id, s]) => ({ id, nombre: s.nombre, estado: s.estado })),
      },
    };
  }

  async invitar(callerId: string, input: InvitarEquipoInput): Promise<InvitacionEquipo> {
    this.exigirDisponible();
    this.exigirSuperadmin(callerId);
    this.motivoValido(input.motivo);
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new EquipoInvitacionError("validation", "correo invalido");
    const org = this.orgs.get(input.organizationId);
    if (!org) throw new EquipoInvitacionError("not_found", "organizacion no encontrada");
    if (org.vertical !== "restaurantes") throw new EquipoInvitacionError("validation", `el alta de equipo aun no esta disponible para la vertical ${org.vertical}`);
    const platformRole = ROLES_RESTAURANTES[input.verticalRole];
    if (!platformRole) throw new EquipoInvitacionError("validation", "rol fuera de la lista blanca (owner, admin, staff, repartidor)");
    if (input.propertyIds !== null) {
      if (input.propertyIds.length === 0) throw new EquipoInvitacionError("validation", "property_ids vacio (usa null para todas las sucursales)");
      if (input.propertyIds.some((p) => !org.sucursales.has(p))) throw new EquipoInvitacionError("validation", "alguna sucursal no pertenece a la organizacion");
    }
    if (org.miembros.some((m) => m.email === email)) throw new EquipoInvitacionError("conflict", "ese correo ya es miembro de la organizacion");
    const ahora = this.ahora().getTime();
    const vigentes = this.invitaciones.filter((i) => i.organizationId === input.organizationId && i.status === "pending" && Date.parse(i.expiresAt) > ahora);
    if (vigentes.some((i) => i.email === email)) throw new EquipoInvitacionError("conflict", "ya hay una invitacion pendiente para ese correo (reenviala o revocala)");
    if (input.verticalRole === "owner" && !input.confirmarSegundoOwner && (org.miembros.some((m) => m.platformRole === "owner") || vigentes.some((i) => i.platformRole === "owner"))) {
      throw new EquipoInvitacionError("segundo_owner", "la organizacion ya tiene un owner (confirma explicitamente un segundo owner)");
    }
    const inv: InvMem = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      organizationId: input.organizationId,
      email,
      verticalRole: input.verticalRole,
      platformRole,
      propertyIds: input.propertyIds === null ? null : [...new Set(input.propertyIds)],
      tokenHash: input.tokenHash,
      status: "pending",
      expiresAt: new Date(ahora + SIETE_DIAS_MS).toISOString(),
      createdAt: new Date(ahora).toISOString(),
      porSuperadmin: true,
    };
    this.invitaciones.push(inv);
    this.bitacora.push({ evento: "org_invite_created", actor: callerId, organizationId: input.organizationId, inviteId: inv.id, correo: enmascararCorreo(email), motivo: input.motivo.trim() });
    return this.serializar(inv);
  }

  private pendiente(organizationId: string, inviteId: string): InvMem {
    const inv = this.invitaciones.find((i) => i.id === inviteId && i.organizationId === organizationId && i.status === "pending");
    if (!inv) throw new EquipoInvitacionError("not_found", "invitacion no encontrada o ya no esta pendiente");
    return inv;
  }

  async reenviar(callerId: string, organizationId: string, inviteId: string, tokenHash: string, motivo: string): Promise<InvitacionEquipo> {
    this.exigirDisponible();
    this.exigirSuperadmin(callerId);
    this.motivoValido(motivo);
    const inv = this.pendiente(organizationId, inviteId);
    inv.tokenHash = tokenHash;
    inv.expiresAt = new Date(this.ahora().getTime() + SIETE_DIAS_MS).toISOString();
    this.bitacora.push({ evento: "org_invite_resent", actor: callerId, organizationId, inviteId, correo: enmascararCorreo(inv.email), motivo: motivo.trim() });
    return this.serializar(inv);
  }

  async revocar(callerId: string, organizationId: string, inviteId: string, motivo: string): Promise<string> {
    this.exigirDisponible();
    this.exigirSuperadmin(callerId);
    this.motivoValido(motivo);
    const inv = this.pendiente(organizationId, inviteId);
    inv.status = "revoked";
    this.bitacora.push({ evento: "org_invite_revoked", actor: callerId, organizationId, inviteId, correo: enmascararCorreo(inv.email), motivo: motivo.trim() });
    return inv.id;
  }

  async aceptacionParaSistema(tokenHash: string): Promise<EquipoFuente<AceptacionSuperadmin | null>> {
    if (!this.disponible) return { ok: false, razon: "no_migrado" };
    const inv = this.invitaciones.find((i) => i.tokenHash === tokenHash && i.status === "accepted" && i.porSuperadmin);
    return { ok: true, data: inv ? { inviteId: inv.id, organizationId: inv.organizationId } : null };
  }
}
