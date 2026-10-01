import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";

import { cn } from "../../lib/utils";
import { campoBase } from "./field-styles";

// py-0: con h-9 (36 px), borde de 1 px y text-ui de 19.5 px de interlineado, un py-2
// dejaba solo 18 px de contenido y el texto salia recortado (hallazgo del revisor de #296,
// restaurantes-staff-movil); el <select> centra su texto en vertical por si solo.
const nativeSelectVariants = cva(`${campoBase} appearance-none pr-9`, {
  variants: {
    size: {
      sm: "h-[var(--control-sm)] py-0",
      md: "h-[var(--control-md)] py-0",
    },
  },
  defaultVariants: { size: "md" },
});

export interface NativeSelectProps
  extends Omit<React.ComponentPropsWithoutRef<"select">, "size">,
    VariantProps<typeof nativeSelectVariants> {
  /** Clases del contenedor (el chevron es hermano del <select>). `className` va al <select>. */
  wrapperClassName?: string;
}

/**
 * <select> nativo con el estilo de los campos de DS v2. Es nativo a propósito:
 * teclado, lectores de pantalla y selector del sistema en móvil funcionan sin
 * JavaScript propio, y no añade dependencias (no hay @radix-ui/react-select en
 * el repo). Lleva sus <option> como hijos, igual que un <select> normal.
 */
const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, wrapperClassName, size, children, ...props }, ref) => (
    <div className={cn("relative w-full", wrapperClassName)}>
      <select ref={ref} className={cn(nativeSelectVariants({ size }), className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  ),
);
NativeSelect.displayName = "NativeSelect";

export { NativeSelect, nativeSelectVariants };
