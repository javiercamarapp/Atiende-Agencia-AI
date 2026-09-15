// Radar de renovaciones (Fase 15, ÚLTIMA porción del hallazgo ALTA
// "Post-adjudicación completa (contratos, documentos, cobranza,
// inconformidades, autopsia, renovaciones) = 22 rutas sin UI") --
// renewalRadar.ts expone POST .../renewals/scan, GET .../renewals/alerts y
// POST .../renewals/alerts/:alertId/acknowledge; ninguno tenía cliente ni
// página todavía (ver lib/renewal-radar-client.ts).
//
// A diferencia del resto de post-adjudicación (Contrato.tsx,
// PostAdjudicacion.tsx), que cuelgan de UNA convocatoria concreta, el radar
// evalúa TODOS los contratos con `endDate` conocida de la organización de una
// sola vez -- por eso esta pantalla es una vista TRANSVERSAL en el nav
// lateral (mismo nivel que "Convocatorias"), no una pestaña dentro del
// detalle de una convocatoria. Enriquece cada alerta con el título/entidad de
// su convocatoria (GET .../tenders, ya cargado por ConvocatoriasPage) solo
// para mostrarlo -- la alerta persistida solo guarda `tenderId`.
//
// Deliberadamente FUERA de esta pieza (alcance de otro agente en paralelo,
// ver README de este vertical): la autopsia del fallo (`Autopsia.tsx`) --
// otro sub-módulo de post-adjudicación, sin relación con el radar salvo
// compartir la fase.
//
// LÍMITE DOCUMENTADO heredado de renewal-radar.ts (honesto, no oculto, se
// muestra también en la UI): el radar detecta a partir de la fecha de fin del
// CONTRATO PROPIO -- cruzar convocatorias históricas de la misma entidad para
// predecir una licitación futura SIN que exista todavía un contrato propio
// con fecha de fin no se construyó en esta fase.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { acknowledgeRenewalAlert, fetchRenewalAlerts, scanRenewalAlerts } from "../lib/renewal-radar-client.ts";
import type { RenewalAlertRecord, ScanRenewalAlertsResult } from "../lib/renewal-radar-client.ts";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Espejo EXACTO de WRITE_ROLES (domain-licitaciones/roles.ts) -- cosmético,
// oculta acciones que el servidor rechazaría igual (`assertVerticalRole(c,
// WRITE_ROLES)` en renewalRadar.ts para scan y acknowledge); el enforcement
// real es siempre server-side. Mismo set literal que Convocatorias.tsx /
// PostAdjudicacion.tsx.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const DEFAULT_LEAD_DAYS_LABEL = "90, 60, 30 (default del servidor)";

const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** `predictedDate` es "YYYY-MM-DD" (sin hora) -- se ancla a UTC al formatear,
 * mismo criterio que `daysBetween` (renewal-radar.ts), para nunca correr un
 * día por el offset local del navegador (REQ-LIC-001, honesto en fechas). */
function formatDateOnly(isoDate: string): string {
  return DATE_ONLY_FORMATTER.format(new Date(`${isoDate}T00:00:00Z`));
}

function formatTimestamp(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

/** Días restantes hasta `isoDate` (UTC) a partir de hoy -- solo para mostrar
 * "faltan N días" en la tabla; puramente informativo, el servidor ya decidió
 * qué alertas emitir, esto no vuelve a evaluar nada. */
function daysUntil(isoDate: string): number {
  const today = new Date();
  const todayUtcMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  return Math.round((target - todayUtcMidnight) / (24 * 60 * 60 * 1000));
}

/** Espejo de `urgencyForLeadDays` (renewal-radar.ts) -- el umbral MÁS PEQUEÑO
 * entre los presentes en las alertas actuales es "urgente", el MÁS GRANDE es
 * "seguimiento", cualquier intermedio es "próxima". Duplicado aquí a
 * propósito (mismo criterio de aislamiento que el resto de lib/*-client.ts:
 * este panel no depende de @atiende/domain-licitaciones). */
function urgencyFor(leadDays: number, sortedDistinctLeadDays: readonly number[]): { label: string; bg: string; fg: string } {
  const idx = sortedDistinctLeadDays.indexOf(leadDays);
  if (idx <= 0) return { label: "Urgente", bg: "#fee2e2", fg: "#991b1b" };
  if (idx === sortedDistinctLeadDays.length - 1) return { label: "Seguimiento", bg: "#dbeafe", fg: "#1e40af" };
  return { label: "Próxima", bg: "#fef9c3", fg: "#854d0e" };
}

const STATUS_LABELS: Record<RenewalAlertRecord["status"], string> = { pendiente: "Pendiente", reconocida: "Reconocida" };
const STATUS_COLORS: Record<RenewalAlertRecord["status"], { bg: string; fg: string }> = {
  pendiente: { bg: "#fef9c3", fg: "#854d0e" },
  reconocida: { bg: "#dcfce7", fg: "#166534" },
};

export function RadarRenovacionesPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const [alerts, setAlerts] = useState<readonly RenewalAlertRecord[] | null>(null);
  const [tenders, setTenders] = useState<readonly TenderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [thresholdsInput, setThresholdsInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<ScanRenewalAlertsResult | null>(null);

  const [onlyPending, setOnlyPending] = useState(true);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [alertList, tenderList] = await Promise.all([fetchRenewalAlerts(fetch, apiBaseUrl, token, propertyId), fetchTenders(fetch, apiBaseUrl, token, propertyId)]);
      setAlerts(alertList);
      setTenders(tenderList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las alertas de renovación.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (sin eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId]);

  const tenderById = new Map(tenders.map((t) => [t.id, t]));

  /** Parsea "90, 60, 30" -> [90, 60, 30]; vacío -> undefined (usa el default del servidor). Nunca inventa un umbral que el usuario no escribió. */
  function parseThresholds(): number[] | undefined {
    const trimmed = thresholdsInput.trim();
    if (trimmed.length === 0) return undefined;
    const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    const values = parts.map((p) => Number(p));
    if (values.length === 0 || values.some((v) => !Number.isInteger(v) || v <= 0)) {
      throw new Error('Umbrales inválidos -- se esperan enteros positivos separados por coma (p. ej. "90, 60, 30").');
    }
    return values;
  }

  async function handleScan() {
    setScanError(null);
    let leadDaysThresholds: number[] | undefined;
    try {
      leadDaysThresholds = parseThresholds();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Umbrales inválidos.");
      return;
    }
    setScanning(true);
    try {
      const result = await scanRenewalAlerts(fetch, apiBaseUrl, token, propertyId, leadDaysThresholds);
      setLastScan(result);
      await load();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "No se pudo correr el escaneo de renovaciones.");
    } finally {
      setScanning(false);
    }
  }

  async function handleAcknowledge(alertId: string) {
    setAckError(null);
    setAcknowledgingId(alertId);
    try {
      const updated = await acknowledgeRenewalAlert(fetch, apiBaseUrl, token, propertyId, alertId);
      setAlerts((prev) => (prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev));
    } catch (err) {
      setAckError(err instanceof Error ? err.message : "No se pudo reconocer la alerta.");
    } finally {
      setAcknowledgingId(null);
    }
  }

  const canWrite = WRITE_ROLES.has(role);
  const visible = (alerts ?? []).filter((a) => !onlyPending || a.status === "pendiente");
  const sorted = [...visible].sort((a, b) => new Date(`${a.predictedDate}T00:00:00Z`).getTime() - new Date(`${b.predictedDate}T00:00:00Z`).getTime());
  const sortedDistinctLeadDays = [...new Set((alerts ?? []).map((a) => a.leadDays))].sort((a, b) => a - b);
  const pendingCount = (alerts ?? []).filter((a) => a.status === "pendiente").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Radar de renovaciones</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0", maxWidth: 720 }}>
          Detecta contratos propios cerca de su fecha de fin para anticipar una renovación o una nueva licitación por la misma necesidad. Vista transversal de la organización, no de una sola
          convocatoria. Límite documentado: NO cruza convocatorias históricas de la misma entidad -- solo evalúa contratos que ya tienen fecha de fin registrada (ver Contrato.tsx).
        </p>
      </header>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Escanear ahora</p>
            <p style={{ fontSize: 12, color: "#9ca3af", margin: "2px 0 0" }}>Reescanear no duplica alertas ya emitidas para el mismo umbral.</p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => void handleScan()}
              disabled={scanning}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: scanning ? "default" : "pointer", fontSize: 13, whiteSpace: "nowrap" }}
            >
              {scanning ? "Escaneando…" : "Escanear renovaciones"}
            </button>
          )}
        </div>
        {canWrite && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Umbrales de antelación en días (opcional)
            <input value={thresholdsInput} onChange={(e) => setThresholdsInput(e.target.value)} placeholder={DEFAULT_LEAD_DAYS_LABEL} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
        )}
        {!canWrite && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede correr el escaneo ni reconocer alertas -- solo consultarlas.</p>}
        {scanError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {scanError}
          </p>
        )}
        {lastScan && !scanError && (
          <p style={{ fontSize: 13, color: "#166534", margin: 0 }}>
            Último escaneo: {lastScan.evaluatedContracts} contrato(s) evaluado(s), {lastScan.alertsCreated} alerta(s) nueva(s).
          </p>
        )}
      </section>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {ackError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {ackError}
        </p>
      )}

      {loading && !alerts && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {alerts && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              Mostrar solo pendientes ({pendingCount})
            </label>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>{alerts.length} alerta(s) en total.</span>
          </div>

          {alerts.length === 0 && <p style={{ color: "#6b7280" }}>Todavía no hay ninguna alerta emitida -- corre un escaneo para generarlas.</p>}

          {alerts.length > 0 && sorted.length === 0 && <p style={{ color: "#6b7280" }}>No hay alertas pendientes.</p>}

          {sorted.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>Convocatoria</th>
                    <th style={{ padding: "6px 8px" }}>Entidad</th>
                    <th style={{ padding: "6px 8px" }}>Fin de contrato previsto</th>
                    <th style={{ padding: "6px 8px" }}>Antelación</th>
                    <th style={{ padding: "6px 8px" }}>Confianza</th>
                    <th style={{ padding: "6px 8px" }}>Estatus</th>
                    <th style={{ padding: "6px 8px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((alert) => {
                    const tender = tenderById.get(alert.tenderId);
                    const urgency = urgencyFor(alert.leadDays, sortedDistinctLeadDays);
                    const remaining = daysUntil(alert.predictedDate);
                    const statusColors = STATUS_COLORS[alert.status];
                    return (
                      <tr key={alert.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "8px" }}>
                          {tender ? (
                            <Link to={`/licitaciones/${orgSlug}/convocatorias/${tender.id}`} style={{ color: "#111827", fontWeight: 600, textDecoration: "none" }}>
                              {tender.title}
                            </Link>
                          ) : (
                            <span style={{ color: "#9ca3af" }}>Convocatoria {alert.tenderId} (no encontrada)</span>
                          )}
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>Contrato {alert.contractId}</div>
                        </td>
                        <td style={{ padding: "8px", color: "#374151" }}>{tender?.contractingBody ?? "—"}</td>
                        <td style={{ padding: "8px", color: "#374151" }}>
                          {formatDateOnly(alert.predictedDate)}
                          <div style={{ fontSize: 11, color: remaining < 0 ? "#b91c1c" : "#9ca3af" }}>{remaining < 0 ? `Venció hace ${Math.abs(remaining)} día(s)` : `Faltan ${remaining} día(s)`}</div>
                        </td>
                        <td style={{ padding: "8px" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: urgency.bg, color: urgency.fg, whiteSpace: "nowrap" }}>{urgency.label}</span>
                            <span style={{ fontSize: 12, color: "#6b7280" }}>{alert.leadDays}d</span>
                          </span>
                        </td>
                        <td style={{ padding: "8px", color: "#374151" }}>{Math.round(alert.confidence * 100)}%</td>
                        <td style={{ padding: "8px" }}>
                          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: statusColors.bg, color: statusColors.fg, whiteSpace: "nowrap" }}>{STATUS_LABELS[alert.status]}</span>
                          {alert.status === "reconocida" && alert.acknowledgedAt && (
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{formatTimestamp(alert.acknowledgedAt)}</div>
                          )}
                        </td>
                        <td style={{ padding: "8px" }}>
                          {alert.status === "pendiente" && canWrite && (
                            <button
                              type="button"
                              onClick={() => void handleAcknowledge(alert.id)}
                              disabled={acknowledgingId === alert.id}
                              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#111827", cursor: acknowledgingId === alert.id ? "default" : "pointer", fontSize: 12, whiteSpace: "nowrap" }}
                            >
                              {acknowledgingId === alert.id ? "Reconociendo…" : "Reconocer"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
