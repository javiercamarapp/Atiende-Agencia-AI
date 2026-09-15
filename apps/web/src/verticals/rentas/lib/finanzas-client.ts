// Cliente web de Finanzas (Fase 16) — cierra el hallazgo de auditoría ALTA
// "Finanzas (movimientos, owner statements, payouts/conciliación) sin UI para
// admin_gestora ni contador": los 3 grupos de endpoints ya montados y probados en
// apps/api (finanzas.ts, finanzas-statements.ts, finanzas-payouts.ts) no tenían
// ningún cliente web que los consumiera — el rol `contador` (FINANZAS_LECTURA_ROLES)
// no tenía una sola pantalla que ver. Mismo patrón exacto que pricing-client.ts:
// separado de pages/Finanzas.tsx para poder probarlo con vitest en entorno "node", y
// los tipos se REDECLARAN aquí (nunca importados de @atiende/domain-rentas — ver el
// comentario de cabecera de calendario-client.ts: apps/web no depende de ningún
// paquete domain-*).
//
// Límite real conocido, no un stub disfrazado (mismo criterio que el límite ya
// documentado en pricing-client.ts): ningún endpoint de rentas expone un GET que
// liste los propietarios (`owners`) de una property, ni un GET que liste los
// payouts ya importados de una property (confirmado leyendo completos
// finanzas-statements.ts/finanzas-payouts.ts/repository.ts — el único payout que se
// puede "ver" es uno cuyo id ya se conoce, típicamente porque se acaba de crear en
// esta misma sesión). pages/Finanzas.tsx compensa pidiendo el `ownerId`/`payoutId`
// como texto libre (igual que un id de Stripe/Airbnb que el staff copia de otro
// lugar) — agregar esos GET de catálogo es trabajo de backend fuera del alcance de
// este hallazgo (los "3 grupos de endpoints" son exactamente los que ya existen).
import { fetchJson, sendJson } from "./admin-client.ts";
import { fetchOcupaciones, fetchUnidades } from "./calendario-client.ts";
import type { OcupacionCalendario, RangoFechas, UnidadOption } from "./calendario-client.ts";
import { basisPointsAPorcentaje, centavosAPesos, pesosACentavos, porcentajeABasisPoints } from "./pricing-client.ts";

export { fetchOcupaciones, fetchUnidades, basisPointsAPorcentaje, centavosAPesos, pesosACentavos, porcentajeABasisPoints };
export type { OcupacionCalendario, RangoFechas, UnidadOption };

// ---------------------------------------------------------------------------
// Movimiento financiero por reserva (Flujo 3, Fase 1 backend) — POST/GET
// /rentas/:propertyId/reservas/:ocupacionId/movimiento.
// ---------------------------------------------------------------------------

export type BaseComisionGestor = "bruto" | "neto_de_canal";

export interface LineaGastoEntrada {
  readonly tipo: string;
  readonly descripcion?: string | null;
  readonly montoCentavos: number;
}

export interface LineaImpuestoEntrada {
  readonly tipo: string;
  readonly montoCentavos: number;
}

export interface MovimientoInput {
  readonly moneda: string;
  readonly montoBrutoCentavos: number;
  readonly comisionGestorBasisPoints: number;
  readonly comisionGestorBase: BaseComisionGestor;
  readonly gastos: readonly LineaGastoEntrada[];
  readonly impuestos: readonly LineaImpuestoEntrada[];
}

export interface MovimientoFinanciero {
  readonly moneda: string;
  readonly ingresoBrutoCentavos: number;
  readonly montoRecibidoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionCanalFuente: string;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

export interface MovimientoCreado extends MovimientoFinanciero {
  readonly id: string;
  readonly ocupacionId: string;
  readonly creadoEn: string;
}

export interface MovimientoDetalle extends MovimientoFinanciero {
  readonly ocupacionId: string;
}

export async function registrarMovimiento(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  ocupacionId: string,
  input: MovimientoInput,
): Promise<MovimientoCreado> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/reservas/${ocupacionId}/movimiento`, token, "POST", input);
}

export async function fetchMovimiento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ocupacionId: string): Promise<MovimientoDetalle> {
  return fetchJson<MovimientoDetalle>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/reservas/${ocupacionId}/movimiento`, token);
}

// ---------------------------------------------------------------------------
// Owner statements (Flujo 5, Fase 2 backend) —
// POST/GET /rentas/:propertyId/owners/:ownerId/statements,
// GET /rentas/:propertyId/statements/:id.
// ---------------------------------------------------------------------------

export type TipoLineaOwnerStatement = "ingreso" | "comision_canal" | "comision_gestor" | "gasto" | "impuesto";

export interface LineaOwnerStatement {
  readonly ocupacionId: string;
  readonly tipo: TipoLineaOwnerStatement;
  readonly descripcion: string;
  readonly montoCentavos: number;
}

export interface TotalesOwnerStatement {
  readonly ingresosBrutosCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

export interface GenerarStatementInput {
  readonly periodoInicio: string;
  readonly periodoFin: string;
  readonly motivoVersion?: string;
}

/** La ruta responde 200 (`creado: false`, idempotente — mismo contenido que la
 * última versión) o 201 (`creado: true`, versión nueva) — `totales`/`generadoEn`
 * solo vienen en el 201, ver finanzas-statements.ts. */
export interface StatementGenerado {
  readonly id: string;
  readonly version: number;
  readonly creado: boolean;
  readonly generadoEn?: string;
  readonly totales?: TotalesOwnerStatement;
}

export interface OwnerStatementSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly netoCentavos: number;
  readonly generadoEn: string;
}

export interface OwnerStatementDetalle extends OwnerStatementSummary {
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly motivoVersion: string | null;
}

export async function generarOwnerStatement(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  ownerId: string,
  input: GenerarStatementInput,
): Promise<StatementGenerado> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/owners/${ownerId}/statements`, token, "POST", input);
}

export async function fetchOwnerStatements(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ownerId: string): Promise<readonly OwnerStatementSummary[]> {
  const body = await fetchJson<{ ownerId: string; statements: readonly OwnerStatementSummary[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/owners/${ownerId}/statements`, token);
  return body.statements;
}

export async function fetchOwnerStatementDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, statementId: string): Promise<OwnerStatementDetalle> {
  return fetchJson<OwnerStatementDetalle>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/statements/${statementId}`, token);
}

// ---------------------------------------------------------------------------
// Invitación al portal de propietario (Fase 3 backend, UI de esta fase) --
// POST /rentas/:propertyId/owners/:ownerId/portal-invite (owner-portal-invite.ts).
// FINANZAS_LECTURA_ROLES ya la permite (mismo criterio que ver los owner statements de
// arriba) -- generar la invitación no es más sensible que ya poder leer sus statements.
// ---------------------------------------------------------------------------

export interface PortalInviteEmitida {
  readonly ownerId: string;
  readonly inviteToken: string;
  readonly expiresAt: string;
}

/** El envío por correo real queda fuera de fase (sin proveedor SMTP en el monorepo
 * todavía, ver el comentario de cabecera de owner-portal-invite.ts) -- el token se
 * devuelve UNA sola vez aquí, staff lo copia/pega en el mensaje que le mande al
 * propietario (nunca se puede recuperar de nuevo tras esta respuesta). */
export async function invitarPropietarioAlPortal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ownerId: string): Promise<PortalInviteEmitida> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/owners/${ownerId}/portal-invite`, token, "POST", {});
}

// ---------------------------------------------------------------------------
// Payout de canal + conciliación (Flujo 6, Fase 2 backend, alcance recortado) —
// POST /rentas/:propertyId/payouts, GET /rentas/:propertyId/payouts/:id.
// ---------------------------------------------------------------------------

export type EstadoConciliacion = "conciliado" | "pendiente" | "discrepancia";

/** Catálogo de canales — mismo enum fijo que TODOS_LOS_CANALES en pricing-client.ts
 * (`rentas.canal`, sembrado en la migración del schema, sin ningún GET que lo
 * liste). Redeclarado aquí porque un payout de "manual" (reserva directa) sí tiene
 * sentido conciliar (a diferencia de una regla de markup, donde "manual" se excluye
 * a propósito en pricing-client.ts). */
export const CANALES_PAYOUT: readonly { codigo: string; nombre: string }[] = [
  { codigo: "airbnb", nombre: "Airbnb" },
  { codigo: "vrbo", nombre: "Vrbo" },
  { codigo: "booking", nombre: "Booking.com" },
  { codigo: "manual", nombre: "Reserva directa / manual" },
];

export interface LineaPayoutEntrada {
  readonly referenciaExternaReserva: string | null;
  readonly montoCentavos: number;
}

export interface LineaConciliada {
  readonly ocupacionId: string | null;
  readonly referenciaExternaReserva: string | null;
  readonly montoCentavos: number;
  readonly montoEsperadoCentavos: number | null;
  readonly estado: EstadoConciliacion;
}

export interface ResumenConciliacion {
  readonly conciliadas: number;
  readonly pendientes: number;
  readonly discrepancias: number;
}

export interface ImportarPayoutInput {
  readonly canalCodigo: string;
  readonly moneda: string;
  readonly fechaPayout: string;
  readonly referenciaExterna?: string | null;
  readonly lineas: readonly LineaPayoutEntrada[];
}

export interface PayoutCreado {
  readonly id: string;
  readonly creadoEn: string;
  readonly canalCodigo: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly resumen: ResumenConciliacion;
  readonly lineas: readonly LineaConciliada[];
}

export interface PayoutDetalle {
  readonly id: string;
  readonly propertyId: string;
  readonly canalCodigo: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly referenciaExterna: string | null;
  readonly resumen: ResumenConciliacion;
  readonly lineas: readonly LineaConciliada[];
}

export async function importarPayout(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: ImportarPayoutInput): Promise<PayoutCreado> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/payouts`, token, "POST", input);
}

export async function fetchPayoutDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, payoutId: string): Promise<PayoutDetalle> {
  return fetchJson<PayoutDetalle>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/payouts/${payoutId}`, token);
}
