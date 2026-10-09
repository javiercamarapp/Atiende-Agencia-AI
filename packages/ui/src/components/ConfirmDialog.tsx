import * as React from "react";
import { AlertTriangle, HelpCircle, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { FormField } from "./ui/form-field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export type ConfirmTono = "default" | "danger";

/**
 * Campo de texto dentro de la confirmacion: sustituye a `window.prompt` (motivos,
 * notas). El boton de confirmar queda deshabilitado mientras el valor no valide.
 */
export interface ConfirmCampo {
  readonly etiqueta: string;
  readonly ayuda?: string;
  readonly placeholder?: string;
  /** Textarea en lugar de input de una linea. */
  readonly multilinea?: boolean;
  /** Si es true (por defecto), el texto no puede quedar vacio (se recorta con trim). */
  readonly requerido?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly valorInicial?: string;
  /** Validacion propia: devuelve el mensaje de error o null/undefined si es valido. */
  readonly validar?: (valor: string) => string | null | undefined;
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly titulo: string;
  readonly descripcion?: React.ReactNode;
  readonly tono?: ConfirmTono;
  /** @default "Confirmar" */
  readonly confirmar?: string;
  /** @default "Cancelar" */
  readonly cancelar?: string;
  readonly campo?: ConfirmCampo;
  /**
   * Se llama al confirmar con el texto recortado (si hay `campo`). Si devuelve una
   * promesa, el dialogo queda abierto con el boton en `loading` hasta que termine;
   * si la promesa se rechaza, queda abierto (quien llama avisa el error con `notify`).
   */
  readonly onConfirm: (valor?: string) => void | Promise<void>;
}

/** Mensaje de error del valor, o null si es valido. Exportado para probarlo y reusarlo. */
export function validarCampoConfirm(campo: ConfirmCampo, valor: string): string | null {
  const limpio = valor.trim();
  const requerido = campo.requerido ?? true;
  if (requerido && limpio.length === 0) return `${campo.etiqueta} es obligatorio.`;
  if (limpio.length > 0 && campo.minLength !== undefined && limpio.length < campo.minLength) {
    return `${campo.etiqueta} debe tener al menos ${campo.minLength} caracteres.`;
  }
  if (campo.maxLength !== undefined && limpio.length > campo.maxLength) {
    return `${campo.etiqueta} no puede pasar de ${campo.maxLength} caracteres.`;
  }
  return campo.validar?.(limpio) ?? null;
}

/**
 * Confirmacion modal (AlertDialog de Radix: foco atrapado, Escape cancela, role
 * "alertdialog"). Sustituye a `window.confirm` / `window.prompt`. Con `tono="danger"`
 * el boton de confirmar es el de peligro de Likida (tinte + texto destructivo) y, sin campo, el foco inicial cae en Cancelar.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  titulo,
  descripcion,
  tono = "default",
  confirmar = "Confirmar",
  cancelar = "Cancelar",
  campo,
  onConfirm,
}: ConfirmDialogProps) {
  const [valor, setValor] = React.useState(campo?.valorInicial ?? "");
  const [tocado, setTocado] = React.useState(false);
  const [enCurso, setEnCurso] = React.useState(false);
  const campoRef = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const campoId = React.useId();

  // Cada apertura empieza limpia (el componente puede quedar montado entre usos).
  React.useEffect(() => {
    if (open) {
      setValor(campo?.valorInicial ?? "");
      setTocado(false);
      setEnCurso(false);
    }
  }, [open, campo?.valorInicial]);

  const error = campo ? validarCampoConfirm(campo, valor) : null;
  const bloqueado = enCurso || error !== null;

  const cerrar = (v: boolean) => {
    if (enCurso && !v) return; // no se cierra a media operacion
    onOpenChange(v);
  };

  const enviar = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTocado(true);
    if (bloqueado) return;
    try {
      const r = onConfirm(campo ? valor.trim() : undefined);
      if (r && typeof (r as Promise<void>).then === "function") {
        setEnCurso(true);
        await r;
      }
      setEnCurso(false);
      onOpenChange(false);
    } catch {
      setEnCurso(false);
    }
  };

  // Salir del campo hacia "Cancelar" no cuenta como tocarlo: el error que aparece al
  // perder el foco agranda el dialogo, este se recentra y el clic en Cancelar caeria fuera del boton.
  const alSalirDelCampo = (e: React.FocusEvent) => {
    if ((e.relatedTarget as HTMLElement | null)?.hasAttribute("data-confirm-cancelar")) return;
    setTocado(true);
  };

  return (
    <AlertDialog open={open} onOpenChange={cerrar}>
      <AlertDialogContent
        onOpenAutoFocus={
          campo
            ? (e) => {
                e.preventDefault();
                campoRef.current?.focus();
              }
            : undefined
        }
      >
        <form onSubmit={enviar} className="grid gap-3" noValidate>
          <AlertDialogHeader icono={tono === "danger" ? AlertTriangle : HelpCircle} tono={tono === "danger" ? "danger" : "default"}>
            <AlertDialogTitle>{titulo}</AlertDialogTitle>
            {descripcion !== undefined ? (
              <AlertDialogDescription>{descripcion}</AlertDialogDescription>
            ) : (
              <AlertDialogDescription className="sr-only">{titulo}</AlertDialogDescription>
            )}
          </AlertDialogHeader>

          {campo && (
            <FormField
              label={campo.etiqueta}
              hint={campo.ayuda}
              error={tocado && error ? error : undefined}
              required={campo.requerido ?? true}
              id={campoId}
            >
              {(controlProps) =>
                campo.multilinea ? (
                  <Textarea
                    {...controlProps}
                    ref={campoRef as React.Ref<HTMLTextAreaElement>}
                    value={valor}
                    rows={3}
                    placeholder={campo.placeholder}
                    maxLength={campo.maxLength}
                    onChange={(e) => setValor(e.target.value)}
                    onBlur={alSalirDelCampo}
                  />
                ) : (
                  <Input
                    {...controlProps}
                    ref={campoRef as React.Ref<HTMLInputElement>}
                    value={valor}
                    placeholder={campo.placeholder}
                    maxLength={campo.maxLength}
                    onChange={(e) => setValor(e.target.value)}
                    onBlur={alSalirDelCampo}
                  />
                )
              }
            </FormField>
          )}

          <AlertDialogFooter>
            {/* AlertDialogCancel recibe el foco inicial de Radix (opcion segura) y cierra via onOpenChange. */}
            <AlertDialogCancel type="button" data-confirm-cancelar="" disabled={enCurso}>
              {cancelar}
            </AlertDialogCancel>
            <Button type="submit" variant={tono === "danger" ? "danger" : "default"} disabled={bloqueado} aria-busy={enCurso || undefined}>
              {enCurso && <Loader2 aria-hidden="true" className="animate-spin" />}
              {confirmar}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
