// Cliente real de apps/api/src/routes/verticals/restaurantes/admin-conocimiento.ts (migracion 053): conocimiento del negocio (politicas,
// preguntas frecuentes y avisos temporales) e interruptor del agente de WhatsApp por sucursal. Mismo criterio de `fetchImpl` inyectado que
// el resto de lib/*.ts (ver admin-client.ts). Nada se inventa en el cliente: `disponible: false` es el estado honesto de la base sin migrar.
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export type TipoConocimiento = "politica" | "faq" | "aviso_temporal";
export type EstadoConocimiento = "borrador" | "publicado";

export const TIPO_CONOCIMIENTO_LABEL: Readonly<Record<TipoConocimiento, string>> = {
  politica: "Política",
  faq: "Pregunta frecuente",
  aviso_temporal: "Aviso temporal",
};

export const TEXTO_MAX = 2000;
export const TITULO_MAX = 120;

export interface EntradaConocimiento {
  readonly id: string;
  /** `null` = toda la organizacion. */
  readonly sucursalId: string | null;
  readonly reemplazaId: string | null;
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: TipoConocimiento;
  readonly prioridad: number;
  readonly vigenteDesde: string | null;
  readonly vigenteHasta: string | null;
  readonly activo: boolean;
  readonly estado: EstadoConocimiento;
  readonly origen: "manual" | "importado";
  readonly version: number;
  readonly actualizadoEn: string;
}

export interface ListaConocimiento {
  readonly disponible: boolean;
  readonly topeCaracteres: number;
  readonly entradas: readonly EntradaConocimiento[];
}

export interface EntradaConocimientoInput {
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: TipoConocimiento;
  readonly sucursalId: string | null;
  readonly reemplazaId: string | null;
  readonly prioridad: number;
  readonly vigenteDesde: string | null;
  readonly vigenteHasta: string | null;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/conocimiento`;

export function fetchConocimiento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ListaConocimiento> {
  return fetchJson<ListaConocimiento>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function crearConocimiento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: EntradaConocimientoInput): Promise<EntradaConocimiento> {
  return sendJson<EntradaConocimiento>(fetchImpl, base(apiBaseUrl, propertyId), token, "POST", input);
}

export function actualizarConocimiento(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  id: string,
  patch: Partial<Omit<EntradaConocimientoInput, "sucursalId">> & { readonly activo?: boolean; readonly estado?: EstadoConocimiento },
): Promise<EntradaConocimiento> {
  return sendJson<EntradaConocimiento>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}`, token, "PATCH", patch);
}

export async function borrarConocimiento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}`, token);
}

export interface InterruptorAgenteWhatsapp {
  readonly disponible: boolean;
  readonly agenteActivo: boolean;
}

const interruptor = (apiBaseUrl: string, propertyId: string, branchId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/sucursales/${branchId}/agente-whatsapp`;

export function fetchInterruptorAgenteWhatsapp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string): Promise<InterruptorAgenteWhatsapp> {
  return fetchJson<InterruptorAgenteWhatsapp>(fetchImpl, interruptor(apiBaseUrl, propertyId, branchId), token);
}

export function updateInterruptorAgenteWhatsapp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, branchId: string, activo: boolean): Promise<InterruptorAgenteWhatsapp> {
  return sendJson<InterruptorAgenteWhatsapp>(fetchImpl, interruptor(apiBaseUrl, propertyId, branchId), token, "PUT", { activo });
}
