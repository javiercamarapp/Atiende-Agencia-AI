import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { validarPriceParaSeat, crearCheckoutPerSeat, verificarFirmaWebhookStripe, PriceStripeInvalido, type StripeClient } from '../src/index.ts';

describe('validarPriceParaSeat', () => {
  const base = { id: 'price_1', activo: true, recurrente: true, moneda: 'mxn', montoUnitarioCentavos: 59900 };

  it('acepta un price recurrente, activo, en MXN y > $0', () => {
    expect(() => validarPriceParaSeat(base)).not.toThrow();
  });
  it('rechaza un price de pago único', () => {
    expect(() => validarPriceParaSeat({ ...base, recurrente: false })).toThrow(PriceStripeInvalido);
  });
  it('rechaza un price archivado', () => {
    expect(() => validarPriceParaSeat({ ...base, activo: false })).toThrow(PriceStripeInvalido);
  });
  it('rechaza un price que no cobra en MXN', () => {
    expect(() => validarPriceParaSeat({ ...base, moneda: 'usd' })).toThrow(PriceStripeInvalido);
  });
  it('rechaza un price de $0', () => {
    expect(() => validarPriceParaSeat({ ...base, montoUnitarioCentavos: 0 })).toThrow(PriceStripeInvalido);
  });
});

describe('crearCheckoutPerSeat', () => {
  it('la metadata SIEMPRE lleva tenant_id y vertical (lo que tenant-verification exige re-derivar)', async () => {
    let metadataCapturada: Record<string, string> | undefined;
    const stripe: StripeClient = {
      async crearSesionCheckout(opts) {
        metadataCapturada = opts.metadata;
        return { url: 'https://checkout.stripe.com/x' };
      },
    };
    await crearCheckoutPerSeat(stripe, {
      tenantId: 't1', vertical: 'hoteles', priceId: 'price_1', cantidadSeats: 3,
      successUrl: 'https://app/x?ok', cancelUrl: 'https://app/x?cancel',
    });
    expect(metadataCapturada).toEqual({ tenant_id: 't1', vertical: 'hoteles' });
  });

  it('rechaza armar un checkout de 0 seats', async () => {
    const stripe: StripeClient = { async crearSesionCheckout() { return { url: 'x' }; } };
    await expect(
      crearCheckoutPerSeat(stripe, {
        tenantId: 't1', vertical: 'hoteles', priceId: 'price_1', cantidadSeats: 0,
        successUrl: 'x', cancelUrl: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('verificarFirmaWebhookStripe', () => {
  const secret = 'whsec_test_secreto';
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';

  function firmar(ts: number, body: string, withSecret = secret): string {
    const hmac = createHmac('sha256', withSecret).update(`${ts}.${body}`, 'utf8').digest('hex');
    return `t=${ts},v1=${hmac}`;
  }

  it('acepta una firma real dentro de la tolerancia de reloj', () => {
    const now = 1_700_000_000;
    const header = firmar(now, payload);
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: header, secret, nowUnix: now })).toBe(true);
  });

  it('acepta si CUALQUIERA de varios v1 (rotación de secreto) coincide', () => {
    const now = 1_700_000_000;
    const bueno = firmar(now, payload).split(',')[1];
    const header = `t=${now},v1=deadbeef00000000000000000000000000000000000000000000000000000000,${bueno}`;
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: header, secret, nowUnix: now })).toBe(true);
  });

  it('rechaza sin secreto configurado (webhook sin credenciales)', () => {
    const now = 1_700_000_000;
    const header = firmar(now, payload);
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: header, secret: null, nowUnix: now })).toBe(false);
  });

  it('rechaza sin header de firma', () => {
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: null, secret })).toBe(false);
  });

  it('rechaza una firma calculada con OTRO secreto (evento falsificado)', () => {
    const now = 1_700_000_000;
    const header = firmar(now, payload, 'whsec_otro_secreto_distinto');
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: header, secret, nowUnix: now })).toBe(false);
  });

  it('rechaza si el payload fue alterado después de firmarse', () => {
    const now = 1_700_000_000;
    const header = firmar(now, payload);
    expect(verificarFirmaWebhookStripe({ payload: payload.replace('evt_1', 'evt_2'), signatureHeader: header, secret, nowUnix: now })).toBe(false);
  });

  it('rechaza un timestamp fuera de la tolerancia (replay de un evento viejo)', () => {
    const now = 1_700_000_000;
    const viejo = now - 600; // 10 minutos, > default 300s
    const header = firmar(viejo, payload);
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: header, secret, nowUnix: now })).toBe(false);
  });

  it('rechaza un header mal formado (sin t= o sin v1=)', () => {
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: 'v1=abc', secret })).toBe(false);
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: 't=123', secret })).toBe(false);
    expect(verificarFirmaWebhookStripe({ payload, signatureHeader: 'basura-total', secret })).toBe(false);
  });
});
