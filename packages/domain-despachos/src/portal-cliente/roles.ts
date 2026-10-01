import type { DespachosRole } from "../roles.ts";

/** Quien puede VER enlaces, documentos y mensajes del portal de un cliente (lectura de lo ya recibido). */
export const VER_PORTAL_CLIENTE_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quien puede crear/revocar enlaces, aceptar/rechazar documentos y responder mensajes. Nunca
 * `auditor`/`readonly` (mismo criterio de separacion de funciones que el resto de despachos). */
export const GESTIONAR_PORTAL_CLIENTE_ROLES: readonly DespachosRole[] = ["admin", "contador"];
