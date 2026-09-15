// Pruebas del adaptador real de cobro con tarjeta (Stripe PaymentIntents) — mismo
// patrón que hoteles-email-dispatch.spec.ts/domain-hoteles/tests/email-dispatch.spec.ts:
// `fetchImpl` inyectado, nunca toca la red real, nunca un mock global.
import { describe, expect, it } from "vitest";
import { StripeHotelesPaymentsPort } from "../src/production/hoteles-payments-port.ts";
import type { PaymentChargeInput } from "@atiende/domain-hoteles";

function input(overrides: Partial<PaymentChargeInput> = {}): PaymentChargeInput {
  return { amount: 150000, currency: "MXN", paymentMethodToken: "pm_test_123", idempotencyKey: "folio-1/cargo-1", ...overrides };
}

describe("StripeHotelesPaymentsPort", () => {
  it("fail-closed: sin STRIPE_SECRET_KEY, SIEMPRE lanza (nunca finge un cobro)", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("no debería llegar aquí", { status: 200 });
    }) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: null });

    await expect(port.charge(input())).rejects.toThrow(/Stripe secret key unavailable/);
    expect(fetchCalled).toBe(false);
  });

  it("con key real, manda el PaymentIntent REAL a Stripe con Idempotency-Key estable, monto en centavos y moneda en minúsculas", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "pi_real_1", status: "succeeded" }), { status: 200 });
    }) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_real" });

    const result = await port.charge(input({ amount: 250000, currency: "MXN" }));

    expect(capturedUrl).toBe("https://api.stripe.com/v1/payment_intents");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_real");
    expect(headers["Idempotency-Key"]).toBe("folio-1/cargo-1");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(capturedInit!.body as string);
    expect(body.get("amount")).toBe("250000");
    expect(body.get("currency")).toBe("mxn");
    expect(body.get("payment_method")).toBe("pm_test_123");
    expect(body.get("confirm")).toBe("true");
    expect(result).toEqual({ status: "capturado", externalPaymentId: "pi_real_1" });
  });

  it("un PaymentIntent en 'requires_action' (3DS pendiente) es 'pendiente', nunca 'fallido' ni 'capturado'", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "pi_2", status: "requires_action" }), { status: 200 })) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_real" });
    const result = await port.charge(input());
    expect(result).toEqual({ status: "pendiente", externalPaymentId: "pi_2" });
  });

  it("un card_error (tarjeta rechazada) real de Stripe es 'fallido', NUNCA lanza -- es un desenlace de negocio, no una falla de integración", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." }, id: undefined }), { status: 402 })) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_real" });
    const result = await port.charge(input());
    expect(result.status).toBe("fallido");
  });

  it("un error que NO es card_error (401 por key inválida, 5xx, etc.) SÍ lanza -- eso es un fallo real de integración", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "Invalid API Key provided" } }), { status: 401 })) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_invalida" });
    await expect(port.charge(input())).rejects.toThrow(/Stripe respondió 401/);
  });

  it("valida el input antes de tocar la red -- amount<=0, currency/paymentMethodToken/idempotencyKey vacíos nunca llegan a Stripe", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const port = new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_real" });

    await expect(port.charge(input({ amount: 0 }))).rejects.toThrow(/amount/);
    await expect(port.charge(input({ currency: "" }))).rejects.toThrow(/currency/);
    await expect(port.charge(input({ paymentMethodToken: "" }))).rejects.toThrow(/paymentMethodToken/);
    await expect(port.charge(input({ idempotencyKey: "" }))).rejects.toThrow(/idempotencyKey/);
    expect(fetchCalled).toBe(false);
  });
});
