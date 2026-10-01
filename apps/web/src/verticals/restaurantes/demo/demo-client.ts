// Cliente del widget publico de chat WhatsApp para demos (R-19). Sin sesion de panel: solo el slug del restaurante.
// `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts). Nunca inventa una respuesta: si el servidor no la
// da (agente no disponible, tope, error), el error llega tal cual al llamador.

export type MotivoNoDisponible = "no_es_demo" | "apagada" | "sin_agente";

export interface EstadoDemo {
  readonly disponible: boolean;
  readonly motivo: MotivoNoDisponible | null;
  readonly mensaje: string | null;
  readonly restaurante: { readonly slug: string; readonly nombre: string } | null;
  readonly sucursales: ReadonlyArray<{ readonly slug: string; readonly nombre: string }>;
  readonly limites: { readonly mensajes_por_sesion: number; readonly caracteres_por_mensaje: number };
}

export interface RespuestaDemo {
  /** `respuesta` = contesto el agente; `humano` = una persona tiene la conversacion; `reintentar` = no se pudo procesar. */
  readonly tipo: "respuesta" | "humano" | "reintentar";
  readonly respuesta: string;
  readonly escalado: boolean;
  readonly pedido: { readonly id: string; readonly total: number; readonly estado: string } | null;
}

export class DemoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly motivo?: string,
  ) {
    super(message);
    this.name = "DemoError";
  }
}

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = fallback;
  let code: string | undefined;
  let motivo: string | undefined;
  try {
    const body = (await res.json()) as { message?: unknown; code?: unknown; motivo?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.motivo === "string") motivo = body.motivo;
  } catch {
    // cuerpo no JSON: se conserva el mensaje generico
  }
  if (res.status === 429 && !code) message = "Demasiados mensajes seguidos. Espere un minuto e inténtelo de nuevo.";
  throw new DemoError(message, res.status, code, motivo);
}

/** Identificador efimero de la conversacion (16-64 caracteres seguros, lo que exige el servidor). Siempre con aleatoriedad
 * criptografica del navegador (`crypto`); sin ella no se inventa un id predecible: la demo no puede iniciar. */
export function nuevaSesionDemo(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Este navegador no ofrece generador aleatorio seguro (crypto): no se puede iniciar la conversación de la demo.");
}

export function crearClienteDemo(apiBaseUrl: string, orgSlug: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const raiz = `${apiBaseUrl.replace(/\/+$/, "")}/v1/restaurantes/demo/${encodeURIComponent(orgSlug)}`;
  return {
    async estado(): Promise<EstadoDemo> {
      return leer(await fetchImpl(`${raiz}/estado`), "No pudimos consultar la demo.");
    },
    async enviar(datos: { readonly sessionId: string; readonly mensaje: string; readonly sucursal?: string }): Promise<RespuestaDemo> {
      const res = await fetchImpl(`${raiz}/mensaje`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: datos.sessionId, mensaje: datos.mensaje, sucursal: datos.sucursal || undefined }),
      });
      return leer(res, "No pudimos enviar su mensaje.");
    },
  };
}

export type ClienteDemo = ReturnType<typeof crearClienteDemo>;
