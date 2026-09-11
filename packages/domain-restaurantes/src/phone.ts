// Port literal de restaurantes/supabase/functions/_shared/create-order-core.ts
// (normalizePhone/canonicalizeMexicanPhone) — cero cambios de comportamiento. El
// mismo cliente real llega con el teléfono en formatos distintos según el canal
// (ElevenLabs transcribe la voz, Meta manda el wa_id sin "+", el checkout web manda
// lo que el cliente haya tecleado); sin normalizar, el MISMO cliente aparecía como
// "nuevo" cada vez que el formato variaba, perdiendo tier VIP/direcciones/historial
// (bug real confirmado 3-sep-2026).

/**
 * Normaliza a los últimos 10 dígitos (número nacional significativo mexicano) —
 * absorbe "+", espacios, guiones, "52"/"521" de país. Si el identificador no tiene un
 * mínimo real de dígitos (7), se usa el string original completo — un fragmento vacío
 * o casi vacío no debe volverse la clave de unicidad de varios clientes distintos
 * (bug real confirmado 3-sep-2026: dos customers distintos colapsados en phone "").
 */
export function normalizePhone(phone: string): string {
  const soloDigitos = phone.replace(/\D/g, "");
  if (soloDigitos.length >= 7) return soloDigitos.slice(-10);
  return phone.trim();
}

/**
 * Valida el número que el agente de voz/WhatsApp entendió antes de buscar o crear.
 * Acepta el número nacional de 10 dígitos y las dos formas reales de México que
 * pueden traer +52/521. No recorta silenciosamente una cantidad arbitraria de
 * dígitos: eso podría asociar el pedido con otra persona.
 */
export function canonicalizeMexicanPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("52")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("521")) return digits.slice(3);
  return null;
}
