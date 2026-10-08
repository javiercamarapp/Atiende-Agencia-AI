// Asignacion de sucursal por cercania en km (R-02, Los Taquitos de PM; radio de 8 km y sucursal de despacho: decision de Javier, 7-oct-2026).
//
// Regla: la sucursal que atiende un domicilio es la sucursal de DESPACHO (activa y que acepta domicilio) MAS CERCANA EN KM (Haversine real) al punto de entrega,
// y solo si esta a `radio` km o menos (8 km en el perfil `taqueria_pm`, 20 por omision en los demas; configurable por organizacion, ver
// `radioRepartoDelPerfil`). El punto sale de, en este orden: (1) coordenadas explicitas del cliente (ubicacion de WhatsApp), (2) la zona conocida
// (`restaurantes.known_zone`) que empata con la colonia o referencia que dio.
//
// La cobertura de entrega EXPLICITA (`branch_delivery_zone`, migracion 023) es un OVERRIDE DEL DUENO y manda sobre la geometria: si la zona reconocida tiene
// cobertura y alguna de esas sucursales de despacho esta activa, se elige la mas cercana ENTRE ellas (con coordenadas; si dos difieren menos de 0.5 km, la que el
// piloto pone primero) o, si la colonia no tiene coordenadas (las del piloto, migracion 056), la primera que nombra la referencia del piloto y, si ninguna, la
// primera por SLUG (orden estable documentado). Una colonia con doble cobertura nunca es `no_reconocida`. Sin cobertura explicita manda el km.
//
// Colonia reconocida SIN coordenadas y SIN cobertura de despacho: nunca se inventa ubicacion. Si la referencia del piloto nombra una sucursal de despacho a mas
// del radio => `fuera_de_zona` (origen `referencia_piloto`); en cualquier otro caso `sugerida` (reparto `por_confirmar`): «no la tengo ubicada con certeza,
// mandeme su ubicacion». Un punto mas alla del radio es `fuera_de_zona`, nunca una sucursal lejana asignada en silencio, y el resultado SIEMPRE nombra la
// sucursal de despacho mas cercana con su distancia aproximada.
//
// Coordenadas de las sucursales: las vigentes en la base. `coordenadasPropuestas` (pines de Google, `coordenadas-sucursales.ts`) es opt-in y esta APAGADA por
// omision: activarla es decision de Javier.
//
// Es dominio puro sobre el repositorio existente: sin SQL nuevo. Contra una base sin migrar, `listBranchDeliveryZoneIds` ya degrada a [] con SAVEPOINT.
import { conCoordenadasPropuestas, type PuntoGeografico } from "./coordenadas-sucursales.ts";
import { UMBRAL_AMBIGUA_KM } from "./colonias-ambiguas.ts";
import { OrderValidationError } from "./errors.ts";
import {
  haversineKmExact,
  mensajeColoniaPorConfirmar,
  mensajeFueraDeZonaHabitual,
  mensajeSucursalAsignada,
  normalizeZoneText,
  COLONIA_NO_RECONOCIDA_MENSAJE,
  type SucursalCercana,
} from "./nearest-branch.ts";
import { matchKnownZone } from "./reglas-pedido.ts";
import type { RestaurantesRepository } from "./repository.ts";
import { opcionesDeReferencia, referenciaDeColonia, sucursalesDeDespacho } from "./sugerencia-despacho.ts";
import type { Branch, KnownZone, PerfilAgenteWhatsApp } from "./types.ts";

/** Radio de reparto del perfil `taqueria_pm`: 8 km en linea recta desde la sucursal de despacho mas cercana (decision de Javier, 7-oct-2026; antes 20 km). Lo decide el
 * SERVIDOR (QA-PM-R2-whatsapp-08): el modelo solo puede bajarlo (`max_km`), nunca subirlo. */
export const RADIO_REPARTO_PM_KM = 8;

/** Doble cobertura con coordenadas: si la mas cercana y la siguiente difieren menos de esto (km), manda la que el piloto original pone primero (decision de Javier, 7-oct-2026). */
export const EMPATE_DOBLE_COBERTURA_KM = 0.5;

/** Radio que usa `assignBranch` cuando quien lo llama no fija ninguno (`radioMaximoKm` ausente): 20 km. Los perfiles que no son PM NO heredan un tope (ver `radioRepartoDelPerfil`). */
export const RADIO_REPARTO_POR_OMISION_KM = 20;

/**
 * Radio de reparto de una organizacion: el configurado por ella (`WhatsAppAgentConfigRow.radioRepartoKm`, entre 0 y 500 km); si no hay, 8 km en `taqueria_pm`.
 * Los demas perfiles (y una base sin la configuracion del agente) NO tienen tope duro por omision (`null`, como antes): una organizacion que lo quiera lo
 * configura de forma explicita, asi este cambio no recorta el alcance de quien nunca lo tuvo.
 */
export function radioRepartoDelPerfil(perfil: PerfilAgenteWhatsApp, configuradoKm?: number | null): number | null {
  if (typeof configuradoKm === "number" && Number.isFinite(configuradoKm) && configuradoKm > 0 && configuradoKm <= 500) return configuradoKm;
  return perfil === "taqueria_pm" ? RADIO_REPARTO_PM_KM : null;
}

export const FUERA_DE_ZONA_MENSAJE = "Ese domicilio queda fuera de la zona de reparto: no se envía. Ofrezca recoger en sucursal.";

export interface AssignBranchInput {
  readonly organizationId: string;
  readonly lat?: number;
  readonly lng?: number;
  /** Colonia/referencia tal como la dijo el cliente (se empareja con `known_zone`). */
  readonly colonia?: string;
  /** Radio maximo de reparto en km que pide el modelo; solo puede ser MENOR que el tope de la organizacion (`radioMaximoKm`): el servidor lo recorta. */
  readonly maxKm?: number;
  /** Tope DURO de la organizacion, fijado por el servidor (no por el modelo; ver `radioRepartoDelPerfil`): ausente = `RADIO_REPARTO_POR_OMISION_KM`; `null` = la organizacion no tiene tope duro. */
  readonly radioMaximoKm?: number | null;
  /** Coordenadas propuestas por slug de sucursal (`COORDENADAS_PROPUESTAS_PM`). Ausente (por omision) = se mide contra las coordenadas vigentes de la base. */
  readonly coordenadasPropuestas?: Readonly<Record<string, PuntoGeografico>>;
}

export type BranchAssignmentVia = "coordenadas" | "zona";

/** De donde sale la sucursal: `pin` = ubicacion del cliente, `distancia` = coordenadas de la colonia, `cobertura_dueno` = cobertura explicita (override del dueno). */
export type BranchAssignmentOrigen = "pin" | "distancia" | "cobertura_dueno";

export type BranchAssignment =
  | {
      readonly estado: "asignada";
      readonly branchSlug: string;
      readonly branchName: string;
      /** `null` = colonia reconocida sin coordenadas: la sucursal sale de la cobertura cargada y no hay distancia calculada que reportar. */
      readonly distanceKm: number | null;
      readonly via: BranchAssignmentVia;
      readonly recognizedZoneName: string | null;
      /** true cuando la cobertura de la zona cambio la sucursal respecto a la mas cercana en km puros. */
      readonly ajustePorZona: boolean;
      readonly origen: BranchAssignmentOrigen;
      /** Sin `distanceKm`: km que dijo el piloto original de esa sucursal (aproximado, nunca calculado); `null` si no hay. */
      readonly kmReferencia: number | null;
      /** Otra sucursal de despacho a menos de 1 km de la elegida (se menciona como alternativa). */
      readonly alternativa: SucursalCercana | null;
      /** La colonia la cubren dos o mas sucursales de despacho (se eligio la mas cercana o, sin coordenadas, la primera del piloto / por slug). */
      readonly dobleCobertura: boolean;
      readonly message: string;
    }
  | {
      readonly estado: "fuera_de_zona";
      /** Sucursal de despacho MAS CERCANA (la que el agente nombra); no se le asigna el domicilio. */
      readonly branchSlug: string;
      readonly branchName: string;
      /** Km a esa sucursal: en linea recta, o aproximados si `origen` es `referencia_piloto`. */
      readonly distanceKm: number;
      readonly maxKm: number;
      readonly origen: "pin" | "distancia" | "referencia_piloto";
      readonly recognizedZoneName: string | null;
      readonly message: string;
    }
  | {
      /** Colonia reconocida pero sin cobertura de despacho ni coordenadas: «no la tengo ubicada con certeza». Nunca promete envio. */
      readonly estado: "sugerida";
      readonly reparto: "por_confirmar";
      readonly sugerida: SucursalCercana | null;
      readonly segunda: SucursalCercana | null;
      /** Las dos referencias difieren menos de 1 km. */
      readonly ambigua: boolean;
      readonly recognizedZoneName: string;
      readonly message: string;
    }
  | { readonly estado: "no_reconocida"; readonly message: string };

export interface RankedBranch {
  readonly branch: Branch;
  /** Distancia sin redondear (para ordenar). */
  readonly km: number;
}

function esCoordenadaValida(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

function redondear1(km: number): number {
  return Math.round(km * 10) / 10;
}

/** Ordena sucursales por km al punto. Empates EXACTOS (misma distancia sin redondear) se rompen por
 * slug para que el resultado sea determinista. Ignora sucursales sin coordenadas. */
export function rankBranchesByKm(lat: number, lng: number, branches: readonly Branch[]): readonly RankedBranch[] {
  const ranked: RankedBranch[] = [];
  for (const branch of branches) {
    if (branch.lat === null || branch.lng === null) continue;
    if (!esCoordenadaValida(branch.lat, branch.lng)) continue;
    ranked.push({ branch, km: haversineKmExact(lat, lng, branch.lat, branch.lng) });
  }
  return ranked.sort((a, b) => a.km - b.km || a.branch.slug.localeCompare(b.branch.slug));
}

const aCercana = (branch: Branch, km: number | null): SucursalCercana => ({ slug: branch.slug, nombre: branch.name, kmAprox: km === null ? null : redondear1(km) });

export async function assignBranch(repo: RestaurantesRepository, input: AssignBranchInput): Promise<BranchAssignment> {
  const hasLat = input.lat !== undefined;
  const hasLng = input.lng !== undefined;
  if (hasLat !== hasLng) throw new OrderValidationError("lat y lng deben venir juntas.");
  if (hasLat && !esCoordenadaValida(input.lat, input.lng)) throw new OrderValidationError("Coordenadas inválidas: lat entre -90 y 90, lng entre -180 y 180.");
  if (input.maxKm !== undefined && (typeof input.maxKm !== "number" || !Number.isFinite(input.maxKm) || input.maxKm <= 0 || input.maxKm > 500)) {
    throw new OrderValidationError("maxKm debe ser un número entre 0 y 500.");
  }
  const colonia = typeof input.colonia === "string" ? input.colonia.trim() : "";

  let zone: KnownZone | null = null;
  if (colonia && normalizeZoneText(colonia)) {
    zone = matchKnownZone(await repo.listKnownZones(input.organizationId), colonia);
  }

  let point: { lat: number; lng: number } | null = null;
  let via: BranchAssignmentVia = "coordenadas";
  if (hasLat) {
    point = { lat: input.lat as number, lng: input.lng as number };
  } else if (zone && zone.lat !== null && zone.lng !== null) {
    point = { lat: zone.lat, lng: zone.lng };
    via = "zona";
  }
  // Solo las sucursales de DESPACHO (activas y que aceptan domicilio) pueden quedarse un domicilio; las coordenadas propuestas son opt-in.
  const despacho = await sucursalesDeDespacho(repo, input.organizationId);
  const medibles = conCoordenadasPropuestas(despacho, input.coordenadasPropuestas);

  const radioOrg = input.radioMaximoKm === undefined ? RADIO_REPARTO_POR_OMISION_KM : input.radioMaximoKm;
  const tope = radioOrg === null ? (input.maxKm ?? Number.POSITIVE_INFINITY) : Math.min(input.maxKm ?? radioOrg, radioOrg);
  const radioTexto = Number.isFinite(tope) ? tope : null;

  // Cobertura EXPLICITA del dueno: sucursales de despacho que cubren la zona reconocida.
  const cubren = new Set<string>();
  if (zone) {
    for (const candidate of despacho) {
      if ((await repo.listBranchDeliveryZoneIds(candidate.propertyId)).includes(zone.id)) cubren.add(candidate.propertyId);
    }
  }

  // Cobertura EXPLICITA sin medir km (colonia sin coordenadas, o cuya sucursal de cobertura no tiene coordenadas): primero la que nombra la referencia del piloto
  // (la 1.a, luego la 2.a) y despues por slug (orden estable y documentado; nunca por orden de listado).
  const referencia = zone && (!point || cubren.size > 0) ? opcionesDeReferencia(await referenciaDeColonia(repo, input.organizationId, zone.id), despacho) : [];
  const porCobertura = (laZona: KnownZone): BranchAssignment => {
    const kmDe = (slug: string): number | null => referencia.find((r) => r.slug === slug)?.kmAprox ?? null;
    const ordenRef = (slug: string): number => {
      const i = referencia.findIndex((r) => r.slug === slug);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ordenadas = despacho.filter((b) => cubren.has(b.propertyId)).sort((a, b) => ordenRef(a.slug) - ordenRef(b.slug) || a.slug.localeCompare(b.slug));
    const elegida = ordenadas[0] as Branch;
    const otra = ordenadas[1];
    const kmElegida = kmDe(elegida.slug);
    const kmOtra = otra ? kmDe(otra.slug) : null;
    const alternativa = otra && kmElegida !== null && kmOtra !== null && Math.abs(kmOtra - kmElegida) < UMBRAL_AMBIGUA_KM ? aCercana(otra, kmOtra) : null;
    return {
      estado: "asignada",
      branchSlug: elegida.slug,
      branchName: elegida.name,
      distanceKm: null,
      via: "zona",
      recognizedZoneName: laZona.name,
      ajustePorZona: false,
      origen: "cobertura_dueno",
      kmReferencia: kmElegida,
      alternativa,
      dobleCobertura: ordenadas.length > 1,
      message: mensajeSucursalAsignada({ principal: aCercana(elegida, kmElegida), alternativa, origen: "cobertura_dueno" }),
    };
  };

  // Colonia reconocida SIN coordenadas propias (migracion 056, colonias del piloto original): no hay punto para medir km.
  if (!point && zone) {
    if (cubren.size > 0) return porCobertura(zone);
    const sugerida = referencia[0] ?? null;
    const segunda = referencia[1] ?? null;
    // La referencia del piloto dice que la sucursal de despacho mas cercana esta mas alla del radio: se dice con claridad, sin prometer envio.
    if (sugerida && sugerida.kmAprox !== null && sugerida.kmAprox > tope) {
      return {
        estado: "fuera_de_zona",
        branchSlug: sugerida.slug,
        branchName: sugerida.nombre,
        distanceKm: sugerida.kmAprox,
        maxKm: tope,
        origen: "referencia_piloto",
        recognizedZoneName: zone.name,
        message: mensajeFueraDeZonaHabitual({ masCercana: sugerida, radioKm: radioTexto, aproximada: true }),
      };
    }
    const ambigua = sugerida !== null && segunda !== null && sugerida.kmAprox !== null && segunda.kmAprox !== null && segunda.kmAprox - sugerida.kmAprox < UMBRAL_AMBIGUA_KM;
    return {
      estado: "sugerida",
      reparto: "por_confirmar",
      sugerida,
      segunda,
      ambigua,
      recognizedZoneName: zone.name,
      message: mensajeColoniaPorConfirmar({ zona: zone.name, sugerida, segunda }),
    };
  }

  if (!point) return { estado: "no_reconocida", message: COLONIA_NO_RECONOCIDA_MENSAJE };
  const ranked = rankBranchesByKm(point.lat, point.lng, medibles);
  const nearest = ranked[0];
  if (!nearest) return { estado: "no_reconocida", message: COLONIA_NO_RECONOCIDA_MENSAJE };

  let chosen = nearest;
  const cubrenRanked = ranked.filter((r) => cubren.has(r.branch.propertyId));
  // Cobertura del dueno cuya sucursal no tiene coordenadas (Pensiones hoy): sin pin no se puede medir contra ella, pero su decision manda.
  if (zone && via === "zona" && cubren.size > 0 && cubrenRanked.length === 0) return porCobertura(zone);
  const override = cubrenRanked.length > 0;
  if (override) {
    chosen = cubrenRanked[0] as RankedBranch;
    // Doble cobertura casi empatada (< 0.5 km): gana la que el piloto original pone primero; si ninguna esta en la referencia, la mas cercana.
    const segundo = cubrenRanked[1];
    if (zone && segundo && segundo.km - chosen.km < EMPATE_DOBLE_COBERTURA_KM) {
      const ref = opcionesDeReferencia(await referenciaDeColonia(repo, input.organizationId, zone.id), despacho);
      const empatadas = cubrenRanked.filter((r) => r.km - chosen.km < EMPATE_DOBLE_COBERTURA_KM);
      const orden = (r: RankedBranch): number => {
        const i = ref.findIndex((o) => o.slug === r.branch.slug);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      const primera = [...empatadas].sort((a, b) => orden(a) - orden(b) || a.km - b.km)[0] as RankedBranch;
      if (orden(primera) !== Number.MAX_SAFE_INTEGER) chosen = primera;
    }
  }
  // Con pin, la ubicacion real manda: si la sucursal que cubre la colonia queda fuera del radio pero otra esta dentro, el cliente no esta en esa colonia.
  if (override && via === "coordenadas" && chosen.km > tope && nearest.km <= tope) {
    chosen = nearest;
  }
  const ajustePorZona = chosen.branch.propertyId !== nearest.branch.propertyId;
  const usaOverride = override && chosen.branch.propertyId === (cubrenRanked[0] as RankedBranch).branch.propertyId;

  // El radio aplica a la distancia medida; la cobertura explicita del dueno por colonia (sin pin) es SU decision y no se recorta por km.
  const aplicaRadio = via === "coordenadas" || !usaOverride;
  if (aplicaRadio && chosen.km > tope) {
    const masCercana = aCercana(nearest.branch, nearest.km);
    return {
      estado: "fuera_de_zona",
      branchSlug: nearest.branch.slug,
      branchName: nearest.branch.name,
      distanceKm: redondear1(nearest.km),
      maxKm: tope,
      origen: via === "coordenadas" ? "pin" : "distancia",
      recognizedZoneName: zone ? zone.name : null,
      message: mensajeFueraDeZonaHabitual({ masCercana, radioKm: radioTexto }),
    };
  }

  const pool = usaOverride ? cubrenRanked : ranked;
  const otra = pool.find((r) => r.branch.propertyId !== chosen.branch.propertyId);
  const alternativa = otra && Math.abs(otra.km - chosen.km) < UMBRAL_AMBIGUA_KM ? aCercana(otra.branch, otra.km) : null;
  const origen: BranchAssignmentOrigen = usaOverride ? "cobertura_dueno" : via === "coordenadas" ? "pin" : "distancia";
  return {
    estado: "asignada",
    branchSlug: chosen.branch.slug,
    branchName: chosen.branch.name,
    distanceKm: redondear1(chosen.km),
    via,
    recognizedZoneName: zone ? zone.name : null,
    ajustePorZona,
    origen,
    kmReferencia: null,
    alternativa,
    dobleCobertura: cubrenRanked.length > 1,
    message: mensajeSucursalAsignada({ principal: aCercana(chosen.branch, chosen.km), alternativa, origen }),
  };
}
