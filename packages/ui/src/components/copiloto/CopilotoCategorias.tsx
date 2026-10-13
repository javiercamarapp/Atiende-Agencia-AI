import { cn } from "../../lib/utils";
import type { CopilotoCategoria } from "./tipos";

/**
 * Tarjetas de la portada ("Consulta" con el campo vacio). Una sola fila en escritorio con 3, 4 o 5 tarjetas (cuadricula
 * auto-fit con minimo de 13 rem; con menos ancho baja a 2 columnas y en movil a 1), TODAS de la misma altura
 * (`items-stretch` + `sm:auto-rows-fr`, en movil cada tarjeta ocupa lo suyo: cada tarjeta ocupa la altura de la mas alta de su fila y el titulo queda arriba), con el
 * mismo relleno y tipografia y cada pregunta (un boton de al menos 2,5 rem) con una linea fina de separacion. Entran en 250 ms.
 * `compacta` (panel lateral angosto) deja una sola columna.
 */
export function CopilotoCategorias({
  categorias,
  id,
  onElegir,
  compacta = false,
}: {
  compacta?: boolean;
  categorias: readonly CopilotoCategoria[];
  id: string;
  onElegir: (pregunta: string) => void;
}) {
  return (
    <div
      id={id}
      data-testid="copiloto-categorias"
      className={cn(
        "copiloto-categorias-entra grid w-full items-stretch sm:auto-rows-fr gap-3 mb-5",
        compacta ? "grid-cols-1 max-w-2xl" : "grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] max-w-5xl",
      )}
    >
      {categorias.map((c) => (
        <section key={c.titulo} data-testid="copiloto-categoria" aria-label={c.titulo} className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4">
          <p className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground mb-2">{c.titulo}</p>
          <div className="flex flex-col">
            {c.preguntas.map((q) => (
              <div key={q} data-testid="copiloto-pregunta" className="border-t border-border py-0.5 first:border-t-0 first:pt-0">
                <button
                  type="button"
                  onClick={() => onElegir(q)}
                  className="flex min-h-10 w-full items-center text-left text-sm leading-snug rounded-md px-2 py-1.5 hover:bg-muted transition-colors"
                >
                  {q}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
