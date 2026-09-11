// ═══════════════════════════════════════════════════════════════════════════
// TIPOS COMPARTIDOS — packages/billing
//
// El motor no depende de Supabase, Stripe SDK ni de ningún vertical concreto:
// todo lo que necesita del mundo exterior entra por interfaces (Store, Lookup,
// Client) que cada app (hoteles, restaurantes, citas-reservaciones, ...)
// implementa contra su propia base. Así el mismo motor de billing sirve para
// los 6 verticales sin acoplarse a ninguno.
// ═══════════════════════════════════════════════════════════════════════════

/** Los dos rieles de cobro que soporta el motor. */
export type Riel = 'stripe' | 'transferencia';

/**
 * Un evento de proveedor de pagos ya verificado en firma (eso lo hace la app,
 * con su propio secreto de webhook) y normalizado a esta forma mínima antes
 * de entrar al motor.
 */
export interface EventoWebhook {
  /** Id del proveedor (p. ej. `evt_...` de Stripe). Es la llave de dedupe. */
  id: string;
  tipo: string;
  /** `created` del proveedor, en segundos Unix. Es lo único que ordena dos
   *  eventos de la MISMA entidad cuando el proveedor los reentrega fuera de
   *  orden (Stripe no promete orden de entrega). */
  creadoUnix: number;
  /** El tenant_id que trae el payload/metadata del evento. NUNCA se confía en
   *  este valor sin re-derivarlo — ver `tenant-verification.ts`. */
  tenantIdDelPayload: string | null;
  /** El customer id del proveedor de pagos asociado al evento. */
  proveedorCustomerId: string;
  /** El resto del payload, para que el llamador extraiga lo que necesite. */
  datos: Record<string, unknown>;
}

export interface DatosFiscalesReceptor {
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  codigoPostal: string;
  usoCfdi: string;
  email?: string | null;
}
