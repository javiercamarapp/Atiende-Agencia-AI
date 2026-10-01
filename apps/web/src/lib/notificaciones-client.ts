// Cliente de la pagina de notificaciones (GET /notifications, POST /notifications/:id/read y /read-all de
// apps/api/src/routes/notifications.ts). Funciones puras sobre `fetch` inyectado para probarlas sin red.
export type NotificacionSeveridad = "info" | "atencion" | "critica";

export interface NotificacionFila {
  readonly id: string;
  readonly titulo: string;
  readonly cuerpo: string | null;
  /** Ruta interna relativa de apps/web ya resuelta por la base; `null` en filas viejas (base sin migrar). */
  readonly enlace: string | null;
  readonly categoria: string | null;
  readonly severidad: NotificacionSeveridad;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601; `null` = sin leer. */
  readonly readAt: string | null;
}

export interface NotificacionesPagina {
  readonly notificaciones: readonly NotificacionFila[];
  readonly unreadCount: number;
}

export interface FiltroNotificaciones {
  readonly soloNoLeidas: boolean;
  readonly categoria: string | null;
  /** ISO 8601: solo las creadas antes de esta fecha (paginacion por fecha). */
  readonly before?: string;
  readonly limit: number;
}

export class NotificacionesError extends Error {
  readonly status: number | null;
  constructor(mensaje: string, status: number | null) {
    super(mensaje);
    this.name = "NotificacionesError";
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function mensajePorEstado(status: number): string {
  if (status === 401) return "Tu sesión expiró. Vuelve a iniciar sesión.";
  if (status === 404) return "Esa notificación ya no existe.";
  return "El servidor no pudo atender la solicitud. Inténtalo de nuevo.";
}

/** Solo rutas internas: una sola barra inicial, sin esquema ni `//` (defensa en profundidad: el enlace ya sale validado de la base). */
export function enlaceInternoSeguro(enlace: string | null): string | null {
  if (enlace === null) return null;
  if (!enlace.startsWith("/") || enlace.startsWith("//") || enlace.includes("\\") || /[\s<>"']/.test(enlace)) return null;
  return enlace;
}

function normalizarSeveridad(valor: unknown): NotificacionSeveridad {
  return valor === "atencion" || valor === "critica" ? valor : "info";
}

function parsearFila(crudo: unknown): NotificacionFila | null {
  if (!crudo || typeof crudo !== "object") return null;
  const r = crudo as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.titulo !== "string" || typeof r.createdAt !== "string") return null;
  return {
    id: r.id,
    titulo: r.titulo,
    cuerpo: typeof r.cuerpo === "string" ? r.cuerpo : null,
    enlace: enlaceInternoSeguro(typeof r.enlace === "string" ? r.enlace : null),
    categoria: typeof r.categoria === "string" ? r.categoria : null,
    severidad: normalizarSeveridad(r.severidad),
    createdAt: r.createdAt,
    readAt: typeof r.readAt === "string" ? r.readAt : null,
  };
}

async function pedir(fetchFn: FetchLike, url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
  } catch {
    throw new NotificacionesError("No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.", null);
  }
  if (!res.ok) throw new NotificacionesError(mensajePorEstado(res.status), res.status);
  try {
    return await res.json();
  } catch {
    throw new NotificacionesError("La respuesta del servidor no es válida.", res.status);
  }
}

export async function listarNotificaciones(fetchFn: FetchLike, apiBaseUrl: string, token: string, filtro: FiltroNotificaciones): Promise<NotificacionesPagina> {
  const qs = new URLSearchParams({ limit: String(filtro.limit) });
  if (filtro.soloNoLeidas) qs.set("unread", "1");
  if (filtro.categoria) qs.set("categoria", filtro.categoria);
  if (filtro.before) qs.set("before", filtro.before);
  const cuerpo = (await pedir(fetchFn, `${apiBaseUrl}/notifications?${qs.toString()}`, token)) as { notifications?: unknown; unreadCount?: unknown } | null;
  if (!cuerpo || !Array.isArray(cuerpo.notifications) || typeof cuerpo.unreadCount !== "number") {
    throw new NotificacionesError("La respuesta del servidor no es válida.", 200);
  }
  const notificaciones = cuerpo.notifications.map(parsearFila).filter((f): f is NotificacionFila => f !== null);
  return { notificaciones, unreadCount: cuerpo.unreadCount };
}

/** Devuelve el contador real de no leidas tras marcar. */
export async function marcarLeida(fetchFn: FetchLike, apiBaseUrl: string, token: string, id: string): Promise<number> {
  const cuerpo = (await pedir(fetchFn, `${apiBaseUrl}/notifications/${encodeURIComponent(id)}/read`, token, { method: "POST" })) as { unreadCount?: unknown } | null;
  return typeof cuerpo?.unreadCount === "number" ? cuerpo.unreadCount : 0;
}

export async function marcarTodasLeidas(fetchFn: FetchLike, apiBaseUrl: string, token: string): Promise<number> {
  const cuerpo = (await pedir(fetchFn, `${apiBaseUrl}/notifications/read-all`, token, { method: "POST" })) as { markedCount?: unknown } | null;
  return typeof cuerpo?.markedCount === "number" ? cuerpo.markedCount : 0;
}
