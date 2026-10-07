// Rn-P3-21 -- insignia «Requiere atención humana» con la señal que la disparó (Emergencia, Queja, Reembolso, VIP), en el tono de
// severidad de status-tones.ts. Una sola pieza para la bandeja y el hilo: lo que el generador marcó se ve igual en ambos.
import { AlertTriangle } from "lucide-react";
import { StatusBadge, statusTone } from "@atiende/ui";
import { SENAL_LABELS } from "../../lib/mensajeria-client.ts";
import type { SenalEscalamiento } from "../../lib/mensajeria-client.ts";
import { SENAL_ESCALAMIENTO_TONES } from "../../lib/status-tones.ts";

export function SenalesBadges({ senales }: { readonly senales: readonly SenalEscalamiento[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge tone="danger">
        <AlertTriangle className="size-3" strokeWidth={1.75} aria-hidden="true" />
        Requiere atención humana
      </StatusBadge>
      {senales.map((s) => (
        <StatusBadge key={s} tone={statusTone(SENAL_ESCALAMIENTO_TONES, s)}>
          {SENAL_LABELS[s]}
        </StatusBadge>
      ))}
    </span>
  );
}
