// Guarda de los avisos de privacidad: un texto legal con datos "por completar" NO puede salir publicado.
// Los borradores (docs/legal/*.md) marcan cada dato del negocio que el repo no conoce como `[[POR COMPLETAR: ...]]`
// (razon social, domicilio, correo ARCO, telefono...). Aqui vive el detector, que usan la prueba de docs/legal/publicable/
// y la validacion de la configuracion de privacidad. Documentacion operativa, NO asesoria legal.

const MARCADOR_RE = /\[\[\s*POR\s+COMPLETAR\b[^\]]*\]\]/gi;
// Tambien se rechaza un marcador truncado o mal escrito (p. ej. "[[POR COMPLETAR" sin cierre, o "{{...}}" de plantilla).
const RESIDUO_RE = /\[\[\s*POR\s+COMPLETAR|\{\{[^}]*\}\}/i;

/** Marcadores completos `[[POR COMPLETAR: ...]]` que quedan en el texto (vacio = nada pendiente). */
export function marcadoresPendientes(texto: string): readonly string[] {
  return texto.match(MARCADOR_RE) ?? [];
}

/** `true` si el texto conserva un marcador (completo o roto) o un residuo de plantilla. */
export function tieneMarcadoresSinCompletar(texto: string): boolean {
  return marcadoresPendientes(texto).length > 0 || RESIDUO_RE.test(texto);
}

/** Lanza si el texto conserva marcadores: se llama antes de publicar un aviso. `nombre` solo sirve para el mensaje. */
export function assertSinMarcadores(texto: string, nombre = "el aviso"): void {
  if (!tieneMarcadoresSinCompletar(texto)) return;
  const pendientes = marcadoresPendientes(texto);
  const muestra = pendientes.slice(0, 3).join(" ");
  throw new Error(`${nombre} no se puede publicar: tiene ${pendientes.length} dato(s) por completar${muestra ? ` (${muestra})` : " o residuos de plantilla"}.`);
}
