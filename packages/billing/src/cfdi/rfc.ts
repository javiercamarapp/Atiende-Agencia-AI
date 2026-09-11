// ═══════════════════════════════════════════════════════════════════════════
// VALIDACIÓN DE RFC — puerto de
// ~/Desktop/supabase/despachos/b2b_ai/common/rfc.py (RFC_RE canónico,
// reutilizado por todos los módulos de ese repo para no divergir el patrón).
// ═══════════════════════════════════════════════════════════════════════════

/** 3-4 letras (& y Ñ incluidas) + 6 dígitos + 2-3 alfanuméricos. Cubre
 *  persona moral (12) y persona física (13), homoclave vieja y nueva. */
export const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

export function normalizarRfc(rfc: string | null | undefined): string {
  return (rfc ?? '').trim().toUpperCase();
}

export function esRfcValido(rfc: string | null | undefined): boolean {
  if (!rfc) return false;
  return RFC_RE.test(normalizarRfc(rfc));
}
