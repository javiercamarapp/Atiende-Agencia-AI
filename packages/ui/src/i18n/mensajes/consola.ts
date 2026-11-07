import type { ModuloEs } from "../tipos.ts";

/** Lo propio de cada consola (nombre de la vertical, titulo, carga inicial, vacios y selector de sucursal): solo lo usan los
 * shells de apps/web, asi que viaja con su chunk y no con el de arranque (a diferencia de `shell`, que usan los componentes). */
export const consola = {
  "consola.vertical.restaurantes": "Restaurantes",
  "consola.vertical.hoteles": "Hoteles",
  "consola.vertical.rentas": "Rentas",
  "consola.vertical.despachos": "Despachos",
  "consola.vertical.licitaciones": "Licitaciones",
  "consola.vertical.citas": "Citas",
  "consola.titulo": "{vertical} · {nombre}",
  "consola.consolaAtiende": "Consola de Atiende",
  "consola.superadmin": "Superadmin",
  "consola.cargandoSucursales": "Cargando sucursales…",
  "consola.cargandoPropiedades": "Cargando propiedades…",
  "consola.cargandoContribuyentes": "Cargando contribuyentes…",
  "consola.cargandoOrganizacion": "Cargando organización…",
  "consola.vacio.sinSucursal": "Este negocio todavía no tiene ninguna sucursal configurada.",
  "consola.vacio.sinHotel": "Esta organización todavía no tiene ningún hotel (property) configurado.",
  "consola.vacio.sinOrganizacion": "Esta organización todavía no tiene ninguna property configurada.",
  "consola.vacio.sinPropiedad": "Esta organización todavía no tiene ninguna propiedad configurada.",
  "consola.vacio.sinContribuyente": "Este despacho todavía no tiene ningún contribuyente configurado. Pide a un administrador que lo dé de alta.",
  "consola.selector.sucursal": "Sucursal activa",
  "consola.selector.hotel": "Hotel activo",
  "consola.selector.propiedad": "Propiedad",
  "consola.selector.contribuyente": "Contribuyente",
} as const satisfies ModuloEs;
