import { useEffect, useState } from "react";
import { IDIOMAS, IDIOMA_CAMBIO_EVENTO, guardarIdioma, leerIdioma, type Idioma } from "../lib/idioma";
import { cn } from "../lib/utils";

// El nombre accesible contiene el texto visible (ES/EN): criterio «etiqueta en el nombre».
const ROTULO: Record<Idioma, string> = { es: "Español (ES)", en: "English (EN)" };

/**
 * Pildora segmentada ES / EN del pie del sidebar (ds3), gemela visual del selector de tema: grupo de dos botones de alternancia
 * (`aria-pressed`; el tema es el unico `radiogroup` del pie). Guarda la
 * preferencia (`lib/idioma`); la traduccion de la consola es de otro carril. Sin bandera ds3 el shell la monta oculta.
 */
export function SelectorIdioma({ className }: { className?: string }) {
  const [idioma, setIdioma] = useState<Idioma>("es");

  useEffect(() => {
    setIdioma(leerIdioma());
    const alCambiar = (e: Event) => {
      const nuevo = (e as CustomEvent<Idioma>).detail;
      if (nuevo === "es" || nuevo === "en") setIdioma(nuevo);
    };
    window.addEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
    return () => window.removeEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
  }, []);

  return (
    <div role="group" aria-label="Idioma de la interfaz" className={cn("ds3-idioma inline-flex items-center gap-0.5 rounded-full border border-border p-0.5", className)}>
      {IDIOMAS.map((valor) => {
        const activo = idioma === valor;
        return (
          <button
            key={valor}
            type="button"
            aria-pressed={activo}
            aria-label={ROTULO[valor]}
            title={ROTULO[valor]}
            lang={valor}
            onClick={() => {
              setIdioma(valor);
              guardarIdioma(valor);
            }}
            className="ds3-idioma-opcion flex items-center justify-center rounded-full text-2xs font-medium uppercase"
          >
            {valor}
          </button>
        );
      })}
    </div>
  );
}
