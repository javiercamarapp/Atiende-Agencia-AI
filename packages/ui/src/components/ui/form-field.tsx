import * as React from "react";

import { cn } from "../../lib/utils";
import { Label } from "./label";

/** Props que FormField inyecta al control para enlazar etiqueta, ayuda y error. */
export interface FormFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FormFieldProps {
  label: React.ReactNode;
  /** Ayuda visible siempre (formato, ejemplo). */
  hint?: React.ReactNode;
  /** Mensaje de error del campo: lo anuncia el lector de pantalla y marca el control como inválido. */
  error?: React.ReactNode;
  required?: boolean;
  /** Id del control; por defecto se genera uno. */
  id?: string;
  className?: string;
  /**
   * El control: un elemento (Input, Textarea, NativeSelect, Checkbox...) que
   * recibe id, aria-describedby, aria-invalid y aria-required, o una función
   * que recibe esas props para controles compuestos.
   */
  children: React.ReactElement | ((props: FormFieldControlProps) => React.ReactNode);
}

/**
 * Etiqueta + control + ayuda + error con los enlaces ARIA ya hechos
 * (`htmlFor`, `aria-describedby`, `aria-invalid`). Reemplaza el par
 * <Label> + <p> manual. `required` marca el campo con asterisco visual y
 * `aria-required` (no usa el atributo HTML `required`, para no disparar la
 * validación nativa del navegador: la validación es de la pantalla).
 */
export function FormField({ label, hint, error, required, id, className, children }: FormFieldProps) {
  const autoId = React.useId();
  const idPropioDelControl = typeof children === "function" ? undefined : (children.props as { id?: string }).id;
  const controlId = id ?? idPropioDelControl ?? `campo-${autoId.replace(/:/g, "")}`;
  const hintId = hint ? `${controlId}-ayuda` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const controlProps: FormFieldControlProps = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    "aria-required": required ? true : undefined,
  };

  let control: React.ReactNode;
  if (typeof children === "function") {
    control = children(controlProps);
  } else {
    const propios = children.props as Partial<FormFieldControlProps>;
    control = React.cloneElement(children, {
      ...controlProps,
      "aria-describedby": [propios["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
    });
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={controlId}>
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
            <span className="sr-only"> (obligatorio)</span>
          </>
        )}
      </Label>
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
