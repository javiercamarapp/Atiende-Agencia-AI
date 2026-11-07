import { useEffect, useState } from "react";
import type { Clave } from "../i18n/mensajes/index.ts";
import { useI18n } from "../i18n/proveedor";
import "../i18n/mensajes/shell.ts";
import { IDIOMAS, IDIOMA_CAMBIO_EVENTO, leerIdioma, type Idioma } from "../lib/idioma";
import { cn } from "../lib/utils";

// El nombre accesible contiene el texto visible (ES/EN): criterio «etiqueta en el nombre».
const ROTULO: Record<Idioma, Clave> = { es: "shell.idioma.es", en: "shell.idioma.en" };

/**
 * Pildora segmentada ES / EN del pie del sidebar (ds3), gemela visual del selector de tema: grupo de dos botones de alternancia
 * (`aria-pressed`; el tema es el unico `radiogroup` del pie). Guarda la
 * preferencia (`lib/idioma`); la traduccion de la consola es de otro carril. Sin bandera ds3 el shell la monta oculta.
 */
export function SelectorIdioma({ className }: { className?: string }) {
  const [idioma, setIdioma] = useState<Idioma>("es");
  // Pasa por el proveedor (cambiarIdioma): guarda, anuncia y llama a `persistir` cuando exista.
  const { t, cambiarIdioma } = useI18n();

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
    <div role="group" aria-label={t("shell.idioma")} className={cn("ds3-idioma inline-flex items-center gap-0.5 rounded-full border border-border p-0.5", className)}>
      {IDIOMAS.map((valor) => {
        const activo = idioma === valor;
        return (
          <button
            key={valor}
            type="button"
            aria-pressed={activo}
            aria-label={t(ROTULO[valor])}
            title={t(ROTULO[valor])}
            lang={valor}
            onClick={() => {
              setIdioma(valor);
              cambiarIdioma(valor);
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
