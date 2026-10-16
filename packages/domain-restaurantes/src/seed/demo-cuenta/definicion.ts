import { AGENTE, MARCA, ORGANIZACION, POLITICAS } from "./marca.ts";
import { CONOCIMIENTO } from "./conocimiento.ts";
import { CATEGORIAS } from "./menu-util.ts";
import { PRODUCTOS } from "./menu.ts";
import { MODIFICADORES } from "./modificadores.ts";
import { PROMOCIONES } from "./promociones.ts";
import { COLONIAS, SUCURSALES } from "./sucursales.ts";
import type { DemoCuentaDef } from "./tipos.ts";

/** Definicion completa y versionada de la cuenta demo ficticia. Es dato puro: no abre ninguna conexion. */
export const DEMO_CUENTA: DemoCuentaDef = {
  organizacion: ORGANIZACION,
  marca: MARCA,
  sucursales: SUCURSALES,
  colonias: COLONIAS,
  categorias: CATEGORIAS,
  productos: PRODUCTOS,
  modificadores: MODIFICADORES,
  promociones: PROMOCIONES,
  politicas: POLITICAS,
  conocimiento: CONOCIMIENTO,
  agente: AGENTE,
  factorPrecio: { MTY1: 1, MTY2: 1, GDL1: 1.04, CDMX1: 1.1, PUE1: 0.97, TIJ1: 1.07 },
};
