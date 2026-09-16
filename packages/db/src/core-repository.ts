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
  /** ISO 8601 o null — hallazgo de auditoría (rubro 2, severidad ALTA: "no hay forma
   *  de invalidar sesiones activas de un usuario"). Cualquier refresh token con `iat`
   *  (epoch seconds) anterior a este valor se trata como revocado en POST
   *  /auth/refresh, sin importar si su `jti` individual está en
   *  `core.revoked_refresh_token` — el corte que fija POST /auth/revoke-sessions para
   *  cerrar TODAS las sesiones de un usuario sin enumerar cada `jti` emitido (nunca se
   *  guardó una tabla de sesiones activas, solo de revocadas). `null` = nunca se pidió
   *  una revocación masiva para este usuario. Opcional (`?`) para no romper los
   *  fixtures existentes que construyen un `StaffUserRow` literal sin necesitarlo —
   *  ver `InMemoryCoreRepository.findStaffByEmail`/`findStaffById`, que lo completan
   *  con `null` cuando no se fijó explícito. */
  readonly sessionsRevokedAt?: string | null;
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

/** Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
 *  no tiene UI"): fila mínima de un miembro YA aceptado (`core.membership`, no una
 *  invitación pendiente) de una organización, para poblar un selector real (ej. "qué
 *  repartidor le asigno a este pedido"). Deliberadamente SIN `platformRole`/
 *  `verticalRole` (el caller ya los conoce: los pidió como filtro) ni ningún otro
 *  campo de `core.staff_user` — solo lo que un selector necesita mostrar/enviar. */
export interface OrganizationMemberRow {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  /** null = acceso a TODAS las properties de la organización, misma semántica que
   *  `MembershipRow.propertyIds`. */
  readonly propertyIds: readonly string[] | null;
}

/** Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
 *  restaurantes permite gestionar roles desde el producto"): verificado contra el
 *  código real que ni siquiera restaurantes podía cambiar el rol de un staff YA
 *  ACEPTADO (`admin-staff.ts` solo fija el rol AL INVITAR) — fila de un miembro ya
 *  aceptado CON su rol actual, para la tabla nueva del panel ("Staff activo") y
 *  para devolver el resultado real de `updateMemberVerticalRole`. Distinta de
 *  `OrganizationMemberRow` (Fase 12, deliberadamente sin rol — ese selector ya
 *  conoce el rol, lo pidió como filtro) — aquí el rol ES el dato que la UI necesita
 *  mostrar/editar. */
export interface OrganizationMemberWithRoleRow {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  /** null = acceso a TODAS las properties de la organización, misma semántica que
   *  `MembershipRow.propertyIds`. */
  readonly propertyIds: readonly string[] | null;
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

/** Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
 *  hoteles"): input de `CoreRepository.revokeRefreshToken` — persiste el `jti` del
 *  refresh token (nunca el JWT completo, mismo criterio que un password/token de
 *  invitación) en `core.revoked_refresh_token`. `expiresAt` es la expiración NATURAL
 *  del propio refresh token (su claim `exp`), no cuándo se revocó — sirve para que un
 *  futuro job de limpieza pueda purgar filas de tokens que de todas formas ya
 *  expiraron por sí solos, sin tener que decodificar cada JWT de nuevo. */
export interface RevokeRefreshTokenInput {
  readonly jti: string;
  readonly userId: string;
  /** ISO 8601 — expiración natural del refresh token (su claim `exp`), no la fecha de
   *  revocación (esa es `revoked_at`, con default `now()` en la tabla). */
  readonly expiresAt: string;
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
  /** POST /auth/logout — revoca UN refresh token concreto por su `jti` (nunca todos
   *  los del usuario, nunca el JWT completo). Idempotente: revocar dos veces el mismo
   *  `jti` no lanza (mismo criterio de idempotencia que ya usa `readPersistedSession`
   *  al limpiar una sesión corrupta, pero aquí no hace falta devolver `boolean` porque
   *  logout siempre "tiene éxito" desde el punto de vista del staff, nunca es un 404). */
  revokeRefreshToken(input: RevokeRefreshTokenInput): Promise<void>;
  /** Usado por `/auth/refresh` ANTES de reemitir sesión: si el `jti` del refresh token
   *  presentado ya fue revocado (el staff cerró sesión con él), la re-emisión debe
   *  fallar aunque el JWT en sí siga siendo criptográficamente válido y no haya
   *  expirado todavía — sin este chequeo, logout solo borraría el localStorage del
   *  navegador que lo pidió, sin impedir que ESE MISMO refresh token (ya copiado o
   *  interceptado) siga sirviendo para sacar access tokens nuevos. */
  isRefreshTokenRevoked(jti: string): Promise<boolean>;
  /** POST /auth/revoke-sessions — hallazgo de auditoría (rubro 2, severidad ALTA: "no
   *  hay forma de invalidar sesiones activas de un usuario", ej. tras cambio de
   *  contraseña o sospecha de compromiso). Marca `core.staff_user.sessions_revoked_at
   *  = now()` para este usuario: cualquier refresh token emitido ANTES de esta llamada
   *  deja de servir en /auth/refresh (ver `isRefreshTokenRevoked`/comentario de
   *  `sessionsRevokedAt` arriba) sin necesitar conocer/enumerar cada `jti` individual
   *  en circulación. El access token ya emitido sigue vivo hasta su propio `exp`
   *  (mismo trade-off ya documentado para `revokeRefreshToken`/logout). Siempre self-
   *  service: el caller (`apps/api/src/routes/auth.ts`) pasa SIEMPRE el `userId` de la
   *  sesión autenticada actual (`c.get("userId")`), nunca un id arbitrario recibido
   *  del body — revocar las sesiones de OTRO usuario (ej. un admin forzando el cierre
   *  de sesión de un empleado) queda fuera de esta pasada. */
  revokeAllRefreshTokens(userId: string): Promise<void>;
  /** "Sign in with Google" (ver `apps/api/src/routes/auth-google.ts`) — busca un
   *  staff YA vinculado a esta cuenta de Google por su `sub` (subject id del
   *  id_token, ver `core.staff_google_identity`). `null` si esta cuenta de Google
   *  nunca se vinculó a ningún staff todavía (el caller decide si intentar
   *  vincular por correo o rechazar, ver `linkGoogleIdentity`/lógica de la ruta). */
  findStaffByGoogleSub(sub: string): Promise<StaffUserRow | null>;
  /** Vincula una cuenta de Google (`sub`+`email`) a un `core.staff_user` YA
   *  existente — idempotente por `sub` único (`on conflict` en el adaptador
   *  Postgres): un mismo `sub` vinculado dos veces al mismo staff no falla ni
   *  duplica fila, solo actualiza el correo si Google lo reporta distinto. Nunca
   *  crea un `core.staff_user` nuevo (eso es responsabilidad exclusiva del alta
   *  por invitación/registro, no de este puerto) — el caller es responsable de
   *  confirmar que `staffId` corresponde a un correo verificado que YA hizo match
   *  contra un staff existente antes de llamar esto. */
  linkGoogleIdentity(input: { readonly staffId: string; readonly sub: string; readonly email: string }): Promise<void>;
  /** "Continuar con correo" sin contraseña (ver `apps/api/src/routes/
   *  auth-magic-link.ts`) — persiste el HASH de un token de un solo uso
   *  (`@atiende/core-auth::generateInviteToken`, nunca el token plano) para un
   *  staff YA existente. `expiresAt` es ISO 8601, típicamente 15 minutos desde
   *  la emisión. */
  createMagicLinkToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void>;
  /** Consume atómicamente un token de enlace mágico: si estaba `pending` y no
   *  había vencido, lo marca `used` y devuelve el staff al que pertenece — en
   *  la MISMA operación, sin ventana de carrera entre leer y marcar usado
   *  (mismo patrón que `acceptStaffInvite`). `null` si el token no existe, ya
   *  se usó, o venció -- el caller decide qué mensaje mostrar (nunca distingue
   *  cuál de los tres casos fue, para no dar pistas a un atacante). */
  consumeMagicLinkToken(tokenHash: string): Promise<StaffUserRow | null>;
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
  /** Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un
   *  pedido no tiene UI"): `PATCH .../admin/orders/:orderId/assign-repartidor`
   *  (Fase 8, `admin-orders.ts`) es el ÚNICO lugar que despacha un pedido, pero
   *  hasta esta fase no existía forma de listar QUÉ staff de la organización tiene
   *  `verticalRole` = "repartidor" para construir un selector real — `admin-staff.ts`
   *  (esta interfaz) solo exponía invitaciones PENDIENTES, nunca membresías ya
   *  aceptadas. Genérico a propósito (cualquier vertical puede necesitar "listar los
   *  miembros con este verticalRole" para su propio selector de asignación, mismo
   *  criterio que el resto de `core`), acotado a la organización del caller — ver
   *  `postgres-core-repository.ts` para la razón real (no solo de estilo) de por qué
   *  esto vive aquí (sesión REAL por-request, `auth.uid()` verdadero) y NUNCA en
   *  `CoreRepository` (sesión de sistema, `auth.uid()` siempre null — ver ese
   *  comentario para el gap de RLS que este método corrige de paso en
   *  `assign-repartidor`). Devuelve SOLO miembros con invitación ya ACEPTADA
   *  (`core.membership`), nunca invitaciones pendientes — un `pending` no es staff
   *  real todavía, no puede recibir un pedido despachado. */
  listMembersByVerticalRole(organizationId: string, verticalRole: string): Promise<readonly OrganizationMemberRow[]>;
  /** Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
   *  restaurantes permite gestionar roles desde el producto"): TODOS los miembros ya
   *  ACEPTADOS de la organización (con su rol actual), para poblar la tabla "Staff
   *  activo" del panel — generaliza `listMembersByVerticalRole` sin el filtro de
   *  `verticalRole`. Mismo criterio de sesión REAL por-request (nunca
   *  `CoreRepository`) que esa función — ver `postgres-core-repository.ts` para el
   *  porqué (RLS de `core.membership` restringe SELECT a la fila propia; la función
   *  SQL `security definer` es la única forma de ver a un COMPAÑERO). */
  listOrgMembers(organizationId: string): Promise<readonly OrganizationMemberWithRoleRow[]>;
  /** Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA): cambia el rol
   *  (`platformRole` + `verticalRole`) de un staff YA ACEPTADO de la organización —
   *  el hueco real que el hallazgo señalaba (ver el comentario de cabecera de la
   *  migración `0007_update_membership_role.sql`). Lanza `MembershipRoleUpdateError`
   *  si el caller no tiene autoridad suficiente (no es admin/owner, intenta tocar a
   *  alguien de más alcance, intenta ascender por encima de su propio rango, o
   *  intenta cambiar su PROPIO rol — bloqueado siempre, ver la migración), o si
   *  `targetUserId` no pertenece a esta organización. El caller ya validó que
   *  `newVerticalRole` es un valor válido PARA SU vertical (mismo criterio que
   *  `createStaffInvite`/`isRestaurantesRole`) antes de llamar — este método no
   *  conoce el string concreto, igual que el resto de `core`. */
  updateMemberVerticalRole(
    organizationId: string,
    targetUserId: string,
    newPlatformRole: "owner" | "admin" | "member" | "viewer",
    newVerticalRole: string,
  ): Promise<OrganizationMemberWithRoleRow>;
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

/** Lanzado por `updateMemberVerticalRole` — a diferencia de `StaffInviteInvalidError`
 *  (un solo mensaje genérico a propósito, para no filtrarle detalle a un atacante),
 *  aquí SÍ se preserva el mensaje real: ningún caso (rango insuficiente, auto-cambio
 *  de rol, target ajeno a la organización) es sensible de ocultar — son las mismas
 *  razones que ya explica `canInviteStaff`/`STAFF_INVITE_ROLES` al invitar, y verlas
 *  tal cual ayuda a quien intenta usar el selector a entender por qué falló. */
export class MembershipRoleUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipRoleUpdateError";
  }
}
