// Puerto de cobro con tarjeta — mismo contrato que `PaymentsPort` de
// `hoteles/apps/api/src/pms/` (`charge()` recibe un `paymentMethodToken` OPACO, nunca
// un PAN; ver diseño Fase 1 §4.1 punto 8: "revisar si packages/billing de fusión ya
// expone un PaymentsPort equivalente antes de duplicarlo").
//
// Verificado: `packages/billing` de atiende-fusion (CFDI, ledger, riel Stripe/
// transferencia, per-seat) resuelve la FACTURACIÓN DE ATIENDE A SUS CLIENTES
// (suscripción de la plataforma), un dominio distinto de "cobrar con tarjeta al
// HUÉSPED de un hotel por su folio" — no hay overlap real que reconciliar en Fase 1
// (la nota del diseño queda satisfecha: no se duplica nada, se documenta la
// diferencia). Este puerto es nuevo y propio de domain-hoteles porque ningún paquete
// de fusión expone hoy un gateway de cobro a huésped final.
export interface PaymentChargeInput {
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodToken: string;
  readonly idempotencyKey: string;
}

export interface PaymentChargeResult {
  readonly status: "capturado" | "pendiente" | "fallido";
  readonly externalPaymentId: string;
}

export interface PaymentsPort {
  charge(input: PaymentChargeInput): Promise<PaymentChargeResult>;
}

/** Adaptador de prueba/desarrollo: siempre "captura" el pago con un id determinista
 *  derivado de la idempotencyKey (nunca aleatorio, para que un test pueda reafirmar el
 *  mismo resultado dos veces). Fase 1 no integra un procesador real (Stripe/otro) —
 *  eso es una integración de infraestructura fuera del alcance de esta fase (ningún
 *  flujo de los 3 elegidos lo exige: los tests de folios usan efectivo/transferencia,
 *  el camino de tarjeta se ejerce contra este doble). */
export class InMemoryPaymentsPort implements PaymentsPort {
  async charge(input: PaymentChargeInput): Promise<PaymentChargeResult> {
    return { status: "capturado", externalPaymentId: `test_${input.idempotencyKey}` };
  }
}
