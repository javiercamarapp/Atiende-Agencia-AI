import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Tarjeta de Likida (`.card`, globals.css:234-239): radio 16, borde hairline,
 * sombra fina. NO trae relleno propio: cada uso pone el suyo, como en Likida
 * (`p-4` tarjeta normal, `p-3` seccion, `p-2` KPI). La clase `card` es el
 * gancho de `.card table` (filas punteadas, ui/index.css).
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("card rounded-lg border border-border bg-card text-card-foreground shadow-card", className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col space-y-1 p-4", className)} {...props} />,
);
CardHeader.displayName = "CardHeader";

/** Titulo de tarjeta de Likida (`text-sm font-medium`, consola.tsx:462): un h2 limpio, sin tracking ni 24 px. */
const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h2 ref={ref} className={cn("text-sm font-medium leading-snug text-foreground", className)} {...props} />,
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <p ref={ref} className={cn("text-ui text-muted-foreground", className)} {...props} />,
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center p-4 pt-0", className)} {...props} />,
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
