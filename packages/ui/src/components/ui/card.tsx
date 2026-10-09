import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Tarjeta de Likida (`.card`, globals.css:234-239): radio 16, borde hairline,
 * sombra fina. `min-w-0` evita que, como hijo de una rejilla o flex, la tarjeta se ensanche hasta el ancho minimo
 * de una tabla ancha (la tabla debe hacer scroll DENTRO de la tarjeta). NO trae relleno propio: cada uso pone el suyo, como en Likida
 * (`p-4` tarjeta normal, `p-3` seccion, `p-2` KPI). La clase `card` es el
 * gancho de `.card table` (filas punteadas, ui/index.css).
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("card min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)} {...props} />
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

/**
 * Panel: la tarjeta de seccion del repo suelto (`rounded-2xl border bg-card p-4 space-y-3`), con la
 * misma receta de borde/radio/fondo que Card y el relleno incluido. Contenedor de TODA lista, tabla
 * o grupo de una pantalla. `relleno="none"` para tablas que van a sangre.
 */
const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article"; relleno?: "none" | "sm" | "md" }>(
  ({ className, as: Tag = "div", relleno = "md", ...props }, ref) => (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={cn("card min-w-0 rounded-lg border border-border bg-card text-card-foreground", relleno === "md" && "space-y-3 p-4", relleno === "sm" && "space-y-2 p-3", className)}
      {...props}
    />
  ),
);
Panel.displayName = "Panel";

export { Panel, Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
