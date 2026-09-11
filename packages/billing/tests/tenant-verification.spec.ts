import { describe, it, expect } from 'vitest';
import {
  verificarTenantDelWebhook,
  type TenantLookup,
  type CustomerLookup,
  type TenantConocido,
} from '../src/index.ts';

function tenants(mapa: Record<string, TenantConocido>): TenantLookup {
  return {
    async getTenantPorId(id) {
      return mapa[id] ?? null;
    },
  };
}

function customers(mapa: Record<string, string | null>): CustomerLookup {
  return {
    async getEmailDelCustomer(id) {
      return mapa[id] ?? null;
    },
  };
}

describe('verificarTenantDelWebhook — un tenant_id falseado en el payload se rechaza', () => {
  it('rechaza cuando el customer del evento NO es el customer registrado del tenant (metadata replay)', async () => {
    // El atacante controla el tenant 'atacante' y manda un webhook cuya
    // metadata dice tenant_id='victima' para adjudicarse su plan/pago.
    const lookup = tenants({
      victima: { tenantId: 'victima', proveedorCustomerId: 'cus_real_de_victima', ownerEmail: 'victima@ejemplo.com' },
    });
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 'victima',
      proveedorCustomerIdDelEvento: 'cus_del_atacante', // no coincide con el de archivo
      tenants: lookup,
      customers: customers({}),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('customer_no_coincide');
  });

  it('rechaza cuando el tenant_id del payload no corresponde a ningún tenant real', async () => {
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 'no-existe-123',
      proveedorCustomerIdDelEvento: 'cus_x',
      tenants: tenants({}),
      customers: customers({}),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('tenant_no_existe');
  });

  it('rechaza cuando falta el tenant_id en el payload', async () => {
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: null,
      proveedorCustomerIdDelEvento: 'cus_x',
      tenants: tenants({}),
      customers: customers({}),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('tenant_id_ausente');
  });

  it('primer checkout: rechaza cuando el email del customer no coincide con el owner del tenant', async () => {
    const lookup = tenants({
      victima: { tenantId: 'victima', proveedorCustomerId: null, ownerEmail: 'victima@ejemplo.com' },
    });
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 'victima',
      proveedorCustomerIdDelEvento: 'cus_del_atacante',
      tenants: lookup,
      customers: customers({ cus_del_atacante: 'atacante@otrodominio.com' }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.motivo).toBe('email_no_coincide');
  });

  it('acepta cuando el customer del evento SÍ es el registrado del tenant', async () => {
    const lookup = tenants({
      t1: { tenantId: 't1', proveedorCustomerId: 'cus_legitimo', ownerEmail: 'dueño@ejemplo.com' },
    });
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 't1',
      proveedorCustomerIdDelEvento: 'cus_legitimo',
      tenants: lookup,
      customers: customers({}),
    });
    expect(res.ok).toBe(true);
  });

  it('primer checkout legítimo: acepta cuando el email del customer SÍ coincide con el owner', async () => {
    const lookup = tenants({
      t1: { tenantId: 't1', proveedorCustomerId: null, ownerEmail: 'dueño@ejemplo.com' },
    });
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 't1',
      proveedorCustomerIdDelEvento: 'cus_nuevo',
      tenants: lookup,
      customers: customers({ cus_nuevo: 'Dueño@Ejemplo.com' }), // mayúsculas: debe normalizar
    });
    expect(res.ok).toBe(true);
  });

  it('no bloquea por un fallo de red al consultar el customer (solo bloquea ante mismatch positivo)', async () => {
    const lookup = tenants({
      t1: { tenantId: 't1', proveedorCustomerId: null, ownerEmail: 'dueño@ejemplo.com' },
    });
    const res = await verificarTenantDelWebhook({
      tenantIdDelPayload: 't1',
      proveedorCustomerIdDelEvento: 'cus_nuevo',
      tenants: lookup,
      customers: customers({}), // no se pudo leer el email -> null
    });
    expect(res.ok).toBe(true);
  });
});
