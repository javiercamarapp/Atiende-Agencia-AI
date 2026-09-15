// Cliente web del radar de renovaciones (Fase 15, última porción del hallazgo
// ALTA "Post-adjudicación completa (contratos, documentos, cobranza,
// inconformidades, autopsia, renovaciones) = 22 rutas sin UI") --
// renewalRadar.ts expone POST .../renewals/scan, GET .../renewals/alerts y
// POST .../renewals/alerts/:alertId/acknowledge; ninguno tenía cliente ni
// página todavía. A diferencia del resto de post-adjudicación
// (contract-client.ts, contract-billing-client.ts, inconformidad-client.ts),
// estas tres rutas NO cuelgan de una convocatoria concreta
// (`/licitaciones/:propertyId/tenders/:tenderId/...`) sino de la property
// completa (`/licitaciones/:propertyId/renewals/...`) -- el radar evalúa
// TODOS los contratos con `endDate` conocida de la organización de una sola
// vez, mismo criterio "transversal" que RadarRenovaciones.tsx aplica del lado
// de la UI (no es una pestaña de una convocatoria, es una vista aparte en el
// nav lateral).
//
// Mismo aislamiento que el resto de apps/web (ver cabecera de
// requirements-client.ts): no depende de `@atiende/domain-licitaciones`, todo
// lo que este cliente necesita del contrato de datos vive duplicado aquí
// (uniones de string LITERALES, mismo criterio que `go-no-go-client.ts` /
// `contract-client.ts`).
import { fetchJson, postJson } from "./admin-client.ts";

/** Espejo EXACTO de `RenewalAlertRecord` (domain-licitaciones/repository.ts). */
export interface RenewalAlertRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly tenderId: string;
  readonly predictedDate: string; // "YYYY-MM-DD" -- `ContractRecord.endDate` del contrato evaluado
  readonly leadDays: number;
  /** Confianza 0.5-1 -- más alta cuanto más cerca está el umbral cruzado de la fecha real de fin (ver renewal-radar.ts::computeRenewalAlertCandidates). */
  readonly confidence: number;
  readonly status: "pendiente" | "reconocida";
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly createdAt: string;
}

/** Espejo EXACTO de `ScanRenewalAlertsResult` (domain-licitaciones/repository.ts). */
export interface ScanRenewalAlertsResult {
  readonly evaluatedContracts: number;
  readonly alertsCreated: number;
  readonly alerts: readonly RenewalAlertRecord[];
}

/**
 * `POST .../licitaciones/:propertyId/renewals/scan` -- WRITE_ROLES en el
 * servidor. Evalúa TODOS los contratos con `endDate` conocida de la
 * organización y persiste una alerta nueva por cada (contrato, umbral) recién
 * cruzado -- idempotente, reescanear no duplica alertas ya emitidas para el
 * mismo umbral (`alertsCreated` puede ser 0 en un reescaneo dentro de la
 * misma ventana, eso es normal, no un error). `leadDaysThresholds` es
 * enteramente OPCIONAL -- se omite del body si no se pasa, y el servidor usa
 * su default (90/60/30 días, `DEFAULT_RENEWAL_LEAD_DAYS`).
 */
export async function scanRenewalAlerts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, leadDaysThresholds?: readonly number[]): Promise<ScanRenewalAlertsResult> {
  const payload = leadDaysThresholds === undefined ? {} : { leadDaysThresholds };
  return postJson<ScanRenewalAlertsResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/renewals/scan`, token, payload);
}

/**
 * `GET .../licitaciones/:propertyId/renewals/alerts` -- sin rol restringido
 * (lectura). Devuelve TODAS las alertas ya emitidas para la organización,
 * pendientes y reconocidas por igual -- el llamador filtra por `status` si
 * solo quiere ver las pendientes (ver `RadarRenovacionesPage`).
 */
export async function fetchRenewalAlerts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RenewalAlertRecord[]> {
  const body = await fetchJson<{ alerts: readonly RenewalAlertRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/renewals/alerts`, token);
  return body.alerts;
}

/**
 * `POST .../licitaciones/:propertyId/renewals/alerts/:alertId/acknowledge` --
 * WRITE_ROLES en el servidor. Marca la alerta como `"reconocida"` (queda
 * registrado quién y cuándo, `acknowledgedBy`/`acknowledgedAt`) -- no dispara
 * ningún envío externo (correo/WhatsApp), es puro registro consultable,
 * mismo criterio "honesto" que el resto del radar. 404 si la alerta no existe
 * (o pertenece a otra organización).
 */
export async function acknowledgeRenewalAlert(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alertId: string): Promise<RenewalAlertRecord> {
  return postJson<RenewalAlertRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/renewals/alerts/${alertId}/acknowledge`, token, {});
}
