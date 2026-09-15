// ConfirmModal — modal de confirmación real y genérico para acciones destructivas
// del panel de hoteles (Reservas.tsx::handleCancel, Folio.tsx::handleClose).
//
// Hallazgo de auditoría (severidad ALTA, "acciones destructivas sin confirmación:
// cancelar reserva y cerrar folio ejecutan de inmediato con un clic"): ninguno de
// los dos handlers pedía ninguna confirmación en absoluto (ni siquiera un
// `window.confirm` nativo) — un solo clic accidental en "Cancelar" (Reservas.tsx) o
// en "Cerrar folio" (Folio.tsx, IRREVERSIBLE: un folio cerrado no puede reabrirse
// desde este panel) ejecutaba la acción sin ninguna oportunidad de arrepentirse.
// La instrucción explícita para este hallazgo es "modal, no window.confirm" — este
// componente es ese modal real: overlay + diálogo enfocable, sin depender de la UI
// nativa del navegador (que además es indistinguible entre sitios y fácil de
// deshabilitar/automatizar).
//
// Deliberadamente MÍNIMO (sin portal/focus-trap library): este monorepo no tiene
// ninguna librería de UI instalada (ver el resto de este panel, todo estilos
// inline) y un solo modal genérico reutilizado por 3 acciones no justifica sumar
// una dependencia nueva. Cierra con Escape y con clic en el overlay (mismo
// criterio de accesibilidad mínima que cualquier modal real), y el foco inicial
// cae en el botón de confirmar (la acción que un teclado-only/lector de pantalla
// más probablemente busca a continuación es "cancelar" — Tab desde el botón de
// confirmar llega primero al botón de cancelar, que es DOM-previo).
//
// Hallazgo de auditoría (rubro 11/18, MEDIO/BAJO, "accesibilidad: falta focus trap
// y aria-describedby en el único ConfirmModal real del repo"): con foco inicial +
// Escape solamente, Tab podía escapar del diálogo hacia contenido de fondo mientras
// seguía abierto (el overlay no bloquea el teclado, solo el clic) — un usuario de
// teclado/lector de pantalla podía terminar interactuando con Reservas.tsx/
// Folio.tsx detrás del modal sin haberlo cerrado. Se agrega un focus trap real
// (Tab/Shift+Tab ciclan solo entre los 2 botones del diálogo), `aria-describedby`
// apuntando al mensaje (antes solo el título tenía `aria-labelledby`, el lector de
// pantalla no anunciaba el mensaje al abrir), y restauración del foco al elemento
// que abrió el modal al cerrarlo (por Escape, overlay, cancelar o confirmar) — sin
// esto el foco caía en `<body>` y un usuario de teclado perdía su lugar en la
// página tras cada acción.
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

export interface ConfirmModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 20,
  maxWidth: 380,
  width: "100%",
  boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
};

export function ConfirmModal({ open, title, message, confirmLabel, cancelLabel = "Volver", busy = false, onConfirm, onCancel }: ConfirmModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Elemento que tenía el foco justo antes de abrir el modal (típicamente el botón
  // "Cancelar reserva"/"Cerrar folio" que lo disparó) — se restaura al cerrar para
  // que un usuario de teclado no pierda su lugar en la página de fondo.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      // Focus trap real: con solo 2 elementos enfocables (cancelar/confirmar),
      // Tab/Shift+Tab siempre deben ciclar entre ambos, nunca salir del diálogo.
      if (event.key === "Tab") {
        const cancelEl = cancelButtonRef.current;
        const confirmEl = confirmButtonRef.current;
        if (!cancelEl || !confirmEl) return;
        const goingBackward = event.shiftKey;
        const active = document.activeElement;
        if (!goingBackward && active === confirmEl) {
          event.preventDefault();
          cancelEl.focus();
        } else if (goingBackward && active === cancelEl) {
          event.preventDefault();
          confirmEl.focus();
        } else if (active !== cancelEl && active !== confirmEl) {
          // El foco quedó fuera de los 2 botones (p. ej. tras un focus() programático
          // a otro lado) — lo regresamos adentro en vez de dejarlo escapar.
          event.preventDefault();
          (goingBackward ? cancelEl : confirmEl).focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div role="presentation" style={overlayStyle} onClick={() => !busy && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hoteles-confirm-modal-title"
        aria-describedby="hoteles-confirm-modal-message"
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="hoteles-confirm-modal-title" style={{ margin: "0 0 8px", fontSize: 16 }}>
          {title}
        </h2>
        <p id="hoteles-confirm-modal-message" style={{ margin: "0 0 18px", fontSize: 13, color: "#4b5563" }}>
          {message}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 13, cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#b91c1c", color: "#fff", fontSize: 13, cursor: "pointer" }}
          >
            {busy ? "Procesando…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
