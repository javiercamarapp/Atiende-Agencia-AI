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

/** Distancia Haversine real en km SIN redondear -- se usa para ORDENAR sucursales: ordenar por
 * la distancia ya redondeada a 0.1 km inventaria empates falsos entre dos sucursales casi
 * equidistantes (ver branch-assignment.ts). */
export function haversineKmExact(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosArg = Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2) - toRad(lng1)) + Math.sin(toRad(lat1)) * Math.sin(toRad(lat2));
  const clamped = Math.min(1, Math.max(-1, cosArg));
  return 6371 * Math.acos(clamped);
}

/** Distancia Haversine real en km entre dos puntos lat/lng — mismo cálculo
 * que la función SQL del origen (radio de la Tierra 6371 km), redondeado a
 * un decimal igual que `round(..., 1)` en el SQL. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return Math.round(haversineKmExact(lat1, lng1, lat2, lng2) * 10) / 10;
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

// ---------------------------------------------------------------------------
// Textos de `buscar_sucursal_cercana` (WhatsApp y voz comparten el nucleo). Los lee el MODELO, que contesta al cliente: llevan la frase sugerida.
// Nunca prometen envio fuera de la zona de reparto; la distancia se dice como aproximada y sin decimales raros («a unos 5 km»).
// ---------------------------------------------------------------------------

/** «a unos 5 km» / «a menos de 1 km»: la distancia en linea recta es una referencia, no un dato exacto; sin decimales. */
export function kmAproxTexto(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "";
  if (km < 1) return "a menos de 1 km";
  if (km < 1.5) return "a cerca de 1 km";
  return `a unos ${Math.round(km)} km`;
}

export interface SucursalCercana {
  readonly slug: string;
  readonly nombre: string;
  /** Km en linea recta (1 decimal) o de la referencia del piloto; `null` = no hay dato que decir. */
  readonly kmAprox: number | null;
}

const conKm = (s: SucursalCercana): string => (s.kmAprox === null ? s.nombre : `${s.nombre} (${kmAproxTexto(s.kmAprox)})`);

/** Colonia con sucursal de despacho: la dice el agente. `cobertura_dueno` = la fijo el dueno (no se afirma que sea la mas cercana). */
export function mensajeSucursalAsignada(args: {
  readonly principal: SucursalCercana;
  readonly alternativa: SucursalCercana | null;
  readonly origen: "pin" | "distancia" | "cobertura_dueno";
  /** Medicion incompleta (alguna sucursal sin coordenada): no se dice «mas cercana» ni distancias. */
  readonly aproximada?: boolean;
}): string {
  const { principal, alternativa, origen } = args;
  const cabeza = args.aproximada
    ? `Por su ubicación le corresponde ${principal.nombre} (cálculo aproximado: no diga distancias ni que es la sucursal más cercana).`
    : origen === "cobertura_dueno"
      ? `La sucursal de despacho que le corresponde a esa zona es ${conKm(principal)}.`
      : `La sucursal de despacho más cercana es ${conKm(principal)}.`;
  const alt = alternativa ? ` También le queda cerca ${conKm(alternativa)}: puede mencionarla como alternativa.` : "";
  return `${cabeza}${alt} Dígale al cliente cuál sucursal le atiende y, si hay dato, a cuántos km aproximadamente (sin decimales); no le prometa tiempos distintos a los de la herramienta.`;
}

/** Fuera del radio de reparto: se dice con claridad, se nombra la sucursal de despacho mas cercana y NO se promete envio. */
export function mensajeFueraDeZonaHabitual(args: {
  readonly masCercana: SucursalCercana | null;
  readonly radioKm: number | null;
  readonly aproximada?: boolean;
  /** Km reales (sin redondear) a la mas cercana; define el texto cuando redondea al radio («a poco mas de 8 km»). */
  readonly kmFuera?: number | null;
}): string {
  const { masCercana, radioKm } = args;
  // `aproximada`: la distancia sale de la referencia del piloto original (la colonia no tiene coordenadas propias), no de una medicion: se dice y se ofrece confirmar con el pin.
  const confirmar = args.aproximada
    ? " La distancia es una referencia aproximada (la colonia no tiene ubicación exacta): si el cliente manda su ubicación de WhatsApp, vuelva a llamar esta herramienta con lat y lng para confirmarlo."
    : "";
  const radio = radioKm === null ? "" : ` (nuestro reparto llega hasta ${Math.round(radioKm)} km de una sucursal)`;
  // Entre el radio y el radio + 0.49 km el texto redondeado diria «a unos 8 km» dentro de una frase de «fuera de zona»: se dice «a poco mas de 8 km».
  const kmTexto = (n: number | null): string => (n === null ? "" : radioKm !== null && Math.round(n) <= radioKm ? `a poco más de ${Math.round(radioKm)} km` : kmAproxTexto(n));
  const kmDeLaCercana = masCercana && args.kmFuera !== undefined && args.kmFuera !== null ? args.kmFuera : (masCercana?.kmAprox ?? null);
  const cerca = masCercana ? ` La sucursal de despacho más cercana es ${masCercana.nombre}${kmDeLaCercana === null ? "" : ` (${kmTexto(kmDeLaCercana)})`}.` : "";
  const recoger = masCercana ? `recoger en ${masCercana.nombre}` : "recoger en sucursal";
  return (
    `Ese domicilio queda fuera de nuestra zona habitual de reparto${radio}: no se envía.${cerca} ` +
    `Dígalo con claridad y sin prometer el envío (solo el dueño puede autorizar una excepción); ofrezca ${recoger} o, si el cliente insiste en domicilio, pase con una persona UNA sola vez (escalar_a_humano, motivo zona_no_reconocida). ` +
    `Frase sugerida: «Esa zona queda fuera de nuestra zona habitual de reparto${masCercana ? `; la sucursal más cercana es ${masCercana.nombre}${kmDeLaCercana === null ? "" : `, ${kmTexto(kmDeLaCercana)}`}` : ""}. ¿Prefiere pasar a recoger?»${confirmar}`
  );
}

/** Colonia reconocida pero sin cobertura confirmada ni coordenadas: honesto, sin inventar ubicacion ni cobertura. */
export function mensajeColoniaPorConfirmar(args: { readonly zona: string; readonly sugerida: SucursalCercana | null; readonly segunda: SucursalCercana | null; readonly conUbicacion?: boolean }): string {
  const { zona, sugerida, segunda } = args;
  // Sin km: la referencia del piloto de una colonia pendiente puede estar equivocada (por eso esta pendiente); solo sirve para ofrecer RECOGER.
  const ref = sugerida
    ? ` Referencia no confirmada: ${sugerida.nombre}${segunda ? ` o ${segunda.nombre}` : ""}; úselas solo para ofrecer RECOGER, sin decir distancias ni como promesa de envío.`
    : "";
  if (args.conUbicacion) {
    return (
      `Reconozco la colonia ${zona}, pero no puedo confirmar con certeza el reparto a domicilio a esa zona.${ref} ` +
      `Frase sugerida: «No la tengo ubicada con certeza: ¿me confirma su colonia y dirección?». Si no se aclara, ofrezca recoger${sugerida ? ` en ${sugerida.nombre}` : " en sucursal"} o pase con una persona UNA sola vez (escalar_a_humano, motivo zona_no_reconocida). ` +
      `Nunca diga que esa zona está fuera de nuestra zona de reparto ni que no reconoce la colonia, ni prometa el envío a domicilio.`
    );
  }
  return (
    `Reconozco la colonia ${zona}, pero no la tengo ubicada con certeza para confirmar el reparto a domicilio.${ref} ` +
    `Pídale UNA sola vez su ubicación de WhatsApp (en llamada, un cruce de calles o una plaza conocida) y vuelva a llamar esta herramienta con lat y lng; ` +
    `frase sugerida: «No la tengo ubicada con certeza: ¿me manda su ubicación?». Si no puede, ofrezca recoger${sugerida ? ` en ${sugerida.nombre}` : " en sucursal"} o pase con una persona (escalar_a_humano, motivo zona_no_reconocida). ` +
    `Nunca diga que no reconoce la colonia ni prometa el envío a domicilio.`
  );
}
