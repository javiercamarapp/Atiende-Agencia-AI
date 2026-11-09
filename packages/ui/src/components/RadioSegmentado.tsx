// Selector segmentado de Likida (`dashboard/[id]/revision-panel.tsx:128-139`, decision 6 de la
// spec): `role="radiogroup"` con una pildora `<label>` por opcion y un `<input type="radio"
// class="sr-only">` real (teclado y lector de pantalla nativos, sin RadioGroup de Radix). El foco
// se pinta en el label con la regla `label:has(> input.sr-only:focus-visible)` de index.css.
// Activa = primario suave de Rovaq con el azul de Atiende (tinte --primary-soft, texto --primary-ink y anillo de 1 px al 30 %), no el azul
// solido (auditoria R2 #8); inactiva = hairline sobre tarjeta. 28 px de alto y radio de control (8 px bajo ds3).
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
    <div role="radiogroup" aria-label={label} className={cn("ds3-segmentado flex flex-wrap gap-2", className)}>
      {opciones.map((o) => {
        const activa = o.id === value;
        return (
          <label
            key={o.id}
            className={cn(
              "inline-flex min-h-7 items-center gap-1.5 rounded-control border px-3 py-1 text-pill font-medium transition-colors duration-fast ease-brand",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              activa ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-border bg-card text-foreground hover:bg-soft",
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
