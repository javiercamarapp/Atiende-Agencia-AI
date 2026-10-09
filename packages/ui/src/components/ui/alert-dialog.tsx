// Portado de atiende-restaurantes (src/components/ui/alert-dialog.tsx, el
// "estándar de oro" de esta fusión) -- shadcn/radix estándar, mismo patrón que
// dialog.tsx de este mismo directorio. Separado a propósito de
// `ModalFormularioLateral.tsx`: ese componente es para formularios reales de
// captura de datos (rail con logo, max-w-5xl); este es para confirmaciones
// pequeñas ("¿Cancelar esta reserva?") -- la propia referencia real las trata
// como componentes distintos (ver PedidosSection.tsx de atiende-restaurantes,
// que usa AlertDialog para "¿Cancelar este pedido?", nunca su modal de
// formulario para esto).
import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";
import { CAJA_MODAL, CAJA_MODAL_MOVIL, CHIP_ICONO_MODAL, OVERLAY_MODAL, TAMANOS_MODAL, type TamanoModal } from "./superficies";

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    className={cn(OVERLAY_MODAL, className)}
    {...props}
    ref={ref}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> & { size?: TamanoModal }
>(({ className, size = "md", ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(CAJA_MODAL, TAMANOS_MODAL[size], CAJA_MODAL_MOVIL, className)}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

const AlertDialogHeader = ({
  className,
  icono: Icono,
  tono = "default",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { icono?: React.ComponentType<{ className?: string; strokeWidth?: number | string }>; tono?: keyof typeof CHIP_ICONO_MODAL }) =>
  Icono ? (
    <div className={cn("flex min-w-0 items-start gap-3 text-left", className)} {...props}>
      <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", CHIP_ICONO_MODAL[tono])}>
        <Icono className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">{children}</div>
    </div>
  ) : (
    <div className={cn("flex min-w-0 flex-col gap-1 text-left", className)} {...props}>
      {children}
    </div>
  );
AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
AlertDialogFooter.displayName = "AlertDialogFooter";

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn("text-base font-semibold leading-snug rest:text-lg rest:leading-none rest:tracking-tight", className)} {...props} />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description ref={ref} className={cn("text-ui text-muted-foreground rest:text-sm", className)} {...props} />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Action ref={ref} className={cn(buttonVariants(), className)} {...props} />
));
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel ref={ref} className={cn(buttonVariants({ variant: "outline" }), className)} {...props} />
));
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
