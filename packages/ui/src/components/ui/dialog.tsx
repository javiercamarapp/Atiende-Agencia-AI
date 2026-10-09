import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";
import { BOTON_CIERRE_MODAL, CAJA_MODAL, CAJA_MODAL_MOVIL, CHIP_ICONO_MODAL, OVERLAY_MODAL, TAMANOS_MODAL, type TamanoModal } from "./superficies";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(OVERLAY_MODAL, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideDefaultClose?: boolean; size?: TamanoModal }
>(({ className, children, hideDefaultClose = false, size = "md", ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(CAJA_MODAL, TAMANOS_MODAL[size], CAJA_MODAL_MOVIL, className)}
      {...props}
    >
      {children}
      {!hideDefaultClose && (
        // Cierre de 44 px solo en movil (objetivo tactil); en escritorio 32 px como los botones de icono de Likida.
        <DialogPrimitive.Close className={BOTON_CIERRE_MODAL}>
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="sr-only">Cerrar</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * Cabecera del modal. Con `icono` pinta el chip circular de 40 px a la izquierda del titulo
 * (`tono` lo tiñe: danger para confirmaciones destructivas).
 */
const DialogHeader = ({
  className,
  icono: Icono,
  tono = "default",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { icono?: React.ComponentType<{ className?: string; strokeWidth?: number | string }>; tono?: keyof typeof CHIP_ICONO_MODAL }) =>
  Icono ? (
    <div className={cn("flex min-w-0 items-start gap-3 pr-10 text-left", className)} {...props}>
      <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", CHIP_ICONO_MODAL[tono])}>
        <Icono className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">{children}</div>
    </div>
  ) : (
    <div className={cn("flex min-w-0 flex-col gap-1 pr-10 text-left", className)} {...props}>
      {children}
    </div>
  );
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold leading-snug", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-ui text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
