import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

// success / warning / info usan los tokens semánticos (par texto + tinte con
// contraste >= 4.5:1 en claro y oscuro, ver tests/tokens-likida.spec.ts):
// reemplazan los pares bg-green-100 text-green-800 dark:... escritos a mano.
// Para un estado de negocio (pendiente, pagado, vencido) prefiere <StatusBadge>.
const badgeVariants = cva(
  "inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-colors rest:px-2.5 rest:font-semibold",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "border-border text-foreground",
        success: "bg-success-tint text-success",
        warning: "bg-warning-tint text-warning",
        info: "bg-info-tint text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
