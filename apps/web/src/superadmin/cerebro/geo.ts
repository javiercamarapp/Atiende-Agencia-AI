// Geometria del mapa: proyeccion lat/lng -> viewBox (las MISMAS constantes Mercator con las que se horneo mexico-estados-geo.ts,
// portadas de dashboard/mapa/mexico-geo.ts de Likida), distancia esferica y casado de la `entidad` de un prospecto con su estado.
import { ESTADOS_GEO, type EstadoGeo } from "./mexico-estados-geo.ts";

export function proyectar(lat: number, lng: number): { x: number; y: number } {
  const mercY = (la: number) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  return {
    x: ((lng - -118.87531275312753) / 32.6529745297453) * 1000,
    y: ((0.6100416151859904 - mercY(lat)) / 0.3586374316849051) * 629,
  };
}

/** Distancia esferica en km: suficiente para un radio comercial. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function clave(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Alias de la `entidad` tal como se captura a mano (nombre oficial largo, siglas, grafias viejas) -> nombre del estado en el mapa.
const ALIAS: Readonly<Record<string, string>> = {
  cdmx: "Ciudad de México",
  "ciudad de mexico": "Ciudad de México",
  "distrito federal": "Ciudad de México",
  df: "Ciudad de México",
  "estado de mexico": "México",
  edomex: "México",
  "edo de mexico": "México",
  mexico: "México",
  "coahuila de zaragoza": "Coahuila",
  "michoacan de ocampo": "Michoacán",
  "veracruz de ignacio de la llave": "Veracruz",
  "veracruz llave": "Veracruz",
  nl: "Nuevo León",
  qroo: "Quintana Roo",
  "q roo": "Quintana Roo",
  "san luis potosi": "San Luis Potosí",
};

const POR_CLAVE: ReadonlyMap<string, EstadoGeo> = new Map(ESTADOS_GEO.map((e) => [clave(e.nombre), e]));

/** El estado del mapa al que pertenece una entidad capturada a mano; `null` si no se reconoce (se dice, no se inventa estado). */
export function estadoDeEntidad(entidad: string | null): EstadoGeo | null {
  if (!entidad) return null;
  const k = clave(entidad);
  if (k === "") return null;
  const alias = ALIAS[k];
  if (alias) return POR_CLAVE.get(clave(alias)) ?? null;
  return POR_CLAVE.get(k) ?? null;
}
