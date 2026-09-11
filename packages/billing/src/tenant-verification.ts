// ═══════════════════════════════════════════════════════════════════════════
// VERIFICACIÓN CROSS-TENANT DEL WEBHOOK — puerto del patrón real de
// atiende.ai (src/app/api/webhook/stripe/route.ts, bloque "Defense-in-depth
// contra metadata-replay cross-tenant").
//
// LA FIRMA DEL WEBHOOK NO BASTA. Verificar la firma HMAC del proveedor prueba
// que el EVENTO es real; no prueba que el `tenant_id` que alguien puso en la
// metadata del checkout sea el tenant correcto. Ese `tenant_id` lo escribe la
// APP al crear la sesión de checkout, y cualquiera que pueda iniciar un
// checkout (un usuario de OTRO tenant, o alguien manipulando el request antes
// de que llegue a Stripe) puede poner ahí el tenant_id de un tercero. Si el
// handler del webhook confía en ese campo a ciegas, un atacante puede:
//   (a) asignarle SU customer de Stripe (y su suscripción/plan pagado) a un
//       tenant ajeno, o
//   (b) mandar eventos con metadata replay para escalar el plan de un tenant
//       que no controla.
//
// DOS CASOS, DOS CHEQUES:
//
//   1. El tenant YA tiene un customer de Stripe en archivo → el customer del
//      EVENTO debe coincidir con el customer YA GUARDADO. Si difieren, es
//      replay: se rechaza.
//   2. Primer checkout (el tenant aún no tiene customer) → no hay nada
//      guardado contra qué comparar. Se cruza el EMAIL del customer de
//      Stripe contra el owner_email del tenant. Sin este segundo cheque, el
//      primer checkout de CUALQUIER tenant confiaría ciegamente en la
//      metadata — que es exactamente el caso (a) de arriba.
//
// En error de red al consultar el customer, NO se bloquea (el evento ya trae
// firma válida de Stripe); solo se bloquea ante un MISMATCH POSITIVO.
// ═══════════════════════════════════════════════════════════════════════════

export interface TenantConocido {
  tenantId: string;
  /** `null`/ausente = el tenant aún no tiene customer asignado (primer
   *  checkout todavía no ha llegado). */
  proveedorCustomerId: string | null;
  ownerEmail: string | null;
}

export interface TenantLookup {
  getTenantPorId(tenantId: string): Promise<TenantConocido | null>;
}

export interface CustomerLookup {
  /** El email que el proveedor de pagos tiene registrado para ese customer,
   *  o `null` si no se pudo leer (no bloquea: ver nota arriba). */
  getEmailDelCustomer(customerId: string): Promise<string | null>;
}

export type MotivoRechazo =
  | 'tenant_id_ausente'
  | 'tenant_no_existe'
  | 'customer_no_coincide'
  | 'email_no_coincide';

export type ResultadoVerificacion =
  | { ok: true }
  | { ok: false; motivo: MotivoRechazo; detalle: string };

/**
 * Verifica que el `tenant_id` que trae el payload del webhook sea de verdad
 * el dueño del customer del evento — RE-DERIVANDO la relación en vez de
 * confiar en lo que el payload afirma.
 */
export async function verificarTenantDelWebhook(opts: {
  tenantIdDelPayload: string | null;
  proveedorCustomerIdDelEvento: string;
  tenants: TenantLookup;
  customers: CustomerLookup;
}): Promise<ResultadoVerificacion> {
  const { tenantIdDelPayload, proveedorCustomerIdDelEvento, tenants, customers } = opts;

  if (!tenantIdDelPayload) {
    return {
      ok: false,
      motivo: 'tenant_id_ausente',
      detalle: 'El evento no trae tenant_id en su metadata; no hay a quién aplicarlo.',
    };
  }

  const tenant = await tenants.getTenantPorId(tenantIdDelPayload);
  if (!tenant) {
    return {
      ok: false,
      motivo: 'tenant_no_existe',
      detalle: `El tenant_id '${tenantIdDelPayload}' de la metadata no corresponde a ningún tenant real.`,
    };
  }

  // Caso 1: ya hay un customer guardado para este tenant — DEBE coincidir.
  if (tenant.proveedorCustomerId) {
    if (tenant.proveedorCustomerId !== proveedorCustomerIdDelEvento) {
      return {
        ok: false,
        motivo: 'customer_no_coincide',
        detalle:
          `El customer del evento (${proveedorCustomerIdDelEvento}) no es el customer registrado para el tenant ` +
          `'${tenantIdDelPayload}' (${tenant.proveedorCustomerId}). Metadata replay bloqueado.`,
      };
    }
    return { ok: true };
  }

  // Caso 2: primer checkout — cruzar por email del customer contra el owner.
  const emailCustomer = (await customers.getEmailDelCustomer(proveedorCustomerIdDelEvento))
    ?.toLowerCase().trim() ?? null;
  const emailTenant = tenant.ownerEmail?.toLowerCase().trim() ?? null;

  if (emailTenant && emailCustomer && emailTenant !== emailCustomer) {
    return {
      ok: false,
      motivo: 'email_no_coincide',
      detalle:
        `Primer checkout del tenant '${tenantIdDelPayload}': el email del customer de Stripe no coincide con el ` +
        'owner_email registrado. Alguien puso el tenant_id de otro tenant en la metadata del checkout.',
    };
  }

  // Sin datos suficientes para cruzar (falta uno de los dos emails, o falló
  // la consulta al proveedor): no se bloquea — el evento ya trae firma
  // válida y bloquear aquí dejaría fuera checkouts legítimos por un fallo de
  // red transitorio.
  return { ok: true };
}
