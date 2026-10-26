// Cliente HTTP del panel movil del encargado (Cola, Nuevo pedido, Viajes). PLAN-PANEL-OPERADOR §2.
//
// Los TIPOS salen del contrato unico `@atiende/domain-restaurantes/operacion` (solo `import type`: apps/web no empaqueta codigo de los
// paquetes domain-*); las URLs, de `RUTAS_OPERACION`. `fetchImpl` se inyecta (como en el resto de lib/*-client.ts) para probar la red
// real con vitest. Toda escritura lleva `Idempotency-Key`: el llamador genera UNA llave por intento de accion y la reutiliza si reintenta.
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import type {
  ColaSalida,
  CotizarPedidoOperadorEntrada,
  CrearPedidoOperadorEntrada,
  DespachoEntrada,
  DespachoSalida,
  ListoSalida,
  RespuestaClientePorTelefono,
  RespuestaCotizar,
  RespuestaCrearPedido,
  ViajesSalida,
} from "@atiende/domain-restaurantes/operacion";
import { defaultAuthCtx } from "./admin-client.ts";

/** Error de una ruta del panel: conserva status y `code` de la API (`estado_cambio`, `no_implementado`...) para decidir que mostrar. */
export class ErrorOperacion extends Error {
  constructor(
    mensaje: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Readonly<Record<string, string>> | null = null,
  ) {
    super(mensaje);
    this.name = "ErrorOperacion";
  }
  /** El pedido ya cambio de estado por otro lado (otro encargado, el POS): no es un fallo, basta recargar la cola. */
  get esEstadoCambio(): boolean {
    return this.status === 409 && this.code === "estado_cambio";
  }
  /** La ruta existe pero el servidor aun no la implementa (501): la pantalla dice «no disponible aun». */
  get esNoDisponible(): boolean {
    return this.status === 501 || this.code === "no_implementado" || this.code === "no_disponible";
  }
}

/** Llave de idempotencia nueva (una por intento de accion). */
export function nuevaLlave(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}`;
}

async function aErrorOperacion(res: Response): Promise<ErrorOperacion> {
  const e = (await res.json().catch(() => null)) as { code?: string; message?: string; error?: string | { code?: string; message?: string }; details?: Record<string, string> } | null;
  const anidado = e && typeof e.error === "object" && e.error !== null ? e.error : null;
  const mensaje = e?.message ?? anidado?.message ?? (typeof e?.error === "string" ? e.error : null) ?? `No se pudo completar la solicitud (${res.status}).`;
  return new ErrorOperacion(mensaje, res.status, e?.code ?? anidado?.code ?? null, e?.details ?? null);
}

export async function enviar<T>(fetchImpl: typeof fetch, url: string, token: string, metodo: "POST" | "PATCH", cuerpo: unknown, llave: string): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, {
      method: metodo,
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json", "idempotency-key": llave },
      body: JSON.stringify(cuerpo),
    }),
  );
  if (!res.ok) throw await aErrorOperacion(res);
  return (await res.json()) as T;
}

/** Lectura que conserva status y `code` del error (el `fetchJson` generico los pierde). */
export async function leer<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) throw await aErrorOperacion(res);
  return (await res.json()) as T;
}

/** `GET admin/operacion/cola`: pedidos activos del turno. `desde` (ISO) pide solo lo cambiado desde esa marca. */
export function fetchCola(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde?: string): Promise<ColaSalida> {
  const q = new URLSearchParams({ propertyId });
  if (desde) q.set("desde", desde);
  return leer<ColaSalida>(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/operacion/cola?${q.toString()}`, token);
}

/** Aceptar = `pending -> preparando` por la ruta de estado vigente (el servidor avisa al cliente y devuelve `yaAplicado` si ya estaba). */
export function aceptarPedido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, llave: string): Promise<{ readonly yaAplicado?: boolean }> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders/${encodeURIComponent(orderId)}/status`, token, "PATCH", { status: "preparando" }, llave);
}

/** `POST admin/orders/:id/listo`. */
export function marcarListo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, llave: string): Promise<ListoSalida> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders/${encodeURIComponent(orderId)}/listo`, token, "POST", {}, llave);
}

/** Entrega en mostrador de un pedido para recoger (`listo_para_recoger -> entregado`). */
export function entregarEnMostrador(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, llave: string): Promise<{ readonly yaAplicado?: boolean }> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders/${encodeURIComponent(orderId)}/status`, token, "PATCH", { status: "entregado" }, llave);
}

// ---- Nuevo pedido y Viajes (los usan B2 y B3; viven aqui para tener un solo cliente del panel) ----

export function cotizarPedido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: CotizarPedidoOperadorEntrada, llave: string): Promise<RespuestaCotizar> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders/cotizar`, token, "POST", entrada, llave);
}

export function capturarPedido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: CrearPedidoOperadorEntrada, llave: string): Promise<RespuestaCrearPedido> {
  return enviar(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders`, token, "POST", entrada, llave);
}

export function fetchClientePorTelefono(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, telefono: string): Promise<RespuestaClientePorTelefono> {
  return leer<RespuestaClientePorTelefono>(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/customers/por-telefono?telefono=${encodeURIComponent(telefono)}`, token);
}

export function fetchViajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde?: string): Promise<ViajesSalida> {
  const q = new URLSearchParams({ propertyId });
  if (desde) q.set("desde", desde);
  return leer<ViajesSalida>(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/operacion/viajes?${q.toString()}`, token);
}

export const MENSAJE_RESPUESTA_INESPERADA = "Respuesta inesperada del servidor: revisa «En camino» y la cola antes de volver a intentar.";

const RESULTADOS_VALIDOS = new Set(["despachado", "ya_aplicado", "reasignado"]);

/** `resultados` bien formado: arreglo y cada elemento con `pedidoId`, `resultado` conocido y `aviso`. Cualquier otra forma NO se interpreta. */
export function resultadosDespachoValidos(valor: unknown): valor is DespachoSalida["resultados"] {
  return (
    Array.isArray(valor) &&
    valor.every((r) => typeof r === "object" && r !== null && typeof (r as { pedidoId?: unknown }).pedidoId === "string" && RESULTADOS_VALIDOS.has(String((r as { resultado?: unknown }).resultado)) && typeof (r as { aviso?: unknown }).aviso === "string")
  );
}

export async function despacharPedidos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: DespachoEntrada, llave: string): Promise<DespachoSalida> {
  const r = await enviar<unknown>(fetchImpl, `${base(apiBaseUrl, propertyId)}/admin/orders/dispatch`, token, "POST", entrada, llave);
  const resultados = (r as { resultados?: unknown } | null)?.resultados;
  // Un 200 sin resultados utilizables no dice que salio: no se inventa exito ni se acusa falta de conexion.
  if (!resultadosDespachoValidos(resultados)) throw new ErrorOperacion(MENSAJE_RESPUESTA_INESPERADA, 502, "respuesta_inesperada");
  return { resultados };
}
