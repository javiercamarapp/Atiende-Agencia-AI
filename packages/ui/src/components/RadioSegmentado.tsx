// Selector segmentado de Likida (`dashboard/[id]/revision-panel.tsx:128-139`, decision 6 de la
// spec): `role="radiogroup"` con una pildora `<label>` por opcion y un `<input type="radio"
// class="sr-only">` real (teclado y lector de pantalla nativos, sin RadioGroup de Radix). El foco
// se pinta en el label con la regla `label:has(> input.sr-only:focus-visible)` de index.css.
// Activa = azul de Atiende donde Likida usa tinta; inactiva = hairline sobre tarjeta.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface RadioSegmentadoOpcion<T extends string = string> {
  readonly id: T;
  readonly rotulo: ReactNode;
  readonly icono?: ReactNode;
}

export interface RadioSegmentadoProps<T extends string = string> {
  /** Nombre del grupo de radios (obligatorio: agrupa y habilita las flechas del teclado). */
  readonly name: string;
  /** Nombre accesible del grupo. */
  readonly label: string;
  readonly opciones: readonly RadioSegmentadoOpcion<T>[];
  readonly value: T;
  readonly onChange: (id: T) => void;
  /** Bloquea todo el grupo (p. ej. mientras se guarda). */
  readonly disabled?: boolean;
  readonly className?: string;
}

export function RadioSegmentado<T extends string = string>({ name, label, opciones, value, onChange, disabled = false, className }: RadioSegmentadoProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {opciones.map((o) => {
        const activa = o.id === value;
        return (
          <label
            key={o.id}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-pill font-medium",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              activa ? "bg-primary text-primary-foreground" : "border border-border bg-card text-foreground",
            )}
          >
            <input type="radio" name={name} value={o.id} checked={activa} disabled={disabled} onChange={() => onChange(o.id)} className="sr-only" />
            {o.icono}
            {o.rotulo}
          </label>
        );
      })}
    </div>
  );
}
