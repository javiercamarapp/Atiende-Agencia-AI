import * as React from "react";
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
//
// Tema: antes `theme="system"` (seguia solo al sistema operativo e ignoraba el
// ThemeSelector). Ahora sigue la clase `dark` de <html>, la misma que alterna
// el ThemeSelector (que ya resuelve "sistema" contra prefers-color-scheme).
function useTemaOscuro(): "light" | "dark" {
  const leer = () => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [tema, setTema] = React.useState<"light" | "dark">(leer);
  React.useEffect(() => {
    setTema(leer());
    const obs = new MutationObserver(() => setTema(leer()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return tema;
}

const Toaster = ({ ...props }: ToasterProps) => {
  const tema = useTemaOscuro();
  return (
    <Sonner
      theme={tema}
      closeButton
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
          // Sonner define su propio color de texto por defecto en [data-title]/
          // [data-description] (sobrevive a heredar el `text-destructive-foreground`
          // del contenedor) -- se fuerza aquí con selectores de descendiente.
          success: "[&_[data-icon]]:text-success",
          warning: "[&_[data-icon]]:text-warning",
          info: "[&_[data-icon]]:text-info",
          error:
            "group-[.toaster]:border-destructive/30 group-[.toaster]:bg-destructive group-[.toaster]:text-destructive-foreground [&_[data-title]]:!text-destructive-foreground [&_[data-description]]:!text-destructive-foreground [&_[data-description]]:!opacity-85",
        },
      }}
      {...props}
    />
  );
};

// ---- notify -------------------------------------------------------------
// API de feedback efimero de DS v2 (4.4/4.5): exito/aviso/error/info + deshacer.
// Duraciones: 4 s exito/info, 6 s aviso, 8 s error; con accion (`deshacer`)
// el toast se queda hasta que la persona decida (persist) -- el boton de
// cerrar siempre esta visible.
export interface NotifyDeshacer {
  /** @default "Deshacer" */
  readonly etiqueta?: string;
  readonly onClick: () => void;
}

export interface NotifyOpciones {
  readonly description?: string;
  /** Milisegundos; sustituye a la duracion por tipo. `Infinity` = persistente. */
  readonly duracion?: number;
  readonly deshacer?: NotifyDeshacer;
  readonly id?: string | number;
}

export const DURACION_NOTIFY_MS = { success: 4000, info: 4000, warning: 6000, error: 8000 } as const;

type TipoNotify = keyof typeof DURACION_NOTIFY_MS;

function opcionesSonner(tipo: TipoNotify, o: NotifyOpciones | undefined) {
  const accion = o?.deshacer;
  return {
    id: o?.id,
    description: o?.description,
    duration: o?.duracion ?? (accion ? Infinity : DURACION_NOTIFY_MS[tipo]),
    action: accion ? { label: accion.etiqueta ?? "Deshacer", onClick: accion.onClick } : undefined,
  };
}

export const notify = {
  success: (mensaje: string, o?: NotifyOpciones) => toast.success(mensaje, opcionesSonner("success", o)),
  warning: (mensaje: string, o?: NotifyOpciones) => toast.warning(mensaje, opcionesSonner("warning", o)),
  error: (mensaje: string, o?: NotifyOpciones) => toast.error(mensaje, opcionesSonner("error", o)),
  info: (mensaje: string, o?: NotifyOpciones) => toast.info(mensaje, opcionesSonner("info", o)),
  /** Toast de progreso: cargando -> exito/error segun resuelva la promesa. */
  promise: <T,>(
    promesa: Promise<T>,
    mensajes: { readonly cargando: string; readonly exito: string | ((v: T) => string); readonly error: string | ((e: unknown) => string) },
  ) => {
    toast.promise(promesa, { loading: mensajes.cargando, success: mensajes.exito, error: mensajes.error });
    return promesa;
  },
  dismiss: (id?: string | number) => toast.dismiss(id),
};

export { Toaster, toast };
