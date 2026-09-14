// Puerto de acceso a `core.staff_user`/`core.membership`/`core.organization`, para
// las rutas núcleo de login (`POST /auth/login`, `/auth/refresh`, `/auth/me`,
// `/auth/select-org` — ver diseño Fase 1 §5: "no son de domain-restaurantes, son
// núcleo compartido, igual patrón que hoteles apps/api/src/routes/auth.ts").
//
// Mismo patrón dual de adaptador que ya usa `@atiende/core-conversation`
// (`InMemoryStateStore`/`PostgresStateStore` implementando el mismo `StateStore`):
// un puerto TS explícito en vez de exponer `TenantDbSession.query(sql, params)` crudo
// en cada caller, para que la lógica de negocio (issueSession, etc.) se pruebe con un
// adaptador real en memoria sin requerir Postgres — packages/db no tiene todavía
// motor de conexión (PGlite/embedded-postgres), ver packages/db/README.md.
//
// Fase 10 restaurantes — gap real detectado durante la Fase 8 (rol "repartidor"):
// ninguna vertical tenía forma de dar de alta staff adicional desde el producto
// después del alta inicial (el ÚNICO valor de `createdVia` que de verdad se escribía
// era 'seed'/'registro_autoservicio' — 'invite' existía como valor permitido en el
// CHECK desde `migrations/0001_core_schema.sql` pero SIN ningún método de escritura
// que lo produjera; el propio comentario de esa migración lo declara fuera de
// alcance: "Escritura de gestión (crear org, invitar staff) queda para las rutas
// núcleo... fuera del alcance de esta migración"). `core.staff_invite`
// (`migrations/0002_staff_invite_schema.sql`) + los métodos de abajo cierran ese gap.
//
// Los 5 métodos nuevos se reparten en DOS interfaces con ciclo de vida de sesión
// DISTINTO, mismo criterio que ya separa `coreRepo` (objeto fijo, sesión de sistema
// `userId: null`) de `restaurantesRepo`/`rentasOwnerPortalRepo` (fábricas
// `(db) => Repo`, sesión real por-request):
//   - `findStaffInviteByTokenHash`/`acceptStaffInvite` se quedan en `CoreRepository`
//     (esta interfaz): igual que login, el invitado que acepta NO tiene sesión
//     autenticada todavía, así que corren en sesión de sistema (`userId: null`,
//     `auth.uid()` null) — `acceptStaffInvite` alcanza a escribir `core.staff_user`/
//     `core.membership` de todas formas porque llama a la función SQL
//     `core.accept_staff_invite` (`security definer`, ver la migración), NUNCA
//     porque el rol `authenticated` tenga GRANT de escritura directo sobre esas
//     tablas.
//   - `createStaffInvite`/`listPendingStaffInvites`/`revokeStaffInvite` viven en
//     `CoreStaffRepository` (nueva interfaz, SEPARADA a propósito): las ejecuta un
//     owner/admin YA autenticado, así que corren sobre la sesión real por-request
//     (`c.get("db")`, `auth.uid()` = su propio `userId`) para que la policy RLS de
//     `core.staff_invite` (owner/admin de la organización) sea la autoridad real,
//     no una promesa de la capa TS — mismo principio "RLS real, TS es defensa en
//     profundidad" que ya aplica en el resto del monorepo (ver
//     `core-auth/src/middleware.ts::requirePropertyMembership`).
// `PostgresCoreRepository`/`InMemoryCoreRepository` implementan AMBAS interfaces (una
// sola clase, sin duplicar código) — es la app (`apps/api/src/deps.ts`) la que decide
// con qué tipo de sesión se invoca cada una vía dos campos separados de `AppDeps`
// (`coreRepo` vs. `coreStaffRepo`).

export interface StaffUserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string | null;
  readonly createdVia: "seed" | "invite" | "registro_autoservicio" | "google";
  readonly emailVerifiedAt: string | null;
}

export interface MembershipRow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

export type StaffInviteStatus = "pending" | "accepted" | "revoked";

export interface StaffInviteRow {
  readonly id: string;
  readonly email: string;
  readonly organizationId: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  /** null = acceso a TODAS las properties de la organización, igual semántica que
   *  `core.membership.property_ids` (ver core-tenancy/src/session.ts). */
  readonly propertyIds: readonly string[] | null;
  readonly status: StaffInviteStatus;
  readonly invitedBy: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedBy: string | null;
  readonly createdAt: string;
}

export interface CreateStaffInviteInput {
  readonly email: string;
  readonly organizationId: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
  /** SHA-256 hex del token plano (ver `@atiende/core-auth::hashInviteToken`) — el
   *  token plano NUNCA se persiste, mismo criterio que un password. */
  readonly tokenHash: string;
  readonly invitedBy: string;
  readonly expiresAt: string;
}

export interface AcceptStaffInviteInput {
  readonly tokenHash: string;
  readonly fullName: string;
  readonly passwordHash: string;
}

export interface AcceptStaffInviteResult {
  readonly staffId: string;
  readonly email: string;
  readonly organizationId: string;
  readonly vertical: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

export interface CoreRepository {
  findStaffByEmail(email: string): Promise<StaffUserRow | null>;
  findStaffById(id: string): Promise<StaffUserRow | null>;
  findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]>;
  /** Lectura pública (sin sesión autenticada) para que la UI muestre a quién/qué
   *  organización invita el token ANTES de pedir nombre/password — `null` si el
   *  token no existe; el llamador decide qué hacer con un estado no-`pending` o ya
   *  expirado (mismo criterio que `findStaffByEmail` para login: este puerto solo
   *  resuelve datos, nunca decide el 401/400 de la ruta). */
  findStaffInviteByTokenHash(tokenHash: string): Promise<StaffInviteRow | null>;
  /** Atómico: valida pending+no-expirado, crea (o reutiliza) `core.staff_user`,
   *  crea/actualiza `core.membership`, marca la invitación 'accepted' — TODO en una
   *  sola llamada a la función SQL `core.accept_staff_invite` (`security definer`).
   *  Lanza si el token es inválido/ya no está pendiente/expiró (ver
   *  `postgres-core-repository.ts`/`in-memory-core-repository.ts` para el código de
   *  error exacto que cada adaptador usa). */
  acceptStaffInvite(input: AcceptStaffInviteInput): Promise<AcceptStaffInviteResult>;
}

/** Ver el comentario de cabecera del archivo para por qué esta interfaz vive
 *  separada de `CoreRepository` (sesión real por-request, nunca de sistema). */
export interface CoreStaffRepository {
  createStaffInvite(input: CreateStaffInviteInput): Promise<StaffInviteRow>;
  listPendingStaffInvites(organizationId: string): Promise<readonly StaffInviteRow[]>;
  /** `true` si revocó una invitación 'pending' de esa organización; `false` si no
   *  existía, ya no estaba 'pending', o pertenecía a otra organización (nunca lanza
   *  por "no encontrado" — el caller decide el 404). */
  revokeStaffInvite(id: string, organizationId: string): Promise<boolean>;
}

/** Lanzado por `acceptStaffInvite` cuando el token no existe, ya no está pendiente, o
 *  expiró — un solo código para los 3 casos (mismo criterio que
 *  `RentasPropertyOwnerInviteTokenInvalido` del portal de propietario: nunca se
 *  distingue "expiró" de "ya usado" en la respuesta, para no filtrarle a un atacante
 *  cuál de los dos aplica). */
export class StaffInviteInvalidError extends Error {
  constructor() {
    super("La invitación es inválida, ya fue usada/revocada, o expiró.");
    this.name = "StaffInviteInvalidError";
  }
}
