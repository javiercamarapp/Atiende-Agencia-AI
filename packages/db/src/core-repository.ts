// Puerto de acceso a `core.staff_user`/`core.membership`/`core.organization`, para
// las rutas núcleo de login (`POST /auth/login`, `/auth/refresh`, `/auth/me`,
// `/auth/select-org` — ver diseño Fase 1 §5: "no son de domain-restaurantes, son
// núcleo compartido, igual patrón que hoteles apps/api/src/routes/auth.ts").
//
// Mismo patrón dual de adaptador que ya usa `@atiende/core-conversation`
// (`InMemoryLockStore`/`RedisLockStore` implementando el mismo `LockStore`):
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

/** Fase 3 caller-binding (ver `packages/db/migrations/0017_caller_binding_fase3.sql`)
 *  — fila mínima que devuelve `core.find_staff_for_org_admin`: un admin YA
 *  autenticado busca a OTRO usuario por correo (para invitarlo o detectar que ya es
 *  staff de su organización). Deliberadamente SIN `passwordHash`/`createdVia`/
 *  `emailVerifiedAt`/`sessionsRevokedAt` (a diferencia de `StaffUserRow`) — esta
 *  búsqueda nunca sirve para login, solo para que un admin vea si ya existe una
 *  cuenta con ese correo. */
export interface OrgAdminStaffLookupRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
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

/** Fila real de `core.notification`, ya resuelta con `readAt` (null = no leída) vía
 *  el LEFT JOIN de `core.list_notifications_for_staff` -- ver
 *  `supabase/migrations/20240101000115_0013_notifications_schema.sql`. Genérica a
 *  propósito (mismo criterio que `MembershipRow.vertical`): `vertical`/`entidadTipo`/
 *  `entidadId` son opacos para `core`, cada dominio decide qué escribir ahí. */
export interface NotificationRow {
  readonly id: string;
  readonly vertical: string | null;
  readonly titulo: string;
  readonly cuerpo: string | null;
  readonly entidadTipo: string | null;
  readonly entidadId: string | null;
  readonly createdAt: string;
  /** null = no leída. */
  readonly readAt: string | null;
}

/** Fila de `core.organization_billing` cruzada con `core.get_organization_billing_
 *  info` (owner_email resuelto) -- ver el comentario de cabecera de
 *  `packages/db/migrations/0009_billing_saas_schema.sql`. Consumida
 *  tanto por el checkout (`POST /billing/checkout`, resolver si ya existe un
 *  customer de Stripe) como por el webhook (`POST /billing/webhook`,
 *  verificación cross-tenant vía `@atiende/billing::TenantConocido` -- ver
 *  `apps/api/src/production/saas-billing-stripe-port.ts` para el adaptador que
 *  mapea esta fila a esa interfaz). `null` en los campos de Stripe = la
 *  organización nunca inició un checkout todavía (fila `organization_billing`
 *  inexistente, `left join` en la función SQL). */
export interface OrganizationBillingRow {
  readonly organizationId: string;
  /** `core.organization.vertical` -- necesario para armar la metadata
   *  `{tenant_id, vertical}` que `@atiende/billing::crearCheckoutPerSeat` exige
   *  siempre (ver el comentario de cabecera de `stripe-rail.ts`), sin una
   *  segunda consulta aparte a `core.organization` desde la ruta. */
  readonly vertical: string;
  /** Email del primer 'owner' (por antigüedad de membership) de la
   *  organización, o `null` si la organización no tiene ningún owner todavía
   *  (no debería pasar en producción real, pero una organización recién creada
   *  en un fixture de prueba puede no tenerlo). */
  readonly ownerEmail: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly priceId: string | null;
  readonly seats: number;
  readonly status: "sin_suscripcion" | "activa" | "pago_pendiente" | "cancelada";
  /** ISO 8601, o `null` si nunca hubo una suscripción. */
  readonly currentPeriodEnd: string | null;
}

/** Input de `CoreRepository.upsertOrganizationBilling` -- llamado SOLO desde
 *  `POST /billing/webhook` DESPUÉS de que `@atiende/billing::aplicarConLedger`
 *  ya resolvió que el evento es nuevo y está en orden (nunca antes -- ver el
 *  comentario de cabecera de `packages/billing/src/ledger.ts`: "los handlers de
 *  este dominio FIJAN estado", así que esto SIEMPRE reemplaza la fila completa,
 *  nunca hace un merge parcial). */
export interface UpsertOrganizationBillingInput {
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string | null;
  readonly priceId: string | null;
  readonly seats: number;
  readonly status: OrganizationBillingRow["status"];
  /** ISO 8601, o `null`. */
  readonly currentPeriodEnd: string | null;
}

/** `'nuevo'` = primera vez que se ve este id de evento; `'duplicado'` = ya se
 *  había marcado (reintento at-least-once del proveedor de pagos) -- mismo
 *  vocabulario que `@atiende/billing::MarcaVisto`, del que
 *  `CoreRepositoryLedgerStore` (`apps/api/src/production/saas-billing-stripe-
 *  port.ts`) es el adaptador `LedgerStore` real. */
export type BillingWebhookEventMark = "nuevo" | "duplicado";

/** Lanzado por `getOrganizationBillingForCheckout` cuando `organizationId` no
 *  existe -- mensaje real (nunca genérico): a diferencia de `StaffInviteInvalidError`,
 *  aquí no hay ningún atacante al que ocultarle si un id existe (el caller ya
 *  está autenticado y el id lo escribió el propio frontend de su organización). */
export class OrganizationNotFoundError extends Error {
  constructor(message = "La organización no existe.") {
    super(message);
    this.name = "OrganizationNotFoundError";
  }
}

/** Lanzado por `getOrganizationBillingForCheckout` cuando `callerId` no es
 *  owner/admin de la organización ni superadmin de plataforma -- ver el
 *  comentario de cabecera de `core.get_organization_billing_for_checkout` en la
 *  migración para la autoridad real (siempre validada DENTRO de la función SQL
 *  en producción, esto es la traducción a un error tipado). */
export class OrganizationBillingAccessDeniedError extends Error {
  constructor(message = "No tienes autoridad para administrar el billing de esta organización.") {
    super(message);
    this.name = "OrganizationBillingAccessDeniedError";
  }
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
  /** Hallazgo de auditoría (P2, "tokens de sesión completos en query params de
   *  URL"): patrón "authorization code" para AMBOS callbacks de login sin
   *  contraseña (`apps/api/src/routes/auth-google.ts`/`auth-magic-link.ts`) —
   *  el redirect 302 hacia el frontend pone este código opaco de un solo uso en
   *  vez del token/refreshToken reales. Mismo mecanismo EXACTO que
   *  `createMagicLinkToken` (`@atiende/core-auth::generateInviteToken`, solo se
   *  persiste el HASH), TTL deliberadamente corto (segundos, no minutos —
   *  `EXCHANGE_CODE_TTL_MS` en `routes/auth.ts`) porque el frontend lo canjea de
   *  inmediato al montar (`GoogleCallback.tsx`). Nunca persiste el JWT en sí —
   *  solo `staffId` — el token/refreshToken reales se generan recién al canjear
   *  (`issueSession`, siempre fresco contra las membresías actuales). */
  createAuthExchangeCode(input: { readonly staffId: string; readonly codeHash: string; readonly expiresAt: string }): Promise<void>;
  /** Consume atómicamente un código de intercambio: si estaba `pending` y no
   *  había vencido, lo marca `used` y devuelve el staff al que pertenece — en la
   *  MISMA operación, sin ventana de carrera entre leer y marcar usado (mismo
   *  patrón que `consumeMagicLinkToken`). `null` si el código no existe, ya se
   *  usó, o venció — el caller (`POST /auth/exchange-code`) nunca distingue cuál
   *  de los tres casos fue. */
  consumeAuthExchangeCode(codeHash: string): Promise<StaffUserRow | null>;
  /** Back office de plataforma (`apps/web/src/superadmin/**`) — `true` si este
   *  staff está en `core.platform_superadmin` (rol cruzado a las 6
   *  verticales, distinto de `core.membership.platform_role` que es DENTRO de
   *  una sola organización). Usado por `GET /auth/me` (para que el frontend
   *  decida si redirigir a `/superadmin`) y por cada ruta de
   *  `apps/api/src/routes/superadmin.ts` como defensa real, no solo un chequeo
   *  en TS. */
  isPlatformSuperadmin(staffId: string): Promise<boolean>;
  /** Todas las organizaciones de las 6 verticales — SOLO resuelve datos reales
   *  si `callerId` es superadmin (el chequeo vive DENTRO de la función SQL
   *  `security definer`, ver la migración); un caller que no lo es obtiene un
   *  arreglo vacío, nunca un error que confirme/niegue si hay datos. */
  listAllOrganizationsForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationRow[]>;
  /** Conteo de staff (`core.membership`) por organización, mismo criterio de
   *  autorización interna que `listAllOrganizationsForSuperadmin` — un `Map`
   *  vacío para un caller que no es superadmin. */
  countStaffByOrganizationForSuperadmin(callerId: string): Promise<ReadonlyMap<string, number>>;
  /** Infraestructura de notificaciones (genérica, 6 verticales + superadmin) — ver el
   *  comentario de cabecera de `supabase/migrations/20240101000115_0013_notifications_
   *  schema.sql`. Últimas 50, más recientes primero, con `readAt` ya resuelto — el
   *  frontend nunca calcula "leída" por su cuenta. Vive en `CoreRepository` (sesión de
   *  sistema, mismo patrón que `isPlatformSuperadmin`) y no en una interfaz-fábrica
   *  aparte porque `core.list_notifications_for_staff` recibe `p_staff_id` explícito y
   *  no depende de `auth.uid()` — el caller HTTP (`routes/notifications.ts`) siempre
   *  pasa `c.get("userId")` de la sesión JWT ya verificada, nunca un id ajeno. */
  listNotificationsForStaff(staffId: string): Promise<readonly NotificationRow[]>;
  /** Conteo real para el badge de la campana — misma fuente de verdad que
   *  `listNotificationsForStaff`, nunca recalculado en cliente restando arreglos. */
  countUnreadNotificationsForStaff(staffId: string): Promise<number>;
  /** Marca UNA notificación leída — idempotente (upsert). Lanza si la notificación no
   *  existe o pertenece a OTRO staff (ver `core.mark_notification_read`, SQLSTATE
   *  P0002) — el adaptador la traduce a `NotificationNotFoundError`. */
  markNotificationRead(staffId: string, notificationId: string): Promise<void>;
  /** Marca TODAS las notificaciones del staff leídas en una sola llamada — mismo
   *  criterio que `restaurantes.mark_all_notifications_read` de la referencia (un solo
   *  INSERT masivo evaluado en Postgres, nunca N llamadas del cliente). Devuelve
   *  cuántas quedaron marcadas leídas en ESTA llamada. */
  markAllNotificationsRead(staffId: string): Promise<number>;
  /** "Cerebro de ventas" (ver `supabase/migrations/20240101000114_0012_superadmin_
   *  prospectos.sql`) — mismo patrón de autorización que el resto del back office de
   *  plataforma: `core.list_prospectos_for_superadmin` valida `is_platform_superadmin`
   *  DENTRO de la función SQL, `callerId` nunca decide nada del lado TS. Más recientes
   *  primero (por `updated_at`). */
  listProspectosForSuperadmin(callerId: string): Promise<readonly ProspectoRow[]>;
  /** Alta real de un prospecto — `callerId` queda como `creado_por` dentro de la
   *  función SQL (nunca un id ajeno pasado por el cliente). */
  createProspectoForSuperadmin(callerId: string, input: CreateProspectoInput): Promise<ProspectoRow>;
  /** Mueve `estado` y/o `notas` de un prospecto ya existente — ambos campos son
   *  `coalesce` dentro de la función SQL (pasar `null` en uno deja ese campo tal
   *  cual). Lanza `ProspectoNotFoundError` si el id no existe (SQLSTATE P0002, ver
   *  `core.update_prospecto_for_superadmin`). */
  updateProspectoForSuperadmin(callerId: string, prospectoId: string, estado: string | null, notas: string | null): Promise<ProspectoRow>;
  /** "Entrar a los otros paneles" (ver `supabase/migrations/20240101000119_0014_
   *  superadmin_demo_access.sql`) — NO es un mecanismo de impersonación nuevo: crea,
   *  de forma idempotente, una organización DEMO real para `vertical` (si no existe
   *  todavía) y una fila real de `core.membership` que vincula a `callerId` con ella
   *  (rol de acceso total real de esa vertical). El caller HTTP encadena esto con el
   *  `POST /auth/select-org` YA existente para obtener una sesión real del Shell de
   *  esa vertical — cero superficie de autorización nueva, mismo modelo que protege
   *  a cualquier cliente real. */
  ensureDemoAccessForSuperadmin(callerId: string, vertical: string): Promise<{ readonly organizationId: string; readonly slug: string }>;

  // ---- Suscripción SaaS propia de Atiende (rubro P1 #6 de la auditoría) — sesión
  // de sistema igual que el resto de este archivo: ninguno de los 5 métodos
  // siguientes depende de `auth.uid()` (el checkout valida autoridad con
  // `callerId` explícito, DENTRO de la función SQL, mismo criterio que
  // `listProspectosForSuperadmin`; el webhook no tiene ningún caller autenticado
  // que pasar -- su autoridad real es la firma HMAC de Stripe, verificada en
  // `apps/api/src/routes/billing.ts` ANTES de llamar aquí). Ver el comentario de
  // cabecera de `packages/db/migrations/0009_billing_saas_schema.sql`
  // para el esquema completo. ----

  /** `POST /billing/checkout` — resuelve billing info de la organización SOLO si
   *  `callerId` la administra (owner/admin de esa organización o superadmin de
   *  plataforma) — la autoridad real vive DENTRO de `core.get_organization_
   *  billing_for_checkout` (`security definer`), nunca solo en la capa TS. Lanza
   *  `OrganizationNotFoundError`/`OrganizationBillingAccessDeniedError` (nunca
   *  devuelve `null`: a diferencia del webhook, aquí SIEMPRE hay un caller
   *  autenticado al que darle un mensaje real). */
  getOrganizationBillingForCheckout(callerId: string, organizationId: string): Promise<OrganizationBillingRow>;
  /** `POST /billing/webhook` — mismos datos que la de arriba, SIN chequeo de
   *  autoridad (el webhook no tiene ningún `callerId` de staff que validar) — la
   *  autoridad real es la firma HMAC ya verificada por el caller HTTP. `null` si
   *  `organizationId` (del `tenant_id` de la metadata del evento, YA re-derivado
   *  y verificado por `@atiende/billing::verificarTenantDelWebhook` antes de
   *  llegar aquí) no corresponde a ninguna organización real. */
  getOrganizationBillingForWebhook(organizationId: string): Promise<OrganizationBillingRow | null>;
  /** Persiste el estado de billing resuelto de un evento de webhook YA procesado
   *  por el ledger (`@atiende/billing::aplicarConLedger`) — ver el comentario de
   *  `UpsertOrganizationBillingInput` para por qué esto SIEMPRE reemplaza la fila
   *  completa. */
  upsertOrganizationBilling(input: UpsertOrganizationBillingInput): Promise<OrganizationBillingRow>;
  /** Adaptador `LedgerStore.marcarVisto` (`@atiende/billing::ledger.ts`) — dedupe
   *  ATÓMICO por id de evento (`insert ... on conflict do nothing`, ver la
   *  migración). */
  markBillingWebhookEventSeen(eventId: string): Promise<BillingWebhookEventMark>;
  /** Adaptador `LedgerStore.ordenAplicado`. */
  getBillingEntityOrder(entityId: string): Promise<number | null>;
  /** Adaptador `LedgerStore.sellarOrden`. */
  sealBillingEntityOrder(entityId: string, createdUnix: number): Promise<void>;
  /** Bitácora completa de CADA intento de `POST /billing/webhook` (procesado,
   *  ignorado, rechazado, error) — ver `packages/db/migrations/0018_billing_
   *  webhook_registro.sql` para el porqué de una tabla nueva separada del
   *  ledger de dedupe. BEST-EFFORT por contrato: esta llamada NUNCA lanza
   *  (incluso si `core.record_billing_webhook_event` todavía no existe en la
   *  base real — SQLSTATE 42883, migración aplicada después del código, ver
   *  `postgres-core-repository.ts`) — un fallo de esta escritura jamás debe
   *  tumbar la respuesta real del webhook. */
  recordBillingWebhookEvent(input: RecordBillingWebhookEventInput): Promise<void>;

  // ---- Pantalla /superadmin/facturacion — lectura agregada de la suscripción
  // SaaS propia de Atiende por organización (asientos contratados/staff real,
  // estado, antigüedad) + diagnóstico de webhook. MISMO criterio de
  // autorización que `listAllOrganizationsForSuperadmin`/`listProspectosForSuperadmin`
  // (chequeo real DENTRO de la función SQL, `callerId` nunca decide nada del
  // lado TS; un caller no-superadmin obtiene arreglos vacíos/0, nunca un error
  // que confirme/niegue si hay datos). Ver
  // `packages/db/migrations/0013_superadmin_facturacion.sql` para el porqué de
  // cada campo, en particular el límite honesto documentado ahí sobre
  // `core.billing_webhook_event` (sin `organization_id`/tipo/resultado — un
  // feed de PLATAFORMA, nunca "por organización", y solo eventos ya aplicados
  // con éxito, nunca los rechazados). ----

  /** Una fila por organización de las 6 verticales (join de
   *  `core.organization`+`core.organization_billing`+conteo real de
   *  `core.membership`) — el cálculo de MRR/reconciliación per-seat vive en
   *  TS (`apps/api/src/routes/superadmin-facturacion.ts`, usando
   *  `@atiende/billing::calcularPerSeat` + las constantes `SEAT_*` conocidas
   *  por vertical), nunca aquí: esta función solo resuelve datos reales
   *  persistidos, ningún precio. */
  listOrganizationBillingForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationBillingRow[]>;
  /** Últimos `limit` eventos de webhook de Stripe ya aplicados con éxito
   *  (`core.billing_webhook_event`, ver el límite honesto documentado en la
   *  migración) — feed de PLATAFORMA, más recientes primero. */
  listRecentBillingWebhookEventsForSuperadmin(callerId: string, limit: number): Promise<readonly BillingWebhookEventSummaryRow[]>;
  /** Conteo total (no acotado por `limit`) de eventos de webhook ya
   *  aplicados con éxito — para el stat card de la pantalla. */
  countBillingWebhookEventsForSuperadmin(callerId: string): Promise<number>;
  /** Bitácora COMPLETA (todo resultado, con o sin organización resuelta) de
   *  `core.billing_webhook_log` — ver `0018_billing_webhook_registro.sql`.
   *  `disponible: false` (nunca lanza) cuando la migración todavía no se
   *  aplicó en este ambiente (SQLSTATE 42883) — la pantalla debe mostrar "no
   *  disponible aún", nunca un 500. */
  listBillingWebhookLogForSuperadmin(callerId: string, filters: BillingWebhookLogFilters): Promise<BillingWebhookLogPage>;
}

/** Fila de `core.list_organization_billing_for_superadmin` — join de
 *  organización + billing (si existe) + conteo real de staff (`core.membership`).
 *  `stripeCustomerId`/`stripeSubscriptionId`/`priceId`/`currentPeriodEnd` `null`
 *  y `billingStatus === "sin_suscripcion"` = la organización nunca inició un
 *  checkout todavía (mismo `left join` que `core.get_organization_billing_info`).
 *  `lastAppliedEventUnix` viene de `core.billing_entity_order` (cruzado por
 *  `stripe_customer_id`) — `null` si la organización no tiene customer de
 *  Stripe todavía, o si nunca se aplicó ningún evento real. */
export interface SuperadminOrganizationBillingRow {
  readonly organizationId: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly orgStatus: "trial" | "active" | "suspended";
  /** ISO 8601 — antigüedad de la organización (`core.organization.created_at`). */
  readonly createdAt: string;
  readonly billingStatus: OrganizationBillingRow["status"];
  /** Asientos CONTRATADOS (última `quantity` real que Stripe reportó,
   *  `core.organization_billing.seats`) — `0` si la organización nunca inició
   *  un checkout. */
  readonly seats: number;
  /** Staff real (`count(*)` de `core.membership` de esta organización) —
   *  misma fuente que `countStaffByOrganizationForSuperadmin`. */
  readonly staffCount: number;
  readonly priceId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly lastAppliedEventUnix: number | null;
}

/** Fila de `core.list_recent_billing_webhook_events_for_superadmin`. */
export interface BillingWebhookEventSummaryRow {
  readonly eventId: string;
  /** ISO 8601. */
  readonly processedAt: string;
}

/** `core.billing_webhook_log.result` — ver `0018_billing_webhook_registro.sql`. */
export type BillingWebhookLogResult = "procesado" | "ignorado" | "rechazado" | "error";

/** `core.billing_webhook_log.reason` — enum corto y estable, MISMO vocabulario
 *  que `@atiende/billing::MotivoRechazo` para los 4 primeros valores (nunca se
 *  traduce/reformula entre el motivo real de `verificarTenantDelWebhook` y lo
 *  que queda guardado). */
export type BillingWebhookLogReason =
  | "tenant_id_ausente"
  | "tenant_no_existe"
  | "customer_no_coincide"
  | "email_no_coincide"
  | "firma_invalida"
  | "json_invalido"
  | "evento_no_reconocido"
  | "duplicado"
  | "fuera_de_orden"
  | "aplicado"
  | "error_interno";

/** Input de `CoreRepository.recordBillingWebhookEvent` — un intento CRUDO de
 *  `POST /billing/webhook`, con o sin éxito. `providerEventId`/`eventType`/
 *  `organizationId` son `null` cuando el intento se rechazó ANTES de poder
 *  resolverlos (p.ej. firma inválida se rechaza antes de parsear el body). */
export interface RecordBillingWebhookEventInput {
  readonly providerEventId: string | null;
  readonly eventType: string | null;
  readonly organizationId: string | null;
  readonly result: BillingWebhookLogResult;
  readonly reason: BillingWebhookLogReason;
}

/** Fila de `core.list_billing_webhook_log_for_superadmin` — `organizationName`/
 *  `organizationSlug` son `null` cuando `organizationId` es `null` (rechazo sin
 *  organización resuelta) o cuando la organización se borró después. */
export interface BillingWebhookLogRow {
  readonly id: string;
  readonly providerEventId: string | null;
  readonly eventType: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly organizationSlug: string | null;
  readonly result: BillingWebhookLogResult;
  readonly reason: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** Filtros de `CoreRepository.listBillingWebhookLogForSuperadmin` — todos
 *  opcionales salvo `limit`/`offset` (paginado explícito; el repositorio
 *  acota ambos a un rango sano igual que la función SQL, nunca confía en que
 *  el caller mande valores fuera de rango). `desde`/`hasta` son ISO 8601. */
export interface BillingWebhookLogFilters {
  readonly result?: BillingWebhookLogResult;
  readonly eventType?: string;
  readonly organizationId?: string;
  readonly desde?: string;
  readonly hasta?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Página de resultados de `listBillingWebhookLogForSuperadmin`. `disponible:
 *  false` (siempre con `rows: []`, `total: 0`) es el "vacío honesto" que la
 *  Fase de compatibilidad exige cuando `0018_billing_webhook_registro.sql`
 *  todavía no se aplicó en el ambiente real -- nunca un 500. */
export interface BillingWebhookLogPage {
  readonly disponible: boolean;
  readonly rows: readonly BillingWebhookLogRow[];
  readonly total: number;
}

/** Fila real de `core.prospecto` — ver el comentario de cabecera de la migración
 *  0012 para el porqué de cada campo (adaptado del "cerebro de ventas" real de
 *  Likida, con `vertical` como columna real ya que aquí un prospecto puede
 *  comprar cualquiera de las 6 soluciones, no siempre una flota). */
export interface ProspectoRow {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly notas: string | null;
  readonly creadoPor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** `null` = no necesita seguimiento ahora mismo. Lo escribe SOLO
   *  `core.marcar_prospectos_sin_movimiento_for_system` (automatización de
   *  `packages/db/migrations/0016_superadmin_acciones.sql`) y se limpia
   *  SOLO — en cualquier actualización real vía `updateProspectoForSuperadmin`
   *  (incluida la que dispara `cerrar_prospecto`). ISO 8601. */
  readonly necesitaSeguimientoDesde: string | null;
}

export interface CreateProspectoInput {
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly fuente: string | null;
  readonly notas: string | null;
}

/** Fila de `core.organization`, tal cual la ve el back office de plataforma —
 *  deliberadamente sin nada de otra vertical/tabla (el dashboard cruza el
 *  conteo de staff por separado, ver `countStaffByOrganizationForSuperadmin`),
 *  mismo criterio de "solo lo que este caller necesita" que `OrganizationMemberRow`. */
export interface SuperadminOrganizationRow {
  readonly id: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "trial" | "active" | "suspended";
  readonly createdAt: string;
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
  /** Fase 3 caller-binding (hallazgo de seguridad, ver `packages/db/migrations/
   *  0017_caller_binding_fase3.sql`) — reemplaza el uso "administración" de
   *  `CoreRepository.findStaffByEmail` (sesión de sistema, ahora bloqueada para
   *  cualquier `auth.uid()` real): `admin-staff.ts` de las 5 verticales con alta de
   *  staff busca aquí a un usuario por correo ANTES de invitarlo, para detectar una
   *  cuenta ya existente (de cualquier organización) sin exponer `passwordHash` ni
   *  el resto de `StaffUserRow`. Autoridad real DENTRO de `core.find_staff_for_org_
   *  admin` (nunca solo la capa TS): exige que el caller (`auth.uid()`, la sesión
   *  real por-request que abre esta interfaz) sea owner/admin de
   *  `organizationId` — mismo umbral que `updateMemberVerticalRole`. `null` si no
   *  existe ningún `core.staff_user` con ese correo. */
  findStaffForOrgAdmin(organizationId: string, email: string): Promise<OrgAdminStaffLookupRow | null>;
  /** Complementa a `findStaffForOrgAdmin` — ¿`targetUserId` (normalmente el `id` que
   *  acaba de devolver esa búsqueda) ya es miembro de `organizationId`? Reemplaza el
   *  uso "administración" de `CoreRepository.findMembershipsByUserId(existingStaff.
   *  id).some(m => m.organizationId === organizationId)` — sin exponer la lista
   *  completa de membresías (de CUALQUIER organización) del target. Mismo umbral de
   *  autoridad que `findStaffForOrgAdmin`. */
  isStaffOrgMember(organizationId: string, targetUserId: string): Promise<boolean>;
  /** FASE 3 (producto, restaurantes) — hallazgo real: hasta ahora ninguna vertical
   *  podía dar de baja a un staff YA ACEPTADO (solo revocar una invitación
   *  PENDIENTE, `revokeStaffInvite`). Elimina SOLO la `core.membership` de esta
   *  organización -- nunca `core.staff_user` (ver comentario de cabecera de
   *  `migrations/0022_remove_membership.sql`). Lanza `MembershipRemovalError`
   *  cuando el caller no tiene autoridad suficiente (mismo umbral que
   *  `updateMemberVerticalRole`: admin/owner, nunca de menor rango que el target),
   *  cuando intenta darse de baja a SÍ MISMO (nunca permitido), cuando `targetUserId`
   *  no pertenece a `organizationId`, o cuando remover al target dejaría la
   *  organización sin ningún owner (caso límite decidido explícitamente en esa
   *  migración). Lanza `MembershipRemovalUnavailableError` cuando `core.
   *  remove_membership` todavía no existe en esta base (SQLSTATE 42883, base real
   *  sin migrar -- REGLA DURA de compatibilidad de AGENTS.md: esta es una
   *  capacidad NUEVA sin camino anterior al que degradar, así que el caller HTTP
   *  debe responder un "no disponible todavía" honesto, nunca un 500). */
  removeMembership(organizationId: string, targetUserId: string): Promise<void>;
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

/** Lanzado por `removeMembership` -- mismo criterio de mensaje real (no genérico)
 *  que `MembershipRoleUpdateError`: ningún caso (rango insuficiente, auto-baja,
 *  target ajeno a la organización, último owner) es sensible de ocultar. */
export class MembershipRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipRemovalError";
  }
}

/** Lanzado por `removeMembership` cuando `core.remove_membership` todavía no existe
 *  en esta base (SQLSTATE 42883) -- a diferencia de `MembershipRemovalError`
 *  (rechazo de autorización/regla de negocio, mensaje real de la función SQL), este
 *  caso es "la migración de esta capacidad nueva todavía no se aplicó" -- el caller
 *  HTTP lo traduce a un 503 honesto ("no disponible todavía"), nunca a un 500. */
export class MembershipRemovalUnavailableError extends Error {
  constructor() {
    super("Dar de baja a un staff todavía no está disponible en esta base de datos.");
    this.name = "MembershipRemovalUnavailableError";
  }
}

/** Lanzado por `markNotificationRead` cuando la notificación no existe o pertenece a
 *  OTRO staff (`core.mark_notification_read`, SQLSTATE P0002) — un solo caso, mismo
 *  criterio de mensaje único que `StaffInviteInvalidError` (nunca le confirma a quien
 *  llama si el id existe pero es ajeno, o si simplemente no existe). */
export class NotificationNotFoundError extends Error {
  constructor() {
    super("La notificación no existe o no pertenece a este staff.");
    this.name = "NotificationNotFoundError";
  }
}

/** Lanzado por `updateProspectoForSuperadmin` cuando el id no existe
 *  (`core.update_prospecto_for_superadmin`, SQLSTATE P0002). */
export class ProspectoNotFoundError extends Error {
  constructor() {
    super("El prospecto no existe.");
    this.name = "ProspectoNotFoundError";
  }
}
