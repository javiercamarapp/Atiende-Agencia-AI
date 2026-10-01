import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";

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
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideDefaultClose?: boolean }
>(({ className, children, hideDefaultClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Material de la ventana flotante de Likida (spec UNI-3c, 6.5): hairline, bg-card,
        // radio 16, sombra de elevacion y p-4. En < md es una hoja inferior (rounded-t-2xl,
        // con el hueco de safe-area abajo) que sube con sheet-up; en >= md, centrado con modal-in.
        "fixed inset-0 z-50 m-auto grid h-fit max-h-[calc(100dvh-2rem)] w-full max-w-lg gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 text-card-foreground shadow-elevated data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out",
        "max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:m-0 max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-2xl max-md:pb-[calc(1rem+var(--safe-area-bottom))] max-md:data-[state=open]:animate-sheet-up max-md:data-[state=closed]:animate-sheet-down",
        className,
      )}
      {...props}
    >
      {children}
      {!hideDefaultClose && (
        // Cierre de 44 px solo en movil (objetivo tactil); en escritorio 32 px como los botones de icono de Likida.
        <DialogPrimitive.Close className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color] duration-fast ease-brand hover:bg-canvas hover:text-foreground disabled:pointer-events-none md:size-8">
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="sr-only">Cerrar</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex min-w-0 flex-col gap-1 pr-10 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
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
