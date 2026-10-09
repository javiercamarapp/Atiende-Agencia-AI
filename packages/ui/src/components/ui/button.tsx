import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/utils";

// Botones identicos a Likida (UNI-3a): rounded-md (12 px), text-sm font-medium,
// sin sombra ni elevacion al hover. El alto sale de --control-sm/md/lg (index.css):
// 32/36/40 px, los h-8/h-9/h-10 de Likida, en todos los anchos; `xs` (h-7) es el
// boton de toolbar. El foco lo pinta el outline global de index.css (:focus-visible,
// 3 px --ring, offset 2), igual que Likida: ya no hay un segundo anillo propio.
// Transiciones enumeradas con los tokens de motion (nada de transition-all).
// Feedback de press global vía CSS (:active { scale(.97) }) en index.css.
// Variantes retiradas por no tener ningun uso en el repo: hero, terracotta, gold y el tamano xl.
// Ambito restaurantes (UNI-R0b): el boton del repo suelto (button-variants.ts) llega por las clases `ambito-boton*` (index.css, solo bajo
// html[data-ambito=restaurantes]): pildora, semibold, px-5/4/8 por tamano, primario con sombra y elevacion de 1 px, destructivo en rojo SOLIDO,
// outline con borde que se oscurece. Los altos (40/36/48) y los 200 ms salen de --control-* y --dur-fast del ambito. Fuera de el, estas clases no hacen nada.
const buttonVariants = cva(
  "ambito-boton inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,opacity,transform] duration-fast ease-brand disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "ambito-boton-primario bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "ambito-boton-peligro bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // Peligro como Likida (--bad sobre --badbg): tinte suave + texto de peligro.
        danger: "ambito-boton-peligro bg-destructive-tint text-destructive hover:opacity-85",
        "danger-outline": "border border-destructive/40 bg-card text-destructive hover:bg-destructive-tint",
        outline: "ambito-boton-borde border border-border bg-card text-foreground hover:bg-canvas",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "ambito-boton-md h-[var(--control-md)] px-4",
        md: "ambito-boton-md h-[var(--control-md)] px-4",
        // CTA de cabecera de Likida: h-8 px-3 rounded-lg text-[13px].
        sm: "ambito-boton-sm h-[var(--control-sm)] rounded-lg px-3 text-ui",
        // Boton de toolbar de Likida: h-7 px-2.5 rounded-lg text-xs.
        xs: "ambito-boton-xs h-7 rounded-lg px-2.5 text-xs",
        lg: "ambito-boton-lg h-[var(--control-lg)] px-6",
        icon: "h-[var(--control-md)] w-[var(--control-md)]",
        "icon-sm": "h-[var(--control-sm)] w-[var(--control-sm)] rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Texto unificado del estado de guardado (reemplaza los "Guardando..." escritos a mano en cada pantalla). */
export const TEXTO_GUARDANDO = "Guardando...";

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
  /**
   * Texto que reemplaza a `children` mientras `loading` es true. `true` usa el
   * texto unificado "Guardando..." (TEXTO_GUARDANDO). Sin esta prop el texto se conserva.
   */
  loadingText?: React.ReactNode;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, loadingText, iconLeft, iconRight, disabled, children, ...props }, ref) => {
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
        {loading && loadingText !== undefined && loadingText !== false ? (loadingText === true ? TEXTO_GUARDANDO : loadingText) : children}
        {iconRight}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
