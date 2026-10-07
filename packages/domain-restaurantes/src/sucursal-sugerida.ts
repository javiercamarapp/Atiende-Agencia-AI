// Sucursal sugerida para la portada del storefront (huecos-finales-restaurantes seccion 4): "¿Dónde está?" con una colonia (se empareja contra
// `known_zone`) o con la ubicacion del navegador. Mismo criterio de distancia y de cobertura que el agente (nearest-branch.ts y
// reglas-pedido.ts): nunca se adivina; una colonia desconocida responde asi, y si la sucursal mas cercana no reparte ahi se ofrece recoger.
// Las coordenadas del cliente se usan SOLO para calcular la distancia en memoria: no se guardan ni se devuelven.
import { haversineKm } from "./nearest-branch.ts";
import { matchKnownZone } from "./reglas-pedido.ts";
import { evaluarDomicilioSucursal } from "./domicilio-sucursal.ts";
import { componentesLocales } from "./horarios.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { RestaurantesRepository } from "./repository.ts";

export interface SucursalSugeridaRef {
  readonly slug: string;
  readonly name: string;
}

export type SugerenciaSucursal =
  /** La sucursal mas cercana reparte a esa colonia (o no tiene cobertura configurada: reparte en general). */
  | { readonly tipo: "reparte"; readonly sucursal: SucursalSugeridaRef; readonly zona: string; readonly distanciaKm: number; readonly mensaje: string }
  /** La colonia es conocida pero ninguna sucursal reparte ahi: se sugiere la mas cercana para recoger. */
  | { readonly tipo: "solo_recoger"; readonly sucursal: SucursalSugeridaRef; readonly zona: string; readonly distanciaKm: number; readonly mensaje: string }
  /** Sugerencia por ubicacion: la sucursal activa mas cercana; la cobertura de domicilio se confirma con la colonia al pedir. */
  | { readonly tipo: "cercana"; readonly sucursal: SucursalSugeridaRef; readonly distanciaKm: number; readonly mensaje: string }
  | { readonly tipo: "sin_resultado"; readonly mensaje: string };

export const MENSAJE_COLONIA_NO_RECONOCIDA = "No reconocemos esa colonia. Pruebe con otra referencia cercana o elija una sucursal de la lista.";
export const MENSAJE_SIN_SUCURSAL = "Por ahora no tenemos una sucursal con ubicación publicada para sugerirle. Elija una de la lista.";

interface Candidata {
  readonly slug: string;
  readonly name: string;
  readonly propertyId: string;
  readonly distanciaKm: number;
}

async function sucursalesConUbicacion(repo: RestaurantesRepository, organizationId: string, origen: { lat: number; lng: number }): Promise<Candidata[]> {
  const branches = (await repo.listBranchesForOrganizationAdmin(organizationId)).filter((b) => b.status === "active" && b.lat !== null && b.lng !== null);
  return branches
    .map((b) => ({ slug: b.slug, name: b.name, propertyId: b.propertyId, distanciaKm: haversineKm(origen.lat, origen.lng, b.lat as number, b.lng as number) }))
    .sort((a, b) => a.distanciaKm - b.distanciaKm || a.name.localeCompare(b.name, "es"));
}

/** Sugerencia por colonia: empareja la zona, y entre las sucursales que REPARTEN ahi elige la mas cercana. */
export async function sugerirSucursalPorColonia(repo: RestaurantesRepository, organizationId: string, colonia: string, ahora: Date = new Date()): Promise<SugerenciaSucursal> {
  const texto = colonia.trim();
  if (!texto) return { tipo: "sin_resultado", mensaje: MENSAJE_COLONIA_NO_RECONOCIDA };
  const zona = matchKnownZone(await repo.listKnownZones(organizationId), texto);
  if (!zona) return { tipo: "sin_resultado", mensaje: MENSAJE_COLONIA_NO_RECONOCIDA };
  // Colonia sin coordenadas propias (migracion 056): no hay distancia que calcular y no se inventan coordenadas; se pide otra referencia o elegir de la lista.
  if (zona.lat === null || zona.lng === null) return { tipo: "sin_resultado", mensaje: MENSAJE_COLONIA_NO_RECONOCIDA };
  const candidatas = await sucursalesConUbicacion(repo, organizationId, { lat: zona.lat, lng: zona.lng });
  if (candidatas.length === 0) return { tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL };
  for (const c of candidatas) {
    const policy = await repo.findBranchPolicy(c.propertyId);
    // Misma regla que el checkout (solo recoger y dias de reparto, en la zona horaria de la sucursal): no se promete un reparto que luego se rechaza.
    const zonaHoraria = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(c.propertyId)).zonaHoraria);
    if (!evaluarDomicilioSucursal(policy, componentesLocales(ahora, zonaHoraria).dia).acepta) continue;
    const zonas = await repo.listBranchDeliveryZoneIds(c.propertyId);
    if (zonas.length === 0 || zonas.includes(zona.id)) {
      return { tipo: "reparte", sucursal: { slug: c.slug, name: c.name }, zona: zona.name, distanciaKm: c.distanciaKm, mensaje: `${c.name} le reparte en ${zona.name}.` };
    }
  }
  const mas = candidatas[0]!;
  return {
    tipo: "solo_recoger",
    sucursal: { slug: mas.slug, name: mas.name },
    zona: zona.name,
    distanciaKm: mas.distanciaKm,
    mensaje: `Esa colonia no está en nuestras zonas de reparto; puede recoger en ${mas.name}.`,
  };
}

/** Sugerencia por ubicacion del navegador. Las coordenadas solo se usan para la distancia; nunca se guardan. */
export async function sugerirSucursalPorUbicacion(repo: RestaurantesRepository, organizationId: string, origen: { lat: number; lng: number }): Promise<SugerenciaSucursal> {
  if (!Number.isFinite(origen.lat) || !Number.isFinite(origen.lng) || Math.abs(origen.lat) > 90 || Math.abs(origen.lng) > 180) return { tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL };
  const candidatas = await sucursalesConUbicacion(repo, organizationId, origen);
  const mas = candidatas[0];
  if (!mas) return { tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL };
  return { tipo: "cercana", sucursal: { slug: mas.slug, name: mas.name }, distanciaKm: mas.distanciaKm, mensaje: `La sucursal más cercana es ${mas.name}, a ${mas.distanciaKm} km.` };
}
