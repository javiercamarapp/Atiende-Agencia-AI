// Panel lateral UNIFICADO (ds3, §3.7): Drawer (420/480/640) y Modal (440/560) con UNA anatomia -- cabecera (titulo 15/600 +
// subtitulo 12 + cerrar de 28), cuerpo con scroll propio (padding 16, gap 12), pie con acciones a la derecha y, solo en el Drawer de
// escritorio, el logo de Atiende de 64 px centrado al 60 % debajo del pie. Sobre Radix Dialog (dentro de @atiende/ui): Esc, clic fuera y
// la X cierran; el foco queda atrapado, arranca en `[data-autofocus]` (o el primer campo) y vuelve al disparador.
// En < 820 px el Drawer es una hoja inferior de 90dvh con agarradera (arrastrar > 80 px cierra), cerrar con area de 44 y sin logo.
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { AtiendeWordmark } from "../AtiendeLogo";
import { useT } from "../../i18n/proveedor";
import "../../i18n/mensajes/comun.ts";

/** Anchos unicos de las superposiciones (px). Un ancho heredado se redondea al estandar con `tamanoDrawerPara`. */
export const ANCHOS_SUPERPOSICION = {
  drawer: { sm: 420, md: 480, lg: 640 },
  modal: { sm: 440, md: 560 },
  popover: 340,
} as const;
export type TamanoDrawer = keyof typeof ANCHOS_SUPERPOSICION.drawer;
export type TamanoModalDs3 = keyof typeof ANCHOS_SUPERPOSICION.modal;

/** Ancho heredado en px -> tamano estandar mas cercano por arriba (lg si excede). */
export function tamanoDrawerPara(anchoPx: number): TamanoDrawer {
  if (anchoPx <= ANCHOS_SUPERPOSICION.drawer.sm) return "sm";
  if (anchoPx <= ANCHOS_SUPERPOSICION.drawer.md) return "md";
  return "lg";
}

/** Arrastre hacia abajo (px) a partir del cual la hoja inferior se cierra. */
export const HOJA_UMBRAL_CIERRE_PX = 80;

const ANCHO_DRAWER: Record<TamanoDrawer, string> = {
  sm: "min-[820px]:w-[min(420px,calc(100vw-16px))]",
  md: "min-[820px]:w-[min(480px,calc(100vw-16px))]",
  lg: "min-[820px]:w-[min(640px,calc(100vw-16px))]",
};
const ANCHO_MODAL: Record<TamanoModalDs3, string> = {
  sm: "w-[min(440px,calc(100vw-32px))]",
  md: "w-[min(560px,calc(100vw-32px))]",
};

const VELO = "ds3-velo fixed inset-0 z-50 bg-scrim data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out";

interface BaseProps {
  readonly open: boolean;
  readonly onOpenChange: (abierto: boolean) => void;
  /** Titulo (h2) y nombre accesible del panel. */
  readonly titulo: React.ReactNode;
  readonly subtitulo?: React.ReactNode;
  /** Acciones del pie, alineadas a la derecha (el primario al final). */
  readonly pie?: React.ReactNode;
  /** Nota opcional a la izquierda del pie. */
  readonly notaPie?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

function enfocarInicial(e: Event, contenido: HTMLElement | null): void {
  const destino = contenido?.querySelector<HTMLElement>("[data-autofocus]");
  if (destino) {
    e.preventDefault();
    destino.focus();
  }
}

/**
 * Retorno del foco al disparador. Radix solo lo devuelve si el panel se abrio con su `Trigger`; aqui el panel es controlado
 * (`open`), asi que se recuerda el elemento enfocado al abrir (efecto de layout: corre ANTES de que la trampa mueva el foco) y se
 * le devuelve al cerrar.
 */
function useRetornoDeFoco(open: boolean): (e: Event) => void {
  const previo = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (open && typeof document !== "undefined") previo.current = document.activeElement as HTMLElement | null;
  }, [open]);
  return React.useCallback((e: Event) => {
    const destino = previo.current;
    previo.current = null;
    if (destino && destino.isConnected && destino !== document.body) {
      e.preventDefault();
      destino.focus();
    }
  }, []);
}

function Cabecera({ titulo, subtitulo }: { titulo: React.ReactNode; subtitulo?: React.ReactNode }) {
  return (
    <header className="ds3-ov-cabecera flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="ds3-ov-titulo text-sm font-semibold leading-snug text-foreground">{titulo}</DialogPrimitive.Title>
        {subtitulo !== undefined ? (
          <DialogPrimitive.Description className="ds3-ov-subtitulo mt-0.5 text-xs text-muted-foreground">{subtitulo}</DialogPrimitive.Description>
        ) : null}
      </div>
      <DialogPrimitive.Close className="ds3-ov-cerrar relative -mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-fast ease-brand after:absolute after:-inset-2 after:content-[''] hover:bg-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        <TextoCerrar />
      </DialogPrimitive.Close>
    </header>
  );
}

function Cuerpo({ children }: { children: React.ReactNode }) {
  return <div className="ds3-ov-cuerpo flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-ui">{children}</div>;
}

function Pie({ pie, notaPie }: { pie?: React.ReactNode; notaPie?: React.ReactNode }) {
  if (pie === undefined && notaPie === undefined) return null;
  return (
    <footer className="ds3-ov-pie flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 pt-3 pb-[calc(0.75rem+var(--safe-area-bottom))] min-[820px]:pb-3">
      {notaPie !== undefined ? <p className="mr-auto min-w-0 text-xs text-muted-foreground">{notaPie}</p> : null}
      {pie}
    </footer>
  );
}

export interface DrawerProps extends BaseProps {
  /** sm 420 · md 480 · lg 640. @default "sm" */
  readonly tamano?: TamanoDrawer;
}

/**
 * Panel lateral derecho flotante (a 8 px del borde, alto completo, radio 12) con el logo de Atiende al pie. En < 820 px es una hoja
 * inferior arrastrable sin logo.
 */
export function Drawer({ open, onOpenChange, titulo, subtitulo, pie, notaPie, tamano = "sm", children, className }: DrawerProps) {
  const contenido = React.useRef<HTMLDivElement>(null);
  const arrastre = React.useRef<{ y: number; id: number } | null>(null);
  const devolverFoco = useRetornoDeFoco(open);

  const moverPanel = (dy: number | null) => {
    const panel = contenido.current;
    if (!panel) return;
    if (dy === null) panel.style.removeProperty("transform");
    else panel.style.setProperty("transform", `translateY(${Math.max(0, dy)}px)`);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={VELO} />
        <DialogPrimitive.Content
          ref={contenido}
          data-tamano={tamano}
          onOpenAutoFocus={(e) => enfocarInicial(e, contenido.current)}
          onCloseAutoFocus={devolverFoco}
          className={cn(
            "ds3-drawer fixed z-50 flex flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-pop outline-none",
            // Escritorio: flota a 8 px del borde derecho, alto completo.
            "min-[820px]:bottom-2 min-[820px]:right-2 min-[820px]:top-2 min-[820px]:rounded-xl",
            "min-[820px]:data-[state=open]:animate-in min-[820px]:data-[state=open]:fade-in-0 min-[820px]:data-[state=open]:slide-in-from-right-4 min-[820px]:data-[state=closed]:animate-out min-[820px]:data-[state=closed]:fade-out-0 min-[820px]:data-[state=closed]:slide-out-to-right-4",
            ANCHO_DRAWER[tamano],
            // Movil: hoja inferior de 90dvh, radio 16 arriba.
            "max-[819.98px]:inset-x-0 max-[819.98px]:bottom-0 max-[819.98px]:max-h-[90dvh] max-[819.98px]:w-full max-[819.98px]:rounded-t-2xl max-[819.98px]:border-x-0 max-[819.98px]:border-b-0 max-[819.98px]:data-[state=open]:animate-sheet-up max-[819.98px]:data-[state=closed]:animate-sheet-down",
            className,
          )}
          {...(subtitulo === undefined ? { "aria-describedby": undefined } : {})}
        >
          {/* Agarradera de la hoja inferior: solo en < 820 px; arrastrar mas de 80 px hacia abajo cierra. Decorativa para lectores
              de pantalla (cerrar tambien con Esc o la X). */}
          <div
            aria-hidden="true"
            data-testid="drawer-agarre"
            className="ds3-drawer-agarre flex shrink-0 touch-none justify-center pb-1 pt-2 min-[820px]:hidden"
            onPointerDown={(e) => {
              arrastre.current = { y: e.clientY, id: e.pointerId };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (arrastre.current?.id === e.pointerId) moverPanel(e.clientY - arrastre.current.y);
            }}
            onPointerUp={(e) => {
              const inicio = arrastre.current;
              arrastre.current = null;
              moverPanel(null);
              if (inicio && e.clientY - inicio.y > HOJA_UMBRAL_CIERRE_PX) onOpenChange(false);
            }}
            onPointerCancel={() => {
              arrastre.current = null;
              moverPanel(null);
            }}
          >
            <span className="h-1 w-9 rounded-full bg-border-strong" />
          </div>
          <Cabecera titulo={titulo} subtitulo={subtitulo} />
          <Cuerpo>{children}</Cuerpo>
          <Pie pie={pie} notaPie={notaPie} />
          {/* Logo al pie del panel (escritorio): marca de Atiende de 64 px, centrada, al 60 %. */}
          <div aria-hidden="true" data-testid="drawer-marca" className="ds3-drawer-marca hidden shrink-0 justify-center border-t border-border pb-[11px] pt-[9px] opacity-60 min-[820px]:flex">
            <span className="ds3-drawer-marca-logo inline-flex w-16 justify-center overflow-hidden">
              <AtiendeWordmark variante="ds3" tamano="sidebar" respetarMinimos={false} />
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ModalProps extends BaseProps {
  /** sm 440 · md 560. @default "sm" */
  readonly tamano?: TamanoModalDs3;
}

/** Ventana centrada con la misma anatomia del Drawer (sin logo): confirmaciones y formularios cortos. */
export function Modal({ open, onOpenChange, titulo, subtitulo, pie, notaPie, tamano = "sm", children, className }: ModalProps) {
  const contenido = React.useRef<HTMLDivElement>(null);
  const devolverFoco = useRetornoDeFoco(open);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={VELO} />
        <DialogPrimitive.Content
          ref={contenido}
          data-tamano={tamano}
          onOpenAutoFocus={(e) => enfocarInicial(e, contenido.current)}
          onCloseAutoFocus={devolverFoco}
          className={cn(
            "ds3-modal fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-32px)] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-pop outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out",
            ANCHO_MODAL[tamano],
            className,
          )}
          {...(subtitulo === undefined ? { "aria-describedby": undefined } : {})}
        >
          <Cabecera titulo={titulo} subtitulo={subtitulo} />
          <Cuerpo>{children}</Cuerpo>
          <Pie pie={pie} notaPie={notaPie} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Nombre accesible del boton de cierre, en el idioma de la consola. */
function TextoCerrar() {
  return <span className="sr-only">{useT()("comun.cerrar")}</span>;
}
