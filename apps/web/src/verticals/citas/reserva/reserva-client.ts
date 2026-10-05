// Cliente de la pagina PUBLICA de reservas de citas (C-19). Sin sesion: no usa tokens. `fetchImpl` inyectado para probar la red
// sin jsdom. Contrato: apps/api/src/routes/verticals/citas/publico.ts (catalogo + disponibilidad) y el POST publico
// /v1/citas/:orgSlug/appointments (source "web"). Nunca inventa un mensaje cuando el servidor ya mando uno.

export interface ServicioPublico {
  readonly id: string;
  readonly nombre: string;
  readonly duracionMinutos: number;
  readonly precioCentavos: number | null;
}
export interface ProfesionalPublico {
  readonly id: string;
  readonly nombre: string;
  readonly servicioIds: readonly string[];
}
export interface CatalogoPublico {
  readonly lista: true;
  readonly nombre: string;
  readonly zonaHoraria: string;
  readonly servicios: readonly ServicioPublico[];
  readonly profesionales: readonly ProfesionalPublico[];
}
/** El negocio todavia no cumple el minimo para recibir reservas en linea: no hay formulario ni datos. */
export interface NegocioNoListo {
  readonly lista: false;
  readonly faltan: readonly string[];
}
export interface HorarioPublico {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly providerId: string;
}
export interface DisponibilidadPublica {
  readonly zonaHoraria: string;
  readonly horarios: readonly HorarioPublico[];
}
export interface CitaCreada {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
}

export class ReservaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReservaError";
  }
}

export interface DatosReserva {
  readonly serviceId: string;
  readonly providerId: string;
  readonly startsAt: string;
  readonly nombre: string;
  readonly telefono: string;
  readonly correo: string;
  readonly idempotencyKey: string;
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
  throw new ReservaError(message, res.status);
}

import { fetchWithTimeout } from "../../../lib/authed-fetch.ts";

export function crearClienteReserva(apiBaseUrl: string, orgSlug: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const raiz = `${apiBaseUrl.replace(/\/+$/, "")}/v1/citas/${encodeURIComponent(orgSlug)}`;
  // Con la API colgada la reserva no se queda en "Confirmando..." para siempre: vence a los 20 s (un RequestTimeoutError que la pagina trata como un fallo de red, con la MISMA llave de idempotencia al reintentar).
  const post = (path: string, body: unknown) => fetchWithTimeout(fetchImpl, `${raiz}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async catalogo(): Promise<CatalogoPublico | NegocioNoListo> {
      const raw = await leer<{
        lista: boolean;
        faltan?: string[];
        negocio?: { nombre: string; zona_horaria: string };
        servicios?: { id: string; nombre: string; duracion_minutos: number; precio_centavos: number | null }[];
        profesionales?: { id: string; nombre: string; servicio_ids: string[] }[];
      }>(await fetchWithTimeout(fetchImpl, `${raiz}/publico/catalogo`), "No pudimos cargar el negocio.");
      if (!raw.lista) return { lista: false, faltan: raw.faltan ?? [] };
      return {
        lista: true,
        nombre: raw.negocio?.nombre ?? "",
        zonaHoraria: raw.negocio?.zona_horaria ?? "America/Mexico_City",
        servicios: (raw.servicios ?? []).map((s) => ({ id: s.id, nombre: s.nombre, duracionMinutos: s.duracion_minutos, precioCentavos: s.precio_centavos })),
        profesionales: (raw.profesionales ?? []).map((p) => ({ id: p.id, nombre: p.nombre, servicioIds: p.servicio_ids })),
      };
    },
    /** `providerId` vacio = "cualquiera": el servidor une los horarios de quienes ofrecen el servicio. */
    async disponibilidad(serviceId: string, providerId: string | null, date: string): Promise<DisponibilidadPublica | NegocioNoListo> {
      const raw = await leer<{ lista: boolean; faltan?: string[]; zona_horaria?: string | null; slots?: { starts_at: string; ends_at: string; provider_id: string }[] }>(
        await post("/publico/disponibilidad", { service_id: serviceId, provider_id: providerId ?? undefined, date }),
        "No pudimos cargar los horarios.",
      );
      if (!raw.lista) return { lista: false, faltan: raw.faltan ?? [] };
      return { zonaHoraria: raw.zona_horaria ?? "America/Mexico_City", horarios: (raw.slots ?? []).map((s) => ({ startsAt: s.starts_at, endsAt: s.ends_at, providerId: s.provider_id })) };
    },
    async reservar(d: DatosReserva): Promise<CitaCreada> {
      const raw = await leer<{ appointment: { id: string; starts_at: string; ends_at: string; status: string } }>(
        await post("/appointments", {
          provider_id: d.providerId,
          service_id: d.serviceId,
          starts_at: d.startsAt,
          customer_name: d.nombre.trim(),
          customer_phone: d.telefono.trim(),
          customer_email: d.correo.trim() || undefined,
          source: "web",
          idempotency_key: d.idempotencyKey,
        }),
        "No pudimos registrar tu cita.",
      );
      return { id: raw.appointment.id, startsAt: raw.appointment.starts_at, endsAt: raw.appointment.ends_at, status: raw.appointment.status };
    },
  };
}

export type ClienteReserva = ReturnType<typeof crearClienteReserva>;

// ---------------------------------------------------------------------------------------------------------------------
// Fechas en la zona horaria del NEGOCIO (nunca la del navegador del cliente).
// ---------------------------------------------------------------------------------------------------------------------

/** Hoy como YYYY-MM-DD en la zona del negocio. */
export function hoyEnZona(zona: string, ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}

export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

export function diasDisponibles(zona: string, cuantos: number, ahora: Date = new Date()): string[] {
  const hoy = hoyEnZona(zona, ahora);
  return Array.from({ length: cuantos }, (_, i) => sumarDias(hoy, i));
}

/** "lun 13 sep": la fecha civil ya es la del negocio, por eso se formatea en UTC. */
export function etiquetaDia(fecha: string): { corta: string; larga: string } {
  const f = new Date(`${fecha}T12:00:00Z`);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", ...o }).format(f);
  return { corta: fmt({ weekday: "short", day: "numeric", month: "short" }).replace(/\./g, ""), larga: fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }) };
}

export function formatoHora(iso: string, zona: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

export function formatoFechaHora(iso: string, zona: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

export function formatoPrecio(centavos: number | null): string | null {
  if (centavos === null) return null;
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(centavos / 100);
}

export interface FormularioReserva {
  nombre: string;
  telefono: string;
  correo: string;
  acepta: boolean;
}

export function validarFormulario(f: FormularioReserva): Partial<Record<keyof FormularioReserva, string>> {
  const e: Partial<Record<keyof FormularioReserva, string>> = {};
  if (!f.nombre.trim()) e.nombre = "Escribe tu nombre.";
  const digitos = f.telefono.replace(/\D/g, "");
  if (!(digitos.length === 10 || (digitos.length === 12 && digitos.startsWith("52")) || (digitos.length === 13 && digitos.startsWith("521")))) e.telefono = "Escribe un teléfono de 10 dígitos.";
  if (f.correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.correo.trim())) e.correo = "Revisa tu correo (o déjalo vacío).";
  if (!f.acepta) e.acepta = "Acepta el aviso de privacidad para continuar.";
  return e;
}
