import * as React from "react";
import { X } from "lucide-react";

import { cn } from "../lib/utils";
import { AtiendeMark } from "./AtiendeLogo";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export interface FormDialogPaso {
  readonly id: string;
  readonly etiqueta: string;
}

export interface FormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Titulo (riel izquierdo en escritorio, cabecera en movil). Es el nombre accesible del dialogo. */
  readonly titulo: string;
  /** Texto secundario; se asocia como descripcion accesible. */
  readonly subtitulo?: string;
  /** Pasos de un formulario multi-paso real. Omitir en formularios de un solo paso. */
  readonly pasos?: readonly FormDialogPaso[];
  readonly pasoActivo?: string;
  readonly children: React.ReactNode;
  /** Botones al pie. Si se omite se arma un boton primario con `onGuardar`/`guardando`. */
  readonly footer?: React.ReactNode;
  /** Con handler, el contenido va dentro de un <form>: Enter en un campo tambien guarda. */
  readonly onGuardar?: () => void;
  readonly guardando?: boolean;
  readonly textoBotonGuardar?: string;
  readonly guardarDeshabilitado?: boolean;
  /** Ancho del dialogo en escritorio. @default "max-w-5xl" */
  readonly anchoClase?: string;
  /** Ancho del riel en escritorio. @default "220px" */
  readonly anchoRiel?: string;
  readonly altoMinimoClase?: string;
  /** No permite cerrar con Escape, clic fuera ni la "x" (operacion en curso). */
  readonly bloquearCierre?: boolean;
}

/**
 * Dialogo de formulario (ModalFormularioLateral movido a @atiende/ui y hecho
 * responsive): en >= md es un dialogo centrado con riel izquierdo de marca +
 * titulo; en < md es una hoja inferior a una columna que sube desde abajo
 * (keyframe `sheet-up`). Foco atrapado, Escape y clic fuera cierran (salvo
 * `bloquearCierre`), titulo y subtitulo enlazados por ARIA.
 */
export function FormDialog({
  open,
  onOpenChange,
  titulo,
  subtitulo,
  pasos,
  pasoActivo,
  children,
  footer,
  onGuardar,
  guardando = false,
  textoBotonGuardar = "Guardar cambios",
  guardarDeshabilitado = false,
  anchoClase = "max-w-5xl",
  anchoRiel = "220px",
  altoMinimoClase,
  bloquearCierre = false,
}: FormDialogProps) {
  const indiceActivo = pasos ? pasos.findIndex((p) => p.id === pasoActivo) : -1;

  const pie =
    footer ?? (
      <Button
        type={onGuardar ? "submit" : "button"}
        className="w-full md:w-auto"
        loading={guardando}
        disabled={guardando || guardarDeshabilitado}
      >
        {guardando ? "Guardando…" : textoBotonGuardar}
      </Button>
    );

  const cuerpo = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <div className="mt-auto flex flex-col-reverse items-stretch justify-end gap-2 pt-4 md:flex-row md:items-center">{pie}</div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
      <DialogContent
        hideDefaultClose
        className={cn(
          // Escritorio: dialogo centrado. Movil: hoja inferior que sube desde abajo.
          anchoClase,
          "gap-0 overflow-hidden p-0",
          "max-md:max-h-[92dvh] max-md:pb-0",
        )}
        onInteractOutside={bloquearCierre ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={bloquearCierre ? (e) => e.preventDefault() : undefined}
      >
        {/* Franja de marca de 4 px (ModalFormularioLateral del repo suelto). */}
        <div aria-hidden="true" className="h-1 bg-gradient-to-r from-primary to-franja" />

        <div
          className={cn("grid min-h-0 grid-cols-1 md:[grid-template-columns:var(--form-dialog-rail)_1fr]", altoMinimoClase)}
          style={{ ["--form-dialog-rail" as string]: anchoRiel }}
        >
          {/* Riel (escritorio) / cabecera (movil): marca + titulo + subtitulo + pasos */}
          <div className="flex flex-col gap-3 border-b border-border bg-muted/30 p-5 pr-12 md:gap-6 md:border-b-0 md:border-r">
            <AtiendeMark className="hidden h-7 w-auto md:block" />
            <div>
              <DialogTitle className="mb-1 font-display text-base font-semibold">{titulo}</DialogTitle>
              {subtitulo ? (
                <DialogDescription className="text-ui">{subtitulo}</DialogDescription>
              ) : (
                <DialogDescription className="sr-only">{titulo}</DialogDescription>
              )}

              {pasos && pasos.length > 0 && (
                <ol className="mt-4 hidden space-y-2.5 md:block" aria-label="Pasos">
                  {pasos.map((p, i) => {
                    const activo = p.id === pasoActivo;
                    const completado = indiceActivo > i;
                    return (
                      <li key={p.id} className="flex items-center gap-2" aria-current={activo ? "step" : undefined}>
                        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", activo ? "bg-primary" : completado ? "bg-primary/50" : "bg-border")} />
                        <span className={cn("text-ui", activo ? "font-medium text-foreground" : "text-muted-foreground")}>{p.etiqueta}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {pasos && pasos.length > 0 && indiceActivo >= 0 && (
                <p className="mt-2 text-xs text-muted-foreground md:hidden">
                  Paso {indiceActivo + 1} de {pasos.length}: {pasos[indiceActivo]?.etiqueta}
                </p>
              )}
            </div>
          </div>

          {onGuardar ? (
            <form
              className="flex min-h-0 flex-col p-5 md:pt-10 max-md:pb-[calc(1.25rem+var(--safe-area-bottom))]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!guardando && !guardarDeshabilitado) onGuardar();
              }}
            >
              {cuerpo}
            </form>
          ) : (
            <div className="flex min-h-0 flex-col p-5 md:pt-10 max-md:pb-[calc(1.25rem+var(--safe-area-bottom))]">{cuerpo}</div>
          )}
        </div>
        {/* Despues del contenido en el DOM: el foco inicial cae en el primer campo, no en la x (que sigue arriba a la derecha por ser absoluta). */}
        {!bloquearCierre && (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Cerrar"
            className="absolute right-2 top-3 z-10 flex size-11 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color] duration-fast ease-brand hover:bg-muted hover:text-foreground md:right-3 md:size-7"
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
