import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const pageContainerVariants = cva("mx-auto grid w-full gap-6 motion-safe:animate-page-in", {
  variants: {
    size: {
      sm: "max-w-2xl",
      md: "max-w-4xl",
      lg: "max-w-6xl",
      xl: "max-w-[88rem]",
    },
    padding: {
      default: "p-4 md:p-6",
      none: "",
    },
  },
  defaultVariants: { size: "lg", padding: "default" },
});

export interface PageContainerProps extends React.HTMLAttributes<HTMLElement>, VariantProps<typeof pageContainerVariants> {
  /** Elemento a renderizar. El `<main>` lo pone el shell; usar "main" solo fuera de un shell. @default "div" */
  readonly as?: "div" | "section" | "main";
}

/**
 * Contenedor de pagina de DS v2 (4.4/4.5): ancho maximo por `size`, relleno y
 * entrada `page-in` (fade + translateY 8px, 250 ms) una vez al montar, solo con
 * movimiento permitido. Sin stagger. Dentro de un `<main>` que ya tiene su
 * propio relleno, usa `padding="none"`.
 */
export const PageContainer = React.forwardRef<HTMLElement, PageContainerProps>(
  ({ as = "div", size, padding, className, ...props }, ref) => {
    const Tag = as as React.ElementType;
    return <Tag ref={ref} className={cn(pageContainerVariants({ size, padding }), className)} {...props} />;
  },
);
PageContainer.displayName = "PageContainer";
