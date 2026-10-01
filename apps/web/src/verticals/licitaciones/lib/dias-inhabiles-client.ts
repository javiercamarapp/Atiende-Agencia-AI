// Cliente del calendario de dias inhabiles de licitaciones (L-22). Llama a
// `.../dias-inhabiles` (apps/api/src/routes/verticals/licitaciones/diasInhabiles.ts). El servidor es
// la autoridad (roles, validacion, calendario efectivo); esta capa solo refleja lo que responde.
import { deleteJson, fetchJson, postJson } from "./admin-client.ts";

export type DiaInhabilAlcance = "oficial" | "organizacion" | "convocatoria";
export type DiaInhabilVerificacion = "verificada" | "por_validar";

export interface DiaInhabilOficial {
  readonly fecha: string;
  readonly nombre: string;
  readonly alcance: DiaInhabilAlcance;
  readonly fuente: string | null;
  readonly verificacion: DiaInhabilVerificacion;
}

export interface DiaInhabilSugerido {
  readonly fecha: string;
  readonly nombre: string;
  readonly motivo: string;
}

export interface DiaInhabilDeclarado {
  readonly id: string;
  readonly fecha: string;
  readonly nombre: string;
  readonly alcance: DiaInhabilAlcance;
  readonly tenderId: string | null;
  readonly publicadoPor: string | null;
  readonly fuente: string | null;
  readonly verificacion: DiaInhabilVerificacion;
  readonly createdAt: string;
}

export interface DiasInhabilesResumen {
  /** `false` con la base sin la migracion 032: los oficiales siguen aplicando, lo declarado no se puede editar. */
  readonly available: boolean;
  readonly timeZone: string;
  readonly coberturaOficial: readonly number[];
  readonly oficiales: readonly DiaInhabilOficial[];
  readonly sugeridos: readonly DiaInhabilSugerido[];
  readonly declarados: readonly DiaInhabilDeclarado[];
  readonly efectivos: readonly string[];
  readonly nota: string;
  readonly puedeEditar: boolean;
}

export interface NuevoDiaInhabil {
  readonly fecha: string;
  readonly nombre: string;
  readonly tenderId?: string | null;
  readonly publicadoPor?: string | null;
  readonly fuente?: string | null;
  readonly verificacion?: DiaInhabilVerificacion;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/dias-inhabiles`;

export function fetchDiasInhabiles(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId?: string): Promise<DiasInhabilesResumen> {
  const query = tenderId ? `?tenderId=${encodeURIComponent(tenderId)}` : "";
  return fetchJson<DiasInhabilesResumen>(f, `${base(apiBaseUrl, propertyId)}${query}`, token);
}

export function declararDiaInhabil(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NuevoDiaInhabil): Promise<DiaInhabilDeclarado> {
  return postJson<DiaInhabilDeclarado>(f, base(apiBaseUrl, propertyId), token, input);
}

export function quitarDiaInhabil(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(f, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(id)}`, token);
}

/** Plazo fijo descrito por el servidor contra el calendario efectivo (sala de guerra y junta). */
export interface PlazoDescripcion {
  readonly fechaLimite: string;
  readonly hoy: string;
  readonly diasHabilesRestantes: number;
  readonly caeEnInhabil: boolean;
  readonly motivoInhabil: string | null;
  readonly siguienteDiaHabil: string | null;
  readonly avisos: readonly string[];
  readonly nota: string;
}

/** Texto corto de un plazo: "3 días hábiles", "vence hoy", "vencido hace 2 días hábiles". */
export function textoDiasHabiles(p: PlazoDescripcion): string {
  if (p.fechaLimite === p.hoy) return "vence hoy";
  const n = p.diasHabilesRestantes;
  if (n > 0) return `${n} ${n === 1 ? "día hábil" : "días hábiles"}`;
  if (n === 0) return p.caeEnInhabil ? "sin días hábiles restantes (cae en día inhábil)" : "sin días hábiles restantes";
  return `vencido hace ${-n} ${-n === 1 ? "día hábil" : "días hábiles"}`;
}
