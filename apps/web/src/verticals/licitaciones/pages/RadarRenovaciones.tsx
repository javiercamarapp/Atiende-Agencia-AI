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
//
// Fase "sistema de diseño real" (contenido) — la tabla inline-styled pasa a
// `Table`, los pills de urgencia/estatus a `Badge`, el panel de escaneo a
// `Card` y los botones/inputs a `Button`/`Input`/`Label` de @atiende/ui. Mismo
// parseo de umbrales, mismos fetch, mismas ramas.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StatusTone } from "@atiende/ui";
import { RadarIcon } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer, StatusBadge, statusTone } from "@atiende/ui";
import { acknowledgeRenewalAlert, fetchRenewalAlerts, scanRenewalAlerts } from "../lib/renewal-radar-client.ts";
import { ALERTA_RENOVACION_TONES, URGENCIA_RENOVACION_TONES } from "../lib/status-tones.ts";
import type { RenewalAlertRecord, ScanRenewalAlertsResult } from "../lib/renewal-radar-client.ts";
import { fetchTendersByIds } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { hoyFechaSolo, parseFechaSolo } from "../../../lib/formato-fecha.ts";
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

/** Días restantes hasta `isoDate` (columna `date`, anclada a medianoche UTC de
 * ESE día -- ver `parseFechaSolo`) a partir de HOY -- solo para mostrar "faltan
 * N días" en la tabla; puramente informativo, el servidor ya decidió qué
 * alertas emitir, esto no vuelve a evaluar nada.
 *
 * Bug real (barrido del hallazgo de auditoría a4, mismo patrón exacto que
 * Dashboard.tsx/hoteles): `Date.UTC(today.getUTCFullYear(), ...)` ancla "hoy" a
 * la medianoche UTC del día UTC actual, no del día de calendario del negocio --
 * entre las 18:00 y las 23:59 hora de CDMX (00:00-05:59 UTC) el día UTC ya es
 * MAÑANA, así que esta cuenta salía UN DÍA MENOS de lo real ("faltan 29 días"
 * en vez de "faltan 30"). `hoyFechaSolo()`/`parseFechaSolo()`
 * (apps/web/src/lib/formato-fecha.ts) anclan el día de calendario CDMX a la
 * misma medianoche UTC que `isoDate`, para que la resta sea consistente. */
function daysUntil(isoDate: string): number {
  const todayCdmxMidnightUtc = parseFechaSolo(hoyFechaSolo()).getTime();
  const target = parseFechaSolo(isoDate).getTime();
  return Math.round((target - todayCdmxMidnightUtc) / (24 * 60 * 60 * 1000));
}

/** Espejo de `urgencyForLeadDays` (renewal-radar.ts) -- el umbral MÁS PEQUEÑO
 * entre los presentes en las alertas actuales es "urgente", el MÁS GRANDE es
 * "seguimiento", cualquier intermedio es "próxima". Duplicado aquí a
 * propósito (mismo criterio de aislamiento que el resto de lib/*-client.ts:
 * este panel no depende de @atiende/domain-licitaciones). */
function urgencyFor(leadDays: number, sortedDistinctLeadDays: readonly number[]): { label: string; tone: StatusTone } {
  const idx = sortedDistinctLeadDays.indexOf(leadDays);
  if (idx <= 0) return { label: "Urgente", tone: URGENCIA_RENOVACION_TONES.urgente };
  if (idx === sortedDistinctLeadDays.length - 1) return { label: "Seguimiento", tone: URGENCIA_RENOVACION_TONES.seguimiento };
  return { label: "Próxima", tone: URGENCIA_RENOVACION_TONES.proxima };
}

const STATUS_LABELS: Record<RenewalAlertRecord["status"], string> = { pendiente: "Pendiente", reconocida: "Reconocida" };

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
      const alertList = await fetchRenewalAlerts(fetch, apiBaseUrl, token, propertyId);
      setAlerts(alertList);
      // Solo las convocatorias de las alertas (por id), no "todas": el titulo y la entidad no se pierden al pasar de 50.
      const ids = alertList.map((a) => a.tenderId);
      setTenders(ids.length > 0 ? await fetchTendersByIds(fetch, apiBaseUrl, token, propertyId, ids).catch(() => []) : []);
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
    <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Radar de renovaciones</h1>
        <p className="mt-1 max-w-[720px] text-sm text-muted-foreground">
          Detecta contratos propios cerca de su fecha de fin para anticipar una renovación o una nueva licitación por la misma necesidad. Vista transversal de la organización, no de una sola
          convocatoria. Límite documentado: NO cruza convocatorias históricas de la misma entidad -- solo evalúa contratos que ya tienen fecha de fin registrada (ver Contrato.tsx).
        </p>
      </header>

      <Card className="max-w-xl">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">Escanear ahora</CardTitle>
            <CardDescription>Reescanear no duplica alertas ya emitidas para el mismo umbral.</CardDescription>
          </div>
          {canWrite && (
            <Button type="button" size="sm" onClick={() => void handleScan()} disabled={scanning}>
              <RadarIcon />
              {scanning ? "Escaneando…" : "Escanear renovaciones"}
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {canWrite && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="radar-umbrales">Umbrales de antelación en días (opcional)</Label>
              <Input id="radar-umbrales" value={thresholdsInput} onChange={(e) => setThresholdsInput(e.target.value)} placeholder={DEFAULT_LEAD_DAYS_LABEL} />
            </div>
          )}
          {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede correr el escaneo ni reconocer alertas -- solo consultarlas.</p>}
          {scanError && (
            <p role="alert" className="text-sm text-destructive">
              {scanError}
            </p>
          )}
          {lastScan && !scanError && (
            <p className="text-sm font-medium text-success">
              Último escaneo: {lastScan.evaluatedContracts} contrato(s) evaluado(s), {lastScan.alertsCreated} alerta(s) nueva(s).
            </p>
          )}
        </CardContent>
      </Card>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {ackError && (
        <p role="alert" className="text-sm text-destructive">
          {ackError}
        </p>
      )}

      {loading && !alerts && <EstadoCargando etiqueta="Cargando alertas de renovación…" />}

      {alerts && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox label={`Mostrar solo pendientes (${pendingCount})`} checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
            <span className="text-xs text-muted-foreground">{alerts.length} alerta(s) en total.</span>
          </div>

          {alerts.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna alerta emitida -- corre un escaneo para generarlas." />}

          {alerts.length > 0 && sorted.length === 0 && <EstadoVacio mensaje="No hay alertas pendientes." />}

          {sorted.length > 0 && (
            <DataTable
              etiqueta="Alertas de renovación"
              obtenerId={(alert) => alert.id}
              filas={sorted}
              paginacion={false}
              columnas={[
                {
                  id: "convocatoria",
                  encabezado: "Convocatoria",
                  principal: true,
                  celda: (alert) => {
                    const tender = tenderById.get(alert.tenderId);
                    return (
                      <>
                        {tender ? (
                          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tender.id}`} className="font-semibold text-foreground no-underline hover:underline">
                            {tender.title}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Convocatoria {alert.tenderId} (no encontrada)</span>
                        )}
                        <div className="text-xs font-normal text-muted-foreground">Contrato {alert.contractId}</div>
                      </>
                    );
                  },
                },
                { id: "entidad", encabezado: "Entidad", celda: (alert) => <span className="text-muted-foreground">{tenderById.get(alert.tenderId)?.contractingBody ?? "—"}</span> },
                {
                  id: "fin",
                  encabezado: "Fin de contrato previsto",
                  celda: (alert) => {
                    const remaining = daysUntil(alert.predictedDate);
                    return (
                      <span className="text-muted-foreground">
                        {formatDateOnly(alert.predictedDate)}
                        <div className={remaining < 0 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                          {remaining < 0 ? `Venció hace ${Math.abs(remaining)} día(s)` : `Faltan ${remaining} día(s)`}
                        </div>
                      </span>
                    );
                  },
                },
                {
                  id: "antelacion",
                  encabezado: "Antelación",
                  celda: (alert) => {
                    const urgency = urgencyFor(alert.leadDays, sortedDistinctLeadDays);
                    return (
                      <span className="inline-flex items-center gap-2">
                        <StatusBadge tone={urgency.tone}>{urgency.label}</StatusBadge>
                        <span className="text-xs text-muted-foreground">{alert.leadDays}d</span>
                      </span>
                    );
                  },
                },
                { id: "confianza", encabezado: "Confianza", celda: (alert) => <span className="tabular-nums text-muted-foreground">{Math.round(alert.confidence * 100)}%</span> },
                {
                  id: "estatus",
                  encabezado: "Estatus",
                  celda: (alert) => (
                    <>
                      <StatusBadge tone={statusTone(ALERTA_RENOVACION_TONES, alert.status)}>{STATUS_LABELS[alert.status]}</StatusBadge>
                      {alert.status === "reconocida" && alert.acknowledgedAt && <div className="mt-1 text-xs font-normal text-muted-foreground">{formatTimestamp(alert.acknowledgedAt)}</div>}
                    </>
                  ),
                },
                {
                  id: "acciones",
                  encabezado: <span className="sr-only">Acciones</span>,
                  etiqueta: "Acciones",
                  ocultarEnTarjeta: false,
                  celda: (alert) =>
                    alert.status === "pendiente" && canWrite ? (
                      <Button type="button" variant="outline" size="sm" className="whitespace-nowrap" onClick={() => void handleAcknowledge(alert.id)} disabled={acknowledgingId === alert.id}>
                        {acknowledgingId === alert.id ? "Reconociendo…" : "Reconocer"}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}
        </div>
      )}
    </PageContainer>
  );
}
