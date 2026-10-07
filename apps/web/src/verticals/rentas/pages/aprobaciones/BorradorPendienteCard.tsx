// Tarjeta de un borrador pendiente de aprobación (Aprobar y enviar / Rechazar con motivo obligatorio). Extraída de
// Aprobaciones.tsx sin cambiar su comportamiento para que la bandeja y el hilo (Hilo.tsx) usen exactamente la misma: el rechazo
// conserva sus dos pasos (revelar el diálogo de motivo -> «Confirmar rechazo»), Cancelar/Escape no rechazan nada y, si el
// servidor falla, el diálogo queda abierto con el motivo escrito. Aprobar/Rechazar se gatean en el cliente por rol (UX); el
// servidor SIEMPRE re-valida con `assertVerticalRole`.
import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button, Card, CardContent, ConfirmDialog, StatusBadge, statusTone } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import type { BorradorRecord } from "../../lib/mensajeria-client.ts";
import { BORRADOR_HISTORIAL_TONES } from "../../lib/status-tones.ts";
import { SenalesBadges } from "./SenalesBadges.tsx";

/** Etiqueta y tono del borrador ya decidido (enviado = verde, rechazado = rojo, aprobado = azul). */
export function historialBadge(b: BorradorRecord): { tono: StatusTone; label: string } {
  if (b.estado === "enviado") return { tono: statusTone(BORRADOR_HISTORIAL_TONES, "enviado"), label: "Enviado" };
  if (b.estado === "rechazado") return { tono: statusTone(BORRADOR_HISTORIAL_TONES, "rechazado"), label: "Rechazado" };
  return { tono: statusTone(BORRADOR_HISTORIAL_TONES, "aprobado"), label: "Aprobado" };
}

export interface BorradorCardProps {
  readonly conversacionId: string;
  readonly borrador: BorradorRecord;
  readonly puedeEscribir: boolean;
  readonly busy: boolean;
  readonly onAprobar: (borradorId: string) => void;
  /** Debe rechazar la promesa si el servidor falla: así el diálogo de rechazo queda abierto con el motivo escrito. */
  readonly onRechazar: (borradorId: string, motivo: string) => Promise<void>;
}

export function BorradorPendienteCard({ conversacionId, borrador, puedeEscribir, busy, onAprobar, onRechazar }: BorradorCardProps) {
  const [rechazando, setRechazando] = useState(false);

  return (
    <Card className="border-dashed bg-muted/40">
      <CardContent className="p-3 flex flex-col gap-2">
        <div className="flex justify-between gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {borrador.generadoPor === "agente_llm" ? "Generado por agente IA" : "Generado por motor de plantillas"} · {new Date(borrador.creadoEn).toLocaleString("es-MX")}
          </span>
          <StatusBadge tone="warning">Pendiente de aprobación</StatusBadge>
        </div>
        {borrador.necesitaEscalamiento && <SenalesBadges senales={borrador.senales} />}
        <p className="m-0 text-sm text-foreground whitespace-pre-wrap">{borrador.texto}</p>
        {puedeEscribir ? (
          <>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => onAprobar(borrador.id)} disabled={busy}>
                <Check className="w-4 h-4" strokeWidth={1.75} />
                {busy ? "Aprobando…" : "Aprobar y enviar"}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => setRechazando(true)} disabled={busy}>
                <X className="w-4 h-4" strokeWidth={1.75} />
                Rechazar
              </Button>
            </div>

            {/* Paso 2 del rechazo: el motivo sigue siendo obligatorio y la llamada al servidor solo sale de "Confirmar
                rechazo"; Cancelar, Escape o clic fuera cierran sin rechazar nada. Si el servidor falla, el dialogo queda
                abierto con el motivo escrito. */}
            <ConfirmDialog
              open={rechazando}
              onOpenChange={setRechazando}
              tono="danger"
              titulo="Rechazar este borrador"
              descripcion="El motivo queda registrado en el historial de la conversación y es obligatorio."
              confirmar="Confirmar rechazo"
              campo={{ etiqueta: "Motivo del rechazo", multilinea: true, placeholder: "Por qué se rechaza este borrador" }}
              onConfirm={(motivo) => onRechazar(borrador.id, motivo ?? "")}
            />
          </>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            Tu rol no puede aprobar ni rechazar mensajería. Contacta a un admin_gestora u operador con acceso a calendario/mensajería. (Conversación: {conversacionId})
          </p>
        )}
      </CardContent>
    </Card>
  );
}
