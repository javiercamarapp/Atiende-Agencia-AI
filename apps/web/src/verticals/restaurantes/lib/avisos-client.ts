// R-16 -- cliente de las rutas de avisos del staff (apps/api/.../restaurantes/admin-avisos.ts, migracion 043). Los tipos
// replican la forma del servidor (apps/web no depende de los paquetes de dominio, mismo criterio que orders-client.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export interface EventoAvisoWire {
  readonly tipo: string;
  readonly etiqueta: string;
  readonly descripcion: string;
  /** `true` solo si el navegador reproduce un sonido real para este aviso. */
  readonly sonidoAplica: boolean;
}

export interface PreferenciaAvisoWire {
  readonly tipo: string;
  readonly enabled: boolean;
  readonly sonido: boolean;
}

export interface MiembroAvisosWire {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly verticalRole: string;
  readonly preferencias: readonly PreferenciaAvisoWire[];
}

export interface UmbralSucursalWire {
  readonly propertyId: string;
  readonly nombre: string;
  readonly entregaTardiaMin: number | null;
}

export interface AvisosWire {
  /** `false` = la base aun no tiene la migracion 043: la pantalla muestra "no disponible aun". */
  readonly disponible: boolean;
  readonly eventos: readonly EventoAvisoWire[];
  readonly mias: readonly PreferenciaAvisoWire[];
  /** Solo owner/admin; `null` para el resto. */
  readonly equipo: readonly MiembroAvisosWire[] | null;
  readonly umbrales: readonly UmbralSucursalWire[] | null;
  readonly umbralMin?: number;
  readonly umbralMax?: number;
  readonly umbralDefectoMin: number;
}

export async function fetchAvisos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AvisosWire> {
  return fetchJson<AvisosWire>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/avisos`, token);
}

/** `userId` ausente = la preferencia propia; con `userId`, owner/admin editan la de su equipo (el servidor y la base re-validan). */
export async function guardarPreferenciaAviso(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly tipo: string; readonly enabled: boolean; readonly sonido?: boolean; readonly userId?: string },
): Promise<{ readonly enabled: boolean; readonly sonido: boolean }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/avisos/preferencias`, token, "PUT", input);
}

export async function guardarUmbralEntrega(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly propertyId: string; readonly minutos: number },
): Promise<{ readonly minutos: number }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/avisos/umbral`, token, "PUT", input);
}

export const TIPO_PEDIDO_NUEVO = "restaurantes.pedido.nuevo";

/**
 * ¿Debe sonar el aviso de pedido nuevo en el navegador? Respeta la preferencia de la persona (aviso encendido Y sonido
 * encendido). Sin respuesta (base sin migrar, error de red, forma inesperada) conserva el comportamiento de siempre:
 * suena segun la casilla local del panel de pedidos.
 */
export function sonidoPedidoNuevoPermitido(avisos: Pick<AvisosWire, "disponible" | "mias"> | null | undefined): boolean {
  if (!avisos || avisos.disponible !== true || !Array.isArray(avisos.mias)) return true;
  const p = avisos.mias.find((m) => m.tipo === TIPO_PEDIDO_NUEVO);
  return p ? p.enabled && p.sonido : true;
}
