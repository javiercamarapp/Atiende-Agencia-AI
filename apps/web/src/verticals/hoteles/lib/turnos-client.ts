// H-35 -- cliente de los turnos de camaristas y lavanderia (REQ-HK-008, LFT). Consume apps/api/.../hoteles/housekeeping.ts
// (`GET|POST /housekeeping/turnos`, que existian sin UI). La publicacion SIEMPRE se valida en el servidor contra la Ley Federal
// del Trabajo: si hay violaciones responde 422 con la cita legal y NO guarda nada; esta pantalla las muestra tal cual.
import { fetchJson, sendJsonConEstado } from "./admin-client.ts";
import { parseFechaSolo, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";

export interface Turno {
  readonly id: string;
  readonly staffId: string;
  readonly fecha: string;
  readonly inicio: string;
  readonly fin: string;
}

export interface ViolacionLft {
  readonly type: string;
  readonly staffId: string;
  readonly article: string;
  readonly message: string;
  readonly scope: { readonly workDate?: string; readonly isoWeek?: string; readonly rangeStart?: string; readonly rangeEnd?: string };
}

export interface TurnosConsulta {
  readonly turnos: readonly Turno[];
  readonly cumplimiento: { readonly valido: boolean; readonly violaciones: readonly ViolacionLft[] };
}

export type PublicacionTurnos =
  | { readonly publicado: true; readonly turnos: readonly Turno[] }
  | { readonly publicado: false; readonly violaciones: readonly ViolacionLft[] };

export interface TurnoPropuesto {
  readonly workDate: string;
  readonly startTime: string;
  readonly endTime: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/housekeeping/turnos`;

export function fetchTurnos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string, staffId?: string): Promise<TurnosConsulta> {
  const qs = new URLSearchParams({ desde, hasta, ...(staffId ? { staffId } : {}) });
  return fetchJson<TurnosConsulta>(fetchImpl, `${base(apiBaseUrl, propertyId)}?${qs.toString()}`, token);
}

export async function publicarTurnos(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly staffId: string; readonly fromDate: string; readonly toDate: string; readonly shifts: readonly TurnoPropuesto[] },
): Promise<PublicacionTurnos> {
  const r = await sendJsonConEstado<{ publicado?: boolean; violaciones?: readonly ViolacionLft[]; turnos?: readonly Turno[]; message?: string }>(fetchImpl, base(apiBaseUrl, propertyId), token, "POST", input);
  if (r.status === 422 && Array.isArray(r.body.violaciones)) return { publicado: false, violaciones: r.body.violaciones };
  if (!r.ok) throw new Error(r.body.message ?? `No se pudo publicar la plantilla (${r.status}).`);
  return { publicado: true, turnos: r.body.turnos ?? [] };
}

// Espejo cosmetico de HOUSEKEEPING_SHIFT_PUBLISH_ROLES (domain-hoteles/src/roles.ts): el servidor es la barrera real (403).
export const TURNOS_PUBLISH_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk"]);

export const DIAS_SEMANA = [
  { valor: 1, etiqueta: "Lun" },
  { valor: 2, etiqueta: "Mar" },
  { valor: 3, etiqueta: "Mié" },
  { valor: 4, etiqueta: "Jue" },
  { valor: 5, etiqueta: "Vie" },
  { valor: 6, etiqueta: "Sáb" },
  { valor: 0, etiqueta: "Dom" },
] as const;

/** Arma un turno por cada fecha del rango cuyo dia de la semana (0 = domingo) este elegido. */
export function turnosDelRango(desde: string, hasta: string, dias: ReadonlySet<number>, inicio: string, fin: string): readonly TurnoPropuesto[] {
  const out: TurnoPropuesto[] = [];
  for (let f = desde; f <= hasta; f = sumarDiasFechaSolo(f, 1)) {
    if (dias.has(parseFechaSolo(f).getUTCDay())) out.push({ workDate: f, startTime: inicio, endTime: fin });
    if (out.length > 62) break;
  }
  return out;
}

/** Validacion previa al envio (el servidor vuelve a validar y exige la LFT). */
export function validarPlantilla(staffId: string, desde: string, hasta: string, inicio: string, fin: string, dias: ReadonlySet<number>): string | null {
  const hora = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!staffId) return "Elige a la camarista.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) return "Elige un rango de fechas válido (desde ≤ hasta).";
  if (!hora.test(inicio) || !hora.test(fin)) return "Captura la hora de entrada y de salida (HH:mm).";
  if (dias.size === 0) return "Elige al menos un día de la semana.";
  if (turnosDelRango(desde, hasta, dias, inicio, fin).length === 0) return "Ningún día del rango coincide con los días elegidos.";
  return null;
}
