import type { CopilotoCategoria } from "./tipos";

/** Tarjetas de la portada ("Consulta" con el campo vacio): 3 columnas, entran en 250 ms. */
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
    <div id={id} className={`copiloto-categorias-entra grid grid-cols-1 ${compacta ? "" : "sm:grid-cols-3"} gap-3 w-full max-w-2xl mb-5`}>
      {categorias.map((c) => (
        <div key={c.titulo} className="rounded-xl border border-border bg-card p-3">
          <p className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground mb-2">{c.titulo}</p>
          {c.preguntas.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onElegir(q)}
              className="w-full text-left text-sm rounded-lg px-2 py-1.5 hover:bg-muted transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
