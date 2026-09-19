// ProductionCoreRepository — adaptador real de `CoreRepository` para producción,
// consumido por deps.ts al construir el handler de Vercel (ver ../vercel.ts).
//
// `PostgresCoreRepository` (@atiende/db) exige un `TenantDbSession` ya abierto en su
// constructor — no abre sesión por sí sola. El patrón documentado en
// `postgres-core-repository.ts` es "se abre siempre vía
// `TenancyEngine.withAppSession({ userId: null }, ...)` (sesión de sistema, sin
// `auth.uid()`) porque login ocurre ANTES de que exista una sesión autenticada" — este
// wrapper es exactamente eso para la mayoría de los métodos: abre una transacción de
// sistema nueva en CADA llamada (nunca reutiliza una conexión entre requests, correcto
// para el `pg.Pool` de `ManagedPostgresEngine`) y delega en un `PostgresCoreRepository`
// construido sobre esa sesión efímera.
//
// EXCEPCIÓN (hallazgo de seguridad, ver `packages/db/migrations/0011_superadmin_
// caller_binding.sql`): los métodos `*ForSuperadmin` de más abajo llaman funciones
// SQL con `p_caller_id` explícito que ahora EXIGEN `auth.uid() = p_caller_id` — para
// esos, la sesión se abre COMO el caller autenticado (`{ userId: callerId }`), nunca
// de sistema. Cada uno sigue siendo una sola consulta por sesión, así que esto no
// afecta el aislamiento de ningún otro método de este archivo.
//
// EXCEPCIÓN #2, Fase 2 (hallazgo de seguridad, ver `packages/db/migrations/0012_
// caller_binding_fase2.sql`): mismo patrón, mismo criterio, extendido a
// `isPlatformSuperadmin`, las 4 funciones de notificaciones, `revokeAllRefreshTokens`
// y `getOrganizationBillingForCheckout` — todas EXIGEN ahora `auth.uid() = <su
// parámetro de identidad>`, y todas ya recibían el id del caller real verificado por
// `authMiddleware` en su único call site — solo faltaba abrir la sesión como ese
// caller en vez de como sistema. `revokeRefreshToken`/`getOrganizationBillingForWebhook`/
// `upsertOrganizationBilling` (y el resto de funciones sin `p_caller_id`/`p_staff_id`
// verificable contra una sesión autenticada) siguen en sesión de sistema sin cambio —
// sus propios call sites (logout/refresh antes de sesión, webhook de Stripe) nunca
// tienen un `auth.uid()` real que pasar.
import type {
  AcceptStaffInviteInput,
  AcceptStaffInviteResult,
  BillingWebhookEventMark,
  BillingWebhookEventSummaryRow,
  BillingWebhookLogFilters,
  BillingWebhookLogPage,
  CoreRepository,
  CreateProspectoInput,
  MembershipRow,
  NotificationRow,
  OrganizationBillingRow,
  ProspectoRow,
  RecordBillingWebhookEventInput,
  RevokeRefreshTokenInput,
  StaffInviteRow,
  StaffUserRow,
  SuperadminOrganizationBillingRow,
  SuperadminOrganizationRow,
  UpsertOrganizationBillingInput,
} from "@atiende/db";
import { PostgresCoreRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionCoreRepository implements CoreRepository {
  constructor(private readonly engine: TenancyEngine) {}

  findStaffByEmail(email: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findStaffByEmail(email),
    );
  }

  findStaffById(id: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findStaffById(id),
    );
  }

  findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findMembershipsByUserId(userId),
    );
  }

  // Fase 10 — lado del INVITADO (sin sesión autenticada todavía, mismo momento que
  // login): sesión de sistema igual que los 3 métodos de arriba. `acceptStaffInvite`
  // alcanza a escribir `core.staff_user`/`core.membership` porque llama a la función
  // `security definer` `core.accept_staff_invite` (ver
  // `packages/db/migrations/0002_staff_invite_schema.sql`), nunca porque el rol
  // `authenticated` sin `auth.uid()` tenga GRANT de escritura directo sobre esas
  // tablas.
  findStaffInviteByTokenHash(tokenHash: string): Promise<StaffInviteRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findStaffInviteByTokenHash(tokenHash),
    );
  }

  acceptStaffInvite(input: AcceptStaffInviteInput): Promise<AcceptStaffInviteResult> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).acceptStaffInvite(input));
  }

  // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles") — sesión de sistema igual que el resto de este archivo: /auth/logout
  // y /auth/refresh corren ANTES/SIN depender de `auth.uid()` (el actor se identifica
  // por el `sub`/`jti` del refresh token mismo, no por un Bearer ya verificado).
  revokeRefreshToken(input: RevokeRefreshTokenInput): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).revokeRefreshToken(input));
  }

  isRefreshTokenRevoked(jti: string): Promise<boolean> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).isRefreshTokenRevoked(jti));
  }

  // Hallazgo de seguridad (Fase 2, ver `packages/db/migrations/0012_caller_binding_
  // fase2.sql`): `core.revoke_all_refresh_tokens` ahora exige `auth.uid() = p_user_id`
  // -- `POST /auth/revoke-sessions` usa `authMiddleware` y ya pasa `c.get("userId")`
  // propio (nunca un id recibido del body), así que la sesión se abre COMO ese
  // caller, mismo criterio que `isPlatformSuperadmin`/las 12 funciones de superadmin.
  revokeAllRefreshTokens(userId: string): Promise<void> {
    return this.engine.withAppSession({ userId }, (session) => new PostgresCoreRepository(session).revokeAllRefreshTokens(userId));
  }

  findStaffByGoogleSub(sub: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).findStaffByGoogleSub(sub));
  }

  linkGoogleIdentity(input: { readonly staffId: string; readonly sub: string; readonly email: string }): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).linkGoogleIdentity(input));
  }

  createMagicLinkToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).createMagicLinkToken(input));
  }

  consumeMagicLinkToken(tokenHash: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).consumeMagicLinkToken(tokenHash));
  }

  createAuthExchangeCode(input: { readonly staffId: string; readonly codeHash: string; readonly expiresAt: string }): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).createAuthExchangeCode(input));
  }

  consumeAuthExchangeCode(codeHash: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).consumeAuthExchangeCode(codeHash));
  }

  // Hallazgo de seguridad (Fase 2, ver `packages/db/migrations/0012_caller_
  // binding_fase2.sql`): `core.is_platform_superadmin` ahora exige `auth.uid()
  // = p_staff_id` -- TODOS sus call sites reales (`GET /auth/me`, las 3 rutas
  // de superadmin) ya pasan `c.get("userId")` propio, nunca el id de otro
  // staff -- la sesión se abre COMO ese caller, mismo criterio que
  // `listAllOrganizationsForSuperadmin` de abajo.
  isPlatformSuperadmin(staffId: string): Promise<boolean> {
    return this.engine.withAppSession({ userId: staffId }, (session) => new PostgresCoreRepository(session).isPlatformSuperadmin(staffId));
  }

  // Hallazgo de seguridad (ver `packages/db/migrations/0011_superadmin_caller_
  // binding.sql`): estas funciones SQL ahora exigen `auth.uid() = p_caller_id`
  // -- abrir sesión de SISTEMA (`userId: null`) aquí las habría bloqueado
  // SIEMPRE, incluso para el superadmin real. La sesión se abre COMO el
  // caller autenticado (`callerId`, ya verificado por `authMiddleware` antes
  // de llegar aquí, ver `apps/api/src/routes/superadmin.ts`), una sola
  // consulta por sesión (nunca se comparte con ninguna otra query), así que
  // esto no cambia el aislamiento de ninguna otra llamada.
  listAllOrganizationsForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).listAllOrganizationsForSuperadmin(callerId));
  }

  countStaffByOrganizationForSuperadmin(callerId: string): Promise<ReadonlyMap<string, number>> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).countStaffByOrganizationForSuperadmin(callerId));
  }

  // ---- Infraestructura de notificaciones — Hallazgo de seguridad (Fase 2, ver
  // `packages/db/migrations/0012_caller_binding_fase2.sql`): las 4 funciones SQL
  // ahora exigen `auth.uid() = p_staff_id` -- `apps/api/src/routes/notifications.ts`
  // ya pasa SIEMPRE `c.get("userId")` propio (nunca un id arbitrario), así que la
  // sesión se abre COMO ese caller, mismo criterio que `isPlatformSuperadmin`. ----

  listNotificationsForStaff(staffId: string): Promise<readonly NotificationRow[]> {
    return this.engine.withAppSession({ userId: staffId }, (session) => new PostgresCoreRepository(session).listNotificationsForStaff(staffId));
  }

  countUnreadNotificationsForStaff(staffId: string): Promise<number> {
    return this.engine.withAppSession({ userId: staffId }, (session) => new PostgresCoreRepository(session).countUnreadNotificationsForStaff(staffId));
  }

  markNotificationRead(staffId: string, notificationId: string): Promise<void> {
    return this.engine.withAppSession({ userId: staffId }, (session) => new PostgresCoreRepository(session).markNotificationRead(staffId, notificationId));
  }

  markAllNotificationsRead(staffId: string): Promise<number> {
    return this.engine.withAppSession({ userId: staffId }, (session) => new PostgresCoreRepository(session).markAllNotificationsRead(staffId));
  }

  // ---- "Cerebro de ventas" — las 3 funciones SQL son `security definer` con
  // `p_caller_id` explícito y (desde `0011_superadmin_caller_binding.sql`)
  // exigen `auth.uid() = p_caller_id` -- sesión abierta COMO el caller
  // autenticado, mismo motivo que `listAllOrganizationsForSuperadmin` arriba. ----

  listProspectosForSuperadmin(callerId: string): Promise<readonly ProspectoRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).listProspectosForSuperadmin(callerId));
  }

  createProspectoForSuperadmin(callerId: string, input: CreateProspectoInput): Promise<ProspectoRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).createProspectoForSuperadmin(callerId, input));
  }

  updateProspectoForSuperadmin(callerId: string, prospectoId: string, estado: string | null, notas: string | null): Promise<ProspectoRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).updateProspectoForSuperadmin(callerId, prospectoId, estado, notas));
  }

  // "Entrar a los otros paneles" — `core.ensure_demo_access_for_superadmin` es
  // `security definer` con `p_caller_id` explícito (ver migración 0014) y
  // (desde `0011_superadmin_caller_binding.sql`) exige `auth.uid() =
  // p_caller_id` -- mismo motivo que arriba.
  ensureDemoAccessForSuperadmin(callerId: string, vertical: string): Promise<{ readonly organizationId: string; readonly slug: string }> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).ensureDemoAccessForSuperadmin(callerId, vertical));
  }

  // Suscripción SaaS propia de Atiende — Hallazgo de seguridad (Fase 2, ver
  // `packages/db/migrations/0012_caller_binding_fase2.sql`): `core.get_organization_
  // billing_for_checkout` ahora exige `auth.uid() = p_caller_id` -- `POST
  // /billing/checkout` ya pasa `c.get("userId")` propio (`callerId`), así que la
  // sesión se abre COMO ese caller, mismo criterio que las 12 funciones de
  // superadmin. `POST /billing/webhook` no tiene ningún `callerId` de staff que
  // pasar (su autoridad real es la firma HMAC de Stripe, ya verificada por el
  // caller HTTP antes de llegar aquí) -- sigue en sesión de sistema, sin cambio.
  getOrganizationBillingForCheckout(callerId: string, organizationId: string): Promise<OrganizationBillingRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).getOrganizationBillingForCheckout(callerId, organizationId));
  }

  getOrganizationBillingForWebhook(organizationId: string): Promise<OrganizationBillingRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).getOrganizationBillingForWebhook(organizationId));
  }

  upsertOrganizationBilling(input: UpsertOrganizationBillingInput): Promise<OrganizationBillingRow> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).upsertOrganizationBilling(input));
  }

  markBillingWebhookEventSeen(eventId: string): Promise<BillingWebhookEventMark> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).markBillingWebhookEventSeen(eventId));
  }

  getBillingEntityOrder(entityId: string): Promise<number | null> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).getBillingEntityOrder(entityId));
  }

  sealBillingEntityOrder(entityId: string, createdUnix: number): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).sealBillingEntityOrder(entityId, createdUnix));
  }

  // Bitácora de webhooks (`0018_billing_webhook_registro.sql`) — escritura en
  // sesión de SISTEMA (mismo criterio que el resto de los adaptadores del
  // ledger arriba: `POST /billing/webhook` nunca tiene un `auth.uid()` real
  // que pasar), lectura COMO el caller (mismo criterio que
  // `listOrganizationBillingForSuperadmin`/etc. abajo: la función SQL exige
  // `auth.uid() = p_caller_id`).
  recordBillingWebhookEvent(input: RecordBillingWebhookEventInput): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).recordBillingWebhookEvent(input));
  }

  listBillingWebhookLogForSuperadmin(callerId: string, filters: BillingWebhookLogFilters): Promise<BillingWebhookLogPage> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).listBillingWebhookLogForSuperadmin(callerId, filters));
  }

  // /superadmin/facturacion (ver `packages/db/migrations/0013_superadmin_
  // facturacion.sql`) — mismo criterio que el resto del back office de
  // plataforma: las 3 funciones SQL exigen `auth.uid() = p_caller_id`, así que
  // la sesión se abre COMO el caller autenticado (`callerId`, ya verificado por
  // `authMiddleware` en `routes/superadmin-facturacion.ts`), nunca de sistema.
  listOrganizationBillingForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationBillingRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).listOrganizationBillingForSuperadmin(callerId));
  }

  listRecentBillingWebhookEventsForSuperadmin(callerId: string, limit: number): Promise<readonly BillingWebhookEventSummaryRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).listRecentBillingWebhookEventsForSuperadmin(callerId, limit));
  }

  countBillingWebhookEventsForSuperadmin(callerId: string): Promise<number> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresCoreRepository(session).countBillingWebhookEventsForSuperadmin(callerId));
  }
}
