// «Atención» del turno: en camino de mas de 90 min (rojo) y pedidos sin aceptar. Color + icono + texto.
import { Card, CardContent, StatusBadge } from "@atiende/ui";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AlertaTurno } from "../../lib/turno-hoy.ts";

export function AlertasTurno({ alertas }: { readonly alertas: readonly AlertaTurno[] }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <h2 className="m-0 text-base font-semibold text-foreground">Atención</h2>
        {alertas.length === 0 ? (
          <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            Nada por atender ahora.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {alertas.map((a) => (
              <li key={`${a.critica ? "r" : "a"}-${a.pedidoId}`} className="flex items-center gap-2 text-base text-foreground" data-alerta={a.critica ? "roja" : "amarilla"}>
                <StatusBadge tone={a.critica ? "danger" : "warning"} dot={false}>
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                  {a.critica ? "Urgente" : "Pendiente"}
                </StatusBadge>
                {a.texto}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
