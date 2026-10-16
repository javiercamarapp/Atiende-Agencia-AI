// Segmentador de frases para sintetizar POR FRASE: recibe los trozos de texto que el LLM va escribiendo y devuelve cada oracion en cuanto
// queda cerrada, para mandarla al TTS sin esperar a que el modelo termine. Puro y sin reloj.
//
// Reglas: una oracion termina en `.`, `!`, `?`, `…` o salto de linea SEGUIDOS de un espacio/fin de linea (asi "12.50" o "3.5" no se parten); no se parte
// tras abreviaturas comunes ("Sr.", "Dra.", "No."); una frase demasiado corta (< `minCaracteres`) se une con la siguiente para no mandar "Sí." sola; y una
// frase demasiado larga (> `maxCaracteres`) sin puntuacion se parte en la ultima coma o espacio.

export interface OpcionesSegmentador {
  readonly minCaracteres: number;
  readonly maxCaracteres: number;
}

export interface SegmentadorFrases {
  /** Agrega un trozo de texto y devuelve las frases que quedaron completas (en orden). */
  agregar(delta: string): string[];
  /** Fin del texto: devuelve lo que quede (sin puntuacion final), o `null`. */
  vaciar(): string | null;
}

const ABREVIATURAS = new Set(["sr", "sra", "srta", "dr", "dra", "lic", "ing", "arq", "no", "núm", "num", "av", "col", "tel", "esq", "art", "vs", "cp", "c.p", "mtro", "mtra"]);
const TERMINADORES = new Set([".", "!", "?", "…", "\n"]);
const CIERRES = new Set(["\"", "'", "»", ")", "”", "’", "?", "!", "."]);

/** Texto listo para la voz: sin marcas de markdown ni emojis (el TTS los leeria o los atoraria). */
export function limpiarParaVoz(texto: string): string {
  if (typeof texto !== "string") return "";
  return texto
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[*#`~>|]/g, " ")
    .replace(/(^|\s)_+|_+(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function esAbreviatura(antes: string): boolean {
  const m = /([\p{L}.]+)$/u.exec(antes);
  if (!m) return false;
  const palabra = (m[1] ?? "").toLowerCase();
  return palabra.length === 1 || ABREVIATURAS.has(palabra);
}

export function crearSegmentadorFrases(opciones: OpcionesSegmentador): SegmentadorFrases {
  const min = Math.max(1, Math.floor(opciones.minCaracteres));
  const max = Math.max(min + 1, Math.floor(opciones.maxCaracteres));
  let buf = "";

  /** Indice (exclusivo) del primer limite de oracion confirmado en `buf` que deja una frase de al menos `min` caracteres, o -1. */
  const buscarLimite = (): number => {
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i] as string;
      if (!TERMINADORES.has(c)) continue;
      // Agrupa terminadores y cierres consecutivos ("?!", "...", `."`).
      let fin = i + 1;
      while (fin < buf.length && (TERMINADORES.has(buf[fin] as string) || CIERRES.has(buf[fin] as string)) && buf[fin] !== "\n") fin++;
      // Sin caracter siguiente no se puede saber si la oracion cerro ("12." + "50"): se espera mas texto.
      if (fin >= buf.length && c !== "\n") return -1;
      const siguiente = buf[fin] ?? " ";
      if (c !== "\n" && !/\s/.test(siguiente)) {
        i = fin - 1;
        continue;
      }
      if (c === "." && esAbreviatura(buf.slice(0, i))) {
        i = fin - 1;
        continue;
      }
      if (buf.slice(0, fin).trim().length < min) {
        i = fin - 1;
        continue;
      }
      return fin;
    }
    return -1;
  };

  const cortarLargo = (): number => {
    if (buf.length <= max) return -1;
    const tramo = buf.slice(0, max);
    const coma = Math.max(tramo.lastIndexOf(", "), tramo.lastIndexOf("; "), tramo.lastIndexOf(": "));
    if (coma >= min) return coma + 1;
    const espacio = tramo.lastIndexOf(" ");
    return espacio >= min ? espacio : max;
  };

  return {
    agregar(delta: string): string[] {
      if (typeof delta !== "string" || delta === "") return [];
      buf += delta;
      const frases: string[] = [];
      for (;;) {
        let corte = buscarLimite();
        if (corte < 0) corte = cortarLargo();
        if (corte < 0) break;
        const frase = limpiarParaVoz(buf.slice(0, corte));
        buf = buf.slice(corte);
        if (frase !== "") frases.push(frase);
      }
      return frases;
    },
    vaciar(): string | null {
      const resto = limpiarParaVoz(buf);
      buf = "";
      return resto === "" ? null : resto;
    },
  };
}
