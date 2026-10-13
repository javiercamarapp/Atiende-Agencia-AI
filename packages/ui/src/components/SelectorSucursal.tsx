// Selector de la sucursal (o propiedad / hotel / contribuyente) activa de las verticales, bajo el logo del Sidebar y en la cabecera movil.
//
// Es el "hundido gris" de la zona inferior del Sidebar (`bg-canvas` + hairline, como las pildoras y el conmutador de tema), pero para ELEGIR:
// fondo `bg-canvas` con sombra interior sutil y borde de 1 px, icono de tienda en `muted-foreground`, nombre de la sucursal truncado en
// `text-ui font-medium` y un chevron pequeno que gira al abrir. Estados: hover (el gris se oscurece apenas), foco de teclado (anillo `ring`),
// abierto (gris mas hundido) y deshabilitado. Sin colores propios: solo tokens, en claro y en oscuro.
//
// La lista es la del sistema (Radix Select de `ui/select`, como `Selector`): teclado completo, busqueda por letra, palomita en la
// elegida y animacion de entrada que se apaga con prefers-reduced-motion. Mantiene el contrato de siempre: `id` en el disparador (un
// `role=combobox` con su `<label for>`), `onCambia(valor)` y, con una sola opcion, un bloque de solo lectura con la misma forma y sin
// chevron. Cada opcion lleva `data-valor` (como `Selector`) para las ayudas de prueba.
import { Store } from "lucide-react";
import { cn } from "../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface SelectorSucursalOpcion {
  readonly valor: string;
  readonly etiqueta: string;
}

export interface SelectorSucursalProps {
  /** Rotulo visible sobre el control ("Sucursal activa", "Hotel activo"...). Es el `<label>` del disparador. */
  readonly etiqueta: string;
  readonly opciones: readonly SelectorSucursalOpcion[];
  readonly valor: string;
  readonly onCambia: (valor: string) => void;
  /** `id` del disparador (cada copia en el DOM lleva el suyo para no duplicar ids). */
  readonly id: string;
  readonly className?: string;
}

const FORMA =
  "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-canvas px-2.5 text-left text-ui font-medium text-foreground shadow-[inset_0_1px_2px_hsl(var(--foreground)/0.06)]";

export function SelectorSucursal({ etiqueta, opciones, valor, onCambia, id, className }: SelectorSucursalProps) {
  const actual = opciones.find((o) => o.valor === valor) ?? opciones[0];
  const icono = <Store aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />;
  if (opciones.length <= 1) {
    return (
      <div className={className}>
        <p className="mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">{etiqueta}</p>
        <div data-testid="selector-sucursal-unica" title={actual?.etiqueta} className={FORMA}>
          {icono}
          <span className="min-w-0 flex-1 truncate">{actual?.etiqueta}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={className}>
      <label htmlFor={id} className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
        {etiqueta}
      </label>
      <Select value={actual?.valor ?? ""} onValueChange={onCambia}>
        <SelectTrigger
          id={id}
          data-testid="selector-sucursal"
          title={actual?.etiqueta}
          className={cn(
            FORMA,
            "h-9 cursor-pointer py-0 transition-[background-color,box-shadow] duration-fast ease-brand motion-reduce:transition-none",
            "hover:bg-muted data-[state=open]:bg-muted data-[state=open]:shadow-[inset_0_1px_3px_hsl(var(--foreground)/0.12)]",
            "focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring",
            // El chevron lo pinta SelectTrigger: aqui queda pequeno y gira al abrir (sin giro con movimiento reducido).
            "[&>svg:last-child]:size-3.5 [&>svg:last-child]:transition-transform [&>svg:last-child]:duration-fast motion-reduce:[&>svg:last-child]:transition-none data-[state=open]:[&>svg:last-child]:rotate-180",
          )}
        >
          {icono}
          <span data-slot="valor" className="min-w-0 flex-1 truncate">
            <SelectValue>{actual?.etiqueta}</SelectValue>
          </span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-[var(--radix-select-trigger-width)]">
          {opciones.map((o) => (
            <SelectItem key={o.valor} value={o.valor} data-valor={o.valor} className="font-medium">
              {o.etiqueta}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

