// Cola local SOLO para «Entregado» del chofer (PLAN-PANEL-OPERADOR §5.3 «Red»): si el celular pierde la senal justo al entregar, la accion se guarda
// y se reintenta al volver la red con la MISMA `Idempotency-Key`, asi un reintento nunca duplica la entrega. Todo lo demas (deshacer, problema,
// llamar) exige conexion y lo dice.
//
// Persistencia en dos capas: `localStorage` (sobrevive a recargar) y una cola EN MEMORIA de respaldo (sobrevive mientras la pantalla siga abierta).
// Si el almacenamiento falla o no existe, la entrega queda solo en memoria y `encolarEntrega` lo dice (`persistida: false`) para que la UI avise
// «no se pudo guardar; no cierres esta pantalla» en vez de prometer algo falso.
//
// La clave incluye la sucursal y una huella corta de la persona en sesion: en un celular compartido otro chofer NO reenvia lo pendiente del anterior.
// Ademas se purga lo ajeno al abrir la pantalla y todo al vencer la sesion.

export interface EntregaPendiente {
  readonly orderId: string;
  readonly llave: string;
  readonly cobradoMonto: number | null;
  /** Epoch ms en que se toco «Entregado». */
  readonly en: number;
}

/** Solo lo que se usa de `Storage`: permite probarla con un doble en memoria. */
export type AlmacenLocal = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIJO = "atiende.chofer.entregas-pendientes.";
/** Una entrega pendiente de mas de 12 h ya no es confiable (turno distinto): se descarta en vez de enviarla. */
export const VIGENCIA_PENDIENTE_MS = 12 * 3_600_000;

/** Respaldo en memoria por clave de cola (vive lo que viva la pestana). */
const enMemoria = new Map<string, readonly EntregaPendiente[]>();

/** Huella corta y no reversible de la identidad en sesion (FNV-1a de 32 bits): separa colas sin guardar el correo en claro. */
export function huellaIdentidad(identidad: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < identidad.length; i++) {
    h ^= identidad.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function claveCola(propertyId: string, identidad: string): string {
  return `${propertyId}.${huellaIdentidad(identidad.trim().toLowerCase())}`;
}

function esPendiente(v: unknown): v is EntregaPendiente {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.orderId === "string" && typeof o.llave === "string" && typeof o.en === "number" && (o.cobradoMonto === null || typeof o.cobradoMonto === "number");
}

function leerAlmacen(almacen: AlmacenLocal | null, clave: string): readonly EntregaPendiente[] {
  if (!almacen) return [];
  try {
    const crudo = almacen.getItem(PREFIJO + clave);
    if (!crudo) return [];
    const lista: unknown = JSON.parse(crudo);
    return Array.isArray(lista) ? lista.filter(esPendiente) : [];
  } catch {
    return [];
  }
}

export function leerPendientes(almacen: AlmacenLocal | null, clave: string, ahoraMs: number): readonly EntregaPendiente[] {
  const todas = [...leerAlmacen(almacen, clave), ...(enMemoria.get(clave) ?? [])];
  const vistas = new Set<string>();
  return todas.filter((p) => ahoraMs - p.en < VIGENCIA_PENDIENTE_MS).filter((p) => (vistas.has(p.orderId) ? false : (vistas.add(p.orderId), true)));
}

/** Guarda en memoria SIEMPRE y en el almacenamiento si se puede; devuelve si quedo persistida (sobrevive a recargar). */
function guardar(almacen: AlmacenLocal | null, clave: string, lista: readonly EntregaPendiente[]): boolean {
  if (lista.length === 0) enMemoria.delete(clave);
  else enMemoria.set(clave, lista);
  if (!almacen) return lista.length === 0;
  try {
    if (lista.length === 0) almacen.removeItem(PREFIJO + clave);
    else almacen.setItem(PREFIJO + clave, JSON.stringify(lista));
    return true;
  } catch {
    return false;
  }
}

/** Agrega (o conserva la del mismo pedido: una sola entrega pendiente por pedido, con su llave original). */
export function encolarEntrega(almacen: AlmacenLocal | null, clave: string, pendiente: EntregaPendiente): { readonly lista: readonly EntregaPendiente[]; readonly persistida: boolean } {
  const actuales = leerPendientes(almacen, clave, pendiente.en);
  const previa = actuales.find((p) => p.orderId === pendiente.orderId);
  const lista = [...actuales.filter((p) => p.orderId !== pendiente.orderId), previa ?? pendiente];
  return { lista, persistida: guardar(almacen, clave, lista) };
}

export function quitarPendiente(almacen: AlmacenLocal | null, clave: string, orderId: string, ahoraMs: number): readonly EntregaPendiente[] {
  const lista = leerPendientes(almacen, clave, ahoraMs).filter((p) => p.orderId !== orderId);
  guardar(almacen, clave, lista);
  return lista;
}

/** Borra las colas de otras personas (o de TODAS si `conservar` es `null`): al abrir la pantalla y al vencer la sesion. */
export function purgarColas(almacen: AlmacenLocal | null, conservar: string | null): void {
  for (const k of [...enMemoria.keys()]) if (conservar === null || k !== conservar) enMemoria.delete(k);
  if (!almacen) return;
  try {
    const claves: string[] = [];
    for (let i = 0; i < almacen.length; i++) {
      const k = almacen.key(i);
      if (k?.startsWith(PREFIJO)) claves.push(k);
    }
    for (const k of claves) if (conservar === null || k !== PREFIJO + conservar) almacen.removeItem(k);
  } catch {
    // Almacenamiento bloqueado: no hay nada persistido que purgar.
  }
}

/** `localStorage` del navegador o `null` si esta bloqueado (el simple acceso puede lanzar). */
export function almacenDelNavegador(): AlmacenLocal | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
