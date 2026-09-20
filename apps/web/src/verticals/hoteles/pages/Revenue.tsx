// Revenue management (Fase 9, REQ-REV-003/004/005/007) — wiring del gate real
// shadow/propone/autopilot (`hoteles.revenue_engine_gate`, autoridad final en el
// trigger de Postgres) + historial de backtests walk-forward. GAP REAL de esta
// fase (ver README de la rama y `lib/revenue-client.ts`): no existe ningún motor
// que produzca "recomendaciones" de tarifa (pickup/compset/evento/tipo de cambio
// reales) ni una tabla que las almacene todavía -- esta pantalla nunca simula esa
// pieza. Lo que sí es real end-to-end: consultar/inicializar/transicionar el gate,
// otorgar/revocar la aprobación de "owner" que exige REQ-REV-003 antes de habilitar
// autopilot pleno, y registrar/ver el historial de backtests.
//
// Gate: REVENUE_GATE_MANAGE_ROLES (owner/gm) para transicionar el gate,
// REVENUE_AUTOPILOT_APPROVAL_ROLES (solo owner) para la aprobación de autopilot,
// REVENUE_BACKTEST_ROLES (owner/gm/accountant) para registrar un backtest -- mismo
// criterio "cosmético, nunca la única barrera" que el resto del panel (ver
// Fraude.tsx/Pl.tsx): un rol sin acceso que intente la acción ve el 403/409 real
// del servidor como mensaje de error.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  COUNTERFACTUAL_METHOD_LABELS,
  RATE_RECOMMENDATION_STATUS_LABELS,
  REVENUE_GATE_STATE_LABELS,
  approveRateRecommendation,
  createCompetitorRate,
  createLocalEvent,
  discardRateRecommendation,
  fetchPricingRule,
  fetchRateRecommendations,
  fetchRevenueBacktests,
  fetchRevenueGate,
  initRevenueGate,
  registerRevenueBacktest,
  savePricingRule,
  setRevenueGateOwnerApproval,
  transitionRevenueGate,
} from "../lib/revenue-client.ts";
import type { CounterfactualMethod, PricingRule, RateRecommendation, RevenueBacktestRun, RevenueGate, RevenueGateState } from "../lib/revenue-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const DOW_LABELS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** Extrae, de forma DEFENSIVA (el desglose es `Record<string, unknown>` real del
 *  servidor, ver RateRecommendationResult.desglose), un resumen legible por señal
 *  -- nunca oculta ni resume el JSON completo, que sigue disponible abajo en el
 *  `<details>` de cada fila ("nunca una caja negra"). */
function summarizeSignal(kind: string, value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  switch (kind) {
    case "pickup":
      if (v.hasSufficientHistory === false) return "Pickup: sin historia suficiente (sin señal)";
      return `Pickup: ${typeof v.onTheBooksVsExpectedPct === "number" ? v.onTheBooksVsExpectedPct.toFixed(1) : "?"}% vs. histórico (${String(v.basis ?? "")})`;
    case "evento":
      return `Evento: "${String(v.nombre ?? "")}" (${v.impacto === "baja_demanda" ? "baja" : "alza"} demanda, ${String(v.magnitudPct ?? "")}%, fuente: ${String(v.fuente ?? "")})`;
    case "compset":
      return `Compset: mediana de competidores ${String(v.medianaCompetidores ?? "")} (${(v.muestras as unknown[] | undefined)?.length ?? 0} captura(s))`;
    default:
      return null;
  }
}

function fmtMoney(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

const DEFAULT_EVALUATIONS_PLACEHOLDER = `[
  {"window":{"trainStart":"2026-01-01","trainEnd":"2026-01-10","testStart":"2026-01-11","testEnd":"2026-01-17"},"engineRevenue":10000,"baselineRevenue":9000},
  {"window":{"trainStart":"2026-01-08","trainEnd":"2026-01-17","testStart":"2026-01-18","testEnd":"2026-01-24"},"engineRevenue":11000,"baselineRevenue":9500}
]`;

export function RevenuePage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [gate, setGate] = useState<RevenueGate | null | undefined>(undefined);
  const [backtests, setBacktests] = useState<readonly RevenueBacktestRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAutopilot, setPendingAutopilot] = useState(false);

  const [method, setMethod] = useState<CounterfactualMethod>("misma_tarifa_periodo_anterior");
  const [evaluationsRaw, setEvaluationsRaw] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // ---- Fase 10 — motor de recomendaciones de tarifa v1. ----
  const [roomTypes, setRoomTypes] = useState<readonly RoomTypeOption[] | null>(null);
  const [recommendations, setRecommendations] = useState<readonly RateRecommendation[] | null>(null);
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string>("");
  const [pricingRule, setPricingRule] = useState<PricingRule | null>(null);
  const [pricingForm, setPricingForm] = useState<{ floorPrice: string; ceilingPrice: string; multipliers: string[]; minStayDefault: string; minStayOnHighDemand: string } | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [localEventForm, setLocalEventForm] = useState({ nombre: "", fechaInicio: "", fechaFin: "", impacto: "alza_demanda" as "alza_demanda" | "baja_demanda", magnitudPct: "20" });
  const [competitorForm, setCompetitorForm] = useState({ competidor: "", fecha: "", tarifa: "" });
  const [captureError, setCaptureError] = useState<string | null>(null);

  function roomTypeName(roomTypeId: string): string {
    return roomTypes?.find((rt) => rt.id === roomTypeId)?.nombre ?? roomTypeId;
  }

  async function loadRecommendations() {
    const { recomendaciones } = await fetchRateRecommendations(fetch, apiBaseUrl, token, propertyId, { limit: 50 });
    setRecommendations(recomendaciones);
  }

  async function loadPricingRule(roomTypeId: string) {
    if (!roomTypeId) return;
    const rule = await fetchPricingRule(fetch, apiBaseUrl, token, propertyId, roomTypeId);
    setPricingRule(rule);
    setPricingForm({
      floorPrice: String(rule.floorPrice),
      ceilingPrice: rule.ceilingPrice != null && Number.isFinite(rule.ceilingPrice) ? String(rule.ceilingPrice) : "",
      multipliers: rule.dayOfWeekMultiplier.map((m) => String(m)),
      minStayDefault: String(rule.minStayDefault),
      minStayOnHighDemand: String(rule.minStayOnHighDemand),
    });
  }

  async function load() {
    setError(null);
    try {
      const [g, b, rts] = await Promise.all([
        fetchRevenueGate(fetch, apiBaseUrl, token, propertyId),
        fetchRevenueBacktests(fetch, apiBaseUrl, token, propertyId),
        fetchRoomTypes(fetch, apiBaseUrl, token, propertyId),
      ]);
      setGate(g);
      setBacktests(b);
      setRoomTypes(rts);
      if (rts.length > 0 && !selectedRoomTypeId) setSelectedRoomTypeId(rts[0]!.id);
      await loadRecommendations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado del motor de revenue.");
    }
  }

  useEffect(() => {
    if (selectedRoomTypeId) void loadPricingRule(selectedRoomTypeId);
  }, [apiBaseUrl, token, propertyId, selectedRoomTypeId]);

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInit() {
    await withBusy(async () => {
      setGate(await initRevenueGate(fetch, apiBaseUrl, token, propertyId));
    });
  }

  async function handleTransition(to: RevenueGateState) {
    await withBusy(async () => {
      setGate(await transitionRevenueGate(fetch, apiBaseUrl, token, propertyId, to));
    });
  }

  async function handleConfirmAutopilotApproval() {
    setPendingAutopilot(false);
    await withBusy(async () => {
      setGate(await setRevenueGateOwnerApproval(fetch, apiBaseUrl, token, propertyId, true));
    });
  }

  async function handleRevokeApproval() {
    await withBusy(async () => {
      setGate(await setRevenueGateOwnerApproval(fetch, apiBaseUrl, token, propertyId, false));
    });
  }

  async function handleRegisterBacktest(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    let evaluations: unknown;
    try {
      evaluations = JSON.parse(evaluationsRaw.trim() || "[]");
    } catch {
      setFormError("El campo de ventanas no es JSON válido.");
      return;
    }
    if (!Array.isArray(evaluations) || evaluations.length === 0) {
      setFormError("Se necesita al menos una ventana evaluada (formato JSON, ver el placeholder).");
      return;
    }
    await withBusy(async () => {
      await registerRevenueBacktest(fetch, apiBaseUrl, token, propertyId, {
        counterfactualMethod: method,
        evaluations: evaluations as RegisterBacktestInputEvaluations,
      });
      setEvaluationsRaw("");
      setBacktests(await fetchRevenueBacktests(fetch, apiBaseUrl, token, propertyId));
    });
  }

  async function handleApprove(id: string) {
    await withBusy(async () => {
      await approveRateRecommendation(fetch, apiBaseUrl, token, propertyId, id);
      await loadRecommendations();
    });
  }

  async function handleDiscard(id: string) {
    await withBusy(async () => {
      await discardRateRecommendation(fetch, apiBaseUrl, token, propertyId, id);
      await loadRecommendations();
    });
  }

  async function handleSavePricingRule(e: FormEvent) {
    e.preventDefault();
    setPricingError(null);
    if (!pricingForm || !selectedRoomTypeId) return;
    const floorPrice = Number(pricingForm.floorPrice);
    const ceilingPrice = Number(pricingForm.ceilingPrice);
    const multipliers = pricingForm.multipliers.map(Number);
    const minStayDefault = Number(pricingForm.minStayDefault);
    const minStayOnHighDemand = Number(pricingForm.minStayOnHighDemand);
    if (!Number.isFinite(floorPrice) || !Number.isFinite(ceilingPrice) || multipliers.some((m) => !Number.isFinite(m)) || multipliers.length !== 7) {
      setPricingError("Revisa que floor/ceiling y los 7 multiplicadores sean números válidos.");
      return;
    }
    await withBusy(async () => {
      const saved = await savePricingRule(fetch, apiBaseUrl, token, propertyId, selectedRoomTypeId, { floorPrice, ceilingPrice, dayOfWeekMultiplier: multipliers, minStayDefault, minStayOnHighDemand });
      setPricingRule(saved);
    });
  }

  async function handleCreateLocalEvent(e: FormEvent) {
    e.preventDefault();
    setCaptureError(null);
    if (!localEventForm.nombre || !localEventForm.fechaInicio || !localEventForm.fechaFin) {
      setCaptureError("Nombre, fecha de inicio y fecha de fin son obligatorios.");
      return;
    }
    const magnitudPct = Number(localEventForm.magnitudPct);
    if (!Number.isFinite(magnitudPct) || magnitudPct <= 0) {
      setCaptureError("La magnitud debe ser un número positivo.");
      return;
    }
    await withBusy(async () => {
      await createLocalEvent(fetch, apiBaseUrl, token, propertyId, { ...localEventForm, magnitudPct });
      setLocalEventForm({ nombre: "", fechaInicio: "", fechaFin: "", impacto: "alza_demanda", magnitudPct: "20" });
    });
  }

  async function handleCreateCompetitorRate(e: FormEvent) {
    e.preventDefault();
    setCaptureError(null);
    if (!competitorForm.competidor || !competitorForm.fecha) {
      setCaptureError("Competidor y fecha son obligatorios.");
      return;
    }
    const tarifa = Number(competitorForm.tarifa);
    if (!Number.isFinite(tarifa) || tarifa <= 0) {
      setCaptureError("La tarifa debe ser un número positivo.");
      return;
    }
    await withBusy(async () => {
      await createCompetitorRate(fetch, apiBaseUrl, token, propertyId, { competidor: competitorForm.competidor, fecha: competitorForm.fecha, tarifa });
      setCompetitorForm({ competidor: "", fecha: "", tarifa: "" });
    });
  }

  if (gate === undefined && !error) {
    return <EstadoCargando etiqueta="Cargando el motor de revenue…" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground">Revenue management</h1>
      </header>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader>
          <CardTitle>Estado del gate</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {gate === undefined ? (
            <p className="text-sm text-muted-foreground">No se pudo determinar el estado del gate.</p>
          ) : gate === null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Esta property todavía no tiene el motor de revenue inicializado. Al inicializarlo entra en <strong>shadow</strong> (solo registra lo que
                habría hecho, nunca ejecuta ni cambia tarifas).
              </p>
              <Button type="button" onClick={() => void handleInit()} disabled={busy} className="self-start">
                Inicializar en shadow
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant={gate.gate === "autopilot" ? "default" : "secondary"} className="text-sm">
                  {REVENUE_GATE_STATE_LABELS[gate.gate]}
                </Badge>
                {gate.gate === "shadow" && <span className="text-xs text-muted-foreground">{daysSince(gate.shadowStartedAt)} de 90 días en shadow</span>}
                {gate.ownerApprovedAutopilotAt && <Badge variant="outline">Autopilot aprobado por owner el {fmtDate(gate.ownerApprovedAutopilotAt)}</Badge>}
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Shadow desde</dt>
                  <dd>{fmtDate(gate.shadowStartedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Propone desde</dt>
                  <dd>{fmtDate(gate.proponeStartedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Autopilot desde</dt>
                  <dd>{fmtDate(gate.autopilotStartedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Límite de variación en propone</dt>
                  <dd>±{gate.proponeMaxVariationPct}%</dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                {gate.gate === "shadow" && (
                  <Button type="button" onClick={() => void handleTransition("propone")} disabled={busy}>
                    Promover a propone
                  </Button>
                )}
                {gate.gate === "propone" && !gate.ownerApprovedAutopilotAt && (
                  <Button type="button" onClick={() => setPendingAutopilot(true)} disabled={busy}>
                    <ShieldCheck className="w-4 h-4" strokeWidth={1.75} />
                    Aprobar autopilot (owner)
                  </Button>
                )}
                {gate.gate === "propone" && gate.ownerApprovedAutopilotAt && (
                  <>
                    <Button type="button" onClick={() => void handleTransition("autopilot")} disabled={busy}>
                      Promover a autopilot
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void handleRevokeApproval()} disabled={busy}>
                      Revocar aprobación
                    </Button>
                  </>
                )}
                {gate.gate !== "shadow" && (
                  <Button type="button" variant="destructive" onClick={() => void handleTransition("shadow")} disabled={busy}>
                    Freno de emergencia (bajar a shadow)
                  </Button>
                )}
                {gate.gate === "autopilot" && (
                  <Button type="button" variant="outline" onClick={() => void handleTransition("propone")} disabled={busy}>
                    Bajar a propone
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registrar backtest walk-forward</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            REQ-REV-003 exige un backtest walk-forward vigente que demuestre mejora vs. baseline antes de habilitar autopilot. Pega las ventanas ya
            evaluadas (fechas + ingreso del motor vs. baseline, YA calculados fuera de este panel) en formato JSON.
          </p>
          <form className="flex flex-col gap-3" onSubmit={(e) => void handleRegisterBacktest(e)}>
            <label className="text-sm font-medium text-foreground" htmlFor="counterfactual-method">
              Método contrafactual
            </label>
            <select
              id="counterfactual-method"
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value as CounterfactualMethod)}
            >
              {Object.entries(COUNTERFACTUAL_METHOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label className="text-sm font-medium text-foreground" htmlFor="evaluations">
              Ventanas evaluadas (JSON)
            </label>
            <textarea
              id="evaluations"
              className="flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              placeholder={DEFAULT_EVALUATIONS_PLACEHOLDER}
              value={evaluationsRaw}
              onChange={(e) => setEvaluationsRaw(e.target.value)}
            />
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button type="submit" disabled={busy} className="self-start">
              Registrar backtest
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historial de backtests</CardTitle>
        </CardHeader>
        <CardContent>
          {!backtests && !error && <EstadoCargando etiqueta="Cargando historial…" />}
          {backtests && backtests.length === 0 && <EstadoVacio mensaje="Todavía no se ha registrado ningún backtest." />}
          {backtests && backtests.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Método</TableHead>
                    <TableHead>Ventanas</TableHead>
                    <TableHead>Mejora</TableHead>
                    <TableHead>Resultado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backtests.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{fmtDate(run.runAt)}</TableCell>
                      <TableCell>{COUNTERFACTUAL_METHOD_LABELS[run.counterfactualMethod]}</TableCell>
                      <TableCell>
                        {run.windowsEngineWon}/{run.windowsEvaluated}
                      </TableCell>
                      <TableCell>{run.improvementPct.toFixed(1)}%</TableCell>
                      <TableCell>
                        <Badge variant={run.passes ? "default" : "destructive"}>{run.passes ? "Pasa" : "No pasa"}</Badge>
                        {!run.passes && run.failureReasons.length > 0 && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{run.failureReasons.join("; ")}</p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recomendaciones de tarifa</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Cada recomendación muestra el desglose completo de las señales que la produjeron (pickup, evento, compset, regla aplicada) — nunca una caja
            negra. En gate "propone", aprobar solo cambia el estado a "aprobada": el sistema es quien escribe la tarifa real en su siguiente corrida. En
            "autopilot", el sistema ya intentó aplicarla directo — si sigue "pendiente" es porque el backtest o el límite de variación la rechazaron.
          </p>
          {!recommendations && !error && <EstadoCargando etiqueta="Cargando recomendaciones…" />}
          {recommendations && recommendations.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna recomendación calculada (corre una vez al día)." />}
          {recommendations && recommendations.length > 0 && (
            <div className="flex flex-col gap-3">
              {recommendations.map((rec) => {
                const desglose = rec.desglose as { pickup?: unknown; evento?: unknown; compset?: unknown; ajustes?: { totalPct?: number } };
                const señales = [summarizeSignal("pickup", desglose.pickup), summarizeSignal("evento", desglose.evento), summarizeSignal("compset", desglose.compset)].filter(
                  (s): s is string => s != null,
                );
                return (
                  <div key={rec.id} className="rounded-md border border-border p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{rec.fecha}</span>
                        <span className="text-xs text-muted-foreground">{roomTypeName(rec.roomTypeId)}</span>
                        <Badge variant={rec.estado === "aplicada" ? "default" : rec.estado === "descartada" || rec.estado === "expirada" ? "secondary" : "outline"}>
                          {RATE_RECOMMENDATION_STATUS_LABELS[rec.estado]}
                        </Badge>
                      </div>
                      <div className="text-sm">
                        {fmtMoney(rec.currentBarPrice)} → <strong>{fmtMoney(rec.recommendedPrice)}</strong>
                        <span className="text-xs text-muted-foreground ml-2">LOS sugerido: {rec.suggestedMinStay}</span>
                      </div>
                    </div>
                    {señales.length > 0 ? (
                      <ul className="text-xs text-muted-foreground list-disc pl-4">
                        {señales.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">Sin señales suficientes -- solo se aplicó la regla de precio (multiplicador por día de la semana / floor / ceiling).</p>
                    )}
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Ver desglose completo (JSON)</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all bg-muted/40 rounded p-2">{JSON.stringify(rec.desglose, null, 2)}</pre>
                    </details>
                    {rec.estado === "pendiente" && (
                      <div className="flex gap-2">
                        <Button type="button" size="sm" onClick={() => void handleApprove(rec.id)} disabled={busy}>
                          Aprobar
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => void handleDiscard(rec.id)} disabled={busy}>
                          Descartar
                        </Button>
                      </div>
                    )}
                    {rec.estado === "aprobada" && <p className="text-xs text-muted-foreground">Aprobada — el sistema la aplicará en su siguiente corrida.</p>}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reglas de precio por tipo de habitación</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="pricing-room-type">
            Tipo de habitación
          </label>
          <select
            id="pricing-room-type"
            className="flex h-11 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={selectedRoomTypeId}
            onChange={(e) => setSelectedRoomTypeId(e.target.value)}
          >
            {(roomTypes ?? []).map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.nombre}
              </option>
            ))}
          </select>
          {pricingRule?.esDefault && <p className="text-xs text-muted-foreground">Sin configurar todavía — mostrando el default razonable del motor.</p>}
          {pricingForm && (
            <form className="flex flex-col gap-3" onSubmit={(e) => void handleSavePricingRule(e)}>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <div>
                  <label className="text-xs text-muted-foreground" htmlFor="floor-price">
                    Tarifa mínima (floor)
                  </label>
                  <input
                    id="floor-price"
                    type="number"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={pricingForm.floorPrice}
                    onChange={(e) => setPricingForm({ ...pricingForm, floorPrice: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground" htmlFor="ceiling-price">
                    Tarifa máxima (ceiling)
                  </label>
                  <input
                    id="ceiling-price"
                    type="number"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={pricingForm.ceilingPrice}
                    onChange={(e) => setPricingForm({ ...pricingForm, ceilingPrice: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Multiplicador por día de la semana (1.0 = sin cambio)</p>
              <div className="grid grid-cols-7 gap-2 max-w-lg">
                {DOW_LABELS.map((label, i) => (
                  <div key={label}>
                    <label className="text-[10px] text-muted-foreground block text-center">{label}</label>
                    <input
                      type="number"
                      step="0.05"
                      className="flex h-9 w-full rounded-md border border-input bg-background px-1 py-1 text-xs text-center"
                      value={pricingForm.multipliers[i]}
                      onChange={(e) => {
                        const next = [...pricingForm.multipliers];
                        next[i] = e.target.value;
                        setPricingForm({ ...pricingForm, multipliers: next });
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <div>
                  <label className="text-xs text-muted-foreground" htmlFor="min-stay-default">
                    Estancia mínima (default)
                  </label>
                  <input
                    id="min-stay-default"
                    type="number"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={pricingForm.minStayDefault}
                    onChange={(e) => setPricingForm({ ...pricingForm, minStayDefault: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground" htmlFor="min-stay-high-demand">
                    Estancia mínima (alta demanda)
                  </label>
                  <input
                    id="min-stay-high-demand"
                    type="number"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={pricingForm.minStayOnHighDemand}
                    onChange={(e) => setPricingForm({ ...pricingForm, minStayOnHighDemand: e.target.value })}
                  />
                </div>
              </div>
              {pricingError && <p className="text-sm text-destructive">{pricingError}</p>}
              <Button type="submit" disabled={busy} className="self-start">
                Guardar reglas
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Captura de datos (evento local / tarifa de competidor)</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-6">
          <form className="flex flex-col gap-2" onSubmit={(e) => void handleCreateLocalEvent(e)}>
            <h3 className="text-sm font-medium">Evento local (feria, concierto, congreso…)</h3>
            <p className="text-xs text-muted-foreground">Solo el staff de esta property lo sabe -- nunca se inventa ni se scrapea.</p>
            <input
              placeholder="Nombre del evento"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={localEventForm.nombre}
              onChange={(e) => setLocalEventForm({ ...localEventForm, nombre: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={localEventForm.fechaInicio}
                onChange={(e) => setLocalEventForm({ ...localEventForm, fechaInicio: e.target.value })}
              />
              <input
                type="date"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={localEventForm.fechaFin}
                onChange={(e) => setLocalEventForm({ ...localEventForm, fechaFin: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={localEventForm.impacto}
                onChange={(e) => setLocalEventForm({ ...localEventForm, impacto: e.target.value as "alza_demanda" | "baja_demanda" })}
              >
                <option value="alza_demanda">Sube la demanda</option>
                <option value="baja_demanda">Baja la demanda</option>
              </select>
              <input
                type="number"
                placeholder="Magnitud %"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={localEventForm.magnitudPct}
                onChange={(e) => setLocalEventForm({ ...localEventForm, magnitudPct: e.target.value })}
              />
            </div>
            <Button type="submit" size="sm" disabled={busy} className="self-start">
              Registrar evento
            </Button>
          </form>

          <form className="flex flex-col gap-2" onSubmit={(e) => void handleCreateCompetitorRate(e)}>
            <h3 className="text-sm font-medium">Tarifa de competidor (captura manual)</h3>
            <p className="text-xs text-muted-foreground">Nunca un scraper -- ver knownGaps del motor para la extensión futura con un proveedor de rate-shopping.</p>
            <input
              placeholder="Nombre del competidor"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={competitorForm.competidor}
              onChange={(e) => setCompetitorForm({ ...competitorForm, competidor: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={competitorForm.fecha}
                onChange={(e) => setCompetitorForm({ ...competitorForm, fecha: e.target.value })}
              />
              <input
                type="number"
                placeholder="Tarifa (MXN)"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={competitorForm.tarifa}
                onChange={(e) => setCompetitorForm({ ...competitorForm, tarifa: e.target.value })}
              />
            </div>
            <Button type="submit" size="sm" disabled={busy} className="self-start">
              Capturar tarifa
            </Button>
          </form>
          {captureError && <p className="text-sm text-destructive sm:col-span-2">{captureError}</p>}
        </CardContent>
      </Card>

      <AlertDialog open={pendingAutopilot} onOpenChange={(open) => { if (!open) setPendingAutopilot(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aprobar autopilot pleno</AlertDialogTitle>
            <AlertDialogDescription>
              REQ-REV-003 (P0/GOB) exige una aprobación explícita del rol owner antes de habilitar autopilot pleno para esta property. Esta aprobación
              queda registrada y es requisito, junto con un backtest vigente que pase, para promover el gate a autopilot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmAutopilotApproval()} disabled={busy}>
              Aprobar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type RegisterBacktestInputEvaluations = Parameters<typeof registerRevenueBacktest>[4]["evaluations"];
