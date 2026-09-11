// ═══════════════════════════════════════════════════════════════════════════
// EL LEDGER ANTI-REORDENAMIENTO — puerto generalizado del patrón real de
// Likida (~/likida.ai/src/lib/saas/suscripcion.ts, funciones `marcarEvento`,
// `ordenAplicado`/`sellarOrden`, auditoría prod 22-ago-2026 RES-11 y
// auditoría 18-c4 BACK-C4-1).
//
// DOS PROTECCIONES DISTINTAS, EN UN SOLO PASO:
//
//   1. DEDUPE por id de evento — un proveedor de pagos reintenta el MISMO
//      evento con semántica at-least-once. Sin dedupe, un reintento de
//      "invoice.paid" vuelve a aplicar el cobro.
//   2. ORDEN por ENTIDAD — el proveedor NO promete que los eventos lleguen en
//      el orden en que ocurrieron. El caso real que esto existe para cerrar:
//      una suscripción se cancela HOY (`customer.subscription.deleted`), y
//      DESPUÉS llega el reintento de un `.updated` de hace dos días (backoff
//      largo del proveedor) que la dejaría "activa" otra vez — un cliente
//      cancelado volvería a verse como cliente que paga. Como los handlers de
//      este dominio FIJAN estado (no acumulan), el último en escribir gana, y
//      sin este ledger el último en LLEGAR no es el último en OCURRIR.
//
// El ledger es por ENTIDAD (la suscripción, la factura — lo que sea que el
// evento cambia), no por evento: dos eventos del mismo id de entidad se
// comparan entre sí aunque traigan ids de evento distintos.
// ═══════════════════════════════════════════════════════════════════════════

export type MarcaVisto = 'nuevo' | 'duplicado';

/**
 * El almacén que el ledger necesita. Cada app lo implementa contra su propia
 * base (Supabase, Postgres directo, lo que sea) — el motor no sabe ni le
 * importa cuál.
 */
export interface LedgerStore {
  /**
   * Intenta reservar `eventId` como visto. Debe ser ATÓMICO (un INSERT con
   * restricción única, o equivalente): dos llamadas concurrentes con el mismo
   * id deben producir exactamente un 'nuevo' y el resto 'duplicado'. Un
   * dedupe que primero lee y luego escribe dejaría la misma carrera que este
   * ledger existe para cerrar.
   */
  marcarVisto(eventId: string): Promise<MarcaVisto>;
  /** `creadoUnix` del último evento APLICADO de esa entidad, o `null` si no
   *  hay marca todavía. */
  ordenAplicado(entidadId: string): Promise<number | null>;
  /** Dejar la marca del evento recién aplicado. */
  sellarOrden(entidadId: string, creadoUnix: number): Promise<void>;
}

/**
 * Implementación en memoria. Sirve para tests y como referencia de la
 * semántica exacta que un adaptador real (Supabase, Postgres) debe respetar
 * — en particular, `marcarVisto` tiene que ser atómico en producción aunque
 * aquí, de un solo hilo de Node, un Map alcance para probar la carrera lógica.
 */
export class LedgerEnMemoria implements LedgerStore {
  private vistos = new Set<string>();
  private orden = new Map<string, number>();

  async marcarVisto(eventId: string): Promise<MarcaVisto> {
    if (this.vistos.has(eventId)) return 'duplicado';
    this.vistos.add(eventId);
    return 'nuevo';
  }

  async ordenAplicado(entidadId: string): Promise<number | null> {
    return this.orden.has(entidadId) ? this.orden.get(entidadId)! : null;
  }

  async sellarOrden(entidadId: string, creadoUnix: number): Promise<void> {
    this.orden.set(entidadId, creadoUnix);
  }
}

export type ResultadoAplicacion<T> =
  | { estado: 'aplicado'; resultado: T }
  /** El id de evento ya se había visto — reintento del proveedor. No se
   *  vuelve a aplicar; NO es un error. */
  | { estado: 'duplicado' }
  /** El evento es más viejo que el último ya aplicado a esta entidad. Se
   *  descarta a propósito: aplicarlo pisaría un estado más nuevo con uno
   *  viejo. NO es un error — el webhook debe contestar 200 igual. */
  | { estado: 'fuera_de_orden'; ultimoAplicado: number };

/**
 * Aplica `aplicar()` con las dos protecciones del ledger. Es el único punto
 * de entrada que un handler de webhook necesita llamar.
 *
 * `aplicar()` solo se invoca si el evento es nuevo Y no está fuera de orden.
 * El sello de orden se escribe DESPUÉS de que `aplicar()` resuelve con éxito:
 * si `aplicar()` lanza, no se sella nada y un reintento puede volver a
 * intentar — igual que el original de Likida, que sella "al final" por la
 * misma razón.
 */
export async function aplicarConLedger<T>(
  store: LedgerStore,
  opts: {
    /** Id del evento del proveedor — la llave de dedupe. */
    eventId: string;
    /** Id de la entidad de dominio que el evento modifica (suscripción,
     *  factura, lo que sea) — la llave de orden. */
    entidadId: string;
    creadoUnix: number;
    aplicar: () => Promise<T>;
  },
): Promise<ResultadoAplicacion<T>> {
  const visto = await store.marcarVisto(opts.eventId);
  if (visto === 'duplicado') return { estado: 'duplicado' };

  const ultimo = await store.ordenAplicado(opts.entidadId);
  if (ultimo !== null && opts.creadoUnix < ultimo) {
    return { estado: 'fuera_de_orden', ultimoAplicado: ultimo };
  }

  const resultado = await opts.aplicar();
  await store.sellarOrden(opts.entidadId, opts.creadoUnix);
  return { estado: 'aplicado', resultado };
}
