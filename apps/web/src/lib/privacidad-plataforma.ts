// Tipos, etiquetas y cliente HTTP de la privacidad de plataforma (PL-13): solicitudes ARCO unificadas,
// retencion por organizacion, bloqueo y registro de purgas y aviso versionado. Backend:
// apps/api/src/routes/superadmin-privacidad.ts (/superadmin/privacidad/*) y
// apps/api/src/routes/privacidad-org.ts (/v1/privacidad/*). Documentacion operativa, NO asesoria legal.
import type { StatusTone } from "@atiende/ui";

export type EstadoPlazo = "vencida" | "por_vencer" | "en_plazo" | "sin_plazo" | "cerrada";

export interface SolicitudArcoPlataforma {
  readonly organizacionId?: string;
  readonly organizacion?: string | null;
  readonly vertical: string;
  readonly id: string;
  readonly referencia: string;
  readonly derecho: string;
  readonly canal: string;
  readonly estado: string;
  readonly estadoOriginal: string;
  readonly abiertaEnMs: number;
  readonly respuestaVenceEnMs: number | null;
  readonly ejecucionVenceEnMs: number | null;
  readonly resueltaEnMs: number | null;
  readonly abierta: boolean;
  readonly plazo: { readonly estado: EstadoPlazo; readonly diasRestantes: number | null; readonly venceEnMs: number | null };
}

export interface PurgaRegistro {
  readonly seq: number;
  readonly organizacionId?: string | null;
  readonly organizacion?: string | null;
  readonly claseDato: string;
  readonly estado: string;
  readonly retencionDias: number | null;
  readonly corteEnMs: number | null;
  readonly filasAfectadas: number;
  readonly filasAnonimizadas: number;
  readonly filasProtegidas: number;
  readonly motivoBloqueo: string | null;
  readonly ocurrioEnMs: number;
}

export interface PlazosReferencia {
  readonly respuestaDias: number;
  readonly ejecucionDias: number;
  readonly porVencerDias: number;
}

export const DERECHO_ETIQUETA: Readonly<Record<string, string>> = { acceso: "Acceso", rectificacion: "Rectificación", cancelacion: "Cancelación", oposicion: "Oposición" };

export const VERTICAL_ETIQUETA: Readonly<Record<string, string>> = { citas: "Citas", restaurantes: "Restaurantes", hoteles: "Hoteles", despachos: "Despachos", licitaciones: "Licitaciones", rentas: "Rentas" };

export const ESTADO_ARCO_ETIQUETA: Readonly<Record<string, string>> = {
  por_confirmar: "Por confirmar",
  abierta: "Recibida",
  en_proceso: "En proceso",
  bloqueada: "Bloqueada",
  resuelta: "Resuelta",
  rechazada: "Rechazada",
  cerrada: "Cerrada",
};

export const PLAZO_ETIQUETA: Readonly<Record<EstadoPlazo, string>> = { vencida: "Vencida", por_vencer: "Por vencer", en_plazo: "En plazo", sin_plazo: "Sin plazo", cerrada: "Cerrada" };

export const PLAZO_TONO: Readonly<Record<EstadoPlazo, StatusTone>> = { vencida: "danger", por_vencer: "warning", en_plazo: "success", sin_plazo: "neutral", cerrada: "neutral" };

export const PURGA_ETIQUETA: Readonly<Record<string, string>> = { ok: "Ejecutada", simulacion: "Simulación", bloqueada: "Bloqueada", sin_ejecutor: "La corre el vertical" };

export const PURGA_TONO: Readonly<Record<string, StatusTone>> = { ok: "success", simulacion: "info", bloqueada: "warning", sin_ejecutor: "neutral" };

export const CLASE_DATO_ETIQUETA: Readonly<Record<string, string>> = {
  restaurantes_whatsapp_conversaciones: "Conversaciones de WhatsApp (restaurantes)",
  restaurantes_voz_transcripciones: "Transcripciones de voz (restaurantes)",
  hoteles_identidad_documento: "Documento de identidad del huésped (hoteles)",
  rentas_huesped_pii: "Nombre y contacto del huésped (rentas)",
  rentas_acceso_instrucciones: "Instrucciones de acceso a la unidad (rentas)",
};

export const ORIGEN_ETIQUETA: Readonly<Record<string, string>> = { organizacion: "Política de la organización", vertical: "Configuración del vertical", defecto: "Valor por defecto" };

/** "vence en 3 días", "venció hace 2 días", "vence hoy". */
export function textoPlazo(plazo: SolicitudArcoPlataforma["plazo"]): string {
  if (plazo.estado === "cerrada") return "—";
  if (plazo.diasRestantes === null) return "Sin plazo registrado";
  if (plazo.estado === "vencida") return plazo.diasRestantes === 0 ? "Venció hoy" : `Venció hace ${Math.abs(plazo.diasRestantes)} día${Math.abs(plazo.diasRestantes) === 1 ? "" : "s"}`;
  if (plazo.diasRestantes === 0) return "Vence hoy";
  return `Vence en ${plazo.diasRestantes} día${plazo.diasRestantes === 1 ? "" : "s"}`;
}

export function fechaMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return new Date(ms).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export function etiquetaClase(clase: string | null): string {
  if (clase === null) return "Todas las clases";
  return CLASE_DATO_ETIQUETA[clase] ?? clase;
}

/** GET/PUT/POST/DELETE con bearer; devuelve el JSON o lanza con el mensaje de la API. */
export async function llamarJson<T>(fetchImpl: typeof fetch, url: string, token: string, init: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetchImpl(url, { method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(err?.message ?? "No se pudo completar la solicitud.");
  }
  return (await res.json()) as T;
}
