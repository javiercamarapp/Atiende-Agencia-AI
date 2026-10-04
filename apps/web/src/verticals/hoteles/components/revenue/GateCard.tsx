// Tarjeta "Estado del gate" de Revenue (UNI-C gestion: extraida de Revenue.tsx). Presentacional: los handlers los pone la pagina.
import { ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, StatusBadge } from "@atiende/ui";
import { REVENUE_GATE_STATE_LABELS } from "../../lib/revenue-client.ts";
import type { RevenueGate, RevenueGateState } from "../../lib/revenue-client.ts";
import { fechaHoraEsMx } from "../../../../lib/formato-fecha.ts";

export function fmtFecha(iso: string | null): string {
  return iso ? fechaHoraEsMx(iso) : "—";
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}

export interface GateCardProps {
  /** `undefined` = no se pudo determinar; `null` = sin inicializar. */
  readonly gate: RevenueGate | null | undefined;
  readonly busy: boolean;
  readonly onInit: () => void;
  readonly onTransition: (to: RevenueGateState) => void;
  readonly onAprobarAutopilot: () => void;
  readonly onRevocarAprobacion: () => void;
}

export function GateCard({ gate, busy, onInit, onTransition, onAprobarAutopilot, onRevocarAprobacion }: GateCardProps) {
  return (
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
            <Button type="button" onClick={onInit} disabled={busy} className="self-start">
              Inicializar en shadow
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <StatusBadge tone={gate.gate === "autopilot" ? "info" : "neutral"} className="text-sm">
                {REVENUE_GATE_STATE_LABELS[gate.gate]}
              </StatusBadge>
              {gate.gate === "shadow" && <span className="text-xs text-muted-foreground">{daysSince(gate.shadowStartedAt)} de 90 días en shadow</span>}
              {gate.ownerApprovedAutopilotAt && <StatusBadge tone="neutral" dot={false}>Autopilot aprobado por owner el {fmtFecha(gate.ownerApprovedAutopilotAt)}</StatusBadge>}
            </div>

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Shadow desde</dt>
                <dd>{fmtFecha(gate.shadowStartedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Propone desde</dt>
                <dd>{fmtFecha(gate.proponeStartedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Autopilot desde</dt>
                <dd>{fmtFecha(gate.autopilotStartedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Límite de variación en propone</dt>
                <dd>±{gate.proponeMaxVariationPct}%</dd>
              </div>
            </dl>

            <div className="flex flex-wrap gap-2">
              {gate.gate === "shadow" && (
                <Button type="button" onClick={() => onTransition("propone")} disabled={busy}>
                  Promover a propone
                </Button>
              )}
              {gate.gate === "propone" && !gate.ownerApprovedAutopilotAt && (
                <Button type="button" onClick={onAprobarAutopilot} disabled={busy} iconLeft={<ShieldCheck className="size-4" strokeWidth={1.75} />}>
                  Aprobar autopilot (owner)
                </Button>
              )}
              {gate.gate === "propone" && gate.ownerApprovedAutopilotAt && (
                <>
                  <Button type="button" onClick={() => onTransition("autopilot")} disabled={busy}>
                    Promover a autopilot
                  </Button>
                  <Button type="button" variant="outline" onClick={onRevocarAprobacion} disabled={busy}>
                    Revocar aprobación
                  </Button>
                </>
              )}
              {gate.gate !== "shadow" && (
                <Button type="button" variant="destructive" onClick={() => onTransition("shadow")} disabled={busy}>
                  Freno de emergencia (bajar a shadow)
                </Button>
              )}
              {gate.gate === "autopilot" && (
                <Button type="button" variant="outline" onClick={() => onTransition("propone")} disabled={busy}>
                  Bajar a propone
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
