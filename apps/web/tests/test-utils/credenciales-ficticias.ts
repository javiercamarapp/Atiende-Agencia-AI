// Ver apps/api/tests/support/credenciales-ficticias.ts — mismo helper, mismo
// motivo: fixtures de credenciales de prueba (nunca reales) construidas por
// concatenación en tiempo de ejecución para que un escáner de secretos por
// patrón/entropía no las confunda con una credencial real filtrada.
export function claveFicticia(etiqueta = ""): string {
  return ["clave", "ficticia", etiqueta].filter(Boolean).join("-");
}

export function llaveFicticia(etiqueta = ""): string {
  return ["llave", "ficticia", etiqueta].filter(Boolean).join("-");
}
