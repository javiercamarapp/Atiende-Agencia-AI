import { describe, it, expect } from 'vitest';
import { validarPriceParaSeat, crearCheckoutPerSeat, PriceStripeInvalido, type StripeClient } from '../src/index.ts';

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
