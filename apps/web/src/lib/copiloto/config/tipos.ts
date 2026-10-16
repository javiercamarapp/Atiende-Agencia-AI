// Forma de la configuracion de UNA vertical del Copiloto. La pagina generica (`CopilotoPage`) la recibe tal cual: aqui
// solo van textos y listas, nunca datos de negocio ni respuestas (esas llegan del servidor por el transporte).
// Las demas verticales (CHAT-09..13) agregan su propio archivo `config/<vertical>.ts` con esta misma forma.
import type { CopilotoCategoria, CopilotoDirecta, CopilotoTextos } from "@atiende/ui";

export interface CopilotoConfigVertical {
  /** Nombre corto de la vertical (nombra los CSV descargados). */
  readonly vertical: string;
  readonly textos: CopilotoTextos;
  /** Maximo 5 chips en reposo. */
  readonly sugerencias: readonly string[];
  /** Tarjetas con 2 o 3 preguntas (restaurantes suma la tarjeta «CFO» con 5, CFO-09). */
  readonly categorias: readonly CopilotoCategoria[];
  /** Texto EXACTO de cada chip y pregunta de tarjeta -> consulta directa (herramienta del catalogo + argumentos tipados, p. ej. el
   *  periodo), que el servidor ejecuta SIN modelo. Un test del API valida cada entrada contra el catalogo real de la vertical. */
  readonly directas: Readonly<Record<string, CopilotoDirecta>>;
  /** Herramienta del catalogo -> texto del paso "en vivo" ("Leyendo ventas por dia"). */
  readonly etiquetasHerramienta: Readonly<Record<string, string>>;
  /** Herramienta -> ruta interna de la pantalla fuente, con `:orgSlug` que la pagina sustituye. Solo rutas que empiezan con "/". */
  readonly rutasFuente: Readonly<Record<string, string>>;
  readonly maxCaracteres: number;
  /** Texto del estado vacio cuando el rol no tiene acceso. */
  readonly textoSinAcceso: string;
}
