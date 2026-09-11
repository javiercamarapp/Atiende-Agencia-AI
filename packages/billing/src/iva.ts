// ═══════════════════════════════════════════════════════════════════════════
// DE QUÉ LADO DEL PRECIO ESTÁ EL IVA — puerto directo de
// ~/likida.ai/src/lib/saas/iva.ts.
//
// El fallo que este archivo existe para cerrar (real, en producción de
// Likida): un módulo guardaba el precio del plan como "lo que el cliente
// transfiere" (IVA incluido) y otro lo mandaba al PAC documentado como
// "subtotal SIN IVA" (que el PAC le suma 16% encima). Con un plan de
// $10,000 el cliente transfería $10,000 y el CFDI salía por $11,600 — y un
// CFDI ya timbrado ante el SAT es irreversible sin cancelarlo.
//
// La regla: `criterio` es `boolean | null`, y `null` NO es "sin IVA" — es
// "nadie lo declaró". Con `null` se LANZA en vez de asumir un lado, porque
// asumir el lado equivocado es exactamente el bug de arriba.
// ═══════════════════════════════════════════════════════════════════════════

export const TASA_IVA = 0.16;

/** `null` = nadie declaró de qué lado está el IVA. No es lo mismo que
 *  `false` (IVA aparte): un default inventaría una respuesta. */
export type CriterioIva = boolean | null;

export interface DesgloseIva {
  /** Base gravable — lo que se le manda al PAC como precio del concepto. */
  subtotal: number;
  iva: number;
  /** Lo que el cliente TRANSFIERE/paga. */
  total: number;
}

export class CriterioIvaFaltante extends Error {
  constructor() {
    super(
      'No se declaró si el precio incluye IVA o si el IVA va aparte. No se calcula un lado a ciegas: ' +
      'emitir o timbrar con el criterio equivocado produce un cobro o un CFDI por un monto distinto al real.',
    );
    this.name = 'CriterioIvaFaltante';
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parte un precio en subtotal + IVA. LANZA si `criterio` es `null`/`undefined`.
 *
 * El redondeo se cierra sobre el TOTAL, no sobre las partes por separado: se
 * redondea el subtotal y el IVA se calcula como el resto, así
 * `subtotal + iva === total` se cumple por construcción.
 */
export function desglosarPrecio(precio: number, criterio: CriterioIva): DesgloseIva {
  if (!Number.isFinite(precio) || precio < 0) {
    throw new Error('El precio no es una cifra válida.');
  }
  if (criterio === null || criterio === undefined) {
    throw new CriterioIvaFaltante();
  }

  if (criterio === true) {
    const total = round2(precio);
    const subtotal = round2(total / (1 + TASA_IVA));
    return { subtotal, iva: round2(total - subtotal), total };
  }

  const subtotal = round2(precio);
  const iva = round2(subtotal * TASA_IVA);
  return { subtotal, iva, total: round2(subtotal + iva) };
}

/** ¿El desglose guardado sigue cuadrando con el total cobrado? Tolerancia de
 *  un centavo más un margen de punto flotante (mismo criterio que Likida). */
export function desgloseCuadra(total: number, subtotal: number, iva: number): boolean {
  return Math.abs(round2(total) - round2(subtotal + iva)) <= 0.01 + 1e-9;
}
