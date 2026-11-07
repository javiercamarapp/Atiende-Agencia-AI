// Analítica del dueño · clasificador de «¿ya salió mi pedido?». ESPEJO del regex de la función SQL `restaurantes.analitica_pregunta_estado` (migración 163):
// una prueba compara las dos fuentes. Solo es una pista para la alerta: la alerta además exige un pedido abierto del mismo teléfono, por eso un
// «¿ya salieron los precios nuevos?» sin pedido abierto no alerta.
export const REGEX_PREGUNTA_ESTADO_FUENTE =
  "(^|[^a-z])(ya\\s+(sali[oó]|va\\s+(para|en)|viene|est[aá]\\s+en\\s+camino|lleg[oó]|mand(aron|[oó])|tard[oó])|c[oó]mo\\s+va\\s+(mi|el)\\s+pedido|cu[aá]nto\\s+(falta|tarda|m[aá]s)|d[oó]nde\\s+(est[aá]|viene|va)\\s+(mi|el)\\s+pedido|no\\s+ha\\s+llegado|sigue\\s+sin\\s+llegar)";

const RE = new RegExp(REGEX_PREGUNTA_ESTADO_FUENTE, "i");

export function esPreguntaDeEstado(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return RE.test(texto.slice(0, 500));
}
