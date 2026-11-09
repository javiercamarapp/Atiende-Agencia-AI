// Textos del aviso de error ds3 (EstadoError, Rovaq «No disponible ahora»), aparte de ds3-contenido-textos.ts porque EstadoError va en la
// entrada de la app: este modulo es lo unico que suma ahi. Mismo criterio para el carril de i18n: claves estables, sin cadenas sueltas.
export const TEXTOS_DS3_ERROR = {
  explicacion: "No está disponible ahora. Vuelve a intentarlo en un momento.",
  verDetalle: "Ver detalle técnico",
  ocultarDetalle: "Ocultar detalle técnico",
  reintentar: "Reintentar",
} as const;

/**
 * ¿El texto de un error es tecnico (no para la persona)? Codigo HTTP (4xx/5xx) o de red, nombre de excepcion, JSON/HTML, identificadores con guion
 * bajo o rutas de API. Un mensaje ya escrito para la persona («No se pudieron cargar los KPIs.») no lo es.
 */
export function pareceErrorTecnico(texto: string): boolean {
  return /\b(HTTP|status|fetch|JSON|[A-Z][a-z]+Error|ECONN\w*|ETIMEDOUT|SQLSTATE|null|undefined)\b|\b[45]\d\d\b|[{}<>]|\w_\w|\/v\d\//.test(texto);
}
