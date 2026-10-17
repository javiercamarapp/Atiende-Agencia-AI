// Guarda de los avisos de privacidad: un texto legal con datos "por completar" NO puede salir publicado.
// Los borradores (docs/legal/*.md) marcan cada dato del negocio que el repo no conoce como `[[POR COMPLETAR: ...]]`
// (razon social, domicilio, correo ARCO, telefono...). Aqui vive el detector, que usan la prueba de docs/legal/publicable/
// y la validacion de la configuracion de privacidad. Documentacion operativa, NO asesoria legal.
//
// Sin expresiones regulares con cuantificadores anidados o abiertos sobre el texto de entrada (entrada no confiable, p. ej.
// el nombre del responsable): se recorre con indexOf, en tiempo lineal.

const ABRE = "[[";
const CIERRA = "]]";
const ABRE_PLANTILLA = "{{";
const CIERRA_PLANTILLA = "}}";
// Despues de "[[" (y espacios), la palabra clave. Anclada con `y` sobre un fragmento corto: no hay retroceso.
const CLAVE_RE = /^\s{0,16}POR\s{1,16}COMPLETAR\b/i;

/** Marcadores completos `[[POR COMPLETAR: ...]]` que quedan en el texto (vacio = nada pendiente). */
export function marcadoresPendientes(texto: string): readonly string[] {
  const encontrados: string[] = [];
  let desde = 0;
  for (;;) {
    const inicio = texto.indexOf(ABRE, desde);
    if (inicio === -1) break;
    const cuerpo = inicio + ABRE.length;
    if (CLAVE_RE.test(texto.slice(cuerpo, cuerpo + 64))) {
      const fin = texto.indexOf(CIERRA, cuerpo);
      if (fin === -1) break;
      encontrados.push(texto.slice(inicio, fin + CIERRA.length));
      desde = fin + CIERRA.length;
    } else {
      desde = cuerpo;
    }
  }
  return encontrados;
}

/** `true` si hay un marcador roto (`[[POR COMPLETAR` sin cierre) o una plantilla `{{...}}` sin resolver. */
function tieneResiduo(texto: string): boolean {
  let desde = 0;
  for (;;) {
    const inicio = texto.indexOf(ABRE, desde);
    if (inicio === -1) break;
    const cuerpo = inicio + ABRE.length;
    if (CLAVE_RE.test(texto.slice(cuerpo, cuerpo + 64))) return true;
    desde = cuerpo;
  }
  const abre = texto.indexOf(ABRE_PLANTILLA);
  return abre !== -1 && texto.indexOf(CIERRA_PLANTILLA, abre + ABRE_PLANTILLA.length) !== -1;
}

/** `true` si el texto conserva un marcador (completo o roto) o un residuo de plantilla. */
export function tieneMarcadoresSinCompletar(texto: string): boolean {
  return marcadoresPendientes(texto).length > 0 || tieneResiduo(texto);
}

/** Lanza si el texto conserva marcadores: se llama antes de publicar un aviso. `nombre` solo sirve para el mensaje. */
export function assertSinMarcadores(texto: string, nombre = "el aviso"): void {
  if (!tieneMarcadoresSinCompletar(texto)) return;
  const pendientes = marcadoresPendientes(texto);
  const muestra = pendientes.slice(0, 3).join(" ");
  throw new Error(`${nombre} no se puede publicar: tiene ${pendientes.length} dato(s) por completar${muestra ? ` (${muestra})` : " o residuos de plantilla"}.`);
}
