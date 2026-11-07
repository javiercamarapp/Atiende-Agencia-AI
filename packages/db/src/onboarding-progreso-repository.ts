// ds3 «Guía»: progreso del recorrido guiado por persona (migracion 0075, core.onboarding_progreso).
// Solo lo NO derivable de los datos (paso, modo, visto/omitido/descartado, activo, terminado). La lectura va por RLS (la propia fila) y
// la escritura por el UNICO camino `core.guardar_onboarding_progreso`, que toma al dueño de auth.uid(), nunca de un parametro.
// Contra la base sin migrar (42P01/42883/42703) responde `disponible: false` y la guia sigue con el progreso del navegador.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { isMigrationPendingError } from "./sql-errors.ts";

export type ModoRecorrido = "corto" | "completo";

export interface ProgresoGuia {
  readonly modo: ModoRecorrido | null;
  readonly paso: string | null;
  readonly visto: boolean;
  readonly omitido: boolean;
  readonly descartado: boolean;
  readonly activo: boolean;
  /** Hito: la persona termino el recorrido alguna vez (no se borra al repetirlo). */
  readonly terminado: boolean;
  /** ISO 8601 de la ultima escritura (para reconciliar con lo guardado en el navegador). */
  readonly actualizado: string;
}

export interface GuardarProgresoGuia {
  readonly modo: ModoRecorrido | null;
  readonly paso: string | null;
  readonly visto: boolean;
  readonly omitido: boolean;
  readonly descartado: boolean;
  readonly activo: boolean;
  readonly terminado: boolean;
}

/** `orgSlug` null = consola de plataforma (pista «superadmin»). */
export interface OnboardingProgresoRepository {
  leer(userId: string, orgSlug: string | null, pista: string): Promise<{ readonly disponible: boolean; readonly progreso: ProgresoGuia | null }>;
  guardar(userId: string, orgSlug: string | null, pista: string, datos: GuardarProgresoGuia): Promise<{ readonly disponible: boolean; readonly actualizado: string | null }>;
}

/** La persona no es miembro de la organizacion (o no es superadmin para la pista de plataforma): 42501 de la funcion. */
export class OnboardingProgresoProhibidoError extends Error {
  constructor() {
    super("No puedes guardar el progreso de la guía en esta organización.");
    this.name = "OnboardingProgresoProhibidoError";
  }
}
/** Formato fuera de la lista cerrada (22023 de la funcion). */
export class OnboardingProgresoInvalidoError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "OnboardingProgresoInvalidoError";
  }
}

const PISTA_RE = /^[a-z]{3,20}(\.[a-z_]{2,20})?$/;
const PASO_RE = /^[a-z0-9._:-]{1,80}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Mismas reglas que la funcion SQL, para responder 400 sin ir a la base. Devuelve el motivo o null. */
export function validarProgresoGuia(orgSlug: string | null, pista: string, datos?: GuardarProgresoGuia): string | null {
  if (!PISTA_RE.test(pista)) return "pista inválida";
  if (orgSlug === null && pista !== "superadmin") return "sin organización solo existe la pista superadmin";
  if (orgSlug !== null && !SLUG_RE.test(orgSlug)) return "organización inválida";
  if (orgSlug !== null && pista === "superadmin") return "la pista superadmin no lleva organización";
  if (!datos) return null;
  if (datos.modo !== null && datos.modo !== "corto" && datos.modo !== "completo") return "modo inválido";
  if (datos.paso !== null && !PASO_RE.test(datos.paso)) return "paso inválido";
  return null;
}

interface FilaProgreso {
  modo: string | null;
  paso: string | null;
  visto: boolean;
  omitido: boolean;
  descartado: boolean;
  activo: boolean;
  terminado: boolean;
  actualizado: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function deFila(f: FilaProgreso): ProgresoGuia {
  return {
    modo: f.modo === "corto" || f.modo === "completo" ? f.modo : null,
    paso: f.paso,
    visto: f.visto === true,
    omitido: f.omitido === true,
    descartado: f.descartado === true,
    activo: f.activo === true,
    terminado: f.terminado === true,
    actualizado: iso(f.actualizado),
  };
}

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined;
}

export class PostgresOnboardingProgresoRepository implements OnboardingProgresoRepository {
  constructor(private readonly db: TenantDbSession) {}

  async leer(userId: string, orgSlug: string | null, pista: string) {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        // RLS ya limita a la propia fila; el filtro por user_id es defensa en profundidad.
        const { rows } = await this.db.query<FilaProgreso>(
          `select p.modo, p.paso, p.visto, p.omitido, p.descartado, p.activo, (p.terminado_en is not null) as terminado, p.updated_at as actualizado
             from core.onboarding_progreso p
             left join core.organization o on o.id = p.organization_id
            where p.user_id = $1 and p.pista = $3
              and (($2::text is null and p.organization_id is null) or o.slug = $2::text)
            limit 1`,
          [userId, orgSlug, pista],
        );
        return { disponible: true, progreso: rows[0] ? deFila(rows[0]) : null };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => ({ disponible: false, progreso: null }),
    });
  }

  async guardar(_userId: string, orgSlug: string | null, pista: string, d: GuardarProgresoGuia) {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ actualizado: string | Date }>(
          `select core.guardar_onboarding_progreso($1, $2, $3, $4, $5, $6, $7, $8, $9) as actualizado`,
          [orgSlug, pista, d.modo, d.paso, d.visto, d.omitido, d.descartado, d.activo, d.terminado],
        );
        const v = rows[0]?.actualizado;
        return { disponible: true, actualizado: v ? iso(v) : null };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "core.guardar_onboarding_progreso") || codigo(err) === "42501" || codigo(err) === "22023",
      fallback: async (err) => {
        if (codigo(err) === "42501") throw new OnboardingProgresoProhibidoError();
        if (codigo(err) === "22023") throw new OnboardingProgresoInvalidoError(err instanceof Error ? err.message : "progreso inválido");
        return { disponible: false, actualizado: null };
      },
    });
  }
}

/** Doble en memoria con las MISMAS reglas que la funcion SQL (membresia por slug, superadmin, hito «terminado»). Solo pruebas. */
export class InMemoryOnboardingProgresoRepository implements OnboardingProgresoRepository {
  private readonly filas = new Map<string, ProgresoGuia>();
  private readonly miembros = new Map<string, Set<string>>();
  private readonly verticales = new Map<string, string>();
  private readonly superadmins = new Set<string>();
  private reloj = Date.parse("2026-11-01T00:00:00.000Z");
  /** `false` simula la base sin la migracion 0075. */
  disponible = true;

  seedOrganizacion(slug: string, vertical: string, miembros: readonly string[]): void {
    this.verticales.set(slug, vertical);
    this.miembros.set(slug, new Set(miembros));
  }
  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }

  async leer(userId: string, orgSlug: string | null, pista: string) {
    if (!this.disponible) return { disponible: false, progreso: null };
    return { disponible: true, progreso: this.filas.get(`${userId}|${orgSlug ?? ""}|${pista}`) ?? null };
  }

  async guardar(userId: string, orgSlug: string | null, pista: string, d: GuardarProgresoGuia) {
    if (!this.disponible) return { disponible: false, actualizado: null };
    const motivo = validarProgresoGuia(orgSlug, pista, d);
    if (motivo) throw new OnboardingProgresoInvalidoError(motivo);
    if (orgSlug === null) {
      if (!this.superadmins.has(userId)) throw new OnboardingProgresoProhibidoError();
    } else {
      if (!this.miembros.get(orgSlug)?.has(userId)) throw new OnboardingProgresoProhibidoError();
      if (pista.split(".")[0] !== this.verticales.get(orgSlug)) throw new OnboardingProgresoInvalidoError("la pista no corresponde a la vertical");
    }
    const clave = `${userId}|${orgSlug ?? ""}|${pista}`;
    this.reloj += 1000;
    const actualizado = new Date(this.reloj).toISOString();
    const previo = this.filas.get(clave);
    this.filas.set(clave, { ...d, terminado: Boolean(previo?.terminado) || d.terminado, actualizado });
    return { disponible: true, actualizado };
  }
}
