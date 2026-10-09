// Herramientas del tablero de Pedidos que el repo suelto no tiene (sondeo, sonido, auto-impresion, reglas del autopiloto y tiempo prometido),
// compactadas en un solo boton con menu para que la barra superior quede como la del original («N en total» + las 3 pildoras).
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { Button, Checkbox, Popover, PopoverContent, PopoverTrigger, StatusBadge } from "@atiende/ui";

export interface HerramientasPedidosProps {
  /** Texto del indicador: «Actualizado hace 5 s · cada 20 s», «En pausa (pestaña oculta)»… */
  readonly estadoActualizacion: string;
  readonly consultando: boolean;
  readonly onActualizar: () => void;
  readonly nuevos: number;
  readonly sonido: boolean;
  readonly sonidoPermitido: boolean;
  readonly onSonido: (activo: boolean) => void;
  readonly autoImprimir: boolean;
  readonly onAutoImprimir: (activo: boolean) => void;
  readonly intervaloAutoImpresionS: number;
  /** Solo owner/admin. */
  readonly onReglas: (() => void) | null;
  readonly tiempoPrometido: string | null;
}

export function HerramientasPedidos(p: HerramientasPedidosProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span role="status" aria-live="polite" data-testid="indicador-actualizacion" className="inline-flex items-center gap-1.5 font-mono text-eyebrow tabular-nums text-muted-foreground">
        <RefreshCw className={`h-3 w-3 ${p.consultando ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
        {p.estadoActualizacion}
      </span>
      {p.nuevos > 0 && (
        <StatusBadge tone="neutral" dot={false} data-testid="aviso-nuevos">
          {p.nuevos} pedido{p.nuevos === 1 ? "" : "s"} nuevo{p.nuevos === 1 ? "" : "s"}
        </StatusBadge>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-2.5 text-eyebrow" aria-label="Herramientas de pedidos">
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Herramientas
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3">
          <Button type="button" size="xs" variant="outline" onClick={p.onActualizar} disabled={p.consultando}>
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Actualizar ahora
          </Button>
          <Checkbox
            id="sonido-pedidos"
            checked={p.sonido && p.sonidoPermitido}
            disabled={!p.sonidoPermitido}
            onChange={(e) => p.onSonido(e.target.checked)}
            label={p.sonidoPermitido ? "Sonido al llegar un pedido nuevo" : "Sonido al llegar un pedido nuevo (apagado en tus Avisos)"}
            wrapperClassName="text-xs text-foreground"
          />
          <Checkbox
            id="auto-imprimir-cocina"
            checked={p.autoImprimir}
            onChange={(e) => p.onAutoImprimir(e.target.checked)}
            label="Imprimir ticket de cocina automáticamente al llegar un pedido (esta sucursal, este equipo)"
            wrapperClassName="text-xs text-foreground"
          />
          {p.autoImprimir && (
            <p className="m-0 text-xs text-muted-foreground">
              Revisando pedidos nuevos cada {p.intervaloAutoImpresionS} s mientras esta pantalla esté abierta. Para imprimir sin diálogo, configura el navegador en modo de impresión silenciosa.
            </p>
          )}
          {p.tiempoPrometido && (
            <p className="m-0 text-xs text-muted-foreground" data-testid="tiempo-prometido">
              {p.tiempoPrometido}
            </p>
          )}
          {p.onReglas && (
            <Button type="button" size="sm" variant="outline" className="w-full" onClick={p.onReglas}>
              <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Reglas del autopiloto
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
