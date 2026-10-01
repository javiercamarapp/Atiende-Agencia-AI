import * as React from "react";

import { cn } from "../../lib/utils";

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "defaultValue"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Con `name`, se emite un <input type="hidden"> ("on" / ausente) para que viaje en un <form> nativo. */
  name?: string;
}

/**
 * Interruptor accesible: <button role="switch" aria-checked>. Tab lo alcanza y
 * Espacio / Enter lo alternan (comportamiento nativo de button). Controlado
 * (`checked` + `onCheckedChange`) o no controlado (`defaultChecked`). Requiere
 * nombre accesible: <label htmlFor>, `aria-label` o `aria-labelledby`.
 * Apagado usa el trazo `control` (>= 3:1 contra el fondo).
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, defaultChecked = false, onCheckedChange, name, disabled, onClick, ...props }, ref) => {
    const [interno, setInterno] = React.useState(defaultChecked);
    const controlado = checked !== undefined;
    const activo = controlado ? checked : interno;

    return (
      <>
        <button
          ref={ref}
          type="button"
          role="switch"
          aria-checked={activo}
          data-state={activo ? "checked" : "unchecked"}
          disabled={disabled}
          onClick={(e) => {
            onClick?.(e);
            if (e.defaultPrevented) return;
            const siguiente = !activo;
            if (!controlado) setInterno(siguiente);
            onCheckedChange?.(siguiente);
          }}
          className={cn(
            "peer relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-control transition-colors duration-fast ease-brand disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
            className,
          )}
          {...props}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none block size-5 translate-x-px rounded-full bg-white shadow-card transition-transform duration-fast ease-brand data-[state=checked]:translate-x-[17px]"
            data-state={activo ? "checked" : "unchecked"}
          />
        </button>
        {name !== undefined && activo && <input type="hidden" name={name} value="on" />}
      </>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
