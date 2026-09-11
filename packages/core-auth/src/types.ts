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
}

export interface CoreAuthHonoEnv {
  Variables: CoreAuthVariables;
}
