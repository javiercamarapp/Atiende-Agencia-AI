import * as React from "react";
import { Check, Minus } from "lucide-react";

import { cn } from "../../lib/utils";

export interface CheckboxProps extends Omit<React.ComponentPropsWithoutRef<"input">, "type" | "size"> {
  /** Estado mixto (p. ej. "seleccionar todo" con selección parcial): se refleja en la propiedad `indeterminate` del DOM (los lectores de pantalla lo anuncian como "mixto"). */
  indeterminate?: boolean;
  /** Texto de la casilla. Con `label` el control se envuelve en un <label> con área de toque completa. */
  label?: React.ReactNode;
  descripcion?: React.ReactNode;
  /** Clases del contenedor <label> (solo con `label`). `className` va al <input>. */
  wrapperClassName?: string;
}

/**
 * Casilla nativa (<input type="checkbox">) dibujada con el trazo `control`
 * (>= 3:1 contra el fondo, WCAG 1.4.11). Es el input real: Tab, Espacio, formularios y
 * lectores de pantalla funcionan sin JavaScript propio.
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, label, descripcion, wrapperClassName, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRef = React.useCallback(
      (el: HTMLInputElement | null) => {
        innerRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef],
    );
    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate, props.checked]);

    const caja = (
      <span className="relative inline-flex size-[18px] shrink-0 items-center justify-center">
        <input
          ref={setRef}
          type="checkbox"
          className={cn(
            "peer size-full cursor-pointer appearance-none rounded-[5px] border border-control bg-background ring-offset-background transition-[background-color,border-color,box-shadow] duration-fast ease-brand checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive",
            className,
          )}
          {...props}
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-0"
        />
        <Minus
          aria-hidden="true"
          strokeWidth={3}
          className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-indeterminate:opacity-100"
        />
      </span>
    );

    if (label === undefined) return caja;
    return (
      <label className={cn("flex min-h-6 cursor-pointer items-start gap-2.5 text-sm", props.disabled && "cursor-not-allowed opacity-70", wrapperClassName)}>
        {caja}
        <span className="grid gap-0.5 leading-5">
          <span className="font-medium text-foreground">{label}</span>
          {descripcion !== undefined && <span className="text-xs text-muted-foreground">{descripcion}</span>}
        </span>
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
