// Semaforo de tiempo de un pedido: color + icono + texto («12 min · A tiempo»). El color nunca es la unica senal.
import { StatusBadge } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import type { Semaforo } from "@atiende/domain-restaurantes/operacion";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { ETIQUETA_SEMAFORO, textoMinutos } from "../../lib/semaforo.ts";

const TONO: Readonly<Record<Semaforo, StatusTone>> = { verde: "success", amarillo: "warning", rojo: "danger" };
const ICONO = { verde: CheckCircle2, amarillo: Clock, rojo: AlertTriangle } as const;

export function SemaforoMinutos({ semaforo, minutos, prefijo }: { readonly semaforo: Semaforo; readonly minutos: number; readonly prefijo?: string }) {
  const Icono = ICONO[semaforo];
  return (
    <StatusBadge tone={TONO[semaforo]} dot={false} data-semaforo={semaforo} className="text-sm">
      <Icono className="size-4" aria-hidden="true" />
      <span>
        {prefijo ? `${prefijo} ` : ""}
        {textoMinutos(minutos)} · {ETIQUETA_SEMAFORO[semaforo]}
      </span>
    </StatusBadge>
  );
}
