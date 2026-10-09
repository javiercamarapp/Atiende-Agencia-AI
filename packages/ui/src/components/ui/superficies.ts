/*
 * Recetas UNICAS de las superficies flotantes (Dialog, AlertDialog, FormDialog,
 * Sheet, Popover, Select, Dropdown, Toast, Tooltip). Un solo lugar para el radio,
 * el borde, la sombra, el relleno y la animacion: cambiar aqui cambia la familia
 * completa. El repo suelto usa Radix + tailwindcss-animate (fade + zoom 95 + slide);
 * aqui la entrada del modal es escala + fade (`modal-in`) y en < md una hoja
 * inferior (`sheet-up`), todo apagado por prefers-reduced-motion (index.css).
 */

/** Anchos del modal: sm confirmaciones, md formularios cortos, lg formularios medios, xl con riel/tablas. */
export const TAMANOS_MODAL = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;
export type TamanoModal = keyof typeof TAMANOS_MODAL;

/** Overlay: tinta al 40 % con desenfoque sutil. En restaurantes (repo suelto): negro al 80 % sin desenfoque. */
export const OVERLAY_MODAL =
  "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out rest:bg-scrim rest:backdrop-blur-none";

/** Caja del modal en escritorio (centrada) y hoja inferior en movil. */
export const CAJA_MODAL =
  "fixed inset-0 z-50 m-auto grid h-fit max-h-[calc(100dvh-2rem)] w-full gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5 text-card-foreground shadow-elevated data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out rest:p-6 rest:md:rounded-dialog";
export const CAJA_MODAL_MOVIL =
  "max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:m-0 max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-2xl max-md:pb-[calc(1.25rem+var(--safe-area-bottom))] max-md:data-[state=open]:animate-sheet-up max-md:data-[state=closed]:animate-sheet-down";

/** Boton de cierre: 44 px tactil en movil, 32 px en escritorio. */
export const BOTON_CIERRE_MODAL =
  "absolute right-2 top-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color] duration-fast ease-brand hover:bg-canvas hover:text-foreground disabled:pointer-events-none md:size-8 rest:focus-visible:outline-none rest:focus-visible:ring-2 rest:focus-visible:ring-ring rest:focus-visible:ring-offset-2 rest:ring-offset-card";

/** Ventana flotante ligera (Popover, menu, lista, tooltip): hairline, bg-popover, sombra elevada. */
export const SUPERFICIE_FLOTANTE = "rounded-lg border border-border bg-popover text-popover-foreground shadow-elevated rest:rounded-menu";

/** Chip circular con icono de la cabecera del modal. */
export const CHIP_ICONO_MODAL: Record<"default" | "danger" | "success" | "warning", string> = {
  default: "bg-primary/10 text-primary",
  danger: "bg-destructive-tint text-destructive",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
};
