// ProductionCoreRepository — adaptador real de `CoreRepository` para producción,
// consumido por deps.ts al construir el handler de Vercel (ver ../vercel.ts).
//
// `PostgresCoreRepository` (@atiende/db) exige un `TenantDbSession` ya abierto en su
// constructor — no abre sesión por sí sola. El patrón documentado en
// `postgres-core-repository.ts` es "se abre siempre vía
// `TenancyEngine.withAppSession({ userId: null }, ...)` (sesión de sistema, sin
// `auth.uid()`) porque login ocurre ANTES de que exista una sesión autenticada" — este
// wrapper es exactamente eso: abre una transacción de sistema nueva en CADA llamada
// (nunca reutiliza una conexión entre requests, correcto para el `pg.Pool` de
// `ManagedPostgresEngine`) y delega en un `PostgresCoreRepository` construido sobre esa
// sesión efímera.
import type { AcceptStaffInviteInput, AcceptStaffInviteResult, CoreRepository, CreateProspectoInput, MembershipRow, NotificationRow, ProspectoRow, RevokeRefreshTokenInput, StaffInviteRow, StaffUserRow, SuperadminOrganizationRow } from "@atiende/db";
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

  // Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
  // sesiones activas de un usuario") — sesión de sistema igual que el resto de este
  // archivo: POST /auth/revoke-sessions usa `authMiddleware` (verifica el JWT Bearer
  // por sí solo) pero nunca abre un `TenantDbSession` por-request propio, mismo
  // criterio ya establecido por GET /auth/me (también autenticado, también resuelto
  // sobre `deps.coreRepo` de sesión de sistema).
  revokeAllRefreshTokens(userId: string): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).revokeAllRefreshTokens(userId));
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

  isPlatformSuperadmin(staffId: string): Promise<boolean> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).isPlatformSuperadmin(staffId));
  }

  listAllOrganizationsForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).listAllOrganizationsForSuperadmin(callerId));
  }

  countStaffByOrganizationForSuperadmin(callerId: string): Promise<ReadonlyMap<string, number>> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).countStaffByOrganizationForSuperadmin(callerId));
  }

  // ---- Infraestructura de notificaciones — sesión de sistema igual que el resto de
  // este archivo: las 4 funciones SQL son `security definer` con `p_staff_id`
  // explícito (nunca `auth.uid()`), mismo motivo que `isPlatformSuperadmin`. ----

  listNotificationsForStaff(staffId: string): Promise<readonly NotificationRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).listNotificationsForStaff(staffId));
  }

  countUnreadNotificationsForStaff(staffId: string): Promise<number> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).countUnreadNotificationsForStaff(staffId));
  }

  markNotificationRead(staffId: string, notificationId: string): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).markNotificationRead(staffId, notificationId));
  }

  markAllNotificationsRead(staffId: string): Promise<number> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).markAllNotificationsRead(staffId));
  }

  // ---- "Cerebro de ventas" — sesión de sistema igual que el resto de este archivo:
  // las 3 funciones SQL son `security definer` con `p_caller_id` explícito. ----

  listProspectosForSuperadmin(callerId: string): Promise<readonly ProspectoRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).listProspectosForSuperadmin(callerId));
  }

  createProspectoForSuperadmin(callerId: string, input: CreateProspectoInput): Promise<ProspectoRow> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).createProspectoForSuperadmin(callerId, input));
  }

  updateProspectoForSuperadmin(callerId: string, prospectoId: string, estado: string | null, notas: string | null): Promise<ProspectoRow> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).updateProspectoForSuperadmin(callerId, prospectoId, estado, notas));
  }

  // "Entrar a los otros paneles" — sesión de sistema igual que el resto de este
  // archivo: `core.ensure_demo_access_for_superadmin` es `security definer` con
  // `p_caller_id` explícito (ver migración 0014).
  ensureDemoAccessForSuperadmin(callerId: string, vertical: string): Promise<{ readonly organizationId: string; readonly slug: string }> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresCoreRepository(session).ensureDemoAccessForSuperadmin(callerId, vertical));
  }
}
