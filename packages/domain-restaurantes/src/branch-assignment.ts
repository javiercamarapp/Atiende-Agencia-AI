// Asignacion de sucursal por cercania en km (R-02, Los Taquitos de PM).
//
// Regla: la sucursal que atiende un domicilio es la MAS CERCANA EN KM (Haversine real) al punto
// de entrega. El punto sale de, en este orden: (1) coordenadas explicitas del cliente (ubicacion
// de WhatsApp), (2) la zona conocida (`restaurantes.known_zone`) que empata con la colonia o
// referencia que dio. Las zonas conocidas son ademas un AJUSTE: si la zona reconocida tiene
// cobertura de entrega explicita (`branch_delivery_zone`, migracion 023) y alguna de esas
// sucursales esta activa y con coordenadas, se elige la mas cercana ENTRE ellas -- asi la practica
// actual del cliente ("zonas fijas por sucursal") gana sobre la geometria pura sin dejar de usar km
// para desempatar. Zona sin cobertura configurada = km puros.
//
// Contrato de silencio: sin punto utilizable NUNCA se adivina sucursal (`no_reconocida`); un punto
// mas alla de `maxKm` es `fuera_de_zona` (el cliente no envia fuera de zona), nunca una sucursal
// lejana asignada en silencio.
//
// Es dominio puro sobre el repositorio existente: sin SQL nuevo. Contra una base sin migrar,
// `listBranchDeliveryZoneIds` ya degrada a [] con SAVEPOINT (sin cobertura = km puros).
import { OrderValidationError } from "./errors.ts";
import { COLONIA_NO_RECONOCIDA_MENSAJE, haversineKmExact, normalizeZoneText } from "./nearest-branch.ts";
import { matchKnownZone } from "./reglas-pedido.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, KnownZone } from "./types.ts";

export const FUERA_DE_ZONA_MENSAJE = "Ese domicilio queda fuera de la zona de reparto: no se envía. Ofrezca recoger en sucursal.";

export interface AssignBranchInput {
  readonly organizationId: string;
  readonly lat?: number;
  readonly lng?: number;
  /** Colonia/referencia tal como la dijo el cliente (se empareja con `known_zone`). */
  readonly colonia?: string;
  /** Radio maximo de reparto en km; sin valor = sin tope. */
  readonly maxKm?: number;
}

export type BranchAssignmentVia = "coordenadas" | "zona";

export type BranchAssignment =
  | {
      readonly estado: "asignada";
      readonly branchSlug: string;
      readonly branchName: string;
      /** `null` = colonia reconocida sin coordenadas: la sucursal sale de la cobertura cargada y no hay distancia que reportar. */
      readonly distanceKm: number | null;
      readonly via: BranchAssignmentVia;
      readonly recognizedZoneName: string | null;
      /** true cuando la cobertura de la zona cambio la sucursal respecto a la mas cercana en km puros. */
      readonly ajustePorZona: boolean;
    }
  | {
      readonly estado: "fuera_de_zona";
      readonly branchSlug: string;
      readonly branchName: string;
      readonly distanceKm: number;
      readonly maxKm: number;
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
  const active = (await repo.listBranchesForOrganizationAdmin(input.organizationId)).filter((b) => b.status === "active");

  // Colonia reconocida SIN coordenadas propias (migracion 056, colonias del piloto original): no hay punto para medir km. La sucursal
  // sale SOLO de la cobertura de entrega cargada (`branch_delivery_zone`); si ninguna sucursal activa la cubre (colonia ambigua o
  // sin asignar) NO se adivina: `no_reconocida` y el agente pide otra referencia o escala. La distancia queda `null` (no se inventa).
  if (!point && zone) {
    const cubren: Branch[] = [];
    for (const candidate of active) {
      if ((await repo.listBranchDeliveryZoneIds(candidate.propertyId)).includes(zone.id)) cubren.push(candidate);
    }
    // Mas de una sucursal que la cubre: no se elige por orden de listado; el cliente debe dar otra referencia o pin.
    const unica = cubren.length === 1 ? cubren[0] : undefined;
    if (!unica) return { estado: "no_reconocida", message: COLONIA_NO_RECONOCIDA_MENSAJE };
    return { estado: "asignada", branchSlug: unica.slug, branchName: unica.name, distanceKm: null, via: "zona", recognizedZoneName: zone.name, ajustePorZona: false };
  }

  if (!point) return { estado: "no_reconocida", message: COLONIA_NO_RECONOCIDA_MENSAJE };
  const ranked = rankBranchesByKm(point.lat, point.lng, active);
  const nearest = ranked[0];
  if (!nearest) return { estado: "no_reconocida", message: COLONIA_NO_RECONOCIDA_MENSAJE };

  let chosen = nearest;
  let ajustePorZona = false;
  if (zone) {
    const covering = new Set<string>();
    for (const candidate of ranked) {
      const zoneIds = await repo.listBranchDeliveryZoneIds(candidate.branch.propertyId);
      if (zoneIds.includes(zone.id)) covering.add(candidate.branch.propertyId);
    }
    const adjusted = ranked.find((r) => covering.has(r.branch.propertyId));
    if (adjusted) {
      chosen = adjusted;
      ajustePorZona = adjusted.branch.propertyId !== nearest.branch.propertyId;
    }
  }

  const distanceKm = redondear1(chosen.km);
  if (input.maxKm !== undefined && chosen.km > input.maxKm) {
    return { estado: "fuera_de_zona", branchSlug: chosen.branch.slug, branchName: chosen.branch.name, distanceKm, maxKm: input.maxKm, message: FUERA_DE_ZONA_MENSAJE };
  }
  return {
    estado: "asignada",
    branchSlug: chosen.branch.slug,
    branchName: chosen.branch.name,
    distanceKm,
    via,
    recognizedZoneName: zone ? zone.name : null,
    ajustePorZona,
  };
}
