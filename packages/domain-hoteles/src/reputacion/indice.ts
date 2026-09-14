// Fase 11 hoteles (REQ-CRM-002/003, P1/F) — índice de reputación agregado.
//
// A diferencia de `clasificador.ts` (port literal del origen), este archivo NO
// tiene un equivalente 1:1 en `hoteles/packages/domain-hotel/src/reputacion/` --
// verificado por grep antes de escribirse: el origen nunca aisló el cálculo del
// agregado en un archivo propio. Se construye aquí porque el gap de paridad lo pide
// explícitamente ("índice de reputación agregado") y porque un inbox unificado sin
// ninguna vista resumida deja de nuevo al staff a hojear reseña por reseña -- mismo
// principio que ya aplica el resto de domain-hoteles (p.ej. `pl/usaliPL.ts` no es
// solo el detalle de gastos, también resume EBITDA/punto de equilibrio).
//
// Dominio puro determinista, SIN I/O: recibe reseñas YA clasificadas (por
// `clasificarResena`, ya persistidas como `hoteles.guest_review`) y calcula un
// resumen -- nunca vuelve a correr el clasificador, nunca decide una acción. Quien
// llama (una futura ruta de `apps/api`, fuera de esta fase) es responsable de leer
// las filas reales y pasarlas aquí; ver comentario de cabecera de `clasificador.ts`
// y el README del paquete para el detalle de qué queda pendiente.

import type { ReviewTopicId, SentimentLabel } from "./clasificador.ts";

/** Una reseña ya clasificada, en la forma mínima que el índice necesita -- espejo
 *  deliberadamente delgado de las columnas reales de `hoteles.guest_review`
 *  (`sentiment`/`sentiment_score`/`topics`/`calificacion`), para que este módulo no
 *  dependa de ningún tipo de fila de repositorio ni de I/O. */
export interface ResenaClasificadaParaIndice {
  readonly sentimientoEtiqueta: SentimentLabel;
  readonly sentimientoPuntaje: number;
  readonly temas: readonly { readonly topic: ReviewTopicId; readonly esConocido: boolean }[];
  readonly calificacion?: number | null;
}

export const SENTIMENT_LABELS: readonly SentimentLabel[] = [
  "muy_negativo",
  "negativo",
  "neutral",
  "positivo",
  "muy_positivo",
];

export interface TemaAgregado {
  readonly topic: ReviewTopicId;
  readonly esConocido: boolean;
  /** Número de RESEÑAS distintas que mencionan el tema (no la suma de menciones
   *  dentro de cada una) -- lo que importa para priorizar un problema recurrente es
   *  cuántos huéspedes distintos lo reportaron, no cuántas veces lo repitió el más
   *  insistente. */
  readonly resenas: number;
  /** De esas reseñas, cuántas tuvieron sentimiento negativo/muy_negativo. */
  readonly resenasNegativas: number;
  readonly pctNegativo: number;
}

export interface IndiceReputacion {
  readonly totalResenas: number;
  /** Promedio del `puntaje` léxico (-1..1) de todas las reseñas del período. `null`
   *  cuando no hay ninguna reseña (evita dividir entre cero / reportar un 0 falso). */
  readonly promedioSentimiento: number | null;
  /** Promedio de `calificacion` (1-5) solo de las reseñas que la trajeron -- una
   *  reseña sin estrellas (encuesta de texto libre) no cuenta ni en el numerador ni
   *  en el denominador, nunca se le asume una calificación. */
  readonly promedioCalificacion: number | null;
  readonly distribucionSentimiento: Record<SentimentLabel, number>;
  readonly distribucionSentimientoPct: Record<SentimentLabel, number>;
  /** 0 (peor reputación posible) .. 100 (mejor) -- reescalado lineal de
   *  `promedioSentimiento` (-1..1), `null` cuando `totalResenas` es 0. Pensado como
   *  un solo número para un tablero/KPI, nunca reemplaza la distribución completa. */
  readonly puntajeIndice: number | null;
  /** Temas ordenados por `resenas` descendente (más mencionado primero). */
  readonly temasFrecuentes: readonly TemaAgregado[];
  /** Subconjunto de `temasFrecuentes`: solo temas con al menos `minResenasCritico`
   *  reseñas Y mayoría de sentimiento negativo (`pctNegativo > 50`) -- la lista
   *  corta que de verdad amerita atención operativa, no cualquier mención. */
  readonly temasCriticos: readonly TemaAgregado[];
}

export interface CalcularIndiceReputacionOptions {
  /** Mínimo de reseñas distintas que debe mencionar un tema para poder calificar
   *  como "crítico", incluso si el 100% de esas pocas reseñas fue negativo -- evita
   *  que una sola queja aislada aparente ser un problema sistémico. Default: 2. */
  readonly minResenasCritico?: number;
  /** Cuántos temas conservar en `temasFrecuentes` (0 = todos). Default: 10. */
  readonly limiteTemasFrecuentes?: number;
}

const NEGATIVOS: ReadonlySet<SentimentLabel> = new Set(["negativo", "muy_negativo"]);

function distribucionVacia(): Record<SentimentLabel, number> {
  return { muy_negativo: 0, negativo: 0, neutral: 0, positivo: 0, muy_positivo: 0 };
}

/**
 * Calcula el índice de reputación agregado de un conjunto de reseñas YA
 * clasificadas (mismo período/hotel -- quien llama decide el recorte, este módulo
 * no conoce fechas ni IDs). Determinista: la misma lista de reseñas, en cualquier
 * orden, produce siempre el mismo resultado (los temas se ordenan de forma estable
 * por conteo descendente y, en empate, alfabéticamente por `topic`).
 */
export function calcularIndiceReputacion(
  resenas: readonly ResenaClasificadaParaIndice[],
  options: CalcularIndiceReputacionOptions = {},
): IndiceReputacion {
  const minResenasCritico = options.minResenasCritico ?? 2;
  const limiteTemasFrecuentes = options.limiteTemasFrecuentes ?? 10;

  const totalResenas = resenas.length;
  const distribucionSentimiento = distribucionVacia();
  let sumaSentimiento = 0;
  let sumaCalificacion = 0;
  let countCalificacion = 0;

  // topic -> { esConocido, resenas, resenasNegativas } -- por RESEÑA, no por mención
  // (ver comentario de `TemaAgregado.resenas`): un `Set` de topics ya vistos DENTRO
  // de la reseña actual evita contar dos veces si el mismo tema apareciera más de
  // una vez en `temas` (no debería pasar viniendo de `detectarTemas`, pero este
  // módulo no confía en esa invariante ajena).
  const temasMap = new Map<ReviewTopicId, { esConocido: boolean; resenas: number; resenasNegativas: number }>();

  for (const resena of resenas) {
    distribucionSentimiento[resena.sentimientoEtiqueta] += 1;
    sumaSentimiento += resena.sentimientoPuntaje;
    if (resena.calificacion != null) {
      sumaCalificacion += resena.calificacion;
      countCalificacion += 1;
    }

    const esNegativa = NEGATIVOS.has(resena.sentimientoEtiqueta);
    const topicsVistosEnEstaResena = new Set<ReviewTopicId>();
    for (const tema of resena.temas) {
      if (topicsVistosEnEstaResena.has(tema.topic)) continue;
      topicsVistosEnEstaResena.add(tema.topic);
      const entrada = temasMap.get(tema.topic) ?? { esConocido: tema.esConocido, resenas: 0, resenasNegativas: 0 };
      entrada.resenas += 1;
      if (esNegativa) entrada.resenasNegativas += 1;
      // `esConocido` es una propiedad del tema, no de la reseña -- si alguna vez
      // difiere entre apariciones (no debería), se queda con la primera vista, sin
      // fallar: este módulo solo agrega, nunca valida la entrada ajena.
      temasMap.set(tema.topic, entrada);
    }
  }

  const distribucionSentimientoPct = distribucionVacia();
  if (totalResenas > 0) {
    for (const etiqueta of SENTIMENT_LABELS) {
      distribucionSentimientoPct[etiqueta] = Math.round((distribucionSentimiento[etiqueta] / totalResenas) * 1000) / 10;
    }
  }

  const promedioSentimiento = totalResenas === 0 ? null : Math.round((sumaSentimiento / totalResenas) * 1000) / 1000;
  const promedioCalificacion = countCalificacion === 0 ? null : Math.round((sumaCalificacion / countCalificacion) * 100) / 100;
  const puntajeIndice = promedioSentimiento === null ? null : Math.round(((promedioSentimiento + 1) / 2) * 1000) / 10;

  const temasFrecuentesCompleto: TemaAgregado[] = [...temasMap.entries()]
    .map(([topic, v]): TemaAgregado => ({
      topic,
      esConocido: v.esConocido,
      resenas: v.resenas,
      resenasNegativas: v.resenasNegativas,
      pctNegativo: Math.round((v.resenasNegativas / v.resenas) * 1000) / 10,
    }))
    .sort((a, b) => b.resenas - a.resenas || a.topic.localeCompare(b.topic));

  const temasFrecuentes = limiteTemasFrecuentes > 0 ? temasFrecuentesCompleto.slice(0, limiteTemasFrecuentes) : temasFrecuentesCompleto;

  const temasCriticos = temasFrecuentesCompleto.filter(
    (t) => t.resenas >= minResenasCritico && t.pctNegativo > 50,
  );

  return {
    totalResenas,
    promedioSentimiento,
    promedioCalificacion,
    distribucionSentimiento,
    distribucionSentimientoPct,
    puntajeIndice,
    temasFrecuentes,
    temasCriticos,
  };
}
