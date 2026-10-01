import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

// Contrato de pagina identico al de Likida: sin `max-w` (ancho completo del marco), `gap-2.5`
// entre bloques (`space-y-2.5` del cuerpo de `admin/consola.tsx`) y sin animacion propia: la
// entrada `page-in` ya la aplica el shell al cambiar de ruta (una sola vez, no doble).
const pageContainerVariants = cva("grid w-full min-w-0 gap-2.5", {
  variants: {
    padding: {
      none: "",
      default: "p-4 md:p-6",
    },
  },
  defaultVariants: { padding: "none" },
});

export interface PageContainerProps extends React.HTMLAttributes<HTMLElement>, VariantProps<typeof pageContainerVariants> {
  /** Elemento a renderizar. El `<main>` lo pone el shell; usar "main" solo fuera de un shell. @default "div" */
  readonly as?: "div" | "section" | "main";
}

/**
 * Contenedor de pagina: columna de ancho completo con `gap-2.5`. Dentro de un shell el
 * relleno lo pone el `<main>` (`padding="none"`, el valor por defecto); fuera de un shell
 * pasa `padding="default"`. No anima: la entrada la pone el shell.
 */
export const PageContainer = React.forwardRef<HTMLElement, PageContainerProps>(({ as = "div", padding, className, ...props }, ref) => {
  const Tag = as as React.ElementType;
  return <Tag ref={ref} className={cn(pageContainerVariants({ padding }), className)} {...props} />;
});
PageContainer.displayName = "PageContainer";
