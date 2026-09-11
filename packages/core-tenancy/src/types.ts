// Modelo de tenancy de dos niveles (organización → property), generalizado del par
// `hotel_staff`/`location`/`org_id` que ya existe y opera en producción en
// `hoteles/packages/db/migrations/0001_extensions_and_auth.sql` y
// `hoteles/apps/api/src/middleware.ts` (`requireHotelMembership`). No es un modelo
// nuevo inventado desde cero: hoteles ya tenía exactamente esta jerarquía de dos
// niveles, solo que con nombres propios de la vertical hotelera.

/** Vertical soportada en ESTA fase. "despachos" queda excluida a propósito —
 * reescritura futura al mismo stack, fuera de alcance de este monorepo por ahora. */
export type Vertical = "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "citas";

export const VERTICALS: readonly Vertical[] = [
  "hoteles",
  "restaurantes",
  "rentas",
  "licitaciones",
  "citas",
] as const;

export function isVertical(value: string): value is Vertical {
  return (VERTICALS as readonly string[]).includes(value);
}

export interface Organization {
  readonly id: string; // uuid
  readonly vertical: Vertical; // fija de por vida — una org no cambia de vertical
  readonly name: string;
  readonly status: "trial" | "active" | "suspended";
  readonly createdAt: string;
  // Campos de plan/facturación deliberadamente AUSENTES — ver packages/billing.
}

/**
 * Unidad operativa dentro de una organización. Cada vertical le da su propio
 * significado de negocio a esta misma fila genérica:
 *   hoteles       -> propiedad/hotel      (hoy: tabla `location` en hoteles)
 *   restaurantes  -> restaurante/sucursal
 *   citas         -> negocio/sucursal de citas
 *   rentas        -> unidad rentable (listing)
 *   licitaciones  -> CASO ESPECIAL: una org de licitaciones normalmente opera como una
 *                    sola Property implícita (la empresa participante) — las tablas de
 *                    licitación/expediente cuelgan de organizationId directo. Property
 *                    sigue existiendo por consistencia de modelo, pero
 *                    domain-licitaciones puede tratarla como singleton por org.
 */
export interface Property {
  readonly id: string;
  readonly organizationId: string;
  readonly vertical: Vertical; // desnormalizado desde Organization, evita join en cada RLS check
  readonly name: string;
  readonly status: "active" | "inactive";
}

/** Techo común de rol que core-auth/middleware necesitan para autorizar SIN conocer el
 * detalle de cada vertical. El rol fino y con significado de negocio (los 8 roles de
 * HOTEL_ROLES hoy en hoteles/apps/api/src/domain/roles.ts, o su equivalente en cada
 * domain-<vertical>) sigue viviendo en el paquete de dominio correspondiente —
 * core-tenancy nunca conoce "frontdesk" ni "housekeeping". */
export type PlatformRole = "owner" | "admin" | "member" | "viewer";

export const PLATFORM_ROLES: readonly PlatformRole[] = ["owner", "admin", "member", "viewer"] as const;

export interface Membership {
  readonly userId: string;
  readonly organizationId: string;
  /** null = acceso a TODAS las properties de la org (equivalente a owner/admin de
   * plataforma); un array de propertyIds acota el alcance, igual que hotel_ids hoy. */
  readonly propertyIds: readonly string[] | null;
  readonly platformRole: PlatformRole;
  /** Rol específico de vertical — opaco para core-tenancy, se valida contra el enum de
   * packages/domain-<vertical> (nunca aquí). Ej.: "gm"|"frontdesk"|... para hoteles. */
  readonly verticalRole: string;
}

/** Claims mínimos que el resto del sistema necesita para escopar cualquier query.
 * core-auth produce esto a partir del JWT; core-tenancy lo consume para abrir la
 * sesión de base de datos. */
export interface TenantSessionClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly vertical: Vertical;
  readonly propertyIds: readonly string[] | null; // null = todas las properties de la org
}

export interface TenantDbSession {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

/**
 * Igual contrato que `PgliteEngine`/`EmbeddedPostgresEngine` de
 * hoteles/packages/db/src/engines.ts (withSession → `set local role authenticated` +
 * `set_config('request.jwt.claim.sub', ...)`), generalizado como interfaz de
 * core-tenancy en vez de vivir solo en packages/db.
 *
 * NOTA DE COMPATIBILIDAD (hecho estructural verificado, no una decisión de esta fase):
 * `auth.uid()` — nativo en el proyecto Supabase consolidado — lee el GUC
 * `request.jwt.claim.sub`. Esto es compatible TANTO con sesiones abiertas por
 * core-auth (JWT propio) COMO, mientras no se ejecute la migración pendiente de
 * restaurantes/citas, con sesiones de Supabase Auth real (que ya puebla ese mismo GUC
 * vía PostgREST). Las políticas RLS de core-tenancy se escriben contra `auth.uid()`
 * desde el día uno sin depender de qué sistema de auth resolvió esa sesión.
 */
export interface TenancyEngine {
  withAppSession<T>(
    claims: { userId: string | null },
    fn: (session: TenantDbSession) => Promise<T>,
  ): Promise<T>;
}
