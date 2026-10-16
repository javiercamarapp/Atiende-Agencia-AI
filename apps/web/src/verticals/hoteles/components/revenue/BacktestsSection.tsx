// Backtests walk-forward de Revenue: historial (DataTable) y alta en FormDialog (UNI-C gestion: extraido de Revenue.tsx).
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, FormDialog, FormField, NativeSelect, StatusBadge, Textarea, notify } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { COUNTERFACTUAL_METHOD_LABELS, registerRevenueBacktest } from "../../lib/revenue-client.ts";
import type { CounterfactualMethod, RevenueBacktestRun } from "../../lib/revenue-client.ts";
import { fmtFecha } from "./GateCard.tsx";

type Evaluaciones = Parameters<typeof registerRevenueBacktest>[4]["evaluations"];

const DEFAULT_EVALUATIONS_PLACEHOLDER = `[
  {"window":{"trainStart":"2026-01-01","trainEnd":"2026-01-10","testStart":"2026-01-11","testEnd":"2026-01-17"},"engineRevenue":10000,"baselineRevenue":9000},
  {"window":{"trainStart":"2026-01-08","trainEnd":"2026-01-17","testStart":"2026-01-18","testEnd":"2026-01-24"},"engineRevenue":11000,"baselineRevenue":9500}
]`;

const COLUMNAS: readonly DataTableColumna<RevenueBacktestRun>[] = [
  { id: "fecha", encabezado: "Fecha", principal: true, valorOrden: (r) => r.runAt, celda: (r) => fmtFecha(r.runAt) },
  { id: "metodo", encabezado: "Método", celda: (r) => COUNTERFACTUAL_METHOD_LABELS[r.counterfactualMethod] },
  { id: "ventanas", encabezado: "Ventanas", alinear: "right", celda: (r) => `${r.windowsEngineWon}/${r.windowsEvaluated}` },
  { id: "mejora", encabezado: "Mejora", alinear: "right", valorOrden: (r) => r.improvementPct, celda: (r) => <span className="tabular-nums">{r.improvementPct.toFixed(1)}%</span> },
  {
    id: "resultado",
    encabezado: "Resultado",
    celda: (r) => (
      <div className="flex flex-col gap-1">
        <StatusBadge tone={r.passes ? "success" : "danger"}>{r.passes ? "Pasa" : "No pasa"}</StatusBadge>
        {!r.passes && r.failureReasons.length > 0 && <span className="text-xs text-muted-foreground">{r.failureReasons.join("; ")}</span>}
      </div>
    ),
  },
];

export interface BacktestsSectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly backtests: readonly RevenueBacktestRun[] | null;
  /** Se llama tras registrar un backtest para recargar el historial. */
  readonly onRegistrado: () => Promise<void>;
}

export function BacktestsSection({ apiBaseUrl, token, propertyId, backtests, onRegistrado }: BacktestsSectionProps) {
  const [abierto, setAbierto] = useState(false);
  const [method, setMethod] = useState<CounterfactualMethod>("misma_tarifa_periodo_anterior");
  const [evaluationsRaw, setEvaluationsRaw] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleRegistrar() {
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
    setEnviando(true);
    try {
      await registerRevenueBacktest(fetch, apiBaseUrl, token, propertyId, { counterfactualMethod: method, evaluations: evaluations as Evaluaciones });
      setEvaluationsRaw("");
      setAbierto(false);
      notify.success("Backtest registrado.");
      await onRegistrado();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Historial de backtests</CardTitle>
        <Button
          type="button"
          size="sm"
          iconLeft={<Plus className="size-3.5" strokeWidth={1.75} />}
          onClick={() => {
            setFormError(null);
            setAbierto(true);
          }}
        >
          Registrar backtest
        </Button>
      </CardHeader>
      <CardContent>
        <DataTable
          etiqueta="Backtests walk-forward"
          columnas={COLUMNAS}
          filas={backtests ?? []}
          obtenerId={(r) => r.id}
          estado={!backtests ? "loading" : backtests.length === 0 ? "empty" : "ok"}
          vacio={{ mensaje: "Todavía no se ha registrado ningún backtest." }}
        />
      </CardContent>

      <FormDialog
        open={abierto}
        onOpenChange={(v) => {
          if (!v && !enviando) setAbierto(false);
        }}
        titulo="Registrar backtest walk-forward"
        subtitulo="REQ-REV-003 exige un backtest walk-forward vigente que demuestre mejora vs. baseline antes de habilitar autopilot. Pega las ventanas ya evaluadas (fechas + ingreso del motor vs. baseline, YA calculados fuera de este panel) en formato JSON."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleRegistrar()}
        guardando={enviando}
        textoBotonGuardar="Registrar backtest"
        bloquearCierre={enviando}
      >
        <div className="flex flex-col gap-3">
          {formError && <Callout tone="danger">{formError}</Callout>}
          <FormField label="Método contrafactual">
            <NativeSelect id="counterfactual-method" value={method} onChange={(e) => setMethod(e.target.value as CounterfactualMethod)}>
              {Object.entries(COUNTERFACTUAL_METHOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Ventanas evaluadas (JSON)" required>
            <Textarea id="evaluations" className="min-h-[140px] text-xs font-mono" placeholder={DEFAULT_EVALUATIONS_PLACEHOLDER} value={evaluationsRaw} onChange={(e) => setEvaluationsRaw(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>
    </Card>
  );
}
