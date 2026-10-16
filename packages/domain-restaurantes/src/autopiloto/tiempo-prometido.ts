// Tiempo prometido aprendido (A-21/B-09) y saturacion (B-10). Funciones PURAS: los datos (muestras de entregas y cola abierta) los trae el
// repositorio. Reglas de producto:
//   * Con menos de 20 muestras se usa el texto fijo del dueno (respaldo).
//   * El estimado es la mediana de las ultimas entregas de la MISMA franja (dia de la semana, hora +-1) y canal, redondeada a rangos de 10 min.
//   * NUNCA promete menos que el piso del dueno (el dueno fija el piso): el limite inferior del texto fijo manda.
//   * Saturacion: si los pedidos abiertos superan el primer umbral se alarga el tiempo prometido (+15 min por omision); si superan el segundo
//     se PROPONE pausar la sucursal (nunca se pausa sola: es una tarjeta de aprobacion de un clic al gerente).
import type { CanalPedido } from "../types.ts";

export const MIN_MUESTRAS_TIEMPO = 20;

export interface SaturacionConfig {
  readonly umbral1: number | null;
  readonly umbral2: number | null;
  readonly extraMinutos: number;
}

export type EstadoSaturacion = "normal" | "alargado" | "proponer_pausa";

export function evaluarSaturacion(abiertos: number, cfg: SaturacionConfig): EstadoSaturacion {
  if (cfg.umbral2 !== null && abiertos > cfg.umbral2) return "proponer_pausa";
  if (cfg.umbral1 !== null && abiertos > cfg.umbral1) return "alargado";
  return "normal";
}

export function medianaMinutos(valores: readonly number[]): number | null {
  const v = valores.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mitad = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mitad]! : (v[mitad - 1]! + v[mitad]!) / 2;
}

/**
 * Limite inferior (minutos) que el dueno fijo en su texto para el canal, p. ej. "Domicilio 30-45 min, recoger 15-25 min" -> 30 (domicilio)
 * y 15 (recoger). Solo lee el tramo de texto del CANAL pedido (hasta la palabra del otro canal, un punto y coma o un punto): el numero de
 * recoger nunca es el piso de domicilio. Entiende minutos y horas ("1 a 2 horas" -> 60, "media hora" -> 30). Un numero sin unidad menor a 5
 * es ambiguo (podria ser horas) y no se usa. `null` si no se puede leer con certeza (entonces se usa el texto fijo tal cual, sin estimar).
 */
export function pisoMinutosDeTexto(texto: string | null | undefined, canal: CanalPedido): number | null {
  if (!texto) return null;
  const propia = canal === "domicilio" ? /domicilio/i : /recoger|recoge|mostrador/i;
  const ajena = canal === "domicilio" ? /recoger|recoge|mostrador/gi : /domicilio/gi;
  const m = propia.exec(texto);
  if (!m) return null;
  let tramo = texto.slice(m.index + m[0].length);
  ajena.lastIndex = 0;
  const corte = [tramo.search(ajena), tramo.search(/[;\n]|\.\s/)].filter((i) => i >= 0);
  if (corte.length > 0) tramo = tramo.slice(0, Math.min(...corte));
  if (/\bmedia\s+hora\b/i.test(tramo)) return 30;
  if (/\buna\s+hora\b/i.test(tramo)) return 60;
  const num = /(\d{1,3}(?:[.,]\d)?)\s*(?:-|–|a|y)?\s*(\d{1,3}(?:[.,]\d)?)?\s*(horas?|hrs?\b|h\b|minutos?|mins?\b|min\b)?/i.exec(tramo);
  if (!num) return null;
  const a = Number(num[1]!.replace(",", "."));
  const unidad = num[3]?.toLowerCase();
  if (!Number.isFinite(a) || a <= 0) return null;
  if (unidad === undefined) return a >= 5 ? Math.round(a) : null;
  const minutos = /^h/.test(unidad) ? Math.round(a * 60) : Math.round(a);
  return minutos > 0 ? minutos : null;
}

export interface EstimarTiempoInput {
  readonly textoFijo: string | null;
  readonly canal: CanalPedido;
  /** Minutos de las ultimas entregas de la franja (la base ya filtro por dia, hora y canal). */
  readonly muestras: readonly number[];
  /** Pedidos abiertos de la sucursal ahora. */
  readonly abiertos: number;
  readonly saturacion: SaturacionConfig;
}

export interface TiempoEstimado {
  readonly origen: "aprendido" | "texto_fijo";
  readonly rango: { readonly minimo: number; readonly maximo: number } | null;
  /** Texto listo para decir al cliente. */
  readonly texto: string;
  readonly saturacion: EstadoSaturacion;
  readonly muestras: number;
}

function redondearARango10(mediana: number): { minimo: number; maximo: number } {
  const minimo = Math.max(10, Math.floor(mediana / 10) * 10);
  return { minimo, maximo: minimo + 10 };
}

export function estimarTiempo(input: EstimarTiempoInput): TiempoEstimado {
  const saturacion = evaluarSaturacion(input.abiertos, input.saturacion);
  const extra = saturacion === "normal" ? 0 : input.saturacion.extraMinutos;
  const fijo = input.textoFijo?.trim() || null;
  const piso = pisoMinutosDeTexto(fijo, input.canal);
  const mediana = input.muestras.length >= MIN_MUESTRAS_TIEMPO ? medianaMinutos(input.muestras) : null;

  if (mediana === null || piso === null) {
    const sufijo = extra > 0 ? ` Hoy puede tardar unos ${extra} minutos mas por la carga.` : "";
    return { origen: "texto_fijo", rango: null, texto: `${fijo ?? "El tiempo lo confirma la sucursal."}${sufijo}`, saturacion, muestras: input.muestras.length };
  }
  const base = redondearARango10(mediana);
  const minimo = Math.max(base.minimo, piso) + extra;
  const maximo = Math.max(base.maximo, Math.max(base.minimo, piso) + 10) + extra;
  return { origen: "aprendido", rango: { minimo, maximo }, texto: `de ${minimo} a ${maximo} minutos`, saturacion, muestras: input.muestras.length };
}
