// Lógica de datos de Folios (Fase 7) — consume
// apps/api/src/routes/verticals/hoteles/folios.ts (H5). Mismo aislamiento que
// reservas-client.ts: `ChargeConcept` se redeclara en vez de importarse de
// @atiende/domain-hoteles (apps/web no depende de ningún paquete domain-*). Cubre el
// subconjunto de flujo diario de recepción/caja (cargo/descuento/reverso/pago/cierre)
// — transferir-entre-folios y split quedan fuera de esta fase (operaciones menos
// frecuentes, ver README del vertical para el detalle de qué queda pendiente).
import { fetchJson, sendJson } from "./admin-client.ts";

export type ChargeConcept = "hospedaje" | "ab" | "extras" | "ajuste" | "propina" | "otro" | "descuento" | "reverso";

export const CHARGE_CONCEPT_LABELS: Record<ChargeConcept, string> = {
  hospedaje: "Hospedaje",
  ab: "Alimentos y bebidas",
  extras: "Extras",
  ajuste: "Ajuste",
  propina: "Propina",
  otro: "Otro",
  descuento: "Descuento",
  reverso: "Reverso",
};

export interface ChargeSummary {
  readonly id: string;
  readonly concepto: ChargeConcept;
  readonly descripcion: string;
  readonly monto: number;
  readonly impuesto: number;
  readonly revertidoPor: string | null;
  readonly reversaDe: string | null;
  readonly transferidoDe: string | null;
  readonly creadoEn: string;
}

export interface PaymentSummary {
  readonly id: string;
  readonly monto: number;
  readonly metodo: "efectivo" | "transferencia" | "tarjeta";
  readonly estado: "capturado" | "pendiente" | "fallido";
  readonly referenciaExterna: string | null;
  readonly creadoEn: string;
}

export interface FolioSummary {
  readonly id: string;
  readonly estado: "abierto" | "cerrado";
  readonly reservationId: string;
  readonly etiqueta: string;
  readonly esPrincipal: boolean;
  readonly cerradoEn: string | null;
  readonly motivoCierre: "saldo_cero" | "cuenta_por_cobrar" | null;
  readonly cargos: readonly ChargeSummary[];
  readonly pagos: readonly PaymentSummary[];
  readonly saldo: number;
}

export async function fetchFoliosByReservation(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservationId: string): Promise<readonly FolioSummary[]> {
  return fetchJson<readonly FolioSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas/${reservationId}/folios`, token);
}

export async function fetchFolio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string): Promise<FolioSummary> {
  return fetchJson<FolioSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}`, token);
}

export interface AddChargeInput {
  readonly descripcion: string;
  readonly monto: number;
  readonly concepto: Exclude<ChargeConcept, "descuento" | "reverso">;
}

export async function addCharge(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, input: AddChargeInput, idempotencyKey: string): Promise<{ id: string; concepto: string; monto: number; impuesto: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cargos`, token, "POST", input, idempotencyKey);
}

export async function addDiscount(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, descripcion: string, monto: number, idempotencyKey: string): Promise<{ id: string; monto: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/descuentos`, token, "POST", { descripcion, monto }, idempotencyKey);
}

export async function reverseCharge(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, chargeId: string, motivo: string, idempotencyKey: string): Promise<{ id: string; reversaDe: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cargos/${chargeId}/reverso`, token, "POST", { motivo }, idempotencyKey);
}

export interface AddPaymentInput {
  readonly monto: number;
  readonly metodo: "efectivo" | "transferencia";
  readonly referenciaExterna?: string;
}

/** `tarjeta` queda fuera de este panel: exige `tokenPago` real de una pasarela
 * (nunca un número de tarjeta capturado a mano, ver folios.ts línea ~472) — sin un
 * proveedor de tokenización de tarjeta integrado en esta fase del panel web, ofrecer
 * el botón sería fingir una capacidad que no existe (ver instrucciones: nunca simular
 * lo que no está construido). `efectivo`/`transferencia` cubren el flujo real de caja
 * de recepción hoy. */
export async function addPayment(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, input: AddPaymentInput, idempotencyKey: string): Promise<{ id: string; monto: number; metodo: string; estado: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/pagos`, token, "POST", input, idempotencyKey);
}

export async function closeFolio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, motivo: "saldo_cero" | "cuenta_por_cobrar"): Promise<{ id: string; estado: string; motivoCierre: string; saldo: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cerrar`, token, "POST", { motivo });
}
