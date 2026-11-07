// Alta de sucursal / propiedad (onboarding P0) -- puerto contra las funciones de packages/db/migrations/0071_alta_sucursal_propiedad.sql.
//
// SESIONES: ambos metodos son caller-bound (`withAppSession({ userId: callerId })`); la autorizacion real (dueño/admin de toda la
// organizacion, o superadmin con auth.uid() = p_caller_id) vive en la base. Esta clase recibe la sesion ya abierta.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: sin la 0071 (42883/42P01/42703) lanza AltaPropiedadNoDisponibleError (la ruta responde 503
// honesto). Lanza HACIA AFUERA del callback de `withAppSession`: el motor revierte la transaccion y nada mas corre en ella.
// Los rechazos de negocio (42501/22023/P0002/23505/54000) se traducen a AltaPropiedadError con un codigo estable.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";

export type AltaPropiedadCodigo = "forbidden" | "validation" | "not_found" | "conflict" | "tope";

export class AltaPropiedadError extends Error {
  constructor(readonly codigo: AltaPropiedadCodigo, message: string) {
    super(message);
    this.name = "AltaPropiedadError";
  }
}

export class AltaPropiedadNoDisponibleError extends Error {
  constructor() {
    super("El alta de sucursales todavia no esta disponible en este despliegue: falta aplicar la migracion 0071_alta_sucursal_propiedad.");
    this.name = "AltaPropiedadNoDisponibleError";
  }
}

export interface PropiedadCreada {
  readonly propertyId: string;
  /** Slug de la sucursal (solo restaurantes); null en las demas verticales. */
  readonly slug: string | null;
}

export interface AltaPropiedadInput {
  readonly nombre: string;
  /** IANA; null = la de la vertical por omision. */
  readonly zonaHoraria: string | null;
}

export interface AltaPropiedadRepository {
  /** Dueño o administrador de toda la organizacion (resuelta por slug y vertical). `callerId` solo lo usa el doble en memoria: la base
   *  toma siempre auth.uid() de la sesion. */
  crearComoDueno(callerId: string, input: AltaPropiedadInput & { readonly orgSlug: string; readonly vertical: string }): Promise<PropiedadCreada>;
  /** Superadmin (alta asistida); motivo >= 20 caracteres. */
  crearComoSuperadmin(callerId: string, input: AltaPropiedadInput & { readonly organizationId: string; readonly motivo: string }): Promise<PropiedadCreada>;
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

/** Quita el prefijo `nombre_funcion: ` del mensaje SQL (estatico, sin datos personales). */
function mensajeSql(err: unknown): string {
  const raw = err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
  const i = raw.indexOf(": ");
  return i > 0 && i < 60 ? raw.slice(i + 2) : raw;
}

export function traducirErrorAltaPropiedad(err: unknown): never {
  if (isMigrationPendingError(err)) throw new AltaPropiedadNoDisponibleError();
  switch (pgCode(err)) {
    case "42501":
      throw new AltaPropiedadError("forbidden", mensajeSql(err) || "Sin permiso para dar de alta sucursales en esta organización.");
    case "22023":
      throw new AltaPropiedadError("validation", mensajeSql(err));
    case "P0002":
      throw new AltaPropiedadError("not_found", mensajeSql(err));
    case "23505":
      throw new AltaPropiedadError("conflict", mensajeSql(err));
    case "54000":
      throw new AltaPropiedadError("tope", mensajeSql(err));
    default:
      throw err;
  }
}

export class PostgresAltaPropiedadRepository implements AltaPropiedadRepository {
  constructor(private readonly db: TenantDbSession) {}

  async crearComoDueno(_callerId: string, input: AltaPropiedadInput & { readonly orgSlug: string; readonly vertical: string }): Promise<PropiedadCreada> {
    try {
      const { rows } = await this.db.query<{ out_property_id: string; out_slug: string | null }>(
        `select out_property_id, out_slug from core.crear_propiedad_organizacion($1, $2, $3, $4);`,
        [input.orgSlug, input.vertical, input.nombre, input.zonaHoraria],
      );
      const r = rows[0];
      if (!r) throw new Error("crear_propiedad_organizacion no devolvio la propiedad");
      return { propertyId: r.out_property_id, slug: r.out_slug };
    } catch (err) {
      return traducirErrorAltaPropiedad(err);
    }
  }

  async crearComoSuperadmin(callerId: string, input: AltaPropiedadInput & { readonly organizationId: string; readonly motivo: string }): Promise<PropiedadCreada> {
    try {
      const { rows } = await this.db.query<{ out_property_id: string; out_slug: string | null }>(
        `select out_property_id, out_slug from core.superadmin_crear_propiedad($1::uuid, $2::uuid, $3, $4, $5);`,
        [callerId, input.organizationId, input.nombre, input.zonaHoraria, input.motivo],
      );
      const r = rows[0];
      if (!r) throw new Error("superadmin_crear_propiedad no devolvio la propiedad");
      return { propertyId: r.out_property_id, slug: r.out_slug };
    } catch (err) {
      return traducirErrorAltaPropiedad(err);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// En memoria (tests de las rutas): replica las reglas de la 0071 (lo que valida la base real esta en scripts/verify-alta-sucursal/).
// ---------------------------------------------------------------------------------------------------------------------------------
interface OrgMem {
  readonly id: string;
  readonly slug: string;
  readonly vertical: string;
  status: string;
  readonly propiedades: Array<{ id: string; nombre: string }>;
}

export class InMemoryAltaPropiedadRepository implements AltaPropiedadRepository {
  private readonly orgs = new Map<string, OrgMem>();
  private readonly gestores = new Set<string>(); // `${orgId}:${userId}` owner/admin con alcance de toda la organizacion
  private readonly superadmins = new Set<string>();
  private disponible = true;
  private seq = 0;
  /** Bitacora equivalente a core.propiedad_alta_log. */
  readonly bitacora: Array<{ organizationId: string; propertyId: string; origen: "dueno" | "superadmin"; actor: string; motivo: string | null }> = [];

  seedOrganizacion(org: { id: string; slug: string; vertical: string; status?: string; propiedades?: string[] }): void {
    this.orgs.set(org.id, { id: org.id, slug: org.slug, vertical: org.vertical, status: org.status ?? "active", propiedades: (org.propiedades ?? []).map((n) => ({ id: `prop-${++this.seq}`, nombre: n })) });
  }
  seedGestor(organizationId: string, userId: string): void {
    this.gestores.add(`${organizationId}:${userId}`);
  }
  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedNoMigrado(): void {
    this.disponible = false;
  }
  propiedadesDe(organizationId: string): readonly { id: string; nombre: string }[] {
    return this.orgs.get(organizationId)?.propiedades ?? [];
  }

  private crear(org: OrgMem, input: AltaPropiedadInput, actor: string, origen: "dueno" | "superadmin", motivo: string | null): PropiedadCreada {
    if (org.status === "suspended") throw new AltaPropiedadError("forbidden", "la organizacion esta suspendida");
    if (org.vertical === "despachos" || org.vertical === "rentas") throw new AltaPropiedadError("validation", `${org.vertical} tiene su propio alta`);
    const nombre = input.nombre.trim();
    if (nombre.length < 2 || nombre.length > 120) throw new AltaPropiedadError("validation", "el nombre debe tener entre 2 y 120 caracteres");
    if (input.zonaHoraria !== null && !Intl.supportedValuesOf("timeZone").includes(input.zonaHoraria)) throw new AltaPropiedadError("validation", "zona horaria IANA invalida");
    const tope = org.vertical === "licitaciones" ? 1 : 50;
    if (org.propiedades.length >= tope) throw new AltaPropiedadError("tope", `la organizacion ya tiene el maximo de ${tope} sucursales/propiedades`);
    if (org.propiedades.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) throw new AltaPropiedadError("conflict", "ya existe una sucursal/propiedad con ese nombre");
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    org.propiedades.push({ id, nombre });
    this.bitacora.push({ organizationId: org.id, propertyId: id, origen, actor, motivo });
    const slug = org.vertical === "restaurantes" ? nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "sucursal" : null;
    return { propertyId: id, slug };
  }

  async crearComoDueno(callerId: string, input: AltaPropiedadInput & { readonly orgSlug: string; readonly vertical: string }): Promise<PropiedadCreada> {
    if (!this.disponible) throw new AltaPropiedadNoDisponibleError();
    const org = [...this.orgs.values()].find((o) => o.slug === input.orgSlug && o.vertical === input.vertical);
    if (!org) throw new AltaPropiedadError("not_found", "organizacion no encontrada");
    if (!this.gestores.has(`${org.id}:${callerId}`)) throw new AltaPropiedadError("forbidden", "solo el dueño o un administrador de toda la organizacion");
    return this.crear(org, input, callerId, "dueno", null);
  }

  async crearComoSuperadmin(callerId: string, input: AltaPropiedadInput & { readonly organizationId: string; readonly motivo: string }): Promise<PropiedadCreada> {
    if (!this.disponible) throw new AltaPropiedadNoDisponibleError();
    if (!this.superadmins.has(callerId)) throw new AltaPropiedadError("forbidden", "solo un superadmin de plataforma");
    const motivo = input.motivo.trim();
    if (motivo.length < 20 || motivo.length > 500) throw new AltaPropiedadError("validation", "motivo obligatorio (20 a 500 caracteres)");
    const org = this.orgs.get(input.organizationId);
    if (!org) throw new AltaPropiedadError("not_found", "organizacion no encontrada");
    return this.crear(org, input, callerId, "superadmin", motivo);
  }
}
