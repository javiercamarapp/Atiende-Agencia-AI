// Recomendaciones de tarifa de Revenue (UNI-C gestion: extraida de Revenue.tsx). Presentacional: cada recomendacion muestra el
// desglose completo de las senales (nunca una caja negra). Aprobar pide confirmacion en la pagina; Descartar sigue directo.
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoVacio, StatusBadge, statusTone } from "@atiende/ui";
import { RATE_RECOMMENDATION_STATUS_LABELS } from "../../lib/revenue-client.ts";
import type { RateRecommendation } from "../../lib/revenue-client.ts";
import { dineroMxConSigno } from "../../lib/dinero.ts";
import { RECOMENDACION_ESTADO_TONES } from "../../lib/status-tones.ts";

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

export interface RecomendacionesSectionProps {
  readonly recommendations: readonly RateRecommendation[] | null;
  /** Hay un error de carga en la pagina: no se pinta "Cargando". */
  readonly hayError: boolean;
  readonly busy: boolean;
  readonly roomTypeName: (id: string) => string;
  readonly onApprove: (id: string) => void;
  readonly onDiscard: (id: string) => void;
}

export function RecomendacionesSection({ recommendations, hayError, busy, roomTypeName, onApprove, onDiscard }: RecomendacionesSectionProps) {
  return (
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
        {!recommendations && !hayError && <EstadoCargando etiqueta="Cargando recomendaciones…" />}
        {recommendations && recommendations.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna recomendación calculada (corre una vez al día)." />}
        {recommendations && recommendations.length > 0 && (
          <div className="flex flex-col gap-2.5">
            {recommendations.map((rec) => {
              const desglose = rec.desglose as { pickup?: unknown; evento?: unknown; compset?: unknown; ajustes?: { totalPct?: number } };
              const señales = [summarizeSignal("pickup", desglose.pickup), summarizeSignal("evento", desglose.evento), summarizeSignal("compset", desglose.compset)].filter(
                (s): s is string => s != null,
              );
              return (
                <div key={rec.id} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{rec.fecha}</span>
                      <span className="text-xs text-muted-foreground">{roomTypeName(rec.roomTypeId)}</span>
                      <StatusBadge tone={statusTone(RECOMENDACION_ESTADO_TONES, rec.estado, "info")}>{RATE_RECOMMENDATION_STATUS_LABELS[rec.estado]}</StatusBadge>
                    </div>
                    <div className="text-sm">
                      {dineroMxConSigno(rec.currentBarPrice, 0)} → <strong>{dineroMxConSigno(rec.recommendedPrice, 0)}</strong>
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
                    <pre className="mt-1 whitespace-pre-wrap break-all bg-canvas border border-border rounded-lg p-2">{JSON.stringify(rec.desglose, null, 2)}</pre>
                  </details>
                  {rec.estado === "pendiente" && (
                    <div className="flex gap-2">
                      <Button type="button" size="sm" onClick={() => onApprove(rec.id)} disabled={busy}>
                        Aprobar
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => onDiscard(rec.id)} disabled={busy}>
                        Descartar
                      </Button>
                    </div>
                  )}
                  {rec.estado === "aprobada" && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">Aprobada — el sistema la aplicará en su siguiente corrida.</p>
                      <div className="flex gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => onDiscard(rec.id)} disabled={busy}>
                          Descartar
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
