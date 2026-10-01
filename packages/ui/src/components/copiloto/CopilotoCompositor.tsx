import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowUp, Search, Square } from "lucide-react";

/**
 * Compositor literal de atiende-restaurantes (rounded-3xl, "Consulta", enviar de 32 px) con un textarea que crece
 * de 1 a 6 lineas: Enter envia, Shift+Enter hace salto de linea. Mientras hay un turno en curso, enviar pasa a Detener.
 * Sin clip de adjuntos en v1 (no se muestra un boton que no hace nada).
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
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
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
    </form>
  );
}
