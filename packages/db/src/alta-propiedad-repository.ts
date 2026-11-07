// Alta de sucursal / propiedad (onboarding P0) -- puerto contra las funciones de packages/db/migrations/0071_alta_sucursal_propiedad.sql.
//
// SESIONES: ambos metodos son caller-bound (`withAppSession({ userId: callerId })`); la autorizacion real (dueño/admin de toda la
// organizacion, o superadmin con auth.uid() = p_caller_id) vive en la base. Esta clase recibe la sesion ya abierta.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: sin la 0071 (42883/42P01/42703) lanza AltaPropiedadNoDisponibleError (la ruta responde 503
// honesto). Lanza HACIA AFUERA del callback de `withAppSession`: el motor revierte la transaccion y nada mas corre en ella.
// Los rechazos de negocio (42501/22023/P0002/23505/54000/55000) se traducen a AltaPropiedadError con un codigo estable.
//
// La sucursal/propiedad NACE INACTIVA (status 'inactive'): no recibe pedidos ni aparece al cliente hasta que el dueño la active con
// `activarComoDueno` (core.activar_propiedad_organizacion), que la base rechaza (55000) mientras falten pasos obligatorios de
// configuracion; los pasos pendientes llegan en `faltantes`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";

/** Tope de sucursales/propiedades por organizacion. TOPE TEMPORAL HASTA LIGARLO AL PLAN. Espejo exacto de
 *  core.propiedad_tope_por_organizacion (0071), que es lo que hace cumplir la base; si cambia uno, cambia el otro. */
export const TOPE_PROPIEDADES_POR_ORGANIZACION = { licitaciones: 1, porOmision: 50 } as const;

export function topePropiedadesPorOrganizacion(vertical: string): number {
  return vertical === "licitaciones" ? TOPE_PROPIEDADES_POR_ORGANIZACION.licitaciones : TOPE_PROPIEDADES_POR_ORGANIZACION.porOmision;
}

/** Slug base de una sucursal de restaurantes, igual que 0071: minusculas sin acentos, todo lo que no sea [a-z0-9] a '-', corte a 60 y
 *  sin '-' al inicio ni al final (el recorte va DESPUES del corte, que puede caer justo en un guion). Vacio = "sucursal". */
export function slugSucursal(nombre: string): string {
  const guionado = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-");
  const base = recortarGuiones(recortarGuiones(guionado).slice(0, 60));
  return base || "sucursal";
}

/** Quita los '-' del inicio y del final en tiempo lineal y sin regex: `/^-+|-+$/` es polinomial (ReDoS, CodeQL
 *  js/polynomial-redos) con muchos '-' seguidos de otro caracter, y el nombre llega del usuario. */
export function recortarGuiones(texto: string): string {
  let inicio = 0;
  let fin = texto.length;
  while (inicio < fin && texto.charCodeAt(inicio) === 45) inicio++;
  while (fin > inicio && texto.charCodeAt(fin - 1) === 45) fin--;
  return texto.slice(inicio, fin);
}

export type AltaPropiedadCodigo = "forbidden" | "validation" | "not_found" | "conflict" | "tope" | "incompleta";

export class AltaPropiedadError extends Error {
  constructor(
    readonly codigo: AltaPropiedadCodigo,
    message: string,
    /** Solo `incompleta`: ids de los pasos obligatorios pendientes (ej. ["menu", "horario"]). */
    readonly faltantes: readonly string[] = [],
  ) {
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
  /** Siempre nace inactiva: se activa con `activarComoDueno` cuando su configuracion obligatoria este completa. */
  readonly status: "inactive";
}

export interface PropiedadActivada {
  readonly propertyId: string;
  readonly status: "active";
  /** true = ya estaba activa (la llamada es idempotente y no escribe bitacora). */
  readonly yaEstabaActiva: boolean;
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
  /** Dueño o administrador de toda la organizacion activa una sucursal/propiedad dada de alta por este camino. Pasos pendientes:
   *  AltaPropiedadError("incompleta") con `faltantes`. */
  activarComoDueno(callerId: string, input: { readonly orgSlug: string; readonly vertical: string; readonly propertyId: string }): Promise<PropiedadActivada>;
}

/** DETAIL de 55000: ids de paso separados por coma. */
function pgDetalleFaltantes(err: unknown): string[] {
  const d = err && typeof err === "object" && typeof (err as { detail?: unknown }).detail === "string" ? (err as { detail: string }).detail : "";
  return d
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[a-z_]{1,40}$/.test(x));
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
    case "55000":
      throw new AltaPropiedadError("incompleta", mensajeSql(err), pgDetalleFaltantes(err));
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
      return { propertyId: r.out_property_id, slug: r.out_slug, status: "inactive" };
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
      return { propertyId: r.out_property_id, slug: r.out_slug, status: "inactive" };
    } catch (err) {
      return traducirErrorAltaPropiedad(err);
    }
  }

  async activarComoDueno(_callerId: string, input: { readonly orgSlug: string; readonly vertical: string; readonly propertyId: string }): Promise<PropiedadActivada> {
    try {
      const { rows } = await this.db.query<{ out_property_id: string; out_ya_estaba_activa: boolean }>(
        `select out_property_id, out_ya_estaba_activa from core.activar_propiedad_organizacion($1, $2, $3::uuid);`,
        [input.orgSlug, input.vertical, input.propertyId],
      );
      const r = rows[0];
      if (!r) throw new Error("activar_propiedad_organizacion no devolvio la propiedad");
      return { propertyId: r.out_property_id, status: "active", yaEstabaActiva: r.out_ya_estaba_activa === true };
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
  readonly propiedades: Array<{ id: string; nombre: string; status: "active" | "inactive"; delAlta: boolean }>;
}

export class InMemoryAltaPropiedadRepository implements AltaPropiedadRepository {
  private readonly orgs = new Map<string, OrgMem>();
  private readonly gestores = new Set<string>(); // `${orgId}:${userId}` owner/admin con alcance de toda la organizacion
  private readonly superadmins = new Set<string>();
  private disponible = true;
  private seq = 0;
  /** Bitacora equivalente a core.propiedad_alta_log. */
  readonly bitacora: Array<{ organizationId: string; propertyId: string; origen: "dueno" | "superadmin"; accion: "alta" | "activacion"; actor: string; motivo: string | null }> = [];
  /** Pasos obligatorios pendientes por propiedad (equivalente a core.propiedad_pasos_activacion). */
  private readonly pasosPendientes = new Map<string, readonly string[]>();

  seedOrganizacion(org: { id: string; slug: string; vertical: string; status?: string; propiedades?: string[] }): void {
    this.orgs.set(org.id, {
      id: org.id,
      slug: org.slug,
      vertical: org.vertical,
      status: org.status ?? "active",
      // Sembradas = de plataforma (no vinieron del alta): el dueño no las activa por aqui.
      propiedades: (org.propiedades ?? []).map((n) => ({ id: `00000000-0000-4000-9000-${String(++this.seq).padStart(12, "0")}`, nombre: n, status: "inactive" as const, delAlta: false })),
    });
  }
  seedPasosPendientes(propertyId: string, pasos: readonly string[]): void {
    this.pasosPendientes.set(propertyId, pasos);
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
  propiedadesDe(organizationId: string): readonly { id: string; nombre: string; status: "active" | "inactive" }[] {
    return (this.orgs.get(organizationId)?.propiedades ?? []).map(({ id, nombre, status }) => ({ id, nombre, status }));
  }

  private crear(org: OrgMem, input: AltaPropiedadInput, actor: string, origen: "dueno" | "superadmin", motivo: string | null): PropiedadCreada {
    if (org.status === "suspended") throw new AltaPropiedadError("forbidden", "la organizacion esta suspendida");
    if (org.vertical === "despachos" || org.vertical === "rentas") throw new AltaPropiedadError("validation", `${org.vertical} tiene su propio alta`);
    const nombre = input.nombre.trim();
    if (nombre.length < 2 || nombre.length > 120) throw new AltaPropiedadError("validation", "el nombre debe tener entre 2 y 120 caracteres");
    if (input.zonaHoraria !== null && !Intl.supportedValuesOf("timeZone").includes(input.zonaHoraria)) throw new AltaPropiedadError("validation", "zona horaria IANA invalida");
    const tope = topePropiedadesPorOrganizacion(org.vertical);
    if (org.propiedades.length >= tope) throw new AltaPropiedadError("tope", `la organizacion ya tiene el maximo de ${tope} sucursales/propiedades`);
    if (org.propiedades.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) throw new AltaPropiedadError("conflict", "ya existe una sucursal/propiedad con ese nombre");
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    org.propiedades.push({ id, nombre, status: "inactive", delAlta: true });
    this.bitacora.push({ organizationId: org.id, propertyId: id, origen, accion: "alta", actor, motivo });
    const slug = org.vertical === "restaurantes" ? slugSucursal(nombre) : null;
    return { propertyId: id, slug, status: "inactive" };
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

  async activarComoDueno(callerId: string, input: { readonly orgSlug: string; readonly vertical: string; readonly propertyId: string }): Promise<PropiedadActivada> {
    if (!this.disponible) throw new AltaPropiedadNoDisponibleError();
    const org = [...this.orgs.values()].find((o) => o.slug === input.orgSlug && o.vertical === input.vertical);
    if (!org) throw new AltaPropiedadError("not_found", "organizacion no encontrada");
    if (!this.gestores.has(`${org.id}:${callerId}`)) throw new AltaPropiedadError("forbidden", "solo el dueño o un administrador de toda la organizacion");
    if (org.status === "suspended") throw new AltaPropiedadError("forbidden", "la organizacion esta suspendida");
    const prop = org.propiedades.find((p) => p.id === input.propertyId);
    if (!prop) throw new AltaPropiedadError("not_found", "sucursal/propiedad no encontrada");
    if (!prop.delAlta) throw new AltaPropiedadError("forbidden", "esta sucursal/propiedad no se dio de alta desde el producto; su activacion la hace la plataforma");
    if (prop.status === "active") return { propertyId: prop.id, status: "active", yaEstabaActiva: true };
    const faltan = this.pasosPendientes.get(prop.id) ?? [];
    if (faltan.length > 0) throw new AltaPropiedadError("incompleta", `faltan pasos obligatorios antes de activar: ${faltan.join("; ")}`, faltan);
    prop.status = "active";
    this.bitacora.push({ organizationId: org.id, propertyId: prop.id, origen: "dueno", accion: "activacion", actor: callerId, motivo: null });
    return { propertyId: prop.id, status: "active", yaEstabaActiva: false };
  }
}
