import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Tarjeta de Likida (`.card`, globals.css:234-239): radio 16, borde hairline,
 * sombra fina. `min-w-0` evita que, como hijo de una rejilla o flex, la tarjeta se ensanche hasta el ancho minimo
 * de una tabla ancha (la tabla debe hacer scroll DENTRO de la tarjeta). NO trae relleno propio: cada uso pone el suyo, como en Likida
 * (`p-4` tarjeta normal, `p-3` seccion, `p-2` KPI). La clase `card` es el
 * gancho de `.card table` (filas punteadas, ui/index.css).
 */
/** Variantes de superficie (ds3 §3.2): `flush` = tabla a sangre, `bare` = sin marco, `interactive` = bloque entero clicable, `highlight` = filete superior de 3 px con `tono`. */
export type CardVariante = "default" | "flush" | "bare" | "interactive" | "highlight";
/** Tono del filete de `highlight` (serie 1..8 de la paleta categorica). Mapa de clases ESTATICAS para que Tailwind las vea. */
export type CardTono = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const TONO_FILETE: Record<CardTono, string> = {
  1: "border-t-chart-1",
  2: "border-t-chart-2",
  3: "border-t-chart-3",
  4: "border-t-chart-4",
  5: "border-t-chart-5",
  6: "border-t-chart-6",
  7: "border-t-chart-7",
  8: "border-t-chart-8",
};
/** Clases ESTATICAS por variante (Tailwind solo conserva las reglas de `@layer utilities` cuyas clases aparecen literales). */
const CLASE_VARIANTE: Record<CardVariante, string> = {
  default: "",
  flush: "ds3-card-flush",
  bare: "ds3-card-bare",
  interactive: "ds3-card-interactive",
  highlight: "ds3-card-highlight",
};
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Solo cambia el aspecto bajo el diseno ds3; sin la bandera no hace nada. */
  variante?: CardVariante;
  /** Solo con `variante="highlight"`. */
  tono?: CardTono;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, variante = "default", tono, ...props }, ref) => (
  <div
    ref={ref}
    data-variante={variante === "default" ? undefined : variante}
    className={cn(
      "card ds3-card min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-card",
      CLASE_VARIANTE[variante],
      variante === "highlight" && tono !== undefined && TONO_FILETE[tono],
      className,
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("ds3-card-header flex flex-col space-y-1 p-4", className)} {...props} />,
);
CardHeader.displayName = "CardHeader";

/** Titulo de tarjeta de Likida (`text-sm font-medium`, consola.tsx:462): un h2 limpio, sin tracking ni 24 px. */
const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h2 ref={ref} className={cn("ds3-card-title text-sm font-medium leading-snug text-foreground", className)} {...props} />,
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => <p ref={ref} className={cn("ds3-card-desc text-ui text-muted-foreground", className)} {...props} />,
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("ds3-card-content p-4 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("ds3-card-footer flex items-center p-4 pt-0", className)} {...props} />,
);
CardFooter.displayName = "CardFooter";

/**
 * Panel: la tarjeta de seccion del repo suelto (`rounded-2xl border bg-card p-4 space-y-3`): mismo borde, radio y fondo que Card,
 * con el relleno incluido y sin sombra (contenedor de listas, tablas o grupos dentro de una pantalla). `relleno="none"` para tablas a sangre.
 */
const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article"; relleno?: "none" | "sm" | "md" }>(
  ({ className, as: Tag = "div", relleno = "md", ...props }, ref) => (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={cn("card ds3-card min-w-0 rounded-lg border border-border bg-card text-card-foreground", relleno === "md" && "ds3-card-panel-md space-y-3 p-4", relleno === "sm" && "ds3-card-panel-sm space-y-2 p-3", className)}
      {...props}
    />
  ),
);
Panel.displayName = "Panel";

export { Panel, Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
