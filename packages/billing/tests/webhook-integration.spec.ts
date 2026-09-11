import { describe, it, expect } from 'vitest';
import {
  verificarTenantDelWebhook,
  type TenantLookup,
  type CustomerLookup,
  LedgerEnMemoria,
  aplicarConLedger,
  calcularPerSeat,
  SEAT_HOTELES,
  SEAT_CITAS_RESERVACIONES,
  type EventoWebhook,
} from '../src/index.ts';

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN: el flujo completo que un handler de webhook real ejecuta,
// combinando las tres piezas que el encargo pidió ejercer juntas:
//   1. verificación cross-tenant (nunca confiar en tenant_id del payload)
//   2. ledger anti-reordenamiento/anti-duplicado
//   3. cálculo per-seat aplicado al resultado, para 2 verticales distintas
// ═══════════════════════════════════════════════════════════════════════════

interface TenantDB {
  tenantId: string;
  proveedorCustomerId: string | null;
  ownerEmail: string | null;
  vertical: 'hoteles' | 'citas-reservaciones';
  seatsActivos: number;
  totalCobradoMxn: number;
}

function procesarWebhook(
  evento: EventoWebhook,
  db: Map<string, TenantDB>,
  ledger: LedgerEnMemoria,
  emailDelCustomerEnStripe: Record<string, string>,
) {
  const tenants: TenantLookup = {
    async getTenantPorId(id) {
      const t = db.get(id);
      if (!t) return null;
      return { tenantId: t.tenantId, proveedorCustomerId: t.proveedorCustomerId, ownerEmail: t.ownerEmail };
    },
  };
  const customers: CustomerLookup = {
    async getEmailDelCustomer(id) {
      return emailDelCustomerEnStripe[id] ?? null;
    },
  };

  return (async () => {
    const verificacion = await verificarTenantDelWebhook({
      tenantIdDelPayload: evento.tenantIdDelPayload,
      proveedorCustomerIdDelEvento: evento.proveedorCustomerId,
      tenants, customers,
    });
    if (!verificacion.ok) {
      return { procesado: false as const, motivo: verificacion.motivo };
    }

    const resultado = await aplicarConLedger(ledger, {
      eventId: evento.id,
      entidadId: evento.proveedorCustomerId, // la "entidad" para el orden es la suscripción/customer
      creadoUnix: evento.creadoUnix,
      aplicar: async () => {
        const t = db.get(evento.tenantIdDelPayload!)!;
        const config = t.vertical === 'hoteles' ? SEAT_HOTELES : SEAT_CITAS_RESERVACIONES;
        const calculo = calcularPerSeat(config, t.seatsActivos);
        t.totalCobradoMxn += calculo.totalMxn;
        return calculo;
      },
    });

    return { procesado: true as const, resultado };
  })();
}

describe('flujo de webhook end-to-end: verificación + ledger + per-seat', () => {
  it('un webhook con tenant_id falseado se rechaza y NUNCA llega a cobrar', async () => {
    const db = new Map<string, TenantDB>([
      ['victima', {
        tenantId: 'victima', proveedorCustomerId: 'cus_real', ownerEmail: 'v@ejemplo.com',
        vertical: 'hoteles', seatsActivos: 20, totalCobradoMxn: 0,
      }],
    ]);
    const ledger = new LedgerEnMemoria();

    const eventoFalseado: EventoWebhook = {
      id: 'evt_ataque', tipo: 'invoice.paid', creadoUnix: 1000,
      tenantIdDelPayload: 'victima', // el atacante pone el tenant de la víctima...
      proveedorCustomerId: 'cus_del_atacante', // ...pero el customer del evento es el suyo.
      datos: {},
    };

    const r = await procesarWebhook(eventoFalseado, db, ledger, {});
    expect(r.procesado).toBe(false);
    if (!r.procesado) expect(r.motivo).toBe('customer_no_coincide');
    expect(db.get('victima')!.totalCobradoMxn).toBe(0); // no se cobró nada
  });

  it('el ledger nunca permite un cobro duplicado por reordenamiento: cancelación + reintento viejo', async () => {
    const db = new Map<string, TenantDB>([
      ['t1', {
        tenantId: 't1', proveedorCustomerId: 'cus_1', ownerEmail: 'a@ejemplo.com',
        vertical: 'citas-reservaciones', seatsActivos: 3, totalCobradoMxn: 0,
      }],
    ]);
    const ledger = new LedgerEnMemoria();

    const cobroHoy: EventoWebhook = {
      id: 'evt_hoy', tipo: 'invoice.paid', creadoUnix: 2_000_000,
      tenantIdDelPayload: 't1', proveedorCustomerId: 'cus_1', datos: {},
    };
    const r1 = await procesarWebhook(cobroHoy, db, ledger, {});
    expect(r1.procesado).toBe(true);
    expect(db.get('t1')!.totalCobradoMxn).toBe(3 * 599);

    // Reintento del proveedor con un evento MÁS VIEJO para la misma entidad
    // (cus_1): no debe volver a cobrar.
    const reintentoViejo: EventoWebhook = {
      id: 'evt_reintento_viejo', tipo: 'invoice.paid', creadoUnix: 1_000_000,
      tenantIdDelPayload: 't1', proveedorCustomerId: 'cus_1', datos: {},
    };
    const r2 = await procesarWebhook(reintentoViejo, db, ledger, {});
    expect(r2.procesado).toBe(true);
    if (r2.procesado) expect(r2.resultado.estado).toBe('fuera_de_orden');
    expect(db.get('t1')!.totalCobradoMxn).toBe(3 * 599); // SIGUE IGUAL: no se duplicó

    // Reintento del MISMO evento de hoy (retry at-least-once del proveedor).
    const r3 = await procesarWebhook(cobroHoy, db, ledger, {});
    if (r3.procesado) expect(r3.resultado.estado).toBe('duplicado');
    expect(db.get('t1')!.totalCobradoMxn).toBe(3 * 599); // SIGUE IGUAL
  });

  it('el cálculo per-seat funciona igual de bien para 2 verticales distintos en el mismo flujo', async () => {
    const db = new Map<string, TenantDB>([
      ['hotel-1', {
        tenantId: 'hotel-1', proveedorCustomerId: 'cus_hotel', ownerEmail: 'h@ejemplo.com',
        vertical: 'hoteles', seatsActivos: 15, totalCobradoMxn: 0,
      }],
      ['clinica-1', {
        tenantId: 'clinica-1', proveedorCustomerId: 'cus_clinica', ownerEmail: 'c@ejemplo.com',
        vertical: 'citas-reservaciones', seatsActivos: 6, totalCobradoMxn: 0,
      }],
    ]);
    const ledger = new LedgerEnMemoria();

    await procesarWebhook(
      { id: 'evt_h', tipo: 'invoice.paid', creadoUnix: 1, tenantIdDelPayload: 'hotel-1', proveedorCustomerId: 'cus_hotel', datos: {} },
      db, ledger, {},
    );
    await procesarWebhook(
      { id: 'evt_c', tipo: 'invoice.paid', creadoUnix: 1, tenantIdDelPayload: 'clinica-1', proveedorCustomerId: 'cus_clinica', datos: {} },
      db, ledger, {},
    );

    // hoteles: 15 seats - 5 incluidas = 10 facturables * $89
    expect(db.get('hotel-1')!.totalCobradoMxn).toBe(10 * 89);
    // citas-reservaciones: 6 seats, sin incluidas * $599
    expect(db.get('clinica-1')!.totalCobradoMxn).toBe(6 * 599);
  });
});
