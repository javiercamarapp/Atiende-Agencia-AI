// Lógica de datos de la sincronización de calendario por iCal (Airbnb/Booking/Vrbo)
// -- cierra el hallazgo de auditoría "el backend de iCal-sync está completo (Fase 5:
// apps/api/src/routes/verticals/rentas/ical-sync.ts + ical-feed-publico.ts) pero
// apps/web no tiene ningún cliente ni pantalla que lo consuma": evitar doble reserva
// entre canales es la capacidad núcleo de un PMS de renta vacacional, y hasta este
// hallazgo un admin_gestora no tenía forma de conectar el feed externo de un canal
// ni de copiar la URL del feed de exportación propio -- solo podía hacerlo pegando
// curls a mano.
//
// Mismo patrón que calendario-client.ts/pricing-client.ts: separado de
// pages/IcalSync.tsx para poder probarlo con vitest en entorno "node", y reusa
// `fetchUnidades`/`UnidadOption` de calendario-client.ts y el catálogo
// `CANALES_CON_MARKUP` de pricing-client.ts (mismos 3 canales externos con feed real
// -- "manual" es reserva directa/bloqueo interno, nunca tiene feed iCal que
// conectar, mismo criterio que ya excluye "manual" de ese catálogo en pricing).
//
// Tres operaciones, calcadas 1:1 de los 3 endpoints de escritura/lectura de
// ical-sync.ts (Fase 5 del backend):
//  - fetchFeedsUnidad   -> GET  .../unidades/:unidadId/ical-sync            (lista, por unidad)
//  - conectarFeed       -> POST .../canales/:canalCodigo/ical-sync          (crear/reemplazar)
//  - desconectarFeed    -> DELETE .../canales/:canalCodigo/ical-sync
//
// `construirUrlFeedExportacion` NO es una llamada de red -- es la URL pública de
// exportación (ical-feed-publico.ts, SIN auth) que el admin_gestora copia y pega en
// el canal externo; se arma en el cliente porque es 100% determinística a partir de
// propertyId/unidadId/canalCodigo, ya conocidos por la UI (mismo criterio que
// "nunca inventar un endpoint nuevo solo para lo que ya se puede calcular").
import { fetchJson, sendJson, deleteJson } from "./admin-client.ts";
import { fetchUnidades } from "./calendario-client.ts";
import type { UnidadOption } from "./calendario-client.ts";
import { CANALES_CON_MARKUP } from "./pricing-client.ts";

export { fetchUnidades, CANALES_CON_MARKUP };
export type { UnidadOption };

/** Espejo web de `feedAJson()` en ical-sync.ts -- misma forma exacta que el JSON
 * que ya manda el servidor (snake_case en el wire, mapeado aquí a camelCase para
 * que el resto del cliente use la misma convención que el resto de este panel). */
export interface FeedIcalSync {
  readonly id: string;
  readonly canal: string;
  readonly urlImportacion: string;
  readonly activo: boolean;
  readonly ultimaSincronizacionExitosaEn: string | null;
  readonly enCuarentenaDesde: string | null;
  readonly intentosFallidosConsecutivos: number;
  readonly motivoCuarentena: string | null;
  readonly driftUltimaReconciliacionCompleta: number;
  /** Resumen JSON de la última corrida -- opaco a propósito, ver el comentario de
   * `ultimoResumen` en domain-rentas/src/sync/tipos.ts ("solo para observabilidad,
   * nunca leído por el propio motor"): la UI nunca depende de su forma interna. */
  readonly ultimoResumen: unknown;
}

interface FeedIcalSyncWire {
  readonly id: string;
  readonly canal: string;
  readonly url_importacion: string;
  readonly activo: boolean;
  readonly ultima_sincronizacion_exitosa_en: string | null;
  readonly en_cuarentena_desde: string | null;
  readonly intentos_fallidos_consecutivos: number;
  readonly motivo_cuarentena: string | null;
  readonly drift_ultima_reconciliacion_completa: number;
  readonly ultimo_resumen: unknown;
}

function mapFeed(wire: FeedIcalSyncWire): FeedIcalSync {
  return {
    id: wire.id,
    canal: wire.canal,
    urlImportacion: wire.url_importacion,
    activo: wire.activo,
    ultimaSincronizacionExitosaEn: wire.ultima_sincronizacion_exitosa_en,
    enCuarentenaDesde: wire.en_cuarentena_desde,
    intentosFallidosConsecutivos: wire.intentos_fallidos_consecutivos,
    motivoCuarentena: wire.motivo_cuarentena,
    driftUltimaReconciliacionCompleta: wire.drift_ultima_reconciliacion_completa,
    ultimoResumen: wire.ultimo_resumen,
  };
}

export async function fetchFeedsUnidad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
): Promise<readonly FeedIcalSync[]> {
  const body = await fetchJson<{ feeds: readonly FeedIcalSyncWire[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/ical-sync`, token);
  return body.feeds.map(mapFeed);
}

export interface ConectarFeedResultado {
  readonly id: string;
  readonly canal: string;
  readonly conectado: true;
}

export async function conectarFeed(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  canalCodigo: string,
  urlImportacion: string,
): Promise<ConectarFeedResultado> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/canales/${canalCodigo}/ical-sync`, token, "POST", { url: urlImportacion });
}

export interface DesconectarFeedResultado {
  readonly canal: string;
  readonly conectado: false;
}

export async function desconectarFeed(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  canalCodigo: string,
): Promise<DesconectarFeedResultado> {
  return deleteJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/canales/${canalCodigo}/ical-sync`, token);
}

/** URL pública (sin auth) que el canal externo debe "importar" para leer la
 * disponibilidad real de esta unidad -- ver ical-feed-publico.ts. Pura, sin red:
 * misma ruta exacta que esa ruta pública declara, calculada del lado del cliente. */
export function construirUrlFeedExportacion(apiBaseUrl: string, propertyId: string, unidadId: string, canalCodigo: string): string {
  return `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/canales/${canalCodigo}/feed.ics`;
}
