import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

// Mismo material que el resto de ventanas flotantes (spec UNI-3c 6.5): hairline,
// bg-card, radio 16, sombra de elevacion y relleno p-3 de las tarjetas de seccion.
// Radix aporta el manejo de foco (se devuelve al disparador al cerrar) y Escape.
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-ui text-popover-foreground shadow-elevated rest:rounded-menu rest:p-4 rest:text-sm outline-none data-[state=open]:animate-popover-in data-[state=closed]:animate-overlay-out",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent };
