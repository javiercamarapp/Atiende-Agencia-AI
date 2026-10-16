import type { Alergeno, ProductoDef, SucursalId } from "./tipos.ts";

/** Categorias del menu (el nombre exacto de «Cervezas» y «Licores y Cocktails» lo usa el motor para pedir confirmacion de mayoria de edad). */
export const CAT = {
  tacos: "Tacos al Carbón",
  burritos: "Burritos de Harina",
  quesadillas: "Quesadillas y Sincronizadas de Harina",
  parrilla: "Parrilla y Cortes",
  cabrito: "Cabrito y Asados",
  desayunos: "Desayunos Norteños",
  caldos: "Caldos y Menudo",
  botanas: "Botanas y Entradas",
  papas: "Papas Asadas y Guarniciones",
  kilos: "Charolas y Kilos",
  tortillas: "Tortillas y Salsas para Llevar",
  combos: "Combos del Día",
  paquetes: "Paquetes para Compartir",
  chiquito: "Menú Chiquito",
  postres: "Postres Norteños",
  refrescos: "Refrescos y Jugos",
  aguas: "Aguas Frescas y Limonadas",
  cafe: "Café y Chocolate",
  cervezas: "Cervezas",
  licores: "Licores y Cocktails",
  extras: "Extras del Asador",
} as const;

export const CATEGORIAS: readonly string[] = Object.values(CAT);

const AL: Readonly<Record<string, Alergeno>> = { g: "gluten", l: "lacteos", h: "huevo", s: "soya", f: "frutos secos", c: "cacahuate", u: "sulfitos", m: "mostaza", a: "ajonjoli", p: "pescado", x: "mariscos", e: "apio" };

export interface Opc {
  readonly pop?: boolean;
  readonly alc?: boolean;
  readonly no?: readonly SucursalId[];
  readonly agot?: readonly SucursalId[];
  readonly precios?: Readonly<Partial<Record<SucursalId, number>>>;
  readonly alias?: readonly string[];
  readonly frac?: { readonly base: string; readonly gramos: number };
}

/** Atajo: nombre, categoria, precio base (MTY), descripcion, ingredientes (separados por coma), alergenos (letras: g gluten, l lacteos, h huevo, s soya, f frutos secos, c cacahuate, u sulfitos, m mostaza, a ajonjoli, p pescado, x mariscos, e apio). */
export function p(nombre: string, categoria: string, precio: number, descripcion: string, ingredientes: string, alergenos = "", o: Opc = {}): ProductoDef {
  return {
    nombre,
    categoria,
    precio,
    descripcion,
    ingredientes: ingredientes.split(",").map((x) => x.trim()).filter(Boolean),
    alergenos: [...alergenos].map((l) => AL[l]!),
    ...(o.pop ? { popular: true } : {}),
    ...(o.alc ? { esAlcohol: true } : {}),
    ...(o.no ? { noSeVendeEn: o.no } : {}),
    ...(o.agot ? { agotadoEn: o.agot } : {}),
    ...(o.precios ? { precios: o.precios } : {}),
    ...(o.alias ? { alias: o.alias } : {}),
    ...(o.frac ? { fraccionKg: o.frac } : {}),
  };
}

/** Texto final de la descripcion que ve el agente: descripcion + ingredientes + alergenos (para que no invente). */
export function descripcionCompleta(d: ProductoDef): string {
  const al = d.alergenos.length > 0 ? `Alérgenos: ${d.alergenos.join(", ")}.` : "Sin alérgenos de declaración obligatoria.";
  return `${d.descripcion} Ingredientes: ${d.ingredientes.join(", ")}. ${al}`;
}

/** Precio proporcional de una fraccion de kilo, redondeado al $0.50 (misma regla de caja que usa el motor de pedidos). */
export function precioFraccion(precioKilo: number, gramos: number): number {
  return Math.floor(((precioKilo * gramos) / 1000) * 2 + 0.5) / 2;
}

export const ETIQUETA_GRAMOS: Readonly<Record<number, string>> = { 250: "250 g", 500: "500 g", 1000: "1 kg", 1500: "1.5 kg", 2000: "2 kg" };
