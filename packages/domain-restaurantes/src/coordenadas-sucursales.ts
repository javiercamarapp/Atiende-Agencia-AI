// Coordenadas PROPUESTAS de las sucursales de PM (pin de la ficha de negocio de Google Maps, 7-oct-2026; mismo telefono que cada sucursal).
//
// Las coordenadas VIGENTES (`branch_detail.lat/lng`) estan desviadas 1.9 a 4.4 km de esos pines (Pensiones no tiene) y cambiarlas en la base o en el seed
// es decision de Javier (`pendientes_dueno.coordenadas_t3` y `coordenadas_propuestas.estado` del seed). Hasta entonces el servidor sigue midiendo contra las
// vigentes: `assignBranch` solo usa estas si quien lo llama le pasa `coordenadasPropuestas` (la herramienta lo hace SOLO con la bandera
// `RESTAURANTES_USAR_COORDENADAS_PROPUESTAS=1` o `ctx.usarCoordenadasPropuestas`, APAGADA por omision). Nada se escribe en la base.
//
// Fuente: scripts/seed-pm-demo/data/pm-seed-data.json (`sucursales[].coordenadas_propuestas`); `tests/sucursal-mas-cercana-8km.spec.ts` comprueba que
// este archivo y el seed no se separen.
import type { Branch } from "./types.ts";

export interface PuntoGeografico {
  readonly lat: number;
  readonly lng: number;
}

export const COORDENADAS_PROPUESTAS_PM: Readonly<Record<string, PuntoGeografico>> = {
  "prol-montejo": { lat: 21.0093272, lng: -89.6135974 },
  "fco-montejo": { lat: 21.0302178, lng: -89.6470973 },
  pensiones: { lat: 20.995212, lng: -89.6476676 },
  "garcia-lavin": { lat: 21.0325451, lng: -89.6026621 },
  altabrisa: { lat: 21.0265048, lng: -89.5725175 },
};

/** Nombre de la variable de entorno que enciende las coordenadas propuestas (apagada por omision). */
export const BANDERA_COORDENADAS_PROPUESTAS = "RESTAURANTES_USAR_COORDENADAS_PROPUESTAS";

export function coordenadasPropuestasActivas(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[BANDERA_COORDENADAS_PROPUESTAS] === "1";
}

/** Copia las sucursales con la coordenada propuesta de su slug (las que no tienen propuesta conservan la vigente). Sin propuestas devuelve la misma lista. */
export function conCoordenadasPropuestas(branches: readonly Branch[], propuestas: Readonly<Record<string, PuntoGeografico>> | undefined): readonly Branch[] {
  if (!propuestas) return branches;
  return branches.map((b) => {
    const p = propuestas[b.slug];
    return p ? { ...b, lat: p.lat, lng: p.lng } : b;
  });
}
