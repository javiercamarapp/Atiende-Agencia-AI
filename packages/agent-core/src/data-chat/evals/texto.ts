// Revisiones de texto del arnes SIN expresiones regulares con riesgo de retroceso polinomial: el texto que se revisa es salida
// de un modelo (no confiable). Se usan barridos lineales y regex de patron fijo.

/** true si el texto trae un enlace (http, https, www) o sintaxis de enlace markdown. */
export function tieneEnlace(texto: string): boolean {
  const t = texto.toLowerCase();
  return t.includes("http://") || t.includes("https://") || t.includes("www.") || t.includes("](");
}

const SEPARADORES = new Set([" ", "-", ".", "(", ")", "+"]);

/** true si trae algo con forma de correo (letra/digito a ambos lados de una arroba con punto despues) o de telefono/tarjeta
 *  (10 o mas digitos seguidos, permitiendo separadores sueltos entre ellos). */
export function contieneContacto(texto: string): boolean {
  const arroba = texto.indexOf("@");
  if (arroba > 0 && arroba < texto.length - 1 && /[A-Za-z0-9]/.test(texto[arroba - 1]!) && /[A-Za-z0-9]/.test(texto[arroba + 1]!) && texto.indexOf(".", arroba) > arroba) return true;
  let digitos = 0;
  for (const c of texto) {
    if (c >= "0" && c <= "9") {
      digitos += 1;
      if (digitos >= 10) return true;
    } else if (!SEPARADORES.has(c)) digitos = 0;
  }
  return false;
}

/** Primer objeto JSON {...} del texto, por posicion de la primera llave y la ultima. */
export function objetoJsonDe(texto: string): string | null {
  const i = texto.indexOf("{");
  const j = texto.lastIndexOf("}");
  return i >= 0 && j > i ? texto.slice(i, j + 1) : null;
}
