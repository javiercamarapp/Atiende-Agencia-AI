// Paquete B: cobertura geografica. Punto en poligono (ray casting) sobre las geocercas de reparto de cada sucursal. Funciones puras.
// Convencion: los vertices vienen como [lng, lat] (orden KML) y los puntos se pasan como (lat, lng).

export interface Geocerca {
  /** Slug de la sucursal que reparte dentro del poligono. */
  readonly slug: string;
  readonly poligono: readonly (readonly [number, number])[];
}

export const GEOCERCA_SIN_ZONA_MENSAJE =
  "La ubicación del cliente no cae en ninguna zona de reparto conocida. Dígalo con honestidad y sin prometer el envío; ofrezca recoger en sucursal y pase con una persona UNA sola vez " +
  "(escalar_a_humano, motivo zona_no_reconocida) para que confirme. No adivine la sucursal ni invente un teléfono.";

/** `true` si (lat, lng) esta dentro del poligono. Entradas no finitas o poligono con menos de 3 vertices distintos: `false`. */
export function puntoEnPoligono(lat: number, lng: number, poligono: readonly (readonly [number, number])[]): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || poligono.length < 4) return false;
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i, i += 1) {
    const [xi, yi] = poligono[i] as readonly [number, number];
    const [xj, yj] = poligono[j] as readonly [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Slugs (orden estable por slug) de las geocercas que contienen el punto. */
export function geocercasQueContienen(lat: number, lng: number, geocercas: readonly Geocerca[]): readonly string[] {
  return geocercas
    .filter((g) => puntoEnPoligono(lat, lng, g.poligono))
    .map((g) => g.slug)
    .sort((a, b) => a.localeCompare(b));
}
