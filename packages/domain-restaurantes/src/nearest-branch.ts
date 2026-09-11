// buscar_sucursal_cercana real (Fase 2 §1.1.1) — puerto de
// restaurantes/supabase/migrations/20260904030000_sucursal_mas_cercana_normaliza_espacios.sql
// (función SQL `sucursal_mas_cercana`), generalizado por organización: el
// origen era mono-tenant (`merida_colonias` global, una sola ciudad); la
// fusión es multi-tenant desde Fase 1, así que la tabla de zonas conocidas
// vive en `restaurantes.known_zone(organization_id, ...)`, sembrada por cada
// restaurante según su propia ciudad de operación.
//
// CONTRATO DE SILENCIO ANTE CERO-MATCH (preservado literal, es la razón de
// ser de este archivo): si la colonia no matchea ninguna zona conocida de
// ESTA organización, NUNCA se inventa/adivina una sucursal — se devuelve
// found:false con el mismo texto que el origen, para que el agente pida otra
// referencia. Bug real que motivó todo el tool: antes de esto, el LLM decidía
// "a ojo" cuál sucursal quedaba más cerca del nombre de la colonia sin ningún
// dato geográfico real — 3 de 4 colonias reales de prueba fallaron (hasta 2x
// más lejos en los casos que fallaron).
import type { RestaurantesRepository } from "./repository.ts";

/** Texto exacto del origen — es una instrucción de comportamiento para el
 * LLM (pedir otra referencia), no solo un mensaje de error, así que se
 * preserva literal en ambos canales (voz y WhatsApp). */
export const COLONIA_NO_RECONOCIDA_MENSAJE =
  "No reconozco esa colonia — pide al cliente otra referencia cercana (colonia vecina, cruce de calles, plaza conocida) e intenta de nuevo.";

export type NearestBranchResult =
  | {
      readonly found: true;
      readonly branchSlug: string;
      readonly branchName: string;
      readonly distanceKm: number;
      readonly recognizedZoneName: string;
    }
  | { readonly found: false; readonly message: string };

/**
 * Quita acentos y todo lo que no sea letra/número de AMBOS lados antes de
 * comparar — port literal del fix real del 4-sep-2026 (`regexp_replace(unaccent(lower(...)), '[^a-z0-9]', '', 'g')`
 * en la migración SQL del origen): sin esto, "Alta Brisa" (como lo dice
 * cualquier cliente real, dos palabras) nunca hacía match con la zona
 * sembrada sin espacio "altabrisa" — un espacio de más/de menos rompía el
 * substring aunque el texto fuera "el mismo" para un humano.
 */
export function normalizeZoneText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos (equivalente de unaccent())
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Distancia Haversine real en km entre dos puntos lat/lng — mismo cálculo
 * que la función SQL del origen (radio de la Tierra 6371 km), redondeado a
 * un decimal igual que `round(..., 1)` en el SQL. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosArg = Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2) - toRad(lng1)) + Math.sin(toRad(lat1)) * Math.sin(toRad(lat2));
  const clamped = Math.min(1, Math.max(-1, cosArg));
  return Math.round(6371 * Math.acos(clamped) * 10) / 10;
}

/**
 * Empareja la colonia/zona que dio el cliente contra las zonas conocidas de
 * ESTA organización y devuelve la sucursal real más cercana — nunca decide
 * "a ojo". Envoltorio delgado sobre `repo.findNearestBranchByColonia` (donde
 * vive el emparejamiento + Haversine real, ver in-memory-repository.ts /
 * postgres-repository.ts), responsable únicamente de dar forma a la
 * respuesta exacta que espera el agente (voz y WhatsApp comparten esta
 * función — "un solo núcleo, dos canales").
 */
export async function findNearestBranch(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly colonia: string },
): Promise<NearestBranchResult> {
  const colonia = typeof args.colonia === "string" ? args.colonia.trim() : "";
  if (!colonia) {
    return { found: false, message: COLONIA_NO_RECONOCIDA_MENSAJE };
  }
  const match = await repo.findNearestBranchByColonia(args.organizationId, colonia);
  if (!match) {
    return { found: false, message: COLONIA_NO_RECONOCIDA_MENSAJE };
  }
  return {
    found: true,
    branchSlug: match.branch.slug,
    branchName: match.branch.name,
    distanceKm: match.distanceKm,
    recognizedZoneName: match.recognizedZoneName,
  };
}
