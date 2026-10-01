// H-27 -- cliente de la ficha de huesped (CRM). Consume apps/api/src/routes/verticals/hoteles/huespedes.ts (ficha, notas) y el
// catalogo `GET .../huespedes` de reservas.ts (busqueda). `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts).
import { fetchJson, sendJson } from "./admin-client.ts";
import { searchGuests } from "./reservas-client.ts";
import type { GuestOption } from "./reservas-client.ts";

export type { GuestOption };
export type NotaTipo = "nota" | "preferencia";
export const NOTA_TIPO_LABELS: Record<NotaTipo, string> = { nota: "Nota", preferencia: "Preferencia" };
export const NOTA_MAX_LENGTH = 500;

export interface Nota {
  readonly id: string;
  readonly tipo: NotaTipo;
  readonly texto: string;
  readonly creadaPor: string | null;
  readonly creadaEn: string;
}

export interface Estancia {
  readonly reservaId: string;
  readonly estado: string;
  readonly entrada: string;
  readonly salida: string;
  readonly tipoHabitacion: string | null;
  readonly habitacion: string | null;
  /** Monto NETO en centavos MXN enteros. */
  readonly montoNetoCentavos: number;
}

export interface Ficha {
  readonly huesped: { readonly id: string; readonly nombreCompleto: string; readonly email: string | null; readonly telefono: string | null };
  readonly resumen: { readonly estancias: number; readonly noches: number; readonly ultimaEstancia: string | null; readonly proximaLlegada: string | null };
  readonly estancias: readonly Estancia[];
  /** `disponible: false` = la base aun no tiene la migracion 038: no es "sin notas". */
  readonly notas: { readonly disponible: boolean; readonly items: readonly Nota[] };
  readonly contactos: readonly { readonly id: string; readonly motivo: string; readonly canal: "voz" | "whatsapp"; readonly mensaje: string | null; readonly creadoEn: string }[];
  /** null = la base aun no tiene la migracion 032. */
  readonly consentimientos: readonly { readonly id: string; readonly aviso: string; readonly finalidadesOpcionales: readonly string[]; readonly canal: string; readonly fecha: string; readonly revocado: boolean }[] | null;
  /** null = la base aun no tiene la boveda de identidad (031). Solo un booleano: el documento nunca viaja. */
  readonly identidad: { readonly registrada: boolean } | null;
  /** restriccion = ARCO de cancelacion/oposicion en curso (bloquea notas nuevas). null = sin la migracion 038. */
  readonly arco: { readonly restriccion: boolean } | null;
}

const base = (apiBaseUrl: string, propertyId: string, guestId: string) => `${apiBaseUrl}/hoteles/${propertyId}/huespedes/${guestId}`;

export function buscarHuespedes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, q?: string): Promise<readonly GuestOption[]> {
  return searchGuests(fetchImpl, apiBaseUrl, token, propertyId, q);
}

export function fetchFicha(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, guestId: string): Promise<Ficha> {
  return fetchJson<Ficha>(fetchImpl, `${base(apiBaseUrl, propertyId, guestId)}/ficha`, token);
}

export function agregarNota(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, guestId: string, tipo: NotaTipo, texto: string): Promise<Nota> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId, guestId)}/notas`, token, "POST", { tipo, texto });
}

export function archivarNota(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, guestId: string, noteId: string): Promise<Nota> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId, guestId)}/notas/${noteId}/archivar`, token, "POST", {});
}

// Espejo cosmetico de `GUEST_CRM_ROLES` (domain-hoteles/src/roles.ts): solo oculta lo que el servidor rechazaria igual (403).
export const HUESPED_CRM_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);

/** Un numero de tarjeta o documento (13 a 19 digitos, con espacios o guiones) no se guarda en una nota: se avisa antes de enviar. */
export function notaTieneDatoSensible(texto: string): boolean {
  return /[0-9]{13,19}/.test(texto.replace(/[ -]/g, ""));
}
