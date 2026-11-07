import { useState } from "react";
import type { CopilotoCategoria } from "./tipos";
import { useIdiomaCopiloto } from "./idioma";

/**
 * Sugerencias de la portada en el diseno ds3 (las «temas rapidos» de la referencia): una fila de temas con su punto de color fijo
 * por orden (serie 1..8 de las graficas) y, debajo, hasta 3 preguntas del tema elegido como chips de una linea. Cabe en un celular.
 * Sale de las MISMAS categorias de la vertical (las del boton «Consulta» del diseno actual): no hay preguntas nuevas inventadas.
 * Se monta con `hidden` + `ds3-solo`: sin la bandera no existe para nadie (ni para el lector de pantalla).
 */
export function CopilotoTemas({ categorias, onElegir, ocupado = false }: { categorias: readonly CopilotoCategoria[]; onElegir: (pregunta: string) => void; ocupado?: boolean }) {
  const { t } = useIdiomaCopiloto();
  const [i, setI] = useState(0);
  const temas = categorias.filter((c) => c.preguntas.length > 0).slice(0, 4);
  const tema = temas[Math.min(i, temas.length - 1)];
  if (!tema) return null;
  return (
    <section hidden className="ds3-solo ds3-copiloto-temas" aria-label={t("temasAria")} data-testid="copiloto-temas">
      <div className="ds3-copiloto-temas-fila" role="group" aria-label={t("temasAria")}>
        {temas.map((x, k) => (
          <button key={x.titulo} type="button" className="ds3-copiloto-ctl ds3-copiloto-tema" data-serie={(k % 8) + 1} aria-pressed={k === i} onClick={() => setI(k)}>
            <i aria-hidden="true" />
            <span>{x.titulo}</span>
          </button>
        ))}
      </div>
      <div className="ds3-copiloto-temas-fila" role="group" aria-label={tema.titulo} key={tema.titulo}>
        {tema.preguntas.slice(0, 3).map((q) => (
          // El texto visible lo pinta la hoja ds3 desde `data-pregunta` (::before) y el nombre accesible es el mismo (`aria-label`): asi
          // la pregunta no existe como texto del DOM del diseno actual (la pantalla sin bandera queda byte a byte igual para quien la lee).
          <button key={q} type="button" className="ds3-copiloto-ctl ds3-copiloto-pregunta" title={q} aria-label={q} data-pregunta={q} disabled={ocupado} onClick={() => onElegir(q)} />
        ))}
      </div>
    </section>
  );
}
