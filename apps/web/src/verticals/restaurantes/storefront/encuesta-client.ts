// Cliente PUBLICO de la encuesta post-entrega (R-41). Sin sesion: la liga que recibio el cliente lleva un token firmado. `fetchImpl`
// inyectado (mismo criterio que storefront-client.ts). Nunca inventa un mensaje cuando el servidor ya mando uno.

export interface EncuestaPublica {
  readonly sucursal: string;
  readonly respondida: boolean;
  readonly calificacion: number | null;
  /** Solo si ya respondio con una calificacion alta y la sucursal configuro su liga de resenas. */
  readonly resenasUrl: string | null;
}

export type LecturaEncuesta = { readonly disponible: true; readonly encuesta: EncuestaPublica } | { readonly disponible: false; readonly mensaje: string };

export interface RespuestaEncuesta {
  readonly estado: "registrada" | "ya_respondida";
  readonly calificacion: number | null;
  readonly resenasUrl: string | null;
}

export class EncuestaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EncuestaError";
  }
}

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = fallback;
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) message = body.message;
  } catch {
    // Cuerpo no JSON: se queda el mensaje por defecto.
  }
  throw new EncuestaError(message, res.status);
}

export function crearClienteEncuesta(apiBaseUrl: string, orgSlug: string, token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/v1/restaurantes/${encodeURIComponent(orgSlug)}/encuesta/${encodeURIComponent(token)}`;
  return {
    async leer(): Promise<LecturaEncuesta> {
      return leer(await fetchImpl(url), "No pudimos cargar la encuesta.");
    },
    async responder(calificacion: number, comentario: string): Promise<RespuestaEncuesta> {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calificacion, comentario: comentario.trim() === "" ? undefined : comentario }) });
      if (res.status === 503) throw new EncuestaError("La encuesta todavía no está disponible. ¡Gracias por tu pedido!", 503);
      return leer(res, "No pudimos guardar tu respuesta.");
    },
  };
}
