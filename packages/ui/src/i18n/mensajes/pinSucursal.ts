import type { ModuloEs } from "../tipos.ts";

/** Pin de sucursal en el mapa con busqueda de direcciones (restaurantes, Sucursales). La traduccion vive en `en/pinSucursal.ts`. */
export const pinSucursal = {
  "pinSucursal.buscar.etiqueta": "Buscar dirección o colonia",
  "pinSucursal.buscar.placeholder": "Buscar dirección o colonia…",
  "pinSucursal.buscar.boton": "Buscar",
  "pinSucursal.buscar.corto": "Escribe al menos 3 letras.",
  "pinSucursal.buscar.sinResultados": "No encontramos esa ubicación. Prueba con más detalle (calle, colonia, ciudad).",
  "pinSucursal.buscar.resultados": "Elige el lugar correcto",
  "pinSucursal.buscar.error": "No se pudo buscar la dirección. Intenta de nuevo.",
  "pinSucursal.miUbicacion": "Usar mi ubicación actual",
  "pinSucursal.miUbicacion.error": "No pudimos leer tu ubicación: revisa el permiso del navegador.",
  "pinSucursal.miUbicacion.noSoportada": "Tu navegador no comparte la ubicación.",
  "pinSucursal.mapa.etiqueta": "Mapa para ubicar la sucursal",
  "pinSucursal.mapa.cargando": "Cargando el mapa",
  "pinSucursal.mapa.ayuda": "Arrastra el pin o toca el mapa para ajustar la ubicación exacta.",
  "pinSucursal.sugerencia.texto": "Dirección de ese punto: {direccion}",
  "pinSucursal.sugerencia.usar": "Usar esta dirección",
} as const satisfies ModuloEs;
