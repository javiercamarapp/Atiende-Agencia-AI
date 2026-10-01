import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "../../lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Desplazable en horizontal: con 4+ pestanas en movil las del final quedan alcanzables
      // (el foco con flechas las trae a la vista). Sin barra visible, como las tabs de Likida.
      // Las pantallas que piden `flex-wrap` envuelven en varias filas: con la clase presente la
      // altura pasa a auto y el overflow a visible (si no, las filas extra quedarian recortadas).
      "inline-flex h-9 max-w-full items-center justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-lg bg-muted p-1 text-muted-foreground [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&.flex-wrap]:h-auto [&.flex-wrap]:overflow-visible",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Activa en azul de marca (bg-primary) con la forma de Likida. El foco usa el outline
      // global sin offset para no recortarse con el overflow del TabsList.
      "inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 text-ui font-medium transition-[color,background-color] duration-fast ease-brand data-[state=active]:bg-primary data-[state=active]:text-primary-foreground focus-visible:outline-offset-0 disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      // Foco: solo el outline global de 3 px (un unico indicador, como Button/Checkbox/Switch).
      "mt-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
