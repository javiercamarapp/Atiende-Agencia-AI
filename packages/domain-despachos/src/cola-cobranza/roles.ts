import type { DespachosRole } from "../roles.ts";

/** Ver la cola, las gestiones, el reporte de cartera y el estado de consentimientos/outbox (lectura). */
export const VER_COLA_COBRANZA_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Registrar/resolver gestiones, fijar consentimiento y encolar WhatsApp. Nunca `auditor`/`readonly`
 * (misma separacion de funciones que `GESTIONAR_COBRANZA_ROLES`; la migracion 017 la repite en SQL). */
export const GESTIONAR_COLA_COBRANZA_ROLES: readonly DespachosRole[] = ["admin", "contador"];
