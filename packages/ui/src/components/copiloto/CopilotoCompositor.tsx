import { useEffect, useRef } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Search, Square } from "lucide-react";
import type { CopilotoAdjuntosConfig } from "./tipos";

/**
 * Compositor literal de atiende-restaurantes (rounded-3xl, "Consulta", enviar de 32 px) con un textarea que crece
 * de 1 a 6 lineas: Enter envia, Shift+Enter hace salto de linea. Mientras hay un turno en curso, enviar pasa a Detener.
 * El clip "Adjuntar archivo" solo se pinta cuando el transporte declara `adjuntos` (su servidor tiene la ruta): nunca un boton que no hace nada.
 */
export function CopilotoCompositor({
  valor,
  onCambia,
  onEnviar,
  onDetener,
  onConsulta,
  enviando,
  placeholder,
  maxCaracteres,
  categoriasId,
  categoriasVisibles,
  inputId,
  adjuntos,
  onAdjuntar,
  avisoAdjunto,
}: {
  valor: string;
  onCambia: (v: string) => void;
  onEnviar: () => void;
  onDetener: () => void;
  onConsulta: () => void;
  enviando: boolean;
  placeholder: string;
  maxCaracteres: number;
  categoriasId: string;
  categoriasVisibles: boolean;
  inputId: string;
  adjuntos?: CopilotoAdjuntosConfig | undefined;
  /** Recibe el archivo elegido (el shell valida tamano y extension y llama al transporte). */
  onAdjuntar?: ((archivo: File) => void) | undefined;
  /** Aviso honesto de un archivo rechazado antes de subirlo (demasiado grande, tipo no soportado). */
  avisoAdjunto?: string | null | undefined;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selector = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [valor]);

  const vacio = valor.trim().length === 0;
  const alEnviar = (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (!vacio) onEnviar();
  };
  const alTeclear = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!enviando && !vacio) onEnviar();
    }
  };
  const umbralContador = Math.floor(maxCaracteres * 0.8);
  const elegirArchivo = (e: ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    // Se limpia el valor para poder elegir de nuevo el MISMO archivo despues de corregirlo.
    e.target.value = "";
    if (archivo && onAdjuntar) onAdjuntar(archivo);
  };

  return (
    <form onSubmit={alEnviar} className="w-full max-w-xl bg-card border border-border rounded-3xl shadow-sm p-3 shrink-0" aria-label="Preguntar al Copiloto">
      <label htmlFor={inputId} className="sr-only">
        Tu pregunta
      </label>
      <textarea
        id={inputId}
        ref={ref}
        rows={1}
        value={valor}
        maxLength={maxCaracteres}
        onChange={(e) => onCambia(e.target.value)}
        onKeyDown={alTeclear}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-2">
          {adjuntos && onAdjuntar ? (
            <>
              <input ref={selector} type="file" accept={adjuntos.accept} onChange={elegirArchivo} className="sr-only" tabIndex={-1} aria-hidden data-testid="copiloto-adjunto-input" />
              <button
                type="button"
                onClick={() => selector.current?.click()}
                disabled={enviando}
                aria-label="Adjuntar archivo"
                title="Adjuntar archivo (CSV, Excel o PDF)"
                className="rounded-full shrink-0 w-8 h-8 inline-flex items-center justify-center border border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <Paperclip className="w-4 h-4" aria-hidden />
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={vacio ? onConsulta : onEnviar}
            disabled={enviando}
            aria-expanded={vacio ? categoriasVisibles : undefined}
            aria-controls={vacio ? categoriasId : undefined}
            className="flex items-center gap-1.5 rounded-full bg-foreground text-background text-xs font-medium pl-3 pr-3.5 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            <Search className="w-3.5 h-3.5" aria-hidden />
            Consulta
          </button>
        </div>
        <div className="flex items-center gap-2">
          {valor.length >= umbralContador ? (
            <span className="text-2xs font-mono text-muted-foreground" aria-live="polite">
              {valor.length}/{maxCaracteres}
            </span>
          ) : null}
          {enviando ? (
            <button
              type="button"
              onClick={onDetener}
              aria-label="Detener"
              className="rounded-full shrink-0 w-8 h-8 inline-flex items-center justify-center bg-copiloto text-copiloto-foreground hover:opacity-90"
            >
              <Square className="w-3 h-3 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={vacio}
              aria-label="Enviar"
              className="rounded-full shrink-0 w-8 h-8 inline-flex items-center justify-center bg-copiloto text-copiloto-foreground hover:opacity-90 disabled:opacity-50"
            >
              <ArrowUp className="w-4 h-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
      {avisoAdjunto ? (
        <p role="alert" className="mt-1.5 px-2 text-xs text-destructive">
          {avisoAdjunto}
        </p>
      ) : null}
    </form>
  );
}
