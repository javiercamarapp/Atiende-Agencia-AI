// Saneo de texto controlado por el cliente (nombre, direccion, notas) antes de que llegue a la
// comanda, al panel o al prompt del modelo. Defensa en profundidad: el texto libre del cliente no
// debe poder introducir saltos de linea, caracteres de control ni marcas de direccion de texto
// que lo hagan pasar por una linea del sistema o por una instruccion.

// Controles C0/C1, ceros de ancho, marcas bidireccionales (incluye RLO/LRO e isolates) y BOM.
// eslint-disable-next-line no-control-regex
const INVISIBLES = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const INVISIBLES_SALVO_SALTO = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Una sola linea: sin controles ni bidi, espacios colapsados, recortada. */
export function sanitizeInlineText(value: string, maxLength = 1000): string {
  return value.replace(INVISIBLES, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Lineas que el sistema agrega a `orders.notes`: una nota del cliente no puede hacerse pasar por ellas.
const LINEA_DE_SISTEMA = /^\s*(?:canal|propina|promoci[oó]n aplicada|recepci[oó]n de alcohol|complementos incluidos|complementos solicitados|no enviar complementos|b[aá]sicas|pedidas|ubicaci[oó]n de entrega|paga con|llevar terminal|indicaciones de acceso|tel[eé]fono alterno|hora de recogida|pedido programado)\b/i;

/** Notas multilinea: conserva los saltos de linea reales pero quita controles y neutraliza las lineas que imitan al sistema. */
export function sanitizeNotes(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLES_SALVO_SALTO, "")
    .split("\n")
    .map((line) => (LINEA_DE_SISTEMA.test(line) ? `Cliente dice: ${line.trim()}` : line))
    .join("\n")
    .trim();
}

export const ADDRESS_MASK_MARKER = "(calle y número omitidos)";
export const ADDRESS_OMITTED_MARKER = "(dirección guardada, omitida)";

/**
 * Referencia parcial de una direccion para el prompt del modelo: omite la calle y el numero (primer
 * segmento) y conserva colonia/ciudad, suficiente para preguntar "¿es para la misma zona?". La
 * direccion completa solo viaja a la comanda y a la herramienta `buscar_cliente` del propio cliente.
 */
export function maskAddressForPrompt(address: string): string {
  const clean = sanitizeInlineText(address, 300);
  const segments = clean.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    // Se descarta el primer segmento (calle) y todo segmento con digitos (numero, "Calle 5 #123"
    // en segunda posicion, codigo postal), para no filtrar numeracion con el orden "Colonia, Calle".
    const kept = segments.slice(1).filter((s) => !/\d/.test(s));
    return kept.length > 0 ? `${ADDRESS_MASK_MARKER}, ${kept.join(", ")}` : ADDRESS_OMITTED_MARKER;
  }
  // Sin comas: conserva solo palabras sin digitos (colonia o referencia) para no exponer numeracion.
  const words = clean.split(" ").filter((w) => !/\d/.test(w));
  const tail = words.slice(-3).join(" ");
  return tail ? `${ADDRESS_MASK_MARKER}, ${tail}` : ADDRESS_OMITTED_MARKER;
}
