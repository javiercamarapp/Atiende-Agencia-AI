// ═══════════════════════════════════════════════════════════════════════════
// CATÁLOGOS SAT AVANZADOS — puerto de la parte de
// ~/Desktop/supabase/despachos/b2b_ai/cfdi/catalogs.py que packages/billing/src/
// cfdi/catalogs.ts NO porta (ver diseño Fase 1 despachos §2, tabla de gaps):
// DIOT_TIPO_OPERACION, CP_CATEGORIAS, TIPOS_FACTOR y sus validadores.
//
// Deliberadamente en domain-despachos y NO en packages/billing: billing es
// infraestructura compartida y estable entre verticales (CFDI de cobro SaaS); DIOT y
// la clasificación contable por ClaveProdServ son necesidades propias de un despacho
// contable, no de "cualquier vertical que factura". Si otra vertical llega a necesitar
// esto, se "sube" a billing entonces — no antes (mismo criterio ya documentado en el
// diseño para retenciones/fechas/IEPS/nómina/notas-de-crédito).
// ═══════════════════════════════════════════════════════════════════════════

// c_TipoFactor (Anexo 20, tabla c_TipoFactor)
export const TIPOS_FACTOR = new Set(["Tasa", "Cuota", "Exento"]);

// DIOT — Tipo de Operación (Regla 3.10.7 RMF vigente, catálogo SAT DIOT). Los tres
// valores válidos son 03 (servicios profesionales), 06 (arrendamiento), 85 (otros).
export const DIOT_TIPO_OPERACION: Record<string, string> = {
  "03": "Prestacion de servicios profesionales",
  "06": "Arrendamiento de inmuebles",
  "85": "Otros",
};

export function esDiotTipoOperacionValido(codigo: string): boolean {
  return codigo in DIOT_TIPO_OPERACION;
}

// Prefijos de ClaveProdServ que delatan categoría contable (para el classifier).
// Nómina NO se detecta por ClaveProdServ (84111505 también se usa en honorarios/
// consultoría); se detecta por TipoDeComprobante=N — ver reglas-fiscales-avanzadas.ts.
export const CP_CATEGORIAS: Record<string, readonly string[]> = {
  activo_fijo: ["432115", "432118", "432119", "441115", "431915", "811216", "811217"],
  gasto_operativo: ["811111", "811121", "811122", "811211", "821015", "821021", "821115"],
  inversion: ["811000", "821110", "811115"],
};

export function describeImpuesto(codigo: string): string {
  const IMPUESTOS: Record<string, string> = { "001": "ISR", "002": "IVA", "003": "IEPS", "004": "ISH" };
  return IMPUESTOS[codigo] ?? codigo;
}
