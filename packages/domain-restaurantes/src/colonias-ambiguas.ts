// X42 / T-ZS09 -- reporte de colonias ambiguas.
//
// El piloto original generaba, en cada sincronizacion, un documento con cada colonia -> sucursal mas cercana, km, segunda opcion y una
// ADVERTENCIA cuando la diferencia entre las dos primeras era menor a 1 km (`agent-config`, commit 5710a5f: unas coordenadas viejas mandaron
// Altabrisa a Prolongacion Montejo en una llamada real). Aqui es una lectura de solo lectura sobre lo que hay cargado:
//   * la referencia del piloto (`known_zone.ref_*`, migracion 056) para las colonias sin coordenadas, o
//   * la distancia REAL (Haversine) para una colonia con coordenadas, cuando hay dos o mas sucursales con coordenadas;
// mas la cobertura de entrega vigente (`branch_delivery_zone`): la sucursal ASIGNADA es la que la cubre, no la mas cercana.
//
// Sin datos personales: solo nombres de colonia y de sucursal y km. Nada se escribe: el reporte nunca cambia una asignacion.
import { haversineKm } from "./nearest-branch.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, ColoniaReferencia } from "./types.ts";

/** Diferencia (km) entre las dos sucursales mas cercanas por debajo de la cual la colonia es ambigua (regla del original). */
export const UMBRAL_AMBIGUA_KM = 1;

export type MotivoRevisionColonia =
  | "ambigua"
  | "sin_asignar"
  | "contradice_distancia"
  | "reasignada_desde_galerias"
  | "distancia_de_otra_direccion_de_pensiones";

export interface FilaColoniaAmbigua {
  readonly zoneId: string;
  readonly colonia: string;
  /** Sucursal que la cubre hoy (`null` = ninguna). Si la cubren varias, la primera por nombre y `variasSucursales` en true. */
  readonly sucursalAsignada: { readonly slug: string; readonly nombre: string } | null;
  readonly variasSucursales: boolean;
  readonly kmAsignada: number | null;
  readonly segundaSucursal: { readonly slug: string; readonly nombre: string } | null;
  readonly segundaKm: number | null;
  /** Diferencia entre las dos primeras (km); `null` si no hay segunda. */
  readonly diferenciaKm: number | null;
  /** De donde salen los km: el piloto original o el calculo con las coordenadas cargadas. */
  readonly origenKm: "piloto_original" | "calculada" | null;
  readonly procedencia: string | null;
  readonly revisar: boolean;
  readonly motivos: readonly MotivoRevisionColonia[];
}

export interface ReporteColoniasAmbiguas {
  /** `false` = la base todavia no tiene la migracion 056: no hay referencia del piloto que reportar. */
  readonly disponible: boolean;
  readonly total: number;
  readonly paraRevisar: number;
  readonly sinAsignar: number;
  readonly ambiguas: number;
  readonly filas: readonly FilaColoniaAmbigua[];
}

type Ref = { readonly sucursal: string; readonly km: number | null; readonly segunda: string | null; readonly segundaKm: number | null; readonly origen: "piloto_original" | "calculada" };

/** Con coordenadas propias y dos o mas sucursales con coordenadas: distancias reales (mismo calculo que `nearest_branch_by_colonia`). */
function referenciaCalculada(z: ColoniaReferencia, branches: readonly Branch[]): Ref | null {
  if (z.lat === null || z.lng === null) return null;
  const ranked = branches
    .filter((b) => b.lat !== null && b.lng !== null)
    .map((b) => ({ slug: b.slug, km: haversineKm(z.lat as number, z.lng as number, b.lat as number, b.lng as number) }))
    .sort((a, b) => a.km - b.km || a.slug.localeCompare(b.slug));
  if (ranked.length < 2) return null;
  return { sucursal: ranked[0]!.slug, km: ranked[0]!.km, segunda: ranked[1]!.slug, segundaKm: ranked[1]!.km, origen: "calculada" };
}

function referenciaDelPiloto(z: ColoniaReferencia): Ref | null {
  if (!z.refSucursalSlug) return null;
  return { sucursal: z.refSucursalSlug, km: z.refKm, segunda: z.ref2SucursalSlug, segundaKm: z.ref2Km, origen: "piloto_original" };
}

/**
 * Reporte de colonias para revisar. Una colonia se marca "revisar" si: sus dos sucursales mas cercanas difieren menos de 1 km, ninguna sucursal la
 * cubre, la sucursal asignada no es la mas cercana segun la referencia (p. ej. la asignacion de los chats contradice la distancia), se reasigno
 * porque la mas cercana no reparte, o la distancia del piloto involucra a Pensiones (calculada desde otra direccion). Solo lectura.
 */
export async function reporteColoniasAmbiguas(repo: RestaurantesRepository, organizationId: string): Promise<ReporteColoniasAmbiguas> {
  const lectura = await repo.listColoniasReferencia(organizationId);
  if (!lectura.disponible) return { disponible: false, total: 0, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [] };

  const branches = await repo.listBranchesForOrganizationAdmin(organizationId);
  const porSlug = new Map(branches.map((b) => [b.slug, b] as const));
  const nombre = (slug: string | null): { slug: string; nombre: string } | null => (slug ? { slug, nombre: porSlug.get(slug)?.name ?? slug } : null);

  // Cobertura vigente: zona -> sucursales que la cubren.
  const cubre = new Map<string, Branch[]>();
  for (const b of branches) {
    for (const zoneId of await repo.listBranchDeliveryZoneIds(b.propertyId)) cubre.set(zoneId, [...(cubre.get(zoneId) ?? []), b]);
  }

  const filas: FilaColoniaAmbigua[] = [];
  for (const z of lectura.zonas) {
    // Solo colonias del piloto o con coordenadas calculables: un punto que el dueño dio de alta sin referencia no es "ambiguo" ni "revisable".
    const ref = referenciaCalculada(z, branches) ?? referenciaDelPiloto(z);
    const cubrientes = (cubre.get(z.zoneId) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, "es"));
    if (!ref && z.fuente === null) continue;
    const asignada = cubrientes[0] ?? null;

    const motivos: MotivoRevisionColonia[] = [];
    const diferencia = ref && ref.km !== null && ref.segundaKm !== null ? Math.round((ref.segundaKm - ref.km) * 10) / 10 : null;
    if (diferencia !== null && diferencia < UMBRAL_AMBIGUA_KM) motivos.push("ambigua");
    if (!asignada) motivos.push("sin_asignar");
    if (asignada && ref) {
      if (z.asignacionFuente === "reasignada_desde_galerias") motivos.push("reasignada_desde_galerias");
      else if (asignada.slug !== ref.sucursal && z.fuente !== null) motivos.push("contradice_distancia");
    }
    if (ref && ref.origen === "piloto_original" && (ref.sucursal === "pensiones" || ref.segunda === "pensiones")) motivos.push("distancia_de_otra_direccion_de_pensiones");

    filas.push({
      zoneId: z.zoneId,
      colonia: z.name,
      sucursalAsignada: asignada ? { slug: asignada.slug, nombre: asignada.name } : null,
      variasSucursales: cubrientes.length > 1,
      kmAsignada: asignada && ref ? (asignada.slug === ref.sucursal ? ref.km : asignada.slug === ref.segunda ? ref.segundaKm : null) : null,
      segundaSucursal: ref ? nombre(ref.segunda) : null,
      segundaKm: ref ? ref.segundaKm : null,
      diferenciaKm: diferencia,
      origenKm: ref ? ref.origen : null,
      procedencia: z.asignacionFuente ?? z.fuente,
      revisar: motivos.length > 0,
      motivos,
    });
  }

  // Primero lo que hay que revisar (ambiguas y sin asignar arriba), luego por nombre.
  const peso = (f: FilaColoniaAmbigua) => (f.motivos.includes("ambigua") || f.motivos.includes("sin_asignar") ? 0 : f.revisar ? 1 : 2);
  filas.sort((a, b) => peso(a) - peso(b) || a.colonia.localeCompare(b.colonia, "es"));
  return {
    disponible: true,
    total: filas.length,
    paraRevisar: filas.filter((f) => f.revisar).length,
    sinAsignar: filas.filter((f) => f.motivos.includes("sin_asignar")).length,
    ambiguas: filas.filter((f) => f.motivos.includes("ambigua")).length,
    filas,
  };
}
