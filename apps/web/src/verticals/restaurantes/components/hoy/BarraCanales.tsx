// Barra apilada «por canal» con etiquetas y conteos (el color nunca es la unica señal: cada tramo lleva su texto).
import { Card, CardContent } from "@atiende/ui";
import type { CanalTurno } from "../../lib/turno-hoy.ts";

const TRAMOS = ["bg-primary", "bg-info", "bg-success", "bg-warning", "bg-muted-foreground"] as const;
const RELLENOS = ["fill-primary", "fill-info", "fill-success", "fill-warning", "fill-muted-foreground"] as const;

export function BarraCanales({ canales }: { readonly canales: readonly CanalTurno[] }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <h2 className="m-0 text-base font-semibold text-foreground">Pedidos por canal</h2>
        {canales.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">Aún no hay pedidos en este corte, así que no hay canales que repartir.</p>
        ) : (
          <>
            {/* SVG con porcentajes como atributos (el guard prohibe `style` en linea): cada tramo empieza donde termina el anterior. */}
            <div className="h-3 w-full overflow-hidden rounded-full bg-canvas">
              <svg role="img" aria-label={canales.map((c) => `${c.etiqueta} ${c.total}`).join(", ")} width="100%" height="100%" preserveAspectRatio="none">
                {canales.map((c, i) => (
                  <rect key={c.canal} x={`${canales.slice(0, i).reduce((s, x) => s + x.porcentaje, 0)}%`} y="0" width={`${c.porcentaje}%`} height="100%" className={RELLENOS[i % RELLENOS.length]} />
                ))}
              </svg>
            </div>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm text-foreground">
              {canales.map((c, i) => (
                <li key={c.canal} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className={`size-2 rounded-full ${TRAMOS[i % TRAMOS.length]}`} />
                  {c.etiqueta} <span className="tabular-nums text-muted-foreground">{c.total} ({c.porcentaje}%)</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
