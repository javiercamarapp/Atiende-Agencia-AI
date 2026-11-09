// Cliente del registro autoservicio de restaurantes (apps/api/src/routes/registro-restaurantes.ts, migracion 0077). Sin sesion.
export interface RegistroEstado {
  readonly disponible: boolean;
  readonly google: boolean;
  readonly correo: boolean;
}

export interface RegistroInput {
  readonly metodo: "correo" | "google";
  readonly correo?: string;
  readonly nombreNegocio: string;
  readonly nombreSucursal: string;
  readonly nombreCompleto: string;
  readonly zonaHoraria?: string | null;
  /** Trampa de bots: siempre vacio desde la pantalla real. */
  readonly sitioWeb: string;
  readonly msLlenado: number;
}

export interface RegistroConfirmado {
  readonly code: string;
  readonly orgSlug: string;
  readonly trialEndsAt: string;
}

export class RegistroError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RegistroError";
  }
}

async function mensajeDeError(res: Response, porOmision: string): Promise<RegistroError> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const message = body && typeof body.message === "string" && body.message ? body.message : porOmision;
  return new RegistroError(res.status, message);
}

export async function fetchRegistroEstado(fetchImpl: typeof fetch, apiBaseUrl: string): Promise<RegistroEstado> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/registro/restaurantes/estado`);
  if (!res.ok) throw await mensajeDeError(res, "No se pudo consultar el registro.");
  return (await res.json()) as RegistroEstado;
}

/** metodo 'correo': resuelve `{ url: null }` (revisa tu correo). metodo 'google': `{ url }` a la que hay que navegar. */
export async function iniciarRegistro(fetchImpl: typeof fetch, apiBaseUrl: string, input: RegistroInput): Promise<{ readonly url: string | null }> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/registro/restaurantes/iniciar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await mensajeDeError(res, "No se pudo iniciar el registro. Intenta de nuevo.");
  const body = (await res.json()) as { url?: unknown };
  return { url: typeof body.url === "string" ? body.url : null };
}

export async function confirmarRegistro(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<RegistroConfirmado> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/registro/restaurantes/confirmar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw await mensajeDeError(res, "No se pudo crear tu restaurante. Intenta de nuevo.");
  return (await res.json()) as RegistroConfirmado;
}

/** Errores que el callback de Google deja en `?registro_error=` (texto legible para la pantalla). */
export const ERRORES_REGISTRO: Readonly<Record<string, string>> = {
  cuenta_existente: "Ya tienes una cuenta con ese correo: inicia sesión.",
  enlace_vencido: "El registro tardó demasiado y venció. Vuelve a intentarlo.",
  no_disponible: "El registro no está disponible aún. Intenta más tarde.",
  demasiados: "Demasiados registros desde esta conexión. Intenta más tarde.",
  state_invalido: "No pudimos validar el regreso de Google. Vuelve a intentarlo.",
  error: "Ocurrió un error inesperado. Intenta de nuevo.",
};

/** Lee el token del fragmento (#token=...): el fragmento nunca viaja al servidor ni a los escaneres de enlaces. */
export function tokenDelFragmento(hash: string): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{20,128})(?:&|$)/.exec(hash.startsWith("#") ? hash : `#${hash}`);
  return m ? m[1]! : null;
}

/** Forma minima de correo en tiempo lineal (sin la regex polinomial clasica); el servidor vuelve a validar. */
export function correoConForma(correo: string): boolean {
  const arroba = correo.indexOf("@");
  if (correo.length < 5 || correo.length > 254 || /\s/.test(correo) || arroba < 1 || arroba !== correo.lastIndexOf("@")) return false;
  const dominio = correo.slice(arroba + 1);
  const punto = dominio.lastIndexOf(".");
  return punto > 0 && punto < dominio.length - 1;
}
