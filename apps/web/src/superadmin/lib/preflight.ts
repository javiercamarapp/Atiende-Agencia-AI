// Tipos y rotulos del "Listo para produccion" de una organizacion. La forma es la de apps/api/src/routes/superadmin-preflight.ts
// (GET /superadmin/organizaciones/:id/preflight); el detalle llega sin secretos ni datos personales.
import type { StatusTone } from "@atiende/ui";

export type PreflightEstado = "ok" | "falta" | "aviso" | "no_aplica";
export type PreflightArea = "entorno" | "crons" | "equipo" | "canal" | "privacidad" | "voz" | "datos" | "monitoreo";

export interface PreflightVerificacion {
  readonly id: string;
  readonly area: PreflightArea;
  readonly titulo: string;
  readonly estado: PreflightEstado;
  readonly detalle: string;
  readonly como_resolver: { readonly texto: string; /** Ruta relativa de la pantalla que lo arregla; null = paso externo. */ readonly enlace: string | null };
}

export interface RespuestaPreflight {
  readonly organizacion: { readonly id: string; readonly nombre: string; readonly slug: string; readonly vertical: string; readonly estado: string };
  readonly generadoEn: string;
  readonly resumen: { readonly total: number; readonly ok: number; readonly falta: number; readonly aviso: number; readonly no_aplica: number; readonly pendientes: number; readonly listo: boolean };
  readonly fuentes: { readonly crons: string; readonly equipo: string; readonly datos: string; readonly mfa: string };
  readonly areas: ReadonlyArray<{ readonly area: PreflightArea; readonly verificaciones: readonly PreflightVerificacion[] }>;
}

export const NOMBRE_AREA_PREFLIGHT: Readonly<Record<PreflightArea, string>> = {
  entorno: "Entorno",
  crons: "Crons",
  equipo: "Equipo",
  canal: "Canal de WhatsApp",
  privacidad: "Privacidad",
  voz: "Voz",
  datos: "Datos del restaurante",
  monitoreo: "Monitoreo",
};

export const NOMBRE_ESTADO_PREFLIGHT: Readonly<Record<PreflightEstado, string>> = { ok: "En orden", falta: "Falta", aviso: "Aviso", no_aplica: "No aplica" };
export const TONO_ESTADO_PREFLIGHT: Readonly<Record<PreflightEstado, StatusTone>> = { ok: "success", falta: "danger", aviso: "warning", no_aplica: "neutral" };

/** Semaforo de un area: el peor estado de sus verificaciones (falta > aviso > ok); todo "no aplica" = no aplica. */
export function semaforoDeArea(vs: readonly PreflightVerificacion[]): PreflightEstado {
  if (vs.some((v) => v.estado === "falta")) return "falta";
  if (vs.some((v) => v.estado === "aviso")) return "aviso";
  if (vs.some((v) => v.estado === "ok")) return "ok";
  return "no_aplica";
}

export const RAZON_FUENTE_PREFLIGHT: Readonly<Record<string, string>> = {
  no_migrado: "no disponible aún en este despliegue (falta aplicar una migración)",
  no_disponible: "no disponible aún en este despliegue",
  error: "la lectura falló; reintenta",
};
