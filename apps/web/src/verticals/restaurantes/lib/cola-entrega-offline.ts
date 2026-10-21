// Cola local SOLO para «Entregado» del chofer (PLAN-PANEL-OPERADOR §5.3 «Red»): si el celular pierde la senal justo al entregar, la
// accion se guarda y se reintenta al volver la red con la MISMA `Idempotency-Key`, asi un reintento nunca duplica la entrega. Todo lo
// demas (deshacer, problema, llamar) exige conexion y lo dice. `localStorage` puede faltar o lanzar (modo privado): nunca rompe la pantalla.

export interface EntregaPendiente {
  readonly orderId: string;
  readonly llave: string;
  readonly cobradoMonto: number | null;
  /** Epoch ms en que se toco «Entregado». */
  readonly en: number;
}

/** Solo lo que se usa de `Storage`: permite probarla con un doble en memoria. */
export type AlmacenLocal = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIJO = "atiende.chofer.entregas-pendientes.";
/** Una entrega pendiente de mas de 12 h ya no es confiable (turno distinto): se descarta en vez de enviarla. */
export const VIGENCIA_PENDIENTE_MS = 12 * 3_600_000;

function esPendiente(v: unknown): v is EntregaPendiente {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.orderId === "string" && typeof o.llave === "string" && typeof o.en === "number" && (o.cobradoMonto === null || typeof o.cobradoMonto === "number");
}

export function leerPendientes(almacen: AlmacenLocal | null, propertyId: string, ahoraMs: number): readonly EntregaPendiente[] {
  if (!almacen) return [];
  try {
    const crudo = almacen.getItem(PREFIJO + propertyId);
    if (!crudo) return [];
    const lista: unknown = JSON.parse(crudo);
    if (!Array.isArray(lista)) return [];
    return lista.filter(esPendiente).filter((p) => ahoraMs - p.en < VIGENCIA_PENDIENTE_MS);
  } catch {
    return [];
  }
}

function guardar(almacen: AlmacenLocal | null, propertyId: string, lista: readonly EntregaPendiente[]): void {
  if (!almacen) return;
  try {
    if (lista.length === 0) almacen.removeItem(PREFIJO + propertyId);
    else almacen.setItem(PREFIJO + propertyId, JSON.stringify(lista));
  } catch {
    // Sin almacenamiento: la accion se reintenta mientras la pantalla siga abierta, pero no sobrevive a recargarla.
  }
}

/** Agrega (o reemplaza la del mismo pedido: una sola entrega pendiente por pedido, conserva la llave original). */
export function encolarEntrega(almacen: AlmacenLocal | null, propertyId: string, pendiente: EntregaPendiente): readonly EntregaPendiente[] {
  const actuales = leerPendientes(almacen, propertyId, pendiente.en);
  const previa = actuales.find((p) => p.orderId === pendiente.orderId);
  const lista = [...actuales.filter((p) => p.orderId !== pendiente.orderId), previa ?? pendiente];
  guardar(almacen, propertyId, lista);
  return lista;
}

export function quitarPendiente(almacen: AlmacenLocal | null, propertyId: string, orderId: string, ahoraMs: number): readonly EntregaPendiente[] {
  const lista = leerPendientes(almacen, propertyId, ahoraMs).filter((p) => p.orderId !== orderId);
  guardar(almacen, propertyId, lista);
  return lista;
}

/** `localStorage` del navegador o `null` si esta bloqueado (el simple acceso puede lanzar). */
export function almacenDelNavegador(): AlmacenLocal | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
