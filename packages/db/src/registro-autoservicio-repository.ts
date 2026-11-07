// Alta autoservicio de restaurantes -- puerto contra las funciones de packages/db/migrations/0077_registro_autoservicio_restaurantes.sql.
//
// SESIONES: ambos metodos son SOLO-SISTEMA (`withAppSession({ userId: null })`); la base lo exige (auth.uid() is null, si no 42501).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: sin la 0077 (42883/42P01/42703) lanza RegistroAutoservicioNoDisponibleError (la ruta responde
// 503 honesto «no disponible aún»). Lanza HACIA AFUERA del callback de `withAppSession`: el motor revierte y nada mas corre en ella.
// Los rechazos de negocio se traducen a RegistroAutoservicioError con un codigo estable:
//   54000 -> tope (demasiados registros), 22023 -> validation, P0002 -> enlace_invalido, 23505 -> cuenta_existente, 42501 -> forbidden.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { slugSucursal } from "./alta-propiedad-repository.ts";

/** Rutas publicas fijas de /restaurantes/* en la SPA (espejo de 0077): un slug asi quedaria tapado por la ruta. */
export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set(["login", "registro", "auth", "acceso-repartidor", "restablecer-contrasena", "verificar-correo", "demo"]);

export type RegistroAutoservicioCodigo = "tope" | "validation" | "enlace_invalido" | "cuenta_existente" | "forbidden";

export class RegistroAutoservicioError extends Error {
  constructor(
    readonly codigo: RegistroAutoservicioCodigo,
    message: string,
  ) {
    super(message);
    this.name = "RegistroAutoservicioError";
  }
}

export class RegistroAutoservicioNoDisponibleError extends Error {
  constructor() {
    super("El registro autoservicio todavia no esta disponible en este despliegue: falta aplicar la migracion 0077_registro_autoservicio_restaurantes.");
    this.name = "RegistroAutoservicioNoDisponibleError";
  }
}

export type MetodoRegistro = "correo" | "google";

export interface SolicitudRegistroInput {
  readonly vertical: "restaurantes";
  readonly metodo: MetodoRegistro;
  /** Obligatorio con metodo 'correo'; con 'google' se ignora (lo fija Google al volver). */
  readonly correo: string | null;
  readonly nombreNegocio: string;
  readonly nombreSucursal: string;
  readonly nombreCompleto: string;
  /** IANA; null = la de la vertical por omision. */
  readonly zonaHoraria: string | null;
  /** sha256 del token de un solo uso (el token plano nunca llega a la base). */
  readonly tokenHash: string;
  /** HMAC de la IP de origen (la IP cruda nunca se guarda). */
  readonly origenHash: string;
  readonly ttlMinutos: number;
}

export interface RegistroCompletado {
  readonly organizationId: string;
  readonly orgSlug: string;
  readonly staffId: string;
  readonly propertyId: string;
  readonly branchSlug: string | null;
  readonly trialEndsAt: string;
}

export interface RegistroAutoservicioRepository {
  solicitar(input: SolicitudRegistroInput): Promise<{ readonly solicitudId: string }>;
  /** Consume la solicitud del token y crea organizacion (prueba 14 dias) + cuenta verificada + membresia owner + primera sucursal
   *  inactiva. `correoVerificado`: el que Google devolvio con email_verified (metodo 'google'); null en el metodo 'correo'. */
  completar(input: { readonly tokenHash: string; readonly correoVerificado: string | null }): Promise<RegistroCompletado>;
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

export function traducirErrorRegistroAutoservicio(err: unknown): never {
  if (isMigrationPendingError(err)) throw new RegistroAutoservicioNoDisponibleError();
  switch (pgCode(err)) {
    case "54000":
      throw new RegistroAutoservicioError("tope", "Demasiados registros. Intenta de nuevo más tarde.");
    case "22023":
      throw new RegistroAutoservicioError("validation", "Revisa los datos del registro.");
    case "P0002":
      throw new RegistroAutoservicioError("enlace_invalido", "El enlace no es válido o ya venció.");
    case "23505":
      throw new RegistroAutoservicioError("cuenta_existente", "Ya existe una cuenta con ese correo.");
    case "42501":
      throw new RegistroAutoservicioError("forbidden", "Operación no permitida.");
    default:
      throw err;
  }
}

export class PostgresRegistroAutoservicioRepository implements RegistroAutoservicioRepository {
  constructor(private readonly db: TenantDbSession) {}

  async solicitar(input: SolicitudRegistroInput): Promise<{ readonly solicitudId: string }> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `select core.registro_autoservicio_solicitar($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id;`,
        [
          input.vertical,
          input.metodo,
          input.correo,
          input.nombreNegocio,
          input.nombreSucursal,
          input.nombreCompleto,
          input.zonaHoraria,
          input.tokenHash,
          input.origenHash,
          input.ttlMinutos,
        ],
      );
      const r = rows[0];
      if (!r) throw new Error("registro_autoservicio_solicitar no devolvio la solicitud");
      return { solicitudId: r.id };
    } catch (err) {
      return traducirErrorRegistroAutoservicio(err);
    }
  }

  async completar(input: { readonly tokenHash: string; readonly correoVerificado: string | null }): Promise<RegistroCompletado> {
    try {
      const { rows } = await this.db.query<{
        out_organization_id: string;
        out_org_slug: string;
        out_staff_id: string;
        out_property_id: string;
        out_branch_slug: string | null;
        out_trial_ends_at: string | Date;
      }>(
        `select out_organization_id, out_org_slug, out_staff_id, out_property_id, out_branch_slug, out_trial_ends_at
           from core.registro_autoservicio_completar($1, $2);`,
        [input.tokenHash, input.correoVerificado],
      );
      const r = rows[0];
      if (!r) throw new Error("registro_autoservicio_completar no devolvio la organizacion");
      return {
        organizationId: r.out_organization_id,
        orgSlug: r.out_org_slug,
        staffId: r.out_staff_id,
        propertyId: r.out_property_id,
        branchSlug: r.out_branch_slug,
        trialEndsAt: r.out_trial_ends_at instanceof Date ? r.out_trial_ends_at.toISOString() : String(r.out_trial_ends_at),
      };
    } catch (err) {
      return traducirErrorRegistroAutoservicio(err);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// En memoria (tests de las rutas): replica las reglas de la 0077 (lo que valida la base real esta en scripts/verify-registro-autoservicio/).
// ---------------------------------------------------------------------------------------------------------------------------------
interface SolicitudMem {
  readonly id: string;
  readonly input: SolicitudRegistroInput;
  readonly createdAt: number;
  readonly expiresAt: number;
  consumedAt: number | null;
  organizationId: string | null;
}

export interface OrganizacionRegistradaMem {
  readonly id: string;
  readonly slug: string;
  readonly nombre: string;
  readonly status: "trial";
  readonly trialEndsAt: string;
  readonly ownerStaffId: string;
  readonly ownerCorreo: string;
  readonly ownerCreatedVia: "registro_autoservicio" | "google";
  readonly sucursal: { readonly id: string; readonly nombre: string; readonly slug: string; readonly status: "inactive" };
}

export class InMemoryRegistroAutoservicioRepository implements RegistroAutoservicioRepository {
  readonly solicitudes: SolicitudMem[] = [];
  readonly organizaciones: OrganizacionRegistradaMem[] = [];
  private readonly correosExistentes = new Set<string>();
  private disponible = true;
  private seq = 0;
  /** Reloj inyectable para probar vencimientos. */
  ahora: () => number = () => Date.now();

  seedNoMigrado(): void {
    this.disponible = false;
  }

  seedCuentaExistente(correo: string): void {
    this.correosExistentes.add(correo.toLowerCase());
  }

  private id(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${this.seq.toString().padStart(12, "0")}`;
  }

  private noMigrado(): never {
    throw new RegistroAutoservicioNoDisponibleError();
  }

  async solicitar(input: SolicitudRegistroInput): Promise<{ readonly solicitudId: string }> {
    if (!this.disponible) this.noMigrado();
    const ahora = this.ahora();
    const correo = input.metodo === "correo" ? (input.correo ?? "").trim().toLowerCase() : null;
    if (input.metodo === "correo" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo ?? "")) throw new RegistroAutoservicioError("validation", "Revisa los datos del registro.");
    for (const n of [input.nombreNegocio, input.nombreSucursal, input.nombreCompleto]) {
      const t = n.trim().length;
      if (t < 2 || t > 120) throw new RegistroAutoservicioError("validation", "Revisa los datos del registro.");
    }
    const dia = 24 * 60 * 60_000;
    const delOrigen = this.solicitudes.filter((s) => s.input.origenHash === input.origenHash && s.createdAt > ahora - dia);
    if (this.solicitudes.filter((s) => s.createdAt > ahora - 60 * 60_000).length >= 300) throw new RegistroAutoservicioError("tope", "Demasiados registros. Intenta de nuevo más tarde.");
    if (delOrigen.length >= 10 || delOrigen.filter((s) => s.organizationId !== null).length >= 3) throw new RegistroAutoservicioError("tope", "Demasiados registros. Intenta de nuevo más tarde.");
    if (correo && this.solicitudes.filter((s) => s.input.correo === correo && s.consumedAt === null && s.expiresAt > ahora).length >= 3) {
      throw new RegistroAutoservicioError("tope", "Demasiados registros. Intenta de nuevo más tarde.");
    }
    const sol: SolicitudMem = { id: this.id(), input: { ...input, correo }, createdAt: ahora, expiresAt: ahora + input.ttlMinutos * 60_000, consumedAt: null, organizationId: null };
    this.solicitudes.push(sol);
    return { solicitudId: sol.id };
  }

  async completar(input: { readonly tokenHash: string; readonly correoVerificado: string | null }): Promise<RegistroCompletado> {
    if (!this.disponible) this.noMigrado();
    const ahora = this.ahora();
    const sol = this.solicitudes.find((s) => s.input.tokenHash === input.tokenHash);
    if (!sol || sol.consumedAt !== null || sol.expiresAt <= ahora) throw new RegistroAutoservicioError("enlace_invalido", "El enlace no es válido o ya venció.");
    const verificado = input.correoVerificado?.trim().toLowerCase() || null;
    let correo: string;
    if (sol.input.metodo === "google") {
      if (!verificado) throw new RegistroAutoservicioError("validation", "Revisa los datos del registro.");
      correo = verificado;
    } else {
      if (verificado && verificado !== sol.input.correo) throw new RegistroAutoservicioError("validation", "Revisa los datos del registro.");
      correo = sol.input.correo ?? "";
    }
    if (this.correosExistentes.has(correo)) throw new RegistroAutoservicioError("cuenta_existente", "Ya existe una cuenta con ese correo.");
    const derivado = slugSucursal(sol.input.nombreNegocio).replace(/^sucursal$/, "restaurante");
    const base = SLUGS_RESERVADOS.has(derivado) ? `${derivado}-restaurante` : derivado;
    let slug = base;
    for (let n = 2; this.organizaciones.some((o) => o.slug === slug); n++) slug = `${base}-${n}`;
    const trialEndsAt = new Date(ahora + 14 * 24 * 60 * 60_000).toISOString();
    const org: OrganizacionRegistradaMem = {
      id: this.id(),
      slug,
      nombre: sol.input.nombreNegocio.trim(),
      status: "trial",
      trialEndsAt,
      ownerStaffId: this.id(),
      ownerCorreo: correo,
      ownerCreatedVia: sol.input.metodo === "google" ? "google" : "registro_autoservicio",
      sucursal: { id: this.id(), nombre: sol.input.nombreSucursal.trim(), slug: slugSucursal(sol.input.nombreSucursal), status: "inactive" },
    };
    this.organizaciones.push(org);
    this.correosExistentes.add(correo);
    sol.consumedAt = ahora;
    sol.organizationId = org.id;
    return { organizationId: org.id, orgSlug: org.slug, staffId: org.ownerStaffId, propertyId: org.sucursal.id, branchSlug: org.sucursal.slug, trialEndsAt };
  }
}
