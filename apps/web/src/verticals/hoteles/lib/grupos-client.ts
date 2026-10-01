// H-06 -- logica de datos de GRUPOS: cotizacion con vigencia, bloqueo de cuartos con fecha de liberacion, pickup,
// rooming list y anticipos REGISTRADOS (sin cobro). Consume apps/api/src/routes/verticals/hoteles/grupos.ts.
// `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts). Dinero SIEMPRE en centavos enteros MXN.
import { fetchJson, sendJson } from "./admin-client.ts";

export type EstadoCotizacion = "borrador" | "enviada" | "aceptada" | "rechazada" | "vencida" | "cancelada";
export type EstadoBloqueo = "activo" | "liberado" | "cancelado";
export type EstadoHuesped = "pendiente" | "confirmada" | "cancelada";

export const ESTADO_COTIZACION_LABELS: Record<EstadoCotizacion, string> = {
  borrador: "Borrador",
  enviada: "Enviada",
  aceptada: "Aceptada",
  rechazada: "Rechazada",
  vencida: "Vencida",
  cancelada: "Cancelada",
};
export const ESTADO_BLOQUEO_LABELS: Record<EstadoBloqueo, string> = { activo: "Activo", liberado: "Liberado", cancelado: "Cancelado" };
export const ESTADO_HUESPED_LABELS: Record<EstadoHuesped, string> = { pendiente: "Pendiente", confirmada: "Confirmado", cancelada: "Cancelado" };
export const TIPO_LIBERACION_LABELS: Record<string, string> = { cutoff: "Por fecha de liberación", manual: "Manual", cancelacion: "Cancelación" };

/** Cosmetico: el servidor es la unica barrera real (403). Espejo de GRUPOS_*_ROLES de @atiende/domain-hoteles. */
export const GRUPOS_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);
export const GRUPOS_MANAGE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "reservations"]);
export const GRUPOS_ROOMING_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "reservations", "frontdesk"]);
export const GRUPOS_DEPOSIT_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);

export interface Cotizacion {
  readonly id: string;
  readonly nombreGrupo: string;
  readonly contacto: string | null;
  readonly correoContacto: string | null;
  readonly llegada: string;
  readonly salida: string;
  readonly noches: number;
  readonly fechaLiberacion: string;
  readonly vigenteHasta: string;
  readonly descuentoBps: number;
  readonly brutoCentavos: number;
  readonly totalCentavos: number;
  readonly anticipoRequeridoCentavos: number;
  readonly anticipoRegistradoCentavos: number;
  readonly estado: EstadoCotizacion;
  readonly motivoCierre: string | null;
}
export interface CotizacionesResultado {
  readonly disponible: boolean;
  readonly cotizaciones: readonly Cotizacion[];
}
export interface Anticipo {
  readonly id: string;
  readonly montoCentavos: number;
  readonly referencia: string;
  readonly registradoEn: string;
}
export interface CotizacionDetalle extends Cotizacion {
  readonly renglones: readonly { id: string; tipoHabitacionId: string; cuartos: number; tarifaCentavos: number }[];
  readonly anticipos: readonly Anticipo[];
  readonly bloqueoId: string | null;
}

export interface Pickup {
  readonly cuartosNocheBloqueados: number;
  readonly cuartosNocheConfirmados: number;
  readonly cuartosNocheLiberados: number;
  readonly cuartosNochePendientes: number;
  readonly cuartosNocheRetenidos: number;
  readonly porcentaje: number;
}
export interface Bloqueo {
  readonly id: string;
  readonly cotizacionId: string;
  readonly nombreGrupo: string;
  readonly estado: EstadoBloqueo;
  readonly llegada: string;
  readonly salida: string;
  readonly fechaLiberacion: string;
  readonly liberadoEn: string | null;
  readonly tipoLiberacion: string | null;
  readonly pickup: Pickup;
}
export interface BloqueosResultado {
  readonly disponible: boolean;
  readonly bloqueos: readonly Bloqueo[];
}
export interface HuespedGrupo {
  readonly id: string;
  readonly tipoHabitacionId: string;
  readonly huesped: string;
  readonly llegada: string;
  readonly salida: string;
  readonly estado: EstadoHuesped;
  readonly reservaId: string | null;
}
export interface BloqueoDetalle extends Bloqueo {
  readonly noches: readonly { tipoHabitacionId: string; fecha: string; bloqueados: number; confirmados: number; liberados: number }[];
  readonly rooming: readonly HuespedGrupo[];
}

export interface NuevaCotizacion {
  readonly nombreGrupo: string;
  readonly contacto?: string;
  readonly correoContacto?: string;
  readonly llegada: string;
  readonly salida: string;
  readonly fechaLiberacion: string;
  /** ISO 8601 con zona. */
  readonly vigenteHasta: string;
  readonly descuentoBps: number;
  readonly anticipoRequeridoCentavos: number;
  readonly renglones: readonly { tipoHabitacionId: string; cuartos: number; tarifaCentavos: number }[];
}

const gBase = (api: string, p: string) => `${api}/hoteles/${p}/grupos`;

export const fetchCotizaciones = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<CotizacionesResultado>(f, `${gBase(api, p)}/cotizaciones`, token);
export const fetchCotizacion = (f: typeof fetch, api: string, token: string, p: string, id: string) => fetchJson<CotizacionDetalle>(f, `${gBase(api, p)}/cotizaciones/${id}`, token);
export const crearCotizacion = (f: typeof fetch, api: string, token: string, p: string, input: NuevaCotizacion) => sendJson<CotizacionDetalle>(f, `${gBase(api, p)}/cotizaciones`, token, "POST", input);
export const enviarCotizacion = (f: typeof fetch, api: string, token: string, p: string, id: string) => sendJson<CotizacionDetalle>(f, `${gBase(api, p)}/cotizaciones/${id}/enviar`, token, "POST", {});
export const cerrarCotizacion = (f: typeof fetch, api: string, token: string, p: string, id: string, resultado: "rechazada" | "cancelada", motivo: string) =>
  sendJson<CotizacionDetalle>(f, `${gBase(api, p)}/cotizaciones/${id}/cerrar`, token, "POST", { resultado, motivo });
/** Aceptar = BLOQUEAR cuartos (atomico, sin sobreventa; 409 si una noche no alcanza). */
export const aceptarCotizacion = (f: typeof fetch, api: string, token: string, p: string, id: string) => sendJson<BloqueoDetalle>(f, `${gBase(api, p)}/cotizaciones/${id}/aceptar`, token, "POST", {});
export const registrarAnticipo = (f: typeof fetch, api: string, token: string, p: string, id: string, montoCentavos: number, referencia: string) =>
  sendJson<CotizacionDetalle>(f, `${gBase(api, p)}/cotizaciones/${id}/anticipos`, token, "POST", { montoCentavos, referencia });

export const fetchBloqueos = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<BloqueosResultado>(f, `${gBase(api, p)}/bloqueos`, token);
export const fetchBloqueo = (f: typeof fetch, api: string, token: string, p: string, id: string) => fetchJson<BloqueoDetalle>(f, `${gBase(api, p)}/bloqueos/${id}`, token);
export const agregarHuesped = (f: typeof fetch, api: string, token: string, p: string, bloqueoId: string, input: { tipoHabitacionId: string; huesped: string; llegada: string; salida: string }) =>
  sendJson<HuespedGrupo>(f, `${gBase(api, p)}/bloqueos/${bloqueoId}/huespedes`, token, "POST", input);
export const confirmarHuesped = (f: typeof fetch, api: string, token: string, p: string, huespedId: string) => sendJson<HuespedGrupo>(f, `${gBase(api, p)}/huespedes/${huespedId}/confirmar`, token, "POST", {});
export const cancelarHuesped = (f: typeof fetch, api: string, token: string, p: string, huespedId: string) => sendJson<HuespedGrupo>(f, `${gBase(api, p)}/huespedes/${huespedId}/cancelar`, token, "POST", {});
export const liberarBloqueo = (f: typeof fetch, api: string, token: string, p: string, id: string) => sendJson<{ cuartosNocheLiberados: number }>(f, `${gBase(api, p)}/bloqueos/${id}/liberar`, token, "POST", {});
export const cancelarBloqueo = (f: typeof fetch, api: string, token: string, p: string, id: string, motivo: string) =>
  sendJson<{ cuartosNocheLiberados: number }>(f, `${gBase(api, p)}/bloqueos/${id}/cancelar`, token, "POST", { motivo });

// ---- helpers de presentacion (puros, con prueba) ----------------------------------------------------

/** Centavos MXN -> "$1,234.50". */
export function formatearCentavos(centavos: number | null | undefined): string {
  if (centavos == null) return "—";
  return (centavos / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

/**
 * Pesos escritos por una persona -> centavos ENTEROS, sin pasar por flotantes: "1500", "1,500.50", "$99.9" => 150000,
 * 150050, 9990. Mas de 2 decimales, negativos o texto => null (nunca se redondea en silencio).
 */
export function pesosACentavos(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$/, "").replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(limpio);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

/** Descuento escrito en % ("10", "12.5") -> puntos base enteros (1000, 1250); mas de 2 decimales o fuera de 0-100 => null. */
export function porcentajeABps(texto: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(texto.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bps <= 10_000 ? bps : null;
}

/** Misma formula y redondeo (half-up, enteros) que la migracion 036: total = bruto * (10000 - bps) / 10000. */
export function totalConDescuento(brutoCentavos: number, bps: number): number {
  return Number((BigInt(brutoCentavos) * BigInt(10_000 - bps) + 5_000n) / 10_000n);
}

/** Bruto de una cotizacion: cuartos x noches x tarifa (centavos). */
export function brutoCentavos(renglones: readonly { cuartos: number; tarifaCentavos: number }[], noches: number): number {
  return renglones.reduce((n, r) => n + r.cuartos * r.tarifaCentavos * noches, 0);
}

/** Noches entre dos fechas YYYY-MM-DD (0 si son invalidas o la salida no es posterior). */
export function nochesEntre(llegada: string, salida: string): number {
  const a = Date.parse(`${llegada}T00:00:00Z`);
  const b = Date.parse(`${salida}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Dias (calendario) que faltan para la fecha de liberacion, comparando YYYY-MM-DD; negativo = ya paso. */
export function diasParaLiberacion(fechaLiberacion: string, hoy: string): number {
  return Math.round((Date.parse(`${fechaLiberacion}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
}

export function describirLiberacion(b: Pick<Bloqueo, "estado" | "fechaLiberacion" | "tipoLiberacion">, hoy: string): string {
  if (b.estado !== "activo") return `${ESTADO_BLOQUEO_LABELS[b.estado]}${b.tipoLiberacion ? ` (${TIPO_LIBERACION_LABELS[b.tipoLiberacion] ?? b.tipoLiberacion})` : ""}`;
  const d = diasParaLiberacion(b.fechaLiberacion, hoy);
  if (d < 0) return `Venció el ${b.fechaLiberacion}: se libera en el siguiente barrido`;
  if (d === 0) return "Se libera hoy";
  return d === 1 ? "Se libera mañana" : `Se libera en ${d} días`;
}

/** Botones de una cotizacion segun estado y rol (cosmetico; la base decide). */
export function accionesCotizacion(c: Pick<Cotizacion, "estado" | "anticipoRegistradoCentavos" | "totalCentavos">, role: string): readonly ("enviar" | "aceptar" | "rechazar" | "cancelar" | "anticipo")[] {
  const out: ("enviar" | "aceptar" | "rechazar" | "cancelar" | "anticipo")[] = [];
  if (GRUPOS_MANAGE_ROLES.has(role)) {
    if (c.estado === "borrador") out.push("enviar", "cancelar");
    if (c.estado === "enviada") out.push("aceptar", "rechazar", "cancelar");
  }
  if (c.estado === "aceptada" && GRUPOS_DEPOSIT_ROLES.has(role) && c.anticipoRegistradoCentavos < c.totalCentavos) out.push("anticipo");
  return out;
}
