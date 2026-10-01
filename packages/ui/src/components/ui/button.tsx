import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/utils";

// Anatomía de píldora (rounded-full en todos los tamaños), feedback de press
// global vía CSS (:active { scale(.97) }) en index.css.
//
// El alto sale de --control-sm/md/lg (index.css): 32/36/40 px, los h-8/h-9/h-10
// de Likida, en todos los anchos. Transiciones enumeradas con los tokens
// de motion (nada de transition-all). Variantes retiradas por no tener ningún
// uso en el repo: hero, terracotta, gold y el tamaño xl.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[0.005em] ring-offset-background transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-fast ease-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-card motion-safe:hover:-translate-y-px motion-safe:hover:shadow-[0_10px_26px_hsl(var(--primary)/0.26)]",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-border bg-card text-foreground hover:border-[color-mix(in_srgb,hsl(var(--foreground))_26%,transparent)] motion-safe:hover:-translate-y-px",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[var(--control-md)] px-5 py-2",
        md: "h-[var(--control-md)] px-5 py-2",
        sm: "h-[var(--control-sm)] px-4",
        lg: "h-[var(--control-lg)] px-8 text-base",
        icon: "h-[var(--control-md)] w-[var(--control-md)]",
        "icon-sm": "h-[var(--control-sm)] w-[var(--control-sm)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Renderiza el hijo (p. ej. <Link>) con los estilos del botón. `loading`, `iconLeft` e `iconRight` no aplican. */
  asChild?: boolean;
  /**
   * Operación en curso: muestra un spinner en lugar de `iconLeft`, marca
   * `aria-busy` y bloquea el botón (un doble clic no duplica el envío). El
   * texto se conserva para que el ancho no salte y el lector de pantalla lo siga leyendo.
   */
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, iconLeft, iconRight, disabled, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    if (asChild) {
      return (
        <Slot className={classes} ref={ref} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} {...props}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        data-loading={loading ? "" : undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : iconLeft}
        {children}
        {iconRight}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
