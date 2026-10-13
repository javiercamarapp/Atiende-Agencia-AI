// Selector de la sucursal (o propiedad / hotel / contribuyente) activa de las verticales, bajo el logo del Sidebar y en la cabecera movil.
//
// Misma familia visual que el conmutador de tema del pie del Sidebar (ThemeSelector): gris suave HUNDIDO (`bg-muted` con sombra
// interior sutil y un hairline `ring-border`, sin borde duro), forma de pildora, texto sobrio del tamano de los items del Sidebar
// (`text-ui`) y chevron pequeno en `muted-foreground`. Hover: el gris se oscurece apenas; teclado: anillo `ring` accesible.
//
// Sigue siendo un `<select>` NATIVO a proposito (como `NativeSelect`): teclado, lectores de pantalla y selector del sistema en
// movil funcionan sin JavaScript propio, el `id`/`<label for>` de cada vertical se conservan y el menu desplegable (lista con
// scroll, ya de por si) lo pinta el navegador. Con una sola opcion no hay nada que elegir: queda de solo lectura, con la misma
// forma y sin chevron.
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

export interface SelectorSucursalOpcion {
  readonly valor: string;
  readonly etiqueta: string;
}

export interface SelectorSucursalProps {
  /** Rotulo visible sobre el control ("Sucursal activa", "Hotel activo"...). Es el `<label>` del select. */
  readonly etiqueta: string;
  readonly opciones: readonly SelectorSucursalOpcion[];
  readonly valor: string;
  readonly onCambia: (valor: string) => void;
  /** `id` del `<select>` (cada copia en el DOM lleva el suyo para no duplicar ids). */
  readonly id: string;
  readonly className?: string;
}

const FORMA = "h-8 w-full rounded-full bg-muted px-3.5 text-ui font-medium text-foreground shadow-[inset_0_1px_2px_hsl(var(--foreground)/0.08)] ring-1 ring-inset ring-border";

export function SelectorSucursal({ etiqueta, opciones, valor, onCambia, id, className }: SelectorSucursalProps) {
  const actual = opciones.find((o) => o.valor === valor) ?? opciones[0];
  if (opciones.length <= 1) {
    return (
      <div data-testid="selector-sucursal-unica" title={actual?.etiqueta} className={cn(FORMA, "flex items-center", className)}>
        <span className="truncate">{actual?.etiqueta}</span>
      </div>
    );
  }
  return (
    <div className={className}>
      <label htmlFor={id} className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
        {etiqueta}
      </label>
      <div className="relative">
        <select
          id={id}
          data-testid="selector-sucursal"
          value={valor}
          title={actual?.etiqueta}
          onChange={(e) => onCambia(e.target.value)}
          className={cn(
            FORMA,
            "peer cursor-pointer appearance-none truncate pr-8 transition-colors duration-fast ease-brand hover:bg-muted-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {opciones.map((o) => (
            <option key={o.valor} value={o.valor} className="bg-popover text-popover-foreground">
              {o.etiqueta}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
      </div>
    </div>
  );
}
