import * as React from "react";
import type { ComponentType } from "react";

import { AtiendeMark } from "./AtiendeLogo";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { type TamanoModal } from "./ui/superficies";

export interface FormDialogEleganteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Icono de la insignia circular de la cabecera; sin el, va la marca de Atiende. */
  readonly icono?: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  readonly titulo: string;
  readonly subtitulo?: string;
  readonly children: React.ReactNode;
  /** Pie propio. Si se omite: un boton primario de ancho completo con `onGuardar`. */
  readonly footer?: React.ReactNode;
  /** Con handler, el contenido va dentro de un <form>: Enter en un campo tambien guarda. */
  readonly onGuardar?: () => void;
  readonly guardando?: boolean;
  readonly textoBotonGuardar?: string;
  readonly guardarDeshabilitado?: boolean;
  /** @default "md" */
  readonly tamano?: TamanoModal;
  readonly bloquearCierre?: boolean;
}

/**
 * Formulario "elegante" (ModalFormularioElegante del repo suelto): franja de marca de 4 px, cabecera
 * centrada con insignia + titulo + subtitulo, cuerpo y pie. Para formularios simples de una sola
 * pantalla; el de dos columnas con riel es FormDialog. Mismo Dialog (foco atrapado, Escape y clic
 * fuera cierran salvo `bloquearCierre`; hoja inferior en < md).
 */
export function FormDialogElegante({
  open,
  onOpenChange,
  icono: Icono,
  titulo,
  subtitulo,
  children,
  footer,
  onGuardar,
  guardando = false,
  textoBotonGuardar = "Guardar cambios",
  guardarDeshabilitado = false,
  tamano = "md",
  bloquearCierre = false,
}: FormDialogEleganteProps) {
  const pie =
    footer ?? (
      <Button type={onGuardar ? "submit" : "button"} className="w-full" loading={guardando} disabled={guardando || guardarDeshabilitado}>
        {guardando ? "Guardando…" : textoBotonGuardar}
      </Button>
    );
  const cuerpo = (
    <>
      <div className="grid gap-4 px-5 py-5 text-left">{children}</div>
      <div className="px-5 pb-5 max-md:pb-[calc(1.25rem+var(--safe-area-bottom))]">{pie}</div>
    </>
  );
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
      <DialogContent
        hideDefaultClose={bloquearCierre}
        size={tamano}
        className="gap-0 overflow-hidden p-0"
        onInteractOutside={bloquearCierre ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={bloquearCierre ? (e) => e.preventDefault() : undefined}
      >
        <div aria-hidden="true" className="h-1 bg-gradient-to-r from-primary to-franja" />
        <div className="flex flex-col items-center border-b border-border px-5 pb-4 pt-5 text-center">
          {Icono ? (
            <span aria-hidden="true" className="mb-3 flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icono className="size-5" strokeWidth={1.75} />
            </span>
          ) : (
            <AtiendeMark className="mb-3 h-7 w-auto" />
          )}
          <DialogTitle className="font-display text-lg font-semibold">{titulo}</DialogTitle>
          {subtitulo ? (
            <DialogDescription className="mt-1 max-w-sm text-ui rest:text-ui">{subtitulo}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{titulo}</DialogDescription>
          )}
        </div>
        {onGuardar ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!guardando && !guardarDeshabilitado) onGuardar();
            }}
          >
            {cuerpo}
          </form>
        ) : (
          <div>{cuerpo}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
