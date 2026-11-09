// Integración folio -> puerto real de cobro (Stripe PaymentIntents) con `fetch` inyectado:
// la ruta HTTP de pagos recibe `monto` en PESOS (2 decimales, mismo número que se guarda en
// `hoteles.payment.amount numeric(12,2)`), y Stripe cobra en CENTAVOS. Estas pruebas cruzan
// la frontera completa (ruta -> StripeHotelesPaymentsPort -> cuerpo del POST a Stripe) para que
// una confusión de unidades no pueda esconderse detrás de un doble en memoria.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { StripeHotelesPaymentsPort } from "../src/production/hoteles-payments-port.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

interface CapturedCall {
  readonly url: string;
  readonly body: URLSearchParams;
}

function fakeStripe(response: { id: string; status: string }) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, port: new StripeHotelesPaymentsPort(fetchImpl, { secretKey: "sk_test_fake" }) };
}

describe("POST /hoteles/:propertyId/folios/:folioId/pagos (tarjeta) -> Stripe: unidades del monto", () => {
  it("un pago de $1,500.50 pesos se cobra como 150050 centavos y se registra como 1500.50", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const stripe = fakeStripe({ id: "pi_decimal", status: "succeeded" });
    const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });

    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
      authedJson(ctx.staff.owner.token, { monto: 1500.5, metodo: "tarjeta", tokenPago: "pm_decimal" }, { "idempotency-key": "k-decimal" }),
    );

    expect(res.status).toBe(201);
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]!.url).toBe("https://api.stripe.com/v1/payment_intents");
    // Antes del arreglo: "1501" (= $15.01) mientras el folio registraba $1,500.50 como pagados.
    expect(stripe.calls[0]!.body.get("amount")).toBe("150050");
    const payments = (await ctx.hotelesRepo.findFolio(ctx.propertyId, ctx.folioId))!.payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe(1500.5);
    expect(payments[0]!.status).toBe("capturado");
  });

  it("montos con error de punto flotante (0.1 + 0.2 pesos, 19.99) se convierten al centavo exacto", async () => {
    for (const [monto, esperado, key] of [
      [0.1 + 0.2, "30", "k-float-1"],
      [19.99, "1999", "k-float-2"],
      [1234567.89, "123456789", "k-float-3"],
    ] as const) {
      const ctx = await buildHotelesTestContext(buildApp);
      const stripe = fakeStripe({ id: `pi_${key}`, status: "succeeded" });
      const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });
      const res = await app.request(
        `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
        authedJson(ctx.staff.owner.token, { monto, metodo: "tarjeta", tokenPago: "pm_float" }, { "idempotency-key": key }),
      );
      expect(res.status).toBe(201);
      expect(stripe.calls[0]!.body.get("amount")).toBe(esperado);
    }
  });

  it("un monto con más de 2 decimales se rechaza con 400 ANTES de llamar a Stripe (nunca se redondea en silencio)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const stripe = fakeStripe({ id: "pi_nunca", status: "succeeded" });
    const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
      authedJson(ctx.staff.owner.token, { monto: 10.005, metodo: "tarjeta", tokenPago: "pm_tres_decimales" }, { "idempotency-key": "k-3dec" }),
    );
    expect(res.status).toBe(400);
    expect(stripe.calls).toHaveLength(0);
    expect((await ctx.hotelesRepo.findFolio(ctx.propertyId, ctx.folioId))!.payments).toHaveLength(0);
  });
});

describe("POST .../pagos (tarjeta): PaymentIntent pendiente (3DS / requires_action / processing)", () => {
  for (const stripeStatus of ["requires_action", "processing"] as const) {
    it(`'${stripeStatus}' responde 202 (aceptado, no cobrado), queda 'pendiente' y NO baja el saldo`, async () => {
      const ctx = await buildHotelesTestContext(buildApp);
      const stripe = fakeStripe({ id: `pi_${stripeStatus}`, status: stripeStatus });
      const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });

      const cargo = await app.request(
        `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
        authedJson(ctx.staff.owner.token, { descripcion: "Propina", monto: 500, concepto: "propina" }, { "idempotency-key": `k-cargo-${stripeStatus}` }),
      );
      expect(cargo.status).toBe(201);
      const saldoAntes = ((await (await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}`, authedJson(ctx.staff.owner.token))).json()) as { saldo: number }).saldo;

      const res = await app.request(
        `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
        authedJson(ctx.staff.owner.token, { monto: saldoAntes, metodo: "tarjeta", tokenPago: "pm_3ds" }, { "idempotency-key": `k-pend-${stripeStatus}` }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { estado: string; requiereAccion: boolean; referenciaExterna: string | null };
      expect(body.estado).toBe("pendiente");
      expect(body.requiereAccion).toBe(true);
      expect(body.referenciaExterna).toBe(`pi_${stripeStatus}`);

      const folio = (await (await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}`, authedJson(ctx.staff.owner.token))).json()) as {
        saldo: number;
        pagos: { estado: string }[];
      };
      expect(folio.pagos.map((p) => p.estado)).toEqual(["pendiente"]);
      expect(folio.saldo).toBe(saldoAntes);

      // Con el saldo intacto, el folio NO puede cerrarse como saldo_cero apoyado en un cobro sin confirmar.
      const cierre = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cerrar`, authedJson(ctx.staff.owner.token, { motivo: "saldo_cero" }));
      expect(cierre.status).toBe(409);
    });
  }

  it("el reintento con la misma Idempotency-Key devuelve el MISMO 202 pendiente sin volver a llamar a Stripe", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const stripe = fakeStripe({ id: "pi_retry", status: "requires_action" });
    const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });
    const req = () =>
      app.request(
        `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
        authedJson(ctx.staff.owner.token, { monto: 100, metodo: "tarjeta", tokenPago: "pm_retry" }, { "idempotency-key": "k-pend-retry" }),
      );
    const first = await req();
    const second = await req();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(stripe.calls).toHaveLength(1);
  });

  it("un cobro 'succeeded' sigue respondiendo 201 con requiereAccion=false", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const stripe = fakeStripe({ id: "pi_ok", status: "succeeded" });
    const app = buildApp({ ...ctx.deps, hotelesPaymentsPort: stripe.port });
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/pagos`,
      authedJson(ctx.staff.owner.token, { monto: 100, metodo: "tarjeta", tokenPago: "pm_ok" }, { "idempotency-key": "k-ok" }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { estado: string; requiereAccion: boolean }).requiereAccion).toBe(false);
  });
});
