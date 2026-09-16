// Saludo real por hora del día + nombre del staff -- pedido explícito: "Buenos
// días"/"Buenas tardes"/"Buenas noches" según la hora LOCAL del navegador (no la
// del servidor -- un saludo de bienvenida es del punto de vista de quien lo lee),
// con el primer nombre real del staff cuando existe, y `email` como respaldo
// honesto (nunca "Usuario"/cadena vacía) para sesiones sin `fullName` -- ver el
// comentario de `LoginSession.fullName` en `auth-client.ts`: puede venir vacío en
// una sesión vieja persistida antes de este campo, y aunque el tipo lo declara
// `string` no-opcional, una sesión leída de `localStorage` con `JSON.parse` nunca
// se valida en tiempo de ejecución -- así que esta función trata cualquier valor
// falsy (undefined incluido, no solo "") como ausente.
export function saludoPorHora(fecha: Date = new Date()): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  const hora = fecha.getHours();
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

/** Primer nombre a partir de `fullName` ("Ana María Torres" -> "Ana"); si no hay
 *  `fullName` real, cae al local-part del correo ("ana.torres@x.com" -> "ana.torres")
 *  -- nunca inventa un nombre ni devuelve "Usuario"/genérico. */
export function primerNombreOCorreo(fullName: string | undefined, email: string): string {
  const nombre = fullName?.trim();
  if (nombre) return nombre.split(/\s+/)[0]!;
  return email.split("@")[0] ?? email;
}

/** Saludo completo listo para pintar -- "Buenos días, Ana". */
export function saludoConNombre(fullName: string | undefined, email: string, fecha: Date = new Date()): string {
  return `${saludoPorHora(fecha)}, ${primerNombreOCorreo(fullName, email)}`;
}
