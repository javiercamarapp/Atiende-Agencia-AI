import type { Traduccion } from "../../tipos.ts";
import type { consola } from "../consola.ts";

export const consolaEn: Traduccion<typeof consola> = {
  "consola.vertical.restaurantes": "Restaurants",
  "consola.vertical.hoteles": "Hotels",
  "consola.vertical.rentas": "Vacation rentals",
  "consola.vertical.despachos": "Accounting firms",
  "consola.vertical.licitaciones": "Tenders",
  "consola.vertical.citas": "Appointments",
  "consola.titulo": "{vertical} · {nombre}",
  "consola.consolaAtiende": "Atiende console",
  "consola.superadmin": "Super admin",
  "consola.cargandoSucursales": "Loading locations…",
  "consola.cargandoPropiedades": "Loading properties…",
  "consola.cargandoContribuyentes": "Loading taxpayers…",
  "consola.cargandoOrganizacion": "Loading organization…",
  "consola.vacio.sinSucursal": "This business doesn't have any locations set up yet.",
  "consola.vacio.sinHotel": "This organization doesn't have any hotels set up yet.",
  "consola.vacio.sinOrganizacion": "This organization isn't set up yet.",
  "consola.vacio.sinPropiedad": "This organization doesn't have any properties set up yet.",
  "consola.vacio.sinContribuyente": "This firm doesn't have any taxpayers set up yet. Ask an admin to add one.",
  "consola.selector.sucursal": "Active location",
  "consola.selector.hotel": "Active hotel",
  "consola.selector.propiedad": "Property",
  "consola.selector.contribuyente": "Taxpayer",
};
