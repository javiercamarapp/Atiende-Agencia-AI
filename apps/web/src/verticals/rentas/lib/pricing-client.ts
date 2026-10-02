// Lógica de datos del cotizador + configuración de pricing (Fase 14) — cierra el
// hallazgo de auditoría "Cotizador y configuración de pricing (6 endpoints) sin UI":
// GET .../cotizacion (cotizaciones.ts, R2) y los 5 POST de configuración
// (pricing-config.ts, Fase 2) ya existían en el backend sin ningún cliente web que
// los consumiera. Mismo patrón que calendario-client.ts: separado de
// pages/Precios.tsx para poder probarlo con vitest en entorno "node", y reusa
// `RangoFechas`/`UnidadOption`/`fetchUnidades` de calendario-client.ts en vez de
// redeclararlos (misma forma exacta: rango semiabierto [inicio, fin) de fecha
// YYYY-MM-DD) -- ver su comentario de cabecera para por qué apps/web nunca importa
// tipos de @atiende/domain-rentas directamente.
//
// Rn-23: pricing-config.ts ahora expone GET .../configuracion-precios (lo ya guardado de la
// unidad) y PATCH/DELETE por id de temporada, descuento, min-stay y regla de canal; Precios.tsx
// muestra lo persistido, lo edita y lo borra (la tarifa base se versiona: se cambia con el POST
// y su historial no se borra).
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";
import { formatMoney } from "@atiende/ui";
import { fetchUnidades } from "./calendario-client.ts";
import type { RangoFechas, UnidadOption } from "./calendario-client.ts";

export { fetchUnidades };
export type { RangoFechas, UnidadOption };

/** Catálogo de canales de rentas — global, no tenant-scoped, y deliberadamente
 * pequeño y fijo (ver `rentas.canal` en
 * supabase/migrations/20240101000024_001_rentas_schema.sql: 4 filas sembradas ahí
 * mismo, sin ningún GET que las liste). Redeclarado aquí en vez de inventar un
 * endpoint de catálogo nuevo -- mismo criterio que RAZONES_BLOQUEO en
 * calendario-client.ts (enum fijo espejo del backend). "manual" es reserva
 * directa/bloqueo interno -- no tiene sentido configurarle un markup de canal, así
 * que no se ofrece en el selector de reglas-canal.
 */
export const CANALES_CON_MARKUP: readonly { codigo: string; nombre: string }[] = [
  { codigo: "airbnb", nombre: "Airbnb" },
  { codigo: "vrbo", nombre: "Vrbo" },
  { codigo: "booking", nombre: "Booking.com" },
];

export const TODOS_LOS_CANALES: readonly { codigo: string; nombre: string }[] = [...CANALES_CON_MARKUP, { codigo: "manual", nombre: "Reserva directa / manual" }];

export interface DesgloseNoche {
  readonly fecha: string;
  readonly precioCentavos: number;
  readonly origen: "base" | "temporada";
  readonly temporadaNombre?: string;
}

export interface DescuentoAplicado {
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
  readonly montoCentavos: number;
}

export interface ViolacionMinStay {
  readonly regla: { rango: RangoFechas; diaSemanaCheckIn: number | null; nochesMinimas: number };
  readonly nochesSolicitadas: number;
}

export interface ResultadoCotizacion {
  readonly unidadId: string;
  readonly moneda: string;
  readonly noches: number;
  readonly desgloseNoches: readonly DesgloseNoche[];
  readonly subtotalAntesDescuentoCentavos: number;
  readonly descuentoAplicado: DescuentoAplicado | null;
  readonly subtotalConDescuentoCentavos: number;
  readonly markupCanalCentavos: number;
  readonly totalCentavos: number;
  readonly violacionesMinStay: readonly ViolacionMinStay[];
}

export async function fetchCotizacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  rango: RangoFechas,
  canalCodigo?: string,
): Promise<ResultadoCotizacion> {
  const params = new URLSearchParams({ checkIn: rango.inicio, checkOut: rango.fin });
  if (canalCodigo) params.set("canal", canalCodigo);
  return fetchJson<ResultadoCotizacion>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/cotizacion?${params.toString()}`, token);
}

export interface TarifaBaseInput {
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde?: string;
}

export interface TarifaBaseCreada {
  readonly id: string;
  readonly unidadId: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string;
}

export async function crearTarifaBase(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: TarifaBaseInput,
): Promise<TarifaBaseCreada> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/tarifa-base`, token, "POST", input);
}

export interface TemporadaInput {
  readonly nombre: string;
  readonly rango: RangoFechas;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
}

export interface TemporadaCreada {
  readonly id: string;
  readonly unidadId: string;
  readonly nombre: string;
  readonly rango: RangoFechas;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
}

export async function crearTemporada(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: TemporadaInput,
): Promise<TemporadaCreada> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/temporadas`, token, "POST", input);
}

export interface DescuentoDuracionInput {
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
}

export interface DescuentoDuracionCreado {
  readonly id: string;
  readonly unidadId: string;
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
}

export async function crearDescuentoDuracion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: DescuentoDuracionInput,
): Promise<DescuentoDuracionCreado> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/descuentos-duracion`, token, "POST", input);
}

export interface MinStayInput {
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
  readonly nochesMinimas: number;
}

export interface MinStayCreada {
  readonly id: string;
  readonly unidadId: string;
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
  readonly nochesMinimas: number;
}

export async function crearReglaMinStay(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: MinStayInput,
): Promise<MinStayCreada> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/min-stay`, token, "POST", input);
}

export interface ReglaCanalInput {
  readonly canalCodigo: string;
  readonly markupBasisPoints: number;
  readonly activo: boolean;
}

export interface ReglaCanalCreada {
  readonly id: string;
  readonly unidadId: string;
  readonly canalCodigo: string;
  readonly markupBasisPoints: number;
  readonly activo: boolean;
}

export async function crearReglaCanal(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: ReglaCanalInput,
): Promise<ReglaCanalCreada> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/reglas-canal`, token, "POST", input);
}

// ---- Rn-23: lectura, edición y borrado ----

export interface TarifaBaseRegistro {
  readonly id: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string;
}
export interface TemporadaRegistro {
  readonly id: string;
  readonly nombre: string;
  readonly rango: RangoFechas;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
}
export interface DescuentoRegistro {
  readonly id: string;
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
}
export interface MinStayRegistro {
  readonly id: string;
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
  readonly nochesMinimas: number;
}
export interface ReglaCanalRegistro {
  readonly id: string;
  readonly canalCodigo: string;
  readonly markupBasisPoints: number;
  readonly activo: boolean;
}
export interface ConfiguracionPricing {
  readonly unidadId: string;
  readonly tarifaBaseVigente: TarifaBaseRegistro | null;
  readonly historialTarifaBase: readonly TarifaBaseRegistro[];
  readonly temporadas: readonly TemporadaRegistro[];
  readonly descuentosDuracion: readonly DescuentoRegistro[];
  readonly reglasMinStay: readonly MinStayRegistro[];
  readonly reglasCanal: readonly ReglaCanalRegistro[];
}

const rutaUnidad = (apiBaseUrl: string, propertyId: string, unidadId: string) => `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}`;

export async function fetchConfiguracionPricing(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string): Promise<ConfiguracionPricing> {
  return fetchJson<ConfiguracionPricing>(fetchImpl, `${rutaUnidad(apiBaseUrl, propertyId, unidadId)}/configuracion-precios`, token);
}

export type RecursoPricing = "temporadas" | "descuentos-duracion" | "min-stay" | "reglas-canal";

/** PATCH parcial: solo los campos enviados cambian. */
export async function editarConfiguracionPricing<T>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  recurso: RecursoPricing,
  id: string,
  cambios: object,
): Promise<T> {
  return sendJson<T>(fetchImpl, `${rutaUnidad(apiBaseUrl, propertyId, unidadId)}/${recurso}/${id}`, token, "PATCH", cambios);
}

export async function borrarConfiguracionPricing(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  recurso: RecursoPricing,
  id: string,
): Promise<void> {
  await deleteJson<unknown>(fetchImpl, `${rutaUnidad(apiBaseUrl, propertyId, unidadId)}/${recurso}/${id}`, token);
}

/** Dinero para pantalla: separador de miles del formateador único de @atiende/ui, sin sufijo
 * para MXN (moneda por defecto de la plataforma); otra moneda lleva su código. */
export function dineroDeCentavos(centavos: number, moneda: string): string {
  const monto = `$${formatMoney(centavos / 100, 2)}`;
  return moneda === "MXN" ? monto : `${monto} ${moneda}`;
}

/** `precioNocheCentavos`/`markupBasisPoints`/etc. son la unidad que el servidor
 * espera (centavos, basis points) -- estos helpers son SOLO para que la UI trabaje
 * en las unidades que un humano escribe (pesos con 2 decimales, porcentaje). Nunca
 * al revés: el servidor jamás recibe pesos ni porcentaje directo. */
export function pesosACentavos(pesos: number): number {
  return Math.round(pesos * 100);
}

export function centavosAPesos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

export function porcentajeABasisPoints(porcentaje: number): number {
  return Math.round(porcentaje * 100);
}

export function basisPointsAPorcentaje(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}
