// ═══════════════════════════════════════════════════════════════════════════
// RIEL DE TRANSFERENCIA / CLABE — puerto de
// ~/proyecto-origen/src/lib/saas/transferencia.ts.
//
// Sin pasarela: el tenant transfiere a una cuenta real. UN BANCO NO MANDA
// WEBHOOKS — no hay nada que "detecte" el pago solo. Alguien concilia a mano
// contra el estado de cuenta, y por eso `conciliar()` exige quién y con qué
// referencia del banco: una factura "pagada" sin eso es la palabra de
// alguien sin nada detrás.
//
// `conciliar()` es COMPARE-AND-SET, no leer-y-después-escribir: dos clics (o
// dos pestañas) marcando la misma factura como pagada, si el store hiciera
// UPDATE incondicional, dispararían DOS timbrados de la misma mensualidad
// aguas abajo — uno hay que cancelarlo ante el SAT. El `FacturaStore` que
// cada app implementa debe hacer el UPDATE con el filtro de estado DENTRO de
// la misma sentencia (`.eq('id', id).neq('estado', 'pagada')` en Supabase, o
// equivalente), para que sea la base la que resuelve la carrera.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valida una CLABE con su dígito verificador (pesos 3-7-1 sobre los 17
 * primeros dígitos). Puerto exacto de `clabeValida` en el original.
 */
export function clabeValida(clabe: string): boolean {
  const c = clabe.replace(/\D/g, '');
  if (c.length !== 18) return false;
  const pesos = [3, 7, 1] as const;
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(c.charAt(i)) * pesos[i % 3]!) % 10;
  return (10 - (suma % 10)) % 10 === Number(c.charAt(17));
}

/**
 * Referencia determinista para el concepto de la transferencia: reemitir la
 * misma factura del mismo periodo da la MISMA referencia, así que un doble
 * clic en "emitir" no genera dos códigos para un solo cobro.
 */
export function referenciaDe(tenantId: string, periodoInicio: string): string {
  const corto = tenantId.replace(/-/g, '').slice(0, 4).toUpperCase();
  const partes = periodoInicio.split('-');
  const anio = partes[0] ?? '';
  const mes = partes[1] ?? '';
  return `FUS${corto}${anio}${mes}`;
}

export type EstadoFactura = 'pendiente' | 'pagada' | 'fallida' | 'cancelada';

export interface FacturaStore {
  /**
   * Marca la factura como pagada SOLO si su estado actual no es ya 'pagada'.
   * Debe implementarse como un UPDATE condicional atómico (compare-and-set):
   * devuelve `true` si esta llamada fue la que hizo la transición, `false`
   * si la factura ya estaba pagada (o no existe) y por lo tanto NO se debe
   * disparar el timbrado desde aquí.
   */
  marcarPagadaSiNoLoEstaba(facturaId: string, referenciaBanco: string, actorId: string): Promise<boolean>;
}

export class ReferenciaBancoInvalida extends Error {
  constructor() {
    super('Falta la referencia del movimiento del banco: es la prueba de que el dinero existe.');
    this.name = 'ReferenciaBancoInvalida';
  }
}

/**
 * Concilia un pago por transferencia. Devuelve `'conciliada'` solo cuando
 * ESTA llamada ganó la carrera compare-and-set; `'ya_conciliada'` cuando
 * otra llamada (u otro clic) ya la había marcado — en ese caso el llamador
 * NO debe volver a disparar el timbrado.
 */
export async function conciliar(
  store: FacturaStore,
  facturaId: string,
  referenciaBanco: string,
  actorId: string,
): Promise<'conciliada' | 'ya_conciliada'> {
  const ref = referenciaBanco.trim();
  if (ref.length < 3) throw new ReferenciaBancoInvalida();

  const gano = await store.marcarPagadaSiNoLoEstaba(facturaId, ref, actorId);
  return gano ? 'conciliada' : 'ya_conciliada';
}
