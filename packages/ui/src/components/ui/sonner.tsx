import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Pedido real de Javier ("hazme todos los mensajes que salgan así — más
// como el software elegante minimalista con letra fina, elegante,
// tipografía como el software, compacto animado"), portado del componente
// de toast de atiende-restaurantes (src/components/ui/toast.tsx) a las
// clases que expone sonner: tarjeta redondeada con blur, tipografía
// compacta font-display/font-body, y SOLO el tipo error con fondo sólido
// (el resto se queda neutro/glassy). Este es el único componente
// compartido detrás de cada llamada a toast() en toda la app -- se
// corrige una vez y aplica a las 6 verticales por igual.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      aria-live="polite"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-2xl group-[.toaster]:border group-[.toaster]:border-border/60 group-[.toaster]:bg-background/95 group-[.toaster]:text-foreground group-[.toaster]:shadow-[0_10px_30px_-8px_rgb(0,0,0,0.18)] group-[.toaster]:backdrop-blur-sm",
          title: "group-[.toast]:font-display group-[.toast]:text-[13.5px] group-[.toast]:font-medium group-[.toast]:tracking-tight",
          description: "group-[.toast]:font-body group-[.toast]:text-[12.5px] group-[.toast]:leading-snug group-[.toast]:opacity-75",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          error: "group-[.toaster]:border-destructive/30 group-[.toaster]:bg-destructive group-[.toaster]:text-destructive-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
