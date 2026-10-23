// Normalizacion del celular mexicano a E.164 (+52 y 10 digitos) para el login del repartidor (docs/LOGIN-CHOFER-WHATSAPP.md).
// Acepta lo que un repartidor teclea en la practica: 10 digitos, con 52 o 521 delante, con +, espacios, guiones o parentesis. No recorta
// digitos "a la fuerza": cualquier otra longitud o prefijo es invalido (un numero mal leido no debe caer en OTRA persona).

/** E.164 mexicano (`+52` + 10 digitos, el primero distinto de 0) o `null` si no es un celular mexicano valido. */
export function normalizarTelefonoMx(entrada: unknown): string | null {
  if (typeof entrada !== "string" || entrada.length > 32) return null;
  // Solo caracteres que un humano teclea en un telefono; letras u otros simbolos invalidan.
  if (!/^[+\d\s().-]+$/.test(entrada)) return null;
  const digitos = entrada.replace(/\D/g, "");
  let nacional: string;
  if (digitos.length === 10) nacional = digitos;
  else if (digitos.length === 12 && digitos.startsWith("52")) nacional = digitos.slice(2);
  else if (digitos.length === 13 && digitos.startsWith("521")) nacional = digitos.slice(3);
  else return null;
  if (!/^[1-9]\d{9}$/.test(nacional)) return null;
  return `+52${nacional}`;
}
