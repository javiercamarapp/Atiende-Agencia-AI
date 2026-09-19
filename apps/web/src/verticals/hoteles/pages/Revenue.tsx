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
  REVENUE_GATE_STATE_LABELS,
  fetchRevenueBacktests,
  fetchRevenueGate,
  initRevenueGate,
  registerRevenueBacktest,
  setRevenueGateOwnerApproval,
  transitionRevenueGate,
} from "../lib/revenue-client.ts";
import type { CounterfactualMethod, RevenueBacktestRun, RevenueGate, RevenueGateState } from "../lib/revenue-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

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

  async function load() {
    setError(null);
    try {
      const [g, b] = await Promise.all([
        fetchRevenueGate(fetch, apiBaseUrl, token, propertyId),
        fetchRevenueBacktests(fetch, apiBaseUrl, token, propertyId),
      ]);
      setGate(g);
      setBacktests(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado del motor de revenue.");
    }
  }

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
