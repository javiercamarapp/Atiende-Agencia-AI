import type { TenantDbSession, PlatformRole, Vertical } from "@atiende/core-tenancy";

/** Config mínima que `authMiddleware` necesita — el secreto HS256 con el que se
 * firmaron/verifican los access tokens. `apps/api` la construye desde variables de
 * entorno (mismo patrón que `apps/api/src/env.ts` en hoteles); este paquete no lee
 * `process.env` directamente, para quedar testeable sin variables globales. */
export interface CoreAuthEnv {
  readonly jwtSecret: string;
}

/** Variables que este paquete escribe en el contexto de Hono a lo largo de la cadena
 * de middlewares. Generaliza `HonoEnvBindings` de hoteles/apps/api/src/types.ts:
 * `hotelIds` -> `propertyIds`, se añade `vertical`, y `hotelRole` se separa en
 * `platformRole` (el techo común, ver core-tenancy) y `verticalRole` (opaco, string). */
export interface CoreAuthVariables {
  requestId: string;
  userId: string;
  userEmail: string;
  organizationId: string;
  vertical: Vertical;
  propertyIds: readonly string[] | null;
  db: TenantDbSession;
  /** Solo definido DESPUÉS de que `requirePropertyMembership` corrió sobre la ruta. */
  platformRole?: PlatformRole;
  verticalRole?: string;
  /**
   * Arreglo de fondo (auditoría a2, "el correo inline nunca sale de verdad
   * desde rutas de staff") — cola de tareas best-effort que `dbSession`
   * ejecuta DESPUÉS de que la transacción de este request haya hecho COMMIT
   * real (nunca si hubo rollback, ver comentario de cabecera de `dbSession`).
   * Un handler de ruta empuja aquí en vez de invocar directo cuando necesita
   * drenar un canal/outbox en sesión de SISTEMA tras confirmar -- p. ej. el
   * correo inline: intentarlo DENTRO de la transacción de staff siempre falla
   * el guard `auth.uid() is null` de `claim_email_outbox_batch` (ver
   * apps/api/.../email-dispatch.ts), así que el envío real solo puede pasar
   * después del commit, en una sesión nueva que sí vea el INSERT ya
   * confirmado. Poblado por `dbSession` (siempre `[]` al entrar al handler);
   * cada tarea corre en su propio try/catch, nunca relanza, nunca toca la
   * respuesta ya armada por el handler.
   */
  postCommitTasks: Array<() => Promise<void>>;
}

export interface CoreAuthHonoEnv {
  Variables: CoreAuthVariables;
}
