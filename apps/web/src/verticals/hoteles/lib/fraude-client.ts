// Lógica de datos de la cola de fraude interno (Fase 7) — consume
// apps/api/src/routes/verticals/hoteles/fraude.ts (H16-014/REQ-REC-014). Escaneo
// determinista (nunca LLM) de los 2 patrones portados + resolución humana
// (confirmar/descartar) de la cola de alertas.
import { fetchJson, sendJson } from "./admin-client.ts";

export type FraudAlertStatus = "pendiente" | "confirmado" | "descartado";

export const FRAUD_ALERT_STATUS_LABELS: Record<FraudAlertStatus, string> = {
  pendiente: "Pendiente",
  confirmado: "Confirmado",
  descartado: "Descartado",
};

export interface FraudAlertSummary {
  readonly id: string;
  readonly patron: string;
  readonly folioId: string;
  readonly cargoId: string | null;
  readonly pagoId: string | null;
  readonly razon: string;
  readonly evidencia: Readonly<Record<string, unknown>>;
  readonly rolesDestinatario: readonly string[];
  readonly estado: FraudAlertStatus;
  readonly notaDecision: string | null;
  readonly resueltoPor: string | null;
  readonly resueltoEn: string | null;
  readonly creadoEn: string;
}

export async function fetchFraudAlerts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado?: FraudAlertStatus): Promise<readonly FraudAlertSummary[]> {
  const qs = estado ? `?estado=${estado}` : "";
  return fetchJson<readonly FraudAlertSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/fraude/alertas${qs}`, token);
}

export interface FraudScanResult {
  readonly alertas: readonly (FraudAlertSummary & { esNueva: boolean })[];
  readonly generadas: number;
  readonly yaExistentes: number;
}

export async function runFraudScan(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<FraudScanResult> {
  return sendJson<FraudScanResult>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/fraude/escaneos`, token, "POST", {});
}

export async function resolveFraudAlert(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alertId: string, decision: "confirmar" | "descartar", nota?: string): Promise<FraudAlertSummary> {
  return sendJson<FraudAlertSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/fraude/alertas/${alertId}/${decision}`, token, "POST", { nota });
}
