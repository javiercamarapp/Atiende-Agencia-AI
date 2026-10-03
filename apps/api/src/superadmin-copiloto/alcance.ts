// Alcance del Copiloto de superadmin (CHAT-16). `PlatformScope` es un tipo SEPARADO de `DataChatScope` (el de las verticales, que siempre lleva
// una organizacion y las sucursales de una membership): aqui no hay organizacion, ni sucursales, ni membership; hay un superadmin de plataforma
// (completo o restringido a `finanzas`) y si verifico un step-up reciente. Lo construye SIEMPRE el servidor a partir de la sesion verificada
// (JWT + core.cfo_zone_resolve_role + header de step-up); ni el cuerpo de la peticion ni el modelo lo eligen o modifican.
import type { DataChatScope } from "@atiende/agent-core/data-chat";

/** Rol efectivo en la zona CFO (core.cfo_zone_resolve_role): `finanzas` = superadmin restringido, solo lectura y solo herramientas financieras. */
export type RolPlataforma = "superadmin" | "finanzas";

export interface PlatformScope {
  readonly userId: string;
  readonly rol: RolPlataforma;
  /** Hay un step-up (MFA reciente) valido, o la politica de step-up del superadmin no lo exige (sin factor activo y sin MFA obligatoria). */
  readonly stepUp: boolean;
  readonly timezone: string;
}

export const PLATAFORMA_TIMEZONE = "America/Mexico_City";

/** Etiqueta que el motor usa donde las verticales llevan el id de su organizacion (claves de limite de uso, bitacora). NO es un uuid y nunca llega a una
 *  columna uuid: la bitacora de plataforma (`PostgresPlataformaAuditSink`) la sustituye por NULL. */
export const PLATAFORMA_ORG_CLAVE = "plataforma";

/** Vertical de la bitacora y de las conversaciones del Copiloto de superadmin. */
export const PLATAFORMA_VERTICAL = "plataforma";

/** Proyeccion al alcance que entiende el motor compartido (`runDataChatTurn`): sin sucursales (`allowedPropertyIds: null`). */
export function alcanceDelMotor(scope: PlatformScope): DataChatScope {
  return {
    organizationId: PLATAFORMA_ORG_CLAVE,
    userId: scope.userId,
    vertical: PLATAFORMA_VERTICAL,
    verticalRole: scope.rol,
    allowedPropertyIds: null,
    timezone: scope.timezone,
  };
}
