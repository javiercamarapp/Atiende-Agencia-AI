import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, OctagonAlert, X } from "lucide-react";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Toast con el material de card de Likida (spec UNI-3c 6.5): radio 16, hairline,
// bg-card, sombra de elevacion y texto de 13 px; sin blur ni fuente de pantalla.
// El error usa el par peligro/tinte de Likida (--bad sobre --badbg) en lugar del
// bloque rojo solido. Este es el unico componente compartido detras de cada
// llamada a toast() en toda la app: se corrige una vez y aplica a las 6 verticales.
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

// Anuncio: sonner anuncia cada toast por su region aria-live="polite" (incluidos los errores); no se intenta forzar "assertive":
// sonner 1.7 no lo ofrece por toast y duplicar el texto en otra region rompia lectores de pantalla y pruebas.

/** Limite de toasts apilados a la vez (los demas esperan; sonner los pliega). */
export const TOASTS_VISIBLES = 3;

const Toaster = ({ ...props }: ToasterProps) => {
  const tema = useTemaOscuro();
  return (
    <>
      <Sonner
        theme={tema}
        closeButton
        position="bottom-right"
        visibleToasts={TOASTS_VISIBLES}
        duration={DURACION_NOTIFY_MS.success}
        gap={10}
        offset={20}
        className="toaster group"
        aria-live="polite"
        icons={{
          success: <CheckCircle2 aria-hidden="true" className="size-5" strokeWidth={1.75} />,
          info: <Info aria-hidden="true" className="size-5" strokeWidth={1.75} />,
          warning: <AlertTriangle aria-hidden="true" className="size-5" strokeWidth={1.75} />,
          error: <OctagonAlert aria-hidden="true" className="size-5" strokeWidth={1.75} />,
          loading: <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} />,
          close: <X aria-hidden="true" className="size-3.5" strokeWidth={2} />,
        }}
        toastOptions={{
          classNames: {
            // Tarjeta premium: radio de dialogo, hairline, sombra elevada, 360 px comodos y barra de
            // autocierre (clase `toast-progreso`, index.css). Familia unica con Dialog/Popover.
            toast:
              "group toast toast-progreso group-[.toaster]:w-[min(22.5rem,calc(100vw-2rem))] group-[.toaster]:items-start group-[.toaster]:gap-3 group-[.toaster]:overflow-hidden group-[.toaster]:rounded-dialog group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:bg-card group-[.toaster]:p-4 group-[.toaster]:text-ui group-[.toaster]:text-card-foreground group-[.toaster]:shadow-elevated",
            title: "group-[.toast]:text-sm group-[.toast]:font-semibold group-[.toast]:leading-snug",
            description: "group-[.toast]:mt-0.5 group-[.toast]:text-xs group-[.toast]:leading-snug group-[.toast]:text-muted-foreground",
            icon: "group-[.toast]:mt-0.5 group-[.toast]:size-5 group-[.toast]:shrink-0",
            actionButton:
              "group-[.toast]:h-8 group-[.toast]:rounded-full group-[.toast]:bg-primary group-[.toast]:px-3 group-[.toast]:text-xs group-[.toast]:font-semibold group-[.toast]:text-primary-foreground",
            cancelButton: "group-[.toast]:h-8 group-[.toast]:rounded-full group-[.toast]:bg-canvas group-[.toast]:px-3 group-[.toast]:text-xs group-[.toast]:text-muted-foreground",
            closeButton: "group-[.toast]:border-border group-[.toast]:bg-card group-[.toast]:text-muted-foreground group-[.toast]:hover:bg-canvas",
            // Sonner define su propio color de texto por defecto en [data-title]/
            // [data-description] (sobrevive a heredar el color del contenedor) -- se
            // fuerza aqui con selectores de descendiente.
            success: "[&_[data-icon]]:text-success",
            warning: "[&_[data-icon]]:text-warning",
            info: "[&_[data-icon]]:text-info",
            loading: "[&_[data-icon]]:text-muted-foreground",
            error:
              "group-[.toaster]:border-destructive/30 group-[.toaster]:bg-destructive-tint group-[.toaster]:text-destructive [&_[data-title]]:!text-destructive [&_[data-description]]:!text-destructive [&_[data-description]]:!opacity-85 [&_[data-icon]]:text-destructive",
          },
        }}
        {...props}
      />
    </>
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
  /** Accion secundaria con otra etiqueta (p. ej. "Ver"); como `deshacer`, deja el toast hasta que se decida. */
  readonly accion?: NotifyDeshacer;
  readonly id?: string | number;
}

export const DURACION_NOTIFY_MS = { success: 4000, info: 4000, warning: 6000, error: 8000 } as const;

type TipoNotify = keyof typeof DURACION_NOTIFY_MS;

function opcionesSonner(tipo: TipoNotify, o: NotifyOpciones | undefined) {
  const accion = o?.deshacer ?? o?.accion;
  const duration = o?.duracion ?? (accion ? Infinity : DURACION_NOTIFY_MS[tipo]);
  return {
    id: o?.id,
    description: o?.description,
    duration,
    // Barra de autocierre (index.css .toast-progreso): dura lo mismo que el toast; con
    // duracion infinita (accion pendiente) no hay barra (--toast-ms: 0).
    style: { "--toast-ms": Number.isFinite(duration) ? `${duration}ms` : "0ms" } as React.CSSProperties,
    action: accion ? { label: accion.etiqueta ?? (o?.deshacer ? "Deshacer" : "Ver"), onClick: accion.onClick } : undefined,
  };
}

export const notify = {
  success: (mensaje: string, o?: NotifyOpciones) => toast.success(mensaje, opcionesSonner("success", o)),
  warning: (mensaje: string, o?: NotifyOpciones) => toast.warning(mensaje, opcionesSonner("warning", o)),
  error: (mensaje: string, o?: NotifyOpciones) => {
    return toast.error(mensaje, opcionesSonner("error", o));
  },
  /** Toast persistente de "cargando" (sin barra); se reemplaza con el mismo `id`. */
  cargando: (mensaje: string, o?: Pick<NotifyOpciones, "description" | "id">) =>
    toast.loading(mensaje, { id: o?.id, description: o?.description, style: { "--toast-ms": "0ms" } as React.CSSProperties }),
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
