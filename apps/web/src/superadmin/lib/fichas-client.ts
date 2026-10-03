// Cliente y tipos de las fichas de agente (SA-L-09) y de Model Ops (SA-L-10) del superadmin. Lee SOLO
// GET /superadmin/agentes/:ficha y GET /superadmin/model-ops (apps/api/src/routes/superadmin-agentes-fichas.ts).
// REGLA DE LA CASA: nunca inventar una cifra. Cada campo es `{ valor, codigo?, razon? }`; `valor: null` se pinta "—" con su razon.
import { resolverFormato } from "@atiende/ui";
import type { Campo } from "./consola-client.ts";

export type FichaId = "extractor" | "conciliacion" | "whatsapp";

export interface FichaModeloFila {
  readonly proveedor: string;
  readonly modelo: string;
  readonly llamadas: number;
  readonly fallbacks: number;
  readonly costoUsd: number;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}
export interface FichaPuntoDia {
  readonly dia: string;
  readonly llamadas: number;
  readonly costoUsd: number;
}
export interface FichaBase {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly ficha: FichaId;
  readonly nombre: string;
  readonly nombreConfirmado: boolean;
  readonly generadoEn: string;
  readonly hoy: string;
  readonly roles: readonly string[];
  readonly gastado: Campo<{ totalUsd: number; llmUsd: number; vozUsd: number | null }>;
  readonly llamadas: Campo<number>;
  readonly fallbacks: Campo<{ total: number; tasaPct: number | null }>;
  readonly costoPorModelo: Campo<readonly FichaModeloFila[]>;
  readonly serie7d: Campo<readonly FichaPuntoDia[]>;
}
export interface FichaExtractor extends FichaBase {
  readonly documentosExtraidos: Campo<{ documentos: number; requisitos: number; licitaciones: number }>;
  readonly precision: Campo<number>;
  readonly notas: readonly string[];
}
export interface FichaConciliacion extends FichaBase {
  readonly movimientosConciliados: Campo<{ total: number; porMotor: number; porLlmAprobado: number; porManual: number; sugerenciasPendientes: number; sugerenciasTotal: number }>;
}
export interface FichaWhatsappVertical {
  readonly vertical: string;
  readonly llamadas: number;
  readonly costoLlmUsd: number;
  readonly escaladas: number;
  readonly conversaciones: Campo<number>;
  readonly minutosVoz: Campo<number>;
  readonly costoVozUsd: Campo<number>;
}
export interface FichaWhatsapp extends FichaBase {
  readonly conversaciones: Campo<number>;
  readonly minutosVoz: Campo<number>;
  readonly escalamiento: Campo<{ escaladas: number; total: number; tasaPct: number | null }>;
  readonly porVertical: Campo<readonly FichaWhatsappVertical[]>;
}
export interface FichaPorId {
  readonly extractor: FichaExtractor;
  readonly conciliacion: FichaConciliacion;
  readonly whatsapp: FichaWhatsapp;
}

export interface ModelOpsEscalon {
  readonly orden: number;
  readonly modelo: string;
  readonly razonamiento: string | null;
  readonly proveedores: readonly string[];
}
export interface ModelOpsFicha {
  readonly role: string;
  readonly vertical: string;
  readonly modelo: string | null;
  readonly proveedores: readonly string[];
  readonly escalera: readonly ModelOpsEscalon[];
  readonly carril: Campo<readonly string[]>;
  readonly llamadas30d: Campo<number>;
  readonly costo30dUsd: Campo<number>;
  readonly tasaFallbackPct: Campo<number>;
  readonly circuitBreaker: Campo<string>;
}
export interface ModelOps {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly generadoEn: string;
  readonly hoy: string;
  readonly desde: string;
  readonly fichas: readonly ModelOpsFicha[];
  readonly porAgente: Campo<readonly { role: string; costoUsd: number }[]>;
  readonly porModelo: Campo<readonly { modelo: string; costoUsd: number }[]>;
  readonly notas: readonly string[];
}

async function getJson<T>(apiBaseUrl: string, token: string, ruta: string, mensajeError: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(mensajeError);
  return (await res.json()) as T;
}

export const fetchFicha = <F extends FichaId>(apiBaseUrl: string, token: string, ficha: F) =>
  getJson<FichaPorId[F]>(apiBaseUrl, token, `/superadmin/agentes/${ficha}`, "No se pudo cargar la ficha del agente.");

export const fetchModelOps = (apiBaseUrl: string, token: string) => getJson<ModelOps>(apiBaseUrl, token, "/superadmin/model-ops", "No se pudo cargar Model Ops.");

// ---- formatos (sin llamadas nuevas a toLocale*: reutilizan los presets del kit de @atiende/ui) -----------------------

export const fmtEntero = resolverFormato("entero");
export const fmtUsd = resolverFormato("usd");
export const fmtDecimal = resolverFormato("numero");
export const fmtPct = (n: number): string => `${fmtDecimal(n)} %`;

/** Primer carril/proveedor para el que no hay dato: "—" (nunca vacio). */
export const SIN_DATO = "—";
