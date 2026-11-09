// i18n ES/EN de la config del Copiloto de cada vertical: arma la version en ingles a partir de `config.en`. Las consultas directas
// conservan sus claves en espanol (el servidor puede sugerir preguntas en espanol con `out_of_catalog`) y suman las del ingles,
// que apuntan a la MISMA herramienta con los MISMOS argumentos. Lo que no tiene traduccion se queda en espanol (nunca vacio).
import type { CopilotoConfigVertical } from "./tipos.ts";

export type IdiomaCopiloto = "es" | "en";

export function configEnIdioma(config: CopilotoConfigVertical, idioma: IdiomaCopiloto): CopilotoConfigVertical {
  const en = config.en;
  if (idioma === "es" || !en) return config;
  const pregunta = (q: string): string => en.preguntas[q] ?? q;
  const directas = { ...config.directas };
  for (const [q, d] of Object.entries(config.directas)) directas[pregunta(q)] = d;
  return {
    ...config,
    textos: { ...config.textos, ...en.textos },
    sugerencias: config.sugerencias.map(pregunta),
    categorias: config.categorias.map((c) => ({ titulo: en.temas[c.titulo] ?? c.titulo, preguntas: c.preguntas.map(pregunta) })),
    directas,
    // Solo las herramientas de ESTA config (la de restaurantes sin `cfo.ver` no debe recuperar las `cfo_*` del ingles compartido).
    etiquetasHerramienta: Object.fromEntries(Object.entries(config.etiquetasHerramienta).map(([h, e]) => [h, en.etiquetasHerramienta[h] ?? e])),
    textoSinAcceso: en.textoSinAcceso,
  };
}

/** Texto del estado «sin acceso» en el idioma (las paginas que cortan antes de montar `CopilotoPage`). */
export function textoSinAccesoEn(config: CopilotoConfigVertical, idioma: IdiomaCopiloto): string {
  return idioma === "en" && config.en ? config.en.textoSinAcceso : config.textoSinAcceso;
}
