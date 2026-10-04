// Cliente de la reserva directa PUBLICA del hotel (H-42). Sin sesion: no usa tokens ni authed-fetch. `fetchImpl` inyectado para probar la red
// sin jsdom. Consume apps/api/src/routes/verticals/hoteles/reservar-publico.ts. Nunca inventa un mensaje cuando el servidor ya mando uno.

export interface PropiedadReserva {
  readonly slug: string;
  readonly nombre: string;
  readonly reservaEnLinea: boolean;
  readonly anticipoPct: number | null;
  readonly maxHuespedes: number;
  readonly maxNoches: number;
  readonly cancelacion: { readonly ventanaGratisHoras: number; readonly penalidadPct: number } | null;
}
export type RespuestaConfig =
  | { readonly disponible: false; readonly motivo: string }
  | { readonly disponible: true; readonly hotel: { readonly nombre: string | null }; readonly propiedades: readonly PropiedadReserva[] };

export interface OpcionHabitacion {
  readonly tipoHabitacionId: string;
  readonly nombre: string;
  readonly maxOcupacion: number;
  readonly disponible: boolean;
  readonly motivo: string | null;
  readonly desdePorNocheCentavos: number | null;
  readonly totalCentavos: number | null;
}
export type RespuestaDisponibilidad =
  | { readonly disponible: false; readonly motivo: string }
  | { readonly disponible: true; readonly reservaEnLinea: false; readonly motivo: string }
  | {
      readonly disponible: true;
      readonly reservaEnLinea: true;
      readonly propiedad: { readonly slug: string; readonly nombre: string };
      readonly llegada: string;
      readonly salida: string;
      readonly noches: number;
      readonly huespedes: number;
      readonly anticipoPct: number;
      readonly opciones: readonly OpcionHabitacion[];
    };

export interface Cancelacion {
  readonly gratisHasta: string | null;
  readonly penalidadPct: number | null;
}
export interface Cotizacion {
  readonly quoteToken: string;
  readonly venceEn: string;
  readonly propiedad: { readonly slug: string; readonly nombre: string };
  readonly tipoHabitacion: { readonly id: string; readonly nombre: string };
  readonly llegada: string;
  readonly salida: string;
  readonly noches: number;
  readonly huespedes: number;
  readonly cotizacion: { readonly netoCentavos: number; readonly ivaCentavos: number; readonly ishCentavos: number; readonly totalCentavos: number };
  readonly anticipo: { readonly porcentaje: number; readonly centavos: number; readonly requerido: boolean };
  readonly cancelacion: Cancelacion;
}

export type EstadoReserva = string;
export interface VistaReserva {
  readonly estado: EstadoReserva;
  readonly hotel: string;
  readonly tipoHabitacion: string;
  readonly llegada: string;
  readonly salida: string;
  readonly noches: number;
  readonly huespedes: number;
  readonly totalCentavos: number;
  readonly anticipoCentavos: number;
  readonly pago: { readonly estado: string; readonly reembolso: string | null; readonly requiereAccion?: string };
  readonly vigenteHasta: string | null;
  readonly cancelable: boolean;
  readonly cancelacion: Cancelacion & {
    readonly siCancelasAhora: { readonly penalidadCents: number; readonly reembolsoCents?: number } | null;
    readonly resultado: { readonly penalidadCentavos: number; readonly reembolsoCentavos: number } | null;
  };
}
export interface ReservaCreada extends VistaReserva {
  readonly rastreoToken: string;
  /** Codigo del servidor cuando el cobro no pudo completarse (pago_no_disponible, pago_rechazado). */
  readonly code?: string;
  readonly message?: string;
  readonly httpStatus: number;
}

export interface DatosHuesped {
  readonly nombre: string;
  readonly telefono: string;
  readonly correo: string;
}

export class ReservarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Codigo de la maquina de estados del servidor (precio_cambio, sin_disponibilidad, cotizacion_vencida...). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ReservarError";
  }
}

async function errorDe(res: Response, fallback: string): Promise<ReservarError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { message?: unknown; code?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // cuerpo no JSON: se conserva el mensaje generico
  }
  if (res.status === 429) message = "Demasiados intentos seguidos. Espera un minuto e inténtalo de nuevo.";
  return new ReservarError(message, res.status, code);
}
async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  throw await errorDe(res, fallback);
}

/** Clave de idempotencia nueva por intento de confirmar o cancelar: un reintento de red reusa la misma, un intento nuevo usa otra. */
export function nuevaClave(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function crearClienteReservar(fetchImpl: typeof fetch, apiBaseUrl: string, orgSlug: string) {
  const base = `${apiBaseUrl}/v1/hoteles/${encodeURIComponent(orgSlug)}/reservar`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return {
    async config(): Promise<RespuestaConfig> {
      return leer<RespuestaConfig>(await fetchImpl(base), "No pudimos cargar la información del hotel.");
    },
    async disponibilidad(p: { llegada: string; salida: string; huespedes: number; propiedad?: string }): Promise<RespuestaDisponibilidad> {
      const qs = new URLSearchParams({ llegada: p.llegada, salida: p.salida, huespedes: String(p.huespedes) });
      if (p.propiedad) qs.set("property", p.propiedad);
      return leer<RespuestaDisponibilidad>(await fetchImpl(`${base}/disponibilidad?${qs}`), "No pudimos consultar la disponibilidad.");
    },
    async cotizar(p: { llegada: string; salida: string; huespedes: number; tipoHabitacionId: string; propiedad?: string }): Promise<Cotizacion> {
      return leer<Cotizacion>(await post("/cotizacion", p), "No pudimos cotizar tu estancia.");
    },
    /** 200/202 = reserva creada (confirmada o pendiente de pago). 402/503 con rastreoToken = reserva apartada sin cobro. Otro error lanza ReservarError. */
    async confirmar(p: { quoteToken: string; huesped: DatosHuesped; sitioWeb?: string }, clave: string): Promise<ReservaCreada> {
      const res = await post("/confirmar", { quoteToken: p.quoteToken, huesped: p.huesped, consentimientoAviso: true, ...(p.sitioWeb ? { sitioWeb: p.sitioWeb } : {}) }, { "idempotency-key": clave });
      if (res.ok || res.status === 402 || res.status === 503) {
        const body = (await res.json()) as Partial<ReservaCreada>;
        if (typeof body.rastreoToken === "string") return { ...(body as ReservaCreada), httpStatus: res.status };
        if (res.ok) throw new ReservarError("No pudimos registrar tu reserva. Inténtalo de nuevo.", res.status);
        throw new ReservarError(typeof body.message === "string" ? body.message : "No pudimos registrar tu reserva.", res.status, body.code);
      }
      throw await errorDe(res, "No pudimos registrar tu reserva.");
    },
    async estado(token: string): Promise<VistaReserva> {
      return leer<VistaReserva>(await fetchImpl(`${base}/estado/${encodeURIComponent(token)}`), "No pudimos consultar tu reserva.");
    },
    async cancelar(token: string, clave: string): Promise<VistaReserva> {
      return leer<VistaReserva>(await post(`/estado/${encodeURIComponent(token)}/cancelar`, {}, { "idempotency-key": clave }), "No pudimos cancelar tu reserva.");
    },
  };
}
export type ClienteReservar = ReturnType<typeof crearClienteReservar>;

export const pesos = (centavos: number): string => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(centavos / 100);

export const ETIQUETA_ESTADO: Record<string, { readonly texto: string; readonly tono: "success" | "warning" | "info" | "danger" }> = {
  confirmada: { texto: "Confirmada", tono: "success" },
  pago_pendiente: { texto: "Pago pendiente", tono: "warning" },
  en_revision: { texto: "En revisión del hotel", tono: "info" },
  aprobada: { texto: "Aprobada", tono: "info" },
  cancelada: { texto: "Cancelada", tono: "danger" },
  rechazada: { texto: "Rechazada", tono: "danger" },
  expirada: { texto: "Expirada", tono: "danger" },
};
