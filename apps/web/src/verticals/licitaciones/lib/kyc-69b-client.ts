// Cliente del KYC negativo 69-B de licitaciones (L-08). Llama a `.../kyc-69b`, `.../kyc-69b/consultar`,
// `.../kyc-69b/fichas` y `.../kyc-69b/consultas` (apps/api/src/routes/verticals/licitaciones/kyc69b.ts).
// El servidor es la autoridad: valida el RFC, aplica los topes y decide el semaforo; esta capa solo
// parte el texto pegado por el usuario y refleja lo que responde.
import { deleteJson, fetchJson, postJson } from "./admin-client.ts";

export type KycSemaforo = "rojo" | "ambar" | "verde" | "sin_datos";
export type KycSituacion = "presunto" | "desvirtuado" | "definitivo" | "sentencia_favorable";
export type KycRol = "proveedor" | "competidor";

/** Tope de RFC por consulta (espejo del servidor, que es la unica barrera real). */
export const KYC_MAX_BATCH = 50;

export interface KycSemaforoInfo {
  readonly semaforo: KycSemaforo;
  readonly etiqueta: string;
  readonly detalle: string;
  readonly accionable: boolean;
}

export interface KycConsultaFila extends KycSemaforoInfo {
  readonly rfc: string;
  readonly encontrado: boolean;
  readonly periodo: string | null;
  readonly nombre: string | null;
  readonly situacion: KycSituacion | null;
  readonly oficioPresuncion: string | null;
  readonly fechaPublicacion: string | null;
}

export interface KycConsultaResultado {
  readonly listaDisponible: boolean;
  readonly periodo: string | null;
  readonly filas: readonly KycConsultaFila[];
}

export interface KycFicha extends KycSemaforoInfo {
  readonly id: string;
  readonly rfc: string;
  readonly rol: KycRol;
  readonly nombre: string;
  readonly periodo: string | null;
  readonly encontrado: boolean;
  readonly situacion: KycSituacion | null;
  readonly fechaPublicacion: string | null;
}

export interface KycResumen {
  /** `false` con la base sin la migracion 031 (o sin la lista 69-B): la pantalla lo dice en vez de fingir. */
  readonly available: boolean;
  readonly lista: { readonly periodo: string; readonly filas: number; readonly ingestadoEn: string } | null;
  readonly listaDisponible: boolean;
  readonly periodo: string | null;
  readonly fichas: readonly KycFicha[];
  readonly alertas: readonly KycFicha[];
}

export interface KycBitacoraEntrada {
  readonly id: string;
  readonly rfc: string;
  readonly encontrado: boolean;
  readonly situacion: KycSituacion | null;
  readonly periodo: string | null;
  readonly consultadoEn: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/kyc-69b`;

/** Parte el texto pegado (comas, espacios, saltos de linea, punto y coma) en candidatos a RFC, sin duplicados. */
export function parseRfcsDelTexto(texto: string): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const parte of texto.split(/[\s,;]+/)) {
    const rfc = parte.trim().toUpperCase();
    if (rfc && !vistos.has(rfc)) {
      vistos.add(rfc);
      out.push(rfc);
    }
  }
  return out;
}

export function fetchKycResumen(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<KycResumen> {
  return fetchJson<KycResumen>(f, base(apiBaseUrl, propertyId), token);
}

export function consultarKyc(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, rfcs: readonly string[]): Promise<KycConsultaResultado> {
  return postJson<KycConsultaResultado>(f, `${base(apiBaseUrl, propertyId)}/consultar`, token, { rfcs });
}

export function agregarFichaKyc(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { rfc: string; rol: KycRol; nombre: string }): Promise<{ id: string }> {
  return postJson<{ id: string }>(f, `${base(apiBaseUrl, propertyId)}/fichas`, token, input);
}

export function quitarFichaKyc(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(f, `${base(apiBaseUrl, propertyId)}/fichas/${encodeURIComponent(id)}`, token);
}

export function fetchKycBitacora(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ available: boolean; consultas: readonly KycBitacoraEntrada[] }> {
  return fetchJson<{ available: boolean; consultas: readonly KycBitacoraEntrada[] }>(f, `${base(apiBaseUrl, propertyId)}/consultas`, token);
}
