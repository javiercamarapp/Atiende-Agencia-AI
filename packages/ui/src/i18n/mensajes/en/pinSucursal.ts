import type { Traduccion } from "../../tipos.ts";
import type { pinSucursal } from "../pinSucursal.ts";

export const pinSucursalEn: Traduccion<typeof pinSucursal> = {
  "pinSucursal.buscar.etiqueta": "Search an address or neighborhood",
  "pinSucursal.buscar.placeholder": "Search an address or neighborhood…",
  "pinSucursal.buscar.boton": "Search",
  "pinSucursal.buscar.corto": "Type at least 3 letters.",
  "pinSucursal.buscar.sinResultados": "We couldn't find that place. Try adding more detail (street, neighborhood, city).",
  "pinSucursal.buscar.resultados": "Pick the right place",
  "pinSucursal.buscar.error": "The address search failed. Please try again.",
  "pinSucursal.miUbicacion": "Use my current location",
  "pinSucursal.miUbicacion.error": "We couldn't read your location: check the browser permission.",
  "pinSucursal.miUbicacion.noSoportada": "Your browser doesn't share its location.",
  "pinSucursal.mapa.etiqueta": "Map to place the branch",
  "pinSucursal.mapa.cargando": "Loading the map",
  "pinSucursal.mapa.ayuda": "Drag the pin or tap the map to set the exact location.",
  "pinSucursal.sugerencia.texto": "Address of that point: {direccion}",
  "pinSucursal.sugerencia.usar": "Use this address",
};
