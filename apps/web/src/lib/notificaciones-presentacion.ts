// Textos y estilos de la pagina de notificaciones. Las categorias son las del catalogo compartido
// (`CATEGORIAS_NOTIFICACION` de @atiende/db); `apps/web/tests/notificaciones-presentacion.spec.ts` falla si
// el catalogo agrega una categoria sin su rotulo aqui.
import type { NotificacionSeveridad } from "./notificaciones-client.ts";

export const CATEGORIAS_ROTULO: Readonly<Record<string, string>> = {
  onboarding: "Alta",
  operacion: "Operación",
  agentes: "Agentes",
  aprobaciones: "Aprobaciones",
  automatizaciones: "Automatizaciones",
  cobranza: "Cobranza",
  fiscal: "Fiscal",
  seguridad: "Seguridad",
  salud: "Salud",
  cierres: "Cierres",
  cfo: "CFO",
};

export function rotuloCategoria(categoria: string | null): string | null {
  if (!categoria) return null;
  return CATEGORIAS_ROTULO[categoria] ?? categoria.charAt(0).toUpperCase() + categoria.slice(1).replace(/_/g, " ");
}

/** Rotulo del badge de severidad (el de Likida: «Requiere atención» / «Aviso»), con la critica explicita. */
export const SEVERIDAD_ROTULO: Readonly<Record<NotificacionSeveridad, string>> = {
  info: "Aviso",
  atencion: "Requiere atención",
  critica: "Crítica",
};

/** "hace un momento" / "hace N min" / "hace N h" / "hace N d" / fecha corta de CDMX. Sin libreria de fechas relativas. */
export function formatoRelativo(iso: string, ahoraMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor((ahoraMs - t) / 60_000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 7) return `hace ${dias} d`;
  return new Date(t).toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "America/Mexico_City" });
}
