// Cliente de la privacidad PUBLICA del huesped de hoteles (H-30). Sin sesion: no usa tokens ni authed-fetch. `fetchImpl` inyectado (mismo
// criterio que el resto de lib/*.ts) para probar la red sin jsdom. Nunca inventa un mensaje cuando el servidor ya mando uno.
// Consume apps/api/src/routes/verticals/hoteles/privacidad-publica.ts.

export type Derecho = "acceso" | "rectificacion" | "cancelacion" | "oposicion";
export const DERECHO_LABELS: Record<Derecho, string> = { acceso: "Acceso", rectificacion: "Rectificación", cancelacion: "Cancelación", oposicion: "Oposición" };
export const DERECHO_AYUDA: Record<Derecho, string> = {
  acceso: "Conocer qué datos personales tuyos tiene el hotel y cómo los usa.",
  rectificacion: "Corregir datos tuyos que estén incorrectos o incompletos.",
  cancelacion: "Pedir que se eliminen tus datos cuando ya no sean necesarios (salvo obligaciones legales).",
  oposicion: "Oponerte a que se usen tus datos para ciertos fines.",
};

export interface AvisoVigente {
  readonly version: string;
  readonly textoSimplificado: string;
  readonly urlIntegral: string | null;
  readonly finalidadesObligatorias: readonly string[];
  readonly finalidadesOpcionales: readonly string[];
  readonly publicadoEn: string;
}
export interface PropiedadAviso {
  readonly propiedad: { readonly slug: string; readonly nombre: string };
  /** null = el hotel aun no publica un aviso vigente. */
  readonly aviso: AvisoVigente | null;
}
export type RespuestaAviso =
  | { readonly disponible: false; readonly motivo: string }
  | { readonly disponible: true; readonly hotel: { readonly nombre: string | null }; readonly propiedades: readonly PropiedadAviso[] };

export interface SolicitudEnviada {
  readonly ok: true;
  readonly referencia: string;
  readonly mensaje: string;
  readonly venceEnMinutos: number;
  /** pendiente_de_configuracion = sin llave de Resend: el correo con el codigo queda en cola y NO sale hasta configurarla. */
  readonly envioDeCorreo: "habilitado" | "pendiente_de_configuracion";
}
export interface FormularioSolicitud {
  readonly derecho: Derecho;
  readonly nombre: string;
  readonly correo: string;
  readonly descripcion?: string;
  readonly propiedad?: string;
  /** Honeypot: un humano nunca lo ve ni lo llena. */
  readonly sitioWeb?: string;
}
export interface MisDatos {
  readonly folio?: string;
  readonly perfil: Record<string, unknown>;
  readonly estancias: readonly Record<string, unknown>[];
  readonly consentimientos: readonly Record<string, unknown>[];
  readonly identidad: readonly Record<string, unknown>[];
}

export class PrivacidadPublicaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PrivacidadPublicaError";
  }
}

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = fallback;
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    // cuerpo no JSON: se conserva el mensaje generico
  }
  if (res.status === 429) message = "Demasiados intentos seguidos. Espera un minuto e inténtalo de nuevo.";
  throw new PrivacidadPublicaError(message, res.status);
}

export function crearClientePrivacidadPublica(fetchImpl: typeof fetch, apiBaseUrl: string, orgSlug: string) {
  const base = `${apiBaseUrl}/v1/hoteles/${encodeURIComponent(orgSlug)}/privacidad`;
  const post = (path: string, body: unknown) => fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async aviso(propiedad?: string): Promise<RespuestaAviso> {
      const qs = propiedad ? `?property=${encodeURIComponent(propiedad)}` : "";
      return leer<RespuestaAviso>(await fetchImpl(`${base}${qs}`), "No pudimos cargar el aviso de privacidad.");
    },
    async solicitar(form: FormularioSolicitud): Promise<SolicitudEnviada> {
      return leer<SolicitudEnviada>(await post("/solicitud", form), "No pudimos registrar tu solicitud.");
    },
    async verificar(referencia: string, codigo: string): Promise<{ readonly ok: true; readonly folio: string; readonly mensaje: string }> {
      return leer(await post("/solicitud/verificar", { referencia, codigo }), "No pudimos verificar el código.");
    },
    async misDatos(token: string): Promise<MisDatos> {
      return leer<MisDatos>(await post("/mis-datos", { token }), "No pudimos cargar tus datos.");
    },
  };
}
export type ClientePrivacidadPublica = ReturnType<typeof crearClientePrivacidadPublica>;
