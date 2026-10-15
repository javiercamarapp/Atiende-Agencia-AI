import { CAT, ETIQUETA_GRAMOS, p } from "./menu-util.ts";
import type { ProductoDef, SucursalId } from "./tipos.ts";

// Menu ficticio de El Tizon Norteño (estilo norteño). Precios en pesos MXN 2026 de la lista base de Monterrey; cada sucursal aplica su factor de
// ciudad (`factorPrecio`) salvo los productos con `precios` propios. NADA se copia de Los Taquitos de PM: los nombres, precios y salsas son inventados
// para este estilo regional (lo vigila `tests/demo-cuenta-originalidad.spec.ts`).

const MTY1: SucursalId = "MTY1";
const MTY2: SucursalId = "MTY2";
const GDL1: SucursalId = "GDL1";
const CDMX1: SucursalId = "CDMX1";
const PUE1: SucursalId = "PUE1";
const TIJ1: SucursalId = "TIJ1";
const SIN_MANANA: readonly SucursalId[] = [MTY2, GDL1, PUE1, TIJ1]; // solo Obispado y Narvarte abren por la mañana

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tacos al carbon: individual, orden de 3 y (los mas pedidos) orden de 5.
// ---------------------------------------------------------------------------------------------------------------------------------------------
interface Taco {
  readonly nombre: string;
  readonly precio: number;
  readonly ingredientes: string;
  readonly alergenos: string;
  readonly orden5?: boolean;
  readonly pop?: boolean;
  readonly no?: readonly SucursalId[];
  readonly agot?: readonly SucursalId[];
  readonly alias?: readonly string[];
}
const TACOS: readonly Taco[] = [
  { nombre: "Arrachera Marinada al Carbón", precio: 54, ingredientes: "arrachera de res, marinada de naranja y soya, cebollita, cilantro", alergenos: "s", orden5: true, pop: true, alias: ["arrachera"] },
  { nombre: "Costilla de Res al Carbón", precio: 50, ingredientes: "costilla de res, sal de grano, cebollita, cilantro", alergenos: "", orden5: true, pop: true },
  { nombre: "Carne Asada de Diezmillo", precio: 44, ingredientes: "diezmillo de res, sal de grano, cebollita, cilantro", alergenos: "", orden5: true, pop: true, alias: ["asada", "carnasada"] },
  { nombre: "Cabeza de Res en Barbacoa", precio: 40, ingredientes: "cabeza de res cocida en vapor, cebolla, cilantro", alergenos: "", no: [TIJ1] },
  { nombre: "Lengua de Res", precio: 48, ingredientes: "lengua de res cocida, cebolla, cilantro", alergenos: "" },
  { nombre: "Tripitas Doradas", precio: 38, ingredientes: "tripitas de res, limón, sal", alergenos: "", alias: ["tripitas"] },
  { nombre: "Machaca con Huevo", precio: 42, ingredientes: "machaca de res, huevo, chile serrano, tomate, cebolla", alergenos: "h", orden5: true, pop: true, alias: ["machaca"] },
  { nombre: "Cecina de Res Oreada", precio: 46, ingredientes: "cecina de res, sal, limón, cebollita", alergenos: "" },
  { nombre: "Longaniza Norteña", precio: 38, ingredientes: "longaniza de cerdo, cebolla, chile de árbol", alergenos: "" },
  { nombre: "Pollo al Carbón", precio: 38, ingredientes: "pierna y muslo de pollo, adobo de achiote, cebollita", alergenos: "" },
  { nombre: "Chuleta Ahumada", precio: 42, ingredientes: "chuleta de cerdo ahumada con mezquite, cebollita", alergenos: "" },
  { nombre: "Discada Norteña", precio: 46, ingredientes: "bistec, chorizo, tocino, jamón, cebolla, pimiento, chile", alergenos: "" },
  { nombre: "Cabrito Asado", precio: 72, ingredientes: "cabrito asado al pastor, cebolla, cilantro", alergenos: "", no: [TIJ1] },
  { nombre: "Frijoles Puercos con Queso", precio: 32, ingredientes: "frijol, chorizo, queso Chihuahua, chile jalapeño", alergenos: "l" },
  { nombre: "Papa con Chorizo", precio: 34, ingredientes: "papa, chorizo de cerdo, cebolla", alergenos: "" },
  { nombre: "Nopal Asado con Queso", precio: 32, ingredientes: "nopal asado, queso Chihuahua, cebolla", alergenos: "l" },
  { nombre: "Chicharrón Prensado en Salsa Roja", precio: 36, ingredientes: "chicharrón prensado, salsa roja de chile guajillo, cebolla", alergenos: "", agot: [GDL1] },
];

const productos: ProductoDef[] = [];
for (const t of TACOS) {
  const o = { pop: t.pop, no: t.no, agot: t.agot, alias: t.alias };
  productos.push(p(`Taco de ${t.nombre} (individual)`, CAT.tacos, t.precio, "Un taco sobre tortilla a elegir (maíz o harina).", t.ingredientes, t.alergenos, o));
  productos.push(p(`Tacos de ${t.nombre} (orden de 3)`, CAT.tacos, Math.round(t.precio * 3 * 0.97), "Tres tacos sobre tortilla a elegir (maíz o harina).", t.ingredientes, t.alergenos, o));
  if (t.orden5) productos.push(p(`Tacos de ${t.nombre} (orden de 5)`, CAT.tacos, Math.round(t.precio * 5 * 0.95), "Cinco tacos sobre tortilla a elegir (maíz o harina).", t.ingredientes, t.alergenos, o));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Burritos de harina (chico y grande), quesadillas y sincronizadas de harina.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const BURRITOS: readonly [string, number, string, string, boolean?][] = [
  ["Machaca con Huevo", 62, "machaca de res, huevo, chile serrano, tomate", "gh", true],
  ["Arrachera", 78, "arrachera marinada, frijol, queso Chihuahua", "gls", true],
  ["Costilla de Res", 72, "costilla de res asada, frijol, salsa verde asada", "g"],
  ["Cecina", 68, "cecina oreada, frijol, aguacate", "g"],
  ["Discada", 68, "discada norteña, queso Chihuahua", "gl"],
  ["Chicharrón en Salsa Verde", 56, "chicharrón prensado, salsa verde asada, frijol", "g"],
  ["Frijoles Puercos", 48, "frijoles puercos, queso Chihuahua", "gl"],
  ["Chile Relleno", 64, "chile poblano relleno de queso, frijol, arroz", "glh"],
];
for (const [n, precio, ing, al, pop] of BURRITOS) {
  productos.push(p(`Burrito Chico de ${n}`, CAT.burritos, precio, "Burrito en tortilla de harina hecha a mano, tamaño chico.", `tortilla de harina, ${ing}`, al, { pop }));
  productos.push(p(`Burrito Grande de ${n}`, CAT.burritos, Math.round(precio * 1.65), "Burrito en tortilla de harina hecha a mano, tamaño grande (para una persona con hambre).", `tortilla de harina, ${ing}`, al, { pop }));
}

const QUESADILLAS: readonly [string, number, string, string, boolean?][] = [
  ["Queso Chihuahua", 58, "queso Chihuahua", "gl"],
  ["Arrachera", 88, "arrachera marinada, queso Chihuahua", "gls"],
  ["Machaca", 82, "machaca de res, queso Chihuahua", "gl"],
  ["Cecina", 80, "cecina oreada, queso Chihuahua", "gl"],
  ["Costilla de Res", 84, "costilla de res asada, queso Chihuahua", "gl"],
  ["Chorizo de Res", 70, "chorizo de res, queso Chihuahua", "gl"],
  ["Papa y Rajas Poblanas", 62, "papa, rajas de chile poblano, queso Chihuahua", "gl"],
  ["Flor de Calabaza", 64, "flor de calabaza, queso Chihuahua", "gl"],
  ["Nopal Asado", 60, "nopal asado, queso Chihuahua", "gl"],
  ["Hongos al Ajillo", 66, "hongos, ajo, queso Chihuahua", "gl"],
];
for (const [n, precio, ing, al] of QUESADILLAS) {
  productos.push(p(`Quesadilla Chica de Harina con ${n}`, CAT.quesadillas, precio, "Quesadilla en tortilla de harina dorada en comal, tamaño chico.", `tortilla de harina, ${ing}`, al));
}
for (const [n, precio, ing, al] of QUESADILLAS.slice(0, 5)) {
  productos.push(p(`Quesadilla Gigante de Harina con ${n}`, CAT.quesadillas, Math.round(precio * 1.7), "Quesadilla en tortilla de harina de 30 cm, para compartir.", `tortilla de harina de 30 cm, ${ing}`, al, { pop: n === "Arrachera" }));
}
productos.push(p("Sincronizada Clásica de Harina", CAT.quesadillas, 72, "Dos tortillas de harina con jamón y queso, doradas al comal.", "tortilla de harina, jamón de pavo, queso Chihuahua", "gl"));
productos.push(p("Sincronizada de Arrachera y Aguacate", CAT.quesadillas, 112, "Dos tortillas de harina con arrachera, queso y aguacate.", "tortilla de harina, arrachera marinada, queso Chihuahua, aguacate", "gls"));
productos.push(p("Sincronizada de Cecina con Nopal", CAT.quesadillas, 104, "Dos tortillas de harina con cecina, nopal asado y queso.", "tortilla de harina, cecina, nopal, queso Chihuahua", "gl"));
productos.push(p("Sincronizada Vegetariana de Hongos", CAT.quesadillas, 88, "Dos tortillas de harina con hongos, espinaca y queso.", "tortilla de harina, hongos, espinaca, queso Chihuahua", "gl"));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Parrilla y cortes (el termino de la carne se elige al pedir: medio, tres cuartos o bien cocido).
// ---------------------------------------------------------------------------------------------------------------------------------------------
const TERMINO = "Se pide en término medio, tres cuartos o bien cocido.";
productos.push(p("Plato de Arrachera Marinada de 300 g", CAT.parrilla, 298, `300 g de arrachera con papa asada, cebollitas y tortillas. ${TERMINO}`, "arrachera de res, papa, cebollita asada, tortillas de harina", "gls", { pop: true }));
productos.push(p("Plato de Costilla de Res de 400 g", CAT.parrilla, 289, `400 g de costilla de res al carbón con frijoles y tortillas. ${TERMINO}`, "costilla de res, frijoles de la olla, tortillas de harina", "g"));
productos.push(p("Rib Eye al Carbón de 350 g", CAT.parrilla, 459, `Corte rib eye con papa asada y cebollitas. ${TERMINO}`, "rib eye de res, papa, cebollita asada, mantequilla", "l", { agot: [PUE1] }));
productos.push(p("Diezmillo a la Parrilla de 350 g", CAT.parrilla, 329, `Diezmillo con frijoles puercos y tortillas. ${TERMINO}`, "diezmillo, frijoles puercos, tortillas de harina", "g"));
productos.push(p("T-Bone Norteño de 450 g", CAT.parrilla, 519, `Corte T-Bone con papa asada y ensalada de col. ${TERMINO}`, "T-Bone de res, papa, col, zanahoria", ""));
productos.push(p("Chuletón Ahumado de Cerdo de 400 g", CAT.parrilla, 269, "Chuletón de cerdo ahumado con mezquite, bien cocido, con arroz rojo.", "chuletón de cerdo, arroz rojo, cebollita", ""));
productos.push(p("Tampiqueña Norteña", CAT.parrilla, 349, `Arrachera con enchilada, guacamole y frijoles. ${TERMINO}`, "arrachera, tortilla de maíz, queso, guacamole, frijoles", "ls"));
productos.push(p("Pechuga de Pollo al Carbón", CAT.parrilla, 249, "Pechuga de pollo marinada, siempre bien cocida, con arroz rojo.", "pechuga de pollo, adobo de achiote, arroz rojo", ""));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Cabrito y asados (no se surte en Tijuana).
// ---------------------------------------------------------------------------------------------------------------------------------------------
const SIN_CABRITO: readonly SucursalId[] = [TIJ1];
productos.push(p("Cabrito Asado al Pastor — Cuarto", CAT.cabrito, 495, "Cuarto de cabrito asado al pastor sobre brasas; pedir con 90 minutos de anticipo.", "cabrito, sal de grano, ajo, tortillas de harina", "g", { no: SIN_CABRITO, pop: true, alias: ["cabrito"] }));
productos.push(p("Cabrito Asado al Pastor — Medio", CAT.cabrito, 940, "Medio cabrito asado; pedir con 90 minutos de anticipo.", "cabrito, sal de grano, ajo, tortillas de harina", "g", { no: SIN_CABRITO }));
productos.push(p("Cabrito Asado al Pastor — Entero", CAT.cabrito, 1790, "Cabrito entero para fiesta; pedir con un día de anticipo.", "cabrito, sal de grano, ajo, tortillas de harina", "g", { no: SIN_CABRITO }));
productos.push(p("Fritada de Cabrito", CAT.cabrito, 285, "Fritada de cabrito en su sangre, guiso tradicional del norte.", "cabrito, sangre de cabrito, cebolla, ajo", "", { no: SIN_CABRITO, agot: [CDMX1] }));
productos.push(p("Machito de Cabrito", CAT.cabrito, 225, "Vísceras de cabrito envueltas en tripa, a la parrilla.", "vísceras de cabrito, tripa, sal", "", { no: SIN_CABRITO }));
productos.push(p("Pierna de Cabrito Asada", CAT.cabrito, 385, "Pierna de cabrito asada con frijoles y tortillas.", "pierna de cabrito, frijoles, tortillas de harina", "g", { no: SIN_CABRITO }));
productos.push(p("Costillar de Cabrito", CAT.cabrito, 410, "Costillar de cabrito al carbón con cebollitas.", "costillar de cabrito, cebollita asada", "", { no: SIN_CABRITO }));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Desayunos norteños (solo Obispado y Narvarte abren por la mañana) y caldos.
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Machacado con Huevo y Tortillas", CAT.desayunos, 129, "Machacado de res con huevo, frijoles refritos y tortillas de harina.", "machaca de res, huevo, frijoles, tortillas de harina", "gh", { no: SIN_MANANA, pop: true }));
productos.push(p("Machacado con Nopales", CAT.desayunos, 135, "Machacado de res con nopales y huevo.", "machaca de res, nopal, huevo", "h", { no: SIN_MANANA }));
productos.push(p("Huevos Rancheros Norteños", CAT.desayunos, 109, "Dos huevos estrellados sobre tortilla con salsa roja y frijoles.", "huevo, salsa roja, frijoles, tortilla de maíz", "h", { no: SIN_MANANA }));
productos.push(p("Huevos con Chorizo de Res", CAT.desayunos, 119, "Huevos revueltos con chorizo de res y frijoles.", "huevo, chorizo de res, frijoles", "h", { no: SIN_MANANA }));
productos.push(p("Chilaquiles Rojos con Pollo", CAT.desayunos, 119, "Chilaquiles en salsa roja con pollo deshebrado, crema y queso.", "totopos, salsa roja, pollo, crema, queso fresco", "l", { no: SIN_MANANA }));
productos.push(p("Chilaquiles Verdes con Cecina", CAT.desayunos, 149, "Chilaquiles en salsa verde con cecina oreada.", "totopos, salsa verde, cecina, crema, queso fresco", "l", { no: SIN_MANANA }));
productos.push(p("Molletes Norteños", CAT.desayunos, 99, "Mollete de bolillo con frijoles, queso Chihuahua y pico de gallo.", "bolillo, frijoles, queso Chihuahua, pico de gallo", "gl", { no: SIN_MANANA }));
productos.push(p("Omelette de Machaca", CAT.desayunos, 139, "Omelette de tres huevos relleno de machaca y queso.", "huevo, machaca de res, queso Chihuahua", "hl", { no: SIN_MANANA }));

const SIN_MENUDO: readonly SucursalId[] = [PUE1, TIJ1];
productos.push(p("Menudo Norteño Chico", CAT.caldos, 109, "Menudo rojo con maíz pozolero, orégano y limón; chico.", "pancita de res, patitas, maíz pozolero, chile guajillo", "", { no: SIN_MENUDO, pop: true }));
productos.push(p("Menudo Norteño Grande", CAT.caldos, 149, "Menudo rojo con maíz pozolero, orégano y limón; grande.", "pancita de res, patitas, maíz pozolero, chile guajillo", "", { no: SIN_MENUDO, pop: true }));
productos.push(p("Pancita Blanca Chica", CAT.caldos, 105, "Pancita blanca de res con cebolla, limón y orégano.", "pancita de res, maíz pozolero, ajo", "", { no: SIN_MENUDO, agot: [MTY2] }));
productos.push(p("Pancita Blanca Grande", CAT.caldos, 145, "Pancita blanca de res con cebolla, limón y orégano; grande.", "pancita de res, maíz pozolero, ajo", "", { no: SIN_MENUDO }));
productos.push(p("Caldo de Res Chico", CAT.caldos, 119, "Caldo de res con verduras y arroz.", "carne de res, calabacita, elote, zanahoria, arroz", "e"));
productos.push(p("Caldo de Res Grande", CAT.caldos, 159, "Caldo de res con verduras y arroz; grande.", "carne de res, calabacita, elote, zanahoria, arroz", "e"));
productos.push(p("Caldillo Durangueño", CAT.caldos, 139, "Caldillo de carne seca con papa y chile colorado.", "carne seca de res, papa, chile colorado, jitomate", ""));
productos.push(p("Consomé de Barbacoa", CAT.caldos, 89, "Consomé del cocimiento de la barbacoa con garbanzo y arroz.", "caldo de res, garbanzo, arroz, cilantro", ""));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Botanas, papas y guarniciones.
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Queso Asado a la Parrilla con Chile", CAT.botanas, 169, "Queso Chihuahua asado con chile poblano en tiras.", "queso Chihuahua, chile poblano", "l", { pop: true }));
productos.push(p("Choriqueso Norteño", CAT.botanas, 179, "Queso fundido con chorizo de res, con tortillas de harina.", "queso Chihuahua, chorizo de res, tortillas de harina", "gl", { pop: true }));
productos.push(p("Frijoles Puercos con Totopos", CAT.botanas, 139, "Frijoles puercos con queso, chorizo y chile; con totopos.", "frijol, chorizo, queso Chihuahua, chile jalapeño, totopos", "l"));
productos.push(p("Chicharrón de Res Botanero", CAT.botanas, 169, "Chicharrón de res crujiente con limón y salsa brava.", "chicharrón de res, limón", ""));
productos.push(p("Costillitas Fritas", CAT.botanas, 219, "Costillitas de cerdo fritas con limón y chile en polvo.", "costilla de cerdo, limón, chile en polvo", ""));
productos.push(p("Papas Gajo con Queso", CAT.botanas, 119, "Papas gajo fritas con queso fundido y jalapeño.", "papa, queso procesado, jalapeño", "l"));
productos.push(p("Esquites Norteños", CAT.botanas, 59, "Vaso de elote desgranado con mayonesa, queso y chile.", "elote, mayonesa, queso cotija, chile en polvo", "hl"));
productos.push(p("Nopales Asados con Queso", CAT.botanas, 99, "Nopales asados con queso panela y pico de gallo.", "nopal, queso panela, pico de gallo", "l"));
productos.push(p("Cebollitas de Rabo a la Parrilla", CAT.botanas, 79, "Cebollitas cambray asadas con limón y sal.", "cebolla cambray, limón, sal", ""));
productos.push(p("Chiles Toreados", CAT.botanas, 49, "Chiles serranos toreados con sal de grano y limón.", "chile serrano, limón, sal", "s"));
productos.push(p("Jalapeños Rellenos de Queso (orden de 4)", CAT.botanas, 119, "Cuatro jalapeños rellenos de queso y envueltos en tocino.", "jalapeño, queso crema, tocino", "l"));
productos.push(p("Guacamole con Chicharrón", CAT.botanas, 129, "Guacamole de aguacate hass con chicharrón de cerdo.", "aguacate, cebolla, cilantro, chicharrón", ""));
productos.push(p("Tostadas de Machaca (orden de 3)", CAT.botanas, 129, "Tres tostadas de machaca con frijol, lechuga y queso.", "tostada, machaca de res, frijol, lechuga, queso", "l"));

productos.push(p("Papa Asada Rellena de Machaca", CAT.papas, 149, "Papa horneada rellena de machaca con huevo y queso.", "papa, machaca de res, huevo, queso Chihuahua", "hl"));
productos.push(p("Papa Asada Rellena de Arrachera", CAT.papas, 169, "Papa horneada rellena de arrachera marinada y queso.", "papa, arrachera, queso Chihuahua, mantequilla", "ls"));
productos.push(p("Papa Asada con Queso y Tocino", CAT.papas, 119, "Papa horneada con queso Chihuahua, tocino y crema.", "papa, queso Chihuahua, tocino, crema", "l"));
productos.push(p("Papa Asada con Frijoles Puercos", CAT.papas, 109, "Papa horneada con frijoles puercos y queso.", "papa, frijoles puercos, queso", "l"));
productos.push(p("Arroz Rojo Norteño", CAT.papas, 49, "Porción de arroz rojo con chícharo y zanahoria.", "arroz, jitomate, chícharo, zanahoria, caldo de pollo", "e"));
productos.push(p("Frijoles Maneados", CAT.papas, 69, "Frijoles refritos con queso derretido, estilo Chihuahua.", "frijol, queso Chihuahua, manteca", "l"));
productos.push(p("Frijoles de la Olla", CAT.papas, 49, "Frijoles de la olla con epazote.", "frijol, epazote, cebolla", ""));
productos.push(p("Ensalada de Col y Zanahoria", CAT.papas, 39, "Ensalada fresca de col morada, zanahoria y limón.", "col, zanahoria, limón", ""));
productos.push(p("Cebolla Cambray Asada", CAT.papas, 49, "Cebolla cambray asada al carbón con limón.", "cebolla cambray, limón", ""));
productos.push(p("Calabacitas con Elote", CAT.papas, 59, "Calabacitas guisadas con elote y crema.", "calabacita, elote, crema", "l"));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Charolas y kilos: carne por peso. 1 kg es la base; las fracciones valen el precio del kilo de la MISMA sucursal por el peso (redondeo a $0.50).
// ---------------------------------------------------------------------------------------------------------------------------------------------
interface Kilo {
  readonly nombre: string;
  readonly precio: number;
  readonly ingredientes: string;
  readonly alergenos: string;
  readonly gramos: readonly number[];
  readonly no?: readonly SucursalId[];
  readonly alias?: readonly string[];
}
const KILOS: readonly Kilo[] = [
  { nombre: "Arrachera Marinada al Carbón", precio: 640, ingredientes: "arrachera de res, marinada de naranja y soya", alergenos: "s", gramos: [250, 500, 1000, 1500, 2000], alias: ["arrachera"] },
  { nombre: "Costilla de Res al Carbón", precio: 560, ingredientes: "costilla de res, sal de grano", alergenos: "", gramos: [250, 500, 1000, 1500, 2000] },
  { nombre: "Carne Asada de Diezmillo", precio: 520, ingredientes: "diezmillo de res, sal de grano", alergenos: "", gramos: [250, 500, 1000, 1500, 2000], alias: ["asada"] },
  { nombre: "Cabrito Asado al Pastor", precio: 880, ingredientes: "cabrito, sal de grano, ajo", alergenos: "", gramos: [500, 1000, 2000], no: [TIJ1] },
  { nombre: "Cecina de Res Oreada", precio: 560, ingredientes: "cecina de res, sal", alergenos: "", gramos: [500, 1000, 2000] },
  { nombre: "Machaca de Res", precio: 720, ingredientes: "carne de res seca y deshebrada", alergenos: "", gramos: [250, 500, 1000] },
  { nombre: "Tripitas Doradas", precio: 380, ingredientes: "tripitas de res, sal", alergenos: "", gramos: [500, 1000, 2000] },
  { nombre: "Pollo al Carbón", precio: 280, ingredientes: "pierna y muslo de pollo, adobo de achiote", alergenos: "", gramos: [500, 1000, 2000] },
];
for (const k of KILOS) {
  const baseNombre = `${k.nombre} — 1 kg`;
  for (const g of [...k.gramos].sort((a, b) => b - a)) {
    // el kilo base primero (la fraccion lo referencia), luego las fracciones
    if (g !== 1000) continue;
    productos.push(p(baseNombre, CAT.kilos, k.precio, "Carne por kilo, lista para llevar con salsas y cebollitas.", k.ingredientes, k.alergenos, { no: k.no, alias: k.alias, pop: k.nombre.startsWith("Arrachera") || k.nombre.startsWith("Carne Asada") }));
  }
  for (const g of k.gramos) {
    if (g === 1000) continue;
    productos.push(p(`${k.nombre} — ${ETIQUETA_GRAMOS[g]}`, CAT.kilos, 0, "Carne por peso, lista para llevar con salsas y cebollitas.", k.ingredientes, k.alergenos, { no: k.no, frac: { base: baseNombre, gramos: g } }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tortillas y salsas para llevar (las salsas propias de la casa).
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Tortillas de Harina del Día — 1 kg", CAT.tortillas, 130, "Tortillas de harina hechas a mano cada día, por kilo.", "harina de trigo, manteca vegetal, sal, agua", "g", { pop: true }));
productos.push(p("Tortillas de Harina del Día — 500 g", CAT.tortillas, 0, "Tortillas de harina hechas a mano cada día, medio kilo.", "harina de trigo, manteca vegetal, sal, agua", "g", { frac: { base: "Tortillas de Harina del Día — 1 kg", gramos: 500 } }));
productos.push(p("Tortillas de Maíz Azul — 1 kg", CAT.tortillas, 46, "Tortillas de maíz azul por kilo.", "maíz azul nixtamalizado", ""));
productos.push(p("Tortillas de Maíz Azul — 500 g", CAT.tortillas, 0, "Tortillas de maíz azul, medio kilo.", "maíz azul nixtamalizado", "", { frac: { base: "Tortillas de Maíz Azul — 1 kg", gramos: 500 } }));
productos.push(p("Tortillas de Harina Hechas a Mano (docena)", CAT.tortillas, 70, "Docena de tortillas de harina.", "harina de trigo, manteca vegetal, sal", "g"));
productos.push(p("Tortillas de Harina Hechas a Mano (media docena)", CAT.tortillas, 38, "Media docena de tortillas de harina.", "harina de trigo, manteca vegetal, sal", "g"));
const SALSAS: readonly [string, string, string][] = [
  ["Brava de Árbol", "chile de árbol, ajo, vinagre", ""],
  ["Verde Asada", "tomatillo asado, chile serrano, cilantro", ""],
  ["Macha Norteña", "chile seco, ajonjolí, cacahuate, aceite", "ac"],
  ["Chipotle Ahumada", "chile chipotle, jitomate, piloncillo", ""],
  ["Pico de Gallo del Patio", "jitomate, cebolla, cilantro, chile serrano, limón", ""],
  ["Aguacatera Cremosa", "aguacate, tomatillo, cilantro, limón", ""],
  ["Pasilla con Piloncillo", "chile pasilla, piloncillo, ajo", ""],
];
for (const [n, ing, al] of SALSAS) {
  productos.push(p(`Salsa ${n} (frasco 250 ml)`, CAT.tortillas, 58, "Salsa de la casa para llevar, frasco de 250 ml.", ing, al, { pop: n.startsWith("Brava") }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Combos del dia y paquetes.
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Combo de 3 Tacos de Arrachera con Frijoles y Bebida", CAT.combos, 189, "Tres tacos de arrachera, frijoles puercos y un refresco o agua fresca de vaso.", "arrachera, tortilla a elegir, frijoles puercos, bebida", "ls", { pop: true }));
productos.push(p("Combo de 3 Tacos de Costilla con Frijoles y Bebida", CAT.combos, 179, "Tres tacos de costilla de res, frijoles puercos y bebida.", "costilla de res, tortilla a elegir, frijoles puercos, bebida", "l"));
productos.push(p("Combo de 3 Tacos Surtidos al Carbón con Bebida", CAT.combos, 165, "Tres tacos surtidos (asada, longaniza y pollo) y una bebida.", "carne asada, longaniza, pollo, tortilla a elegir, bebida", ""));
productos.push(p("Combo Burrito Grande de Machaca con Papas y Bebida", CAT.combos, 169, "Burrito grande de machaca con huevo, papas gajo y bebida.", "tortilla de harina, machaca, huevo, papa, bebida", "gh"));
productos.push(p("Combo Burrito Grande de Arrachera con Papas y Bebida", CAT.combos, 185, "Burrito grande de arrachera, papas gajo y bebida.", "tortilla de harina, arrachera, queso, papa, bebida", "gls"));
productos.push(p("Combo Quesadilla Gigante con Frijoles y Bebida", CAT.combos, 159, "Quesadilla gigante de queso, frijoles maneados y bebida.", "tortilla de harina, queso Chihuahua, frijol, bebida", "gl"));
productos.push(p("Combo Menudo Grande con Tortillas y Bebida", CAT.combos, 169, "Menudo grande, tortillas de harina y bebida.", "pancita de res, maíz pozolero, tortillas de harina, bebida", "g", { no: [MTY2, GDL1, PUE1, TIJ1] }));
productos.push(p("Combo Desayuno Norteño con Café", CAT.combos, 139, "Machacado con huevo, frijoles, tortillas y café de olla.", "machaca, huevo, frijoles, tortillas de harina, café", "gh", { no: SIN_MANANA }));
productos.push(p("Combo Plato de Arrachera con Papa y Bebida", CAT.combos, 285, "Plato de arrachera de 300 g, papa asada y bebida.", "arrachera, papa, tortillas de harina, bebida", "gls"));
productos.push(p("Combo Dúo de 6 Tacos al Carbón y 2 Bebidas", CAT.combos, 329, "Seis tacos surtidos al carbón y dos bebidas para dos personas.", "carne asada, costilla, pollo, tortilla a elegir, bebidas", ""));
productos.push(p("Combo Cabrito Cuarto con Frijoles y Tortillas", CAT.combos, 395, "Cuarto de cabrito asado, frijoles de la olla y tortillas de harina.", "cabrito, frijoles, tortillas de harina", "g", { no: SIN_CABRITO }));
productos.push(p("Combo Estudiante de 2 Tacos de Carne Asada y Agua", CAT.combos, 99, "Dos tacos de carne asada y un vaso de agua fresca.", "carne asada, tortilla a elegir, agua fresca", ""));

productos.push(p("Charola Norteña para 2", CAT.paquetes, 649, "Arrachera y costilla (400 g en total), cebollitas, frijoles, tortillas de harina y salsas.", "arrachera, costilla de res, cebolla cambray, frijoles, tortillas de harina, salsas", "gls", { pop: true }));
productos.push(p("Charola Norteña para 4", CAT.paquetes, 1199, "800 g de carne surtida, papas asadas, frijoles, cebollitas, tortillas y salsas.", "arrachera, costilla de res, diezmillo, papa, frijoles, tortillas de harina, salsas", "gls", { pop: true }));
productos.push(p("Charola Norteña para 6", CAT.paquetes, 1749, "1.3 kg de carne surtida, guarniciones, tortillas y salsas.", "arrachera, costilla de res, diezmillo, papa, frijoles, tortillas de harina, salsas", "gls"));
productos.push(p("Paquete Fiesta de 20 Tacos al Carbón Surtidos", CAT.paquetes, 950, "Veinte tacos surtidos con cebollitas y salsas; se elige tortilla.", "carne asada, costilla, pollo, longaniza, tortilla a elegir, salsas", ""));
productos.push(p("Paquete Fútbol de 40 Tacos al Carbón", CAT.paquetes, 1790, "Cuarenta tacos surtidos con cebollitas, limones y salsas; se elige tortilla.", "carne asada, costilla, arrachera, tortilla a elegir, salsas", "s"));
productos.push(p("Paquete Fútbol de 60 Tacos al Carbón", CAT.paquetes, 2550, "Sesenta tacos surtidos para el partido; se confirma con un día de anticipo.", "carne asada, costilla, arrachera, tortilla a elegir, salsas", "s"));
productos.push(p("Paquete Carne Asada de 3 kg", CAT.paquetes, 2150, "Tres kilos de carne surtida con tortillas de harina, cebollitas y salsas para tu carne asada.", "diezmillo, arrachera, costilla, tortillas de harina, cebollitas, salsas", "gs", { pop: true }));
productos.push(p("Paquete Cabrito para 6", CAT.paquetes, 2890, "Medio cabrito, frijoles puercos, tortillas y salsas; pedir con un día de anticipo.", "cabrito, frijoles puercos, tortillas de harina, salsas", "gl", { no: SIN_CABRITO }));
productos.push(p("Paquete Desayuno Familiar", CAT.paquetes, 549, "Machacado, huevos rancheros, frijoles, tortillas y jarra de café de olla para cuatro.", "machaca, huevo, frijoles, tortillas de harina, café", "gh", { no: SIN_MANANA }));
productos.push(p("Paquete de 10 Burritos Chicos Surtidos", CAT.paquetes, 590, "Diez burritos chicos surtidos de machaca, costilla y frijoles.", "tortilla de harina, machaca, costilla, frijoles, queso", "ghl"));

// Menu chiquito.
productos.push(p("Mini Tacos de Carne Asada (orden de 4)", CAT.chiquito, 79, "Cuatro mini tacos de carne asada en tortilla chica.", "carne asada, tortilla de maíz chica", ""));
productos.push(p("Mini Burrito de Frijoles con Queso", CAT.chiquito, 69, "Burrito pequeño de frijoles y queso.", "tortilla de harina, frijol, queso", "gl"));
productos.push(p("Quesadilla Chiquita con Jamón", CAT.chiquito, 69, "Quesadilla pequeña de harina con jamón y queso.", "tortilla de harina, jamón, queso", "gl"));
productos.push(p("Sincronizada Chiquita", CAT.chiquito, 69, "Sincronizada pequeña con jamón y queso.", "tortilla de harina, jamón, queso", "gl"));
productos.push(p("Papitas Doradas con Catsup", CAT.chiquito, 45, "Porción chica de papas fritas con catsup.", "papa, aceite, catsup", ""));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Postres.
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Capirotada Norteña", CAT.postres, 69, "Capirotada de bolillo con piloncillo, nuez, pasas y queso.", "bolillo, piloncillo, nuez, pasas, queso", "glf"));
productos.push(p("Glorias de Linares (3 piezas)", CAT.postres, 79, "Tres glorias de leche quemada con nuez.", "leche de cabra, azúcar, nuez", "lf"));
productos.push(p("Empanada de Cajeta (orden de 2)", CAT.postres, 69, "Dos empanadas de harina rellenas de cajeta.", "harina de trigo, cajeta, azúcar", "gl", { pop: true }));
productos.push(p("Buñuelos con Piloncillo (orden de 3)", CAT.postres, 75, "Tres buñuelos crujientes bañados en miel de piloncillo.", "harina de trigo, piloncillo, canela", "g"));
productos.push(p("Pay de Nuez", CAT.postres, 79, "Rebanada de pay de nuez.", "nuez, mantequilla, harina, huevo, azúcar", "ghlf"));
productos.push(p("Flan de Cajeta", CAT.postres, 69, "Flan casero bañado en cajeta.", "leche, huevo, cajeta, azúcar", "hl"));
productos.push(p("Helado de Vainilla con Cajeta", CAT.postres, 59, "Dos bolas de helado de vainilla con cajeta.", "leche, crema, vainilla, cajeta", "l"));
productos.push(p("Pastel de Tres Leches", CAT.postres, 75, "Rebanada de pastel de tres leches.", "harina, huevo, leche, crema", "ghl"));
productos.push(p("Churros con Cajeta (orden de 5)", CAT.postres, 79, "Cinco churros con azúcar y canela y cajeta para untar.", "harina de trigo, azúcar, canela, cajeta", "gl"));
productos.push(p("Pan de Elote", CAT.postres, 59, "Rebanada de pan de elote tibio.", "elote, mantequilla, huevo, azúcar", "hl"));
productos.push(p("Dulce de Calabaza en Tacha", CAT.postres, 65, "Calabaza en tacha con piloncillo y canela.", "calabaza, piloncillo, canela", ""));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Bebidas sin alcohol.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const REF: readonly [string, number, string?][] = [
  ["Coca-Cola (lata 355 ml)", 32],
  ["Coca-Cola (600 ml)", 38],
  ["Coca-Cola (2 L)", 62],
  ["Coca-Cola Zero (600 ml)", 38],
  ["Sprite (600 ml)", 36],
  ["Fanta Naranja (600 ml)", 36],
  ["Manzanita Sol (600 ml)", 36],
  ["Jarritos de Tamarindo (370 ml)", 30],
  ["Jarritos de Mandarina (370 ml)", 30],
  ["Agua Mineral Topo Chico (355 ml)", 32],
  ["Agua Purificada (600 ml)", 20],
  ["Agua Purificada (1 L)", 28],
  ["Té Helado de Limón (500 ml)", 36],
];
for (const [n, precio] of REF) productos.push(p(n, CAT.refrescos, precio, "Bebida embotellada fría.", "agua, endulzante", "", { pop: n.startsWith("Coca-Cola (600") }));
productos.push(p("Jugo de Naranja Natural (vaso)", CAT.refrescos, 48, "Jugo de naranja exprimido al momento, vaso de 400 ml.", "naranja", ""));
productos.push(p("Jugo de Naranja Natural (litro)", CAT.refrescos, 120, "Jugo de naranja exprimido al momento, un litro.", "naranja", ""));

const AGUAS: readonly [string, string][] = [
  ["Limón con Chía", "limón, chía, azúcar"],
  ["Sandía", "sandía, azúcar"],
  ["Melón", "melón, azúcar"],
  ["Tamarindo", "tamarindo, azúcar"],
  ["Pepino con Limón", "pepino, limón, azúcar"],
];
for (const [n, ing] of AGUAS) {
  productos.push(p(`Agua de ${n} (vaso 500 ml)`, CAT.aguas, 34, "Agua fresca preparada en la sucursal.", ing, "", { pop: n === "Limón con Chía" }));
  productos.push(p(`Agua de ${n} (litro)`, CAT.aguas, 62, "Agua fresca preparada en la sucursal.", ing, ""));
}
for (const [n, ing] of AGUAS.slice(0, 3)) productos.push(p(`Jarra de Agua de ${n} (2 L)`, CAT.aguas, 110, "Jarra de agua fresca para compartir.", ing, ""));
productos.push(p("Limonada Mineral (vaso 500 ml)", CAT.aguas, 38, "Limonada con agua mineral.", "limón, agua mineral, azúcar", ""));
productos.push(p("Limonada Mineral (litro)", CAT.aguas, 70, "Limonada con agua mineral, un litro.", "limón, agua mineral, azúcar", ""));

productos.push(p("Café de Olla (taza)", CAT.cafe, 38, "Café de olla con piloncillo y canela.", "café, piloncillo, canela", ""));
productos.push(p("Café de Olla (jarro)", CAT.cafe, 65, "Jarro de café de olla para compartir.", "café, piloncillo, canela", ""));
productos.push(p("Café Americano (taza)", CAT.cafe, 36, "Café americano recién hecho.", "café", ""));
productos.push(p("Chocolate Caliente (taza)", CAT.cafe, 48, "Chocolate de mesa caliente con leche.", "chocolate, leche, canela", "l"));
productos.push(p("Atole de Piloncillo (vaso)", CAT.cafe, 40, "Atole de maíz con piloncillo.", "maíz, piloncillo, leche", "l"));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Alcohol (solo para recoger: la regla de alcohol a domicilio se prueba con estos productos).
// ---------------------------------------------------------------------------------------------------------------------------------------------
const CERV: readonly [string, number, Partial<Record<SucursalId, boolean>>?][] = [
  ["Tecate Roja (lata 355 ml)", 38],
  ["Tecate Roja (caguama 940 ml)", 78],
  ["Carta Blanca (355 ml)", 38],
  ["Carta Blanca (caguama 940 ml)", 82],
  ["Indio (355 ml)", 40],
  ["Dos Equis Lager (355 ml)", 42],
  ["Noche Buena (355 ml)", 48],
  ["Bohemia Clara (355 ml)", 48],
  ["Modelo Especial (355 ml)", 42],
  ["Corona Extra (355 ml)", 42],
  ["Heineken (355 ml)", 48],
  ["Stella Artois (355 ml)", 50],
  ["Michelob Ultra (355 ml)", 52],
];
for (const [n, precio] of CERV) productos.push(p(n, CAT.cervezas, precio, "Cerveza fría; solo para recoger y con identificación de mayoría de edad.", "agua, malta de cebada, lúpulo", "g", { alc: true, agot: n.startsWith("Noche Buena") ? [PUE1, TIJ1] : undefined }));
productos.push(p("Corona Cero (355 ml, sin alcohol)", CAT.cervezas, 40, "Cerveza sin alcohol, fría.", "agua, malta de cebada, lúpulo", "g"));
productos.push(p("Cubeta de 6 Tecate Roja (lata 355 ml)", CAT.cervezas, 210, "Cubeta con seis latas heladas; solo para recoger.", "agua, malta de cebada, lúpulo, hielo", "g", { alc: true }));
productos.push(p("Cubeta de 6 Indio (355 ml)", CAT.cervezas, 230, "Cubeta con seis botellas heladas; solo para recoger.", "agua, malta de cebada, lúpulo, hielo", "g", { alc: true }));
productos.push(p("Michelada Cubana (vaso 470 ml)", CAT.cervezas, 85, "Michelada con salsas, limón y chile; solo para recoger.", "cerveza, limón, salsa inglesa, salsa de soya, chile", "gsu", { alc: true, pop: true }));
productos.push(p("Chelada de Limón y Sal (vaso 470 ml)", CAT.cervezas, 65, "Cerveza con limón y sal; solo para recoger.", "cerveza, limón, sal", "g", { alc: true }));

const LIC: readonly [string, number, string, boolean?][] = [
  ["Mezcal Espadín Joven (copa 2 oz)", 95, "mezcal espadín"],
  ["Mezcal Espadín Joven (botella 750 ml)", 780, "mezcal espadín"],
  ["Mezcal Tobalá (copa 2 oz)", 180, "mezcal tobalá"],
  ["Sotol Reposado (copa 2 oz)", 110, "sotol reposado"],
  ["Raicilla (copa 2 oz)", 105, "raicilla"],
  ["Tequila Blanco (copa 2 oz)", 90, "tequila blanco"],
  ["Tequila Reposado (copa 2 oz)", 105, "tequila reposado"],
  ["Tequila Añejo (copa 2 oz)", 140, "tequila añejo"],
  ["Tequila Reposado (botella 750 ml)", 950, "tequila reposado"],
  ["Carajillo Norteño", 120, "licor de vainilla, café espresso, hielo"],
  ["Paloma Clásica", 95, "tequila blanco, toronja, limón, sal"],
  ["Mezcalita de Maracuyá", 130, "mezcal espadín, maracuyá, limón, chile"],
  ["Margarita de Tamarindo", 110, "tequila blanco, tamarindo, limón, sal"],
  ["Cantarito Jalisciense", 105, "tequila blanco, toronja, naranja, limón"],
  ["Vampiro", 110, "tequila blanco, sangrita, toronja"],
  ["Ranch Water", 115, "tequila blanco, agua mineral, limón"],
];
for (const [n, precio, ing] of LIC) productos.push(p(n, CAT.licores, precio, "Bebida con alcohol; solo para recoger y con identificación de mayoría de edad.", ing, n.startsWith("Carajillo") ? "" : "u", { alc: true, agot: n.startsWith("Mezcal Tobalá") ? [GDL1, PUE1] : undefined }));
productos.push(p("Mezcalita Sin Alcohol de Maracuyá", CAT.licores, 85, "Versión sin alcohol de la mezcalita, con maracuyá, limón y chile.", "maracuyá, limón, chile, agua mineral", ""));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Extras del asador (con costo).
// ---------------------------------------------------------------------------------------------------------------------------------------------
productos.push(p("Extra de Queso Chihuahua", CAT.extras, 25, "Porción extra de queso Chihuahua.", "queso Chihuahua", "l"));
productos.push(p("Extra de Machaca (porción 60 g)", CAT.extras, 49, "Porción extra de machaca.", "machaca de res", ""));
productos.push(p("Extra de Arrachera (porción 60 g)", CAT.extras, 59, "Porción extra de arrachera marinada.", "arrachera, marinada de naranja y soya", "s"));
productos.push(p("Extra de Tortillas de Harina (3 piezas)", CAT.extras, 20, "Tres tortillas de harina extra.", "harina de trigo, manteca vegetal", "g"));
productos.push(p("Extra de Tortillas de Maíz (6 piezas)", CAT.extras, 15, "Seis tortillas de maíz extra.", "maíz nixtamalizado", ""));
productos.push(p("Extra de Salsa Brava (60 ml)", CAT.extras, 12, "Porción extra de salsa brava.", "chile de árbol, ajo, vinagre", ""));
productos.push(p("Extra de Aguacate", CAT.extras, 25, "Medio aguacate hass en rebanadas.", "aguacate", ""));
productos.push(p("Extra de Tocino", CAT.extras, 25, "Porción extra de tocino.", "tocino", ""));
productos.push(p("Extra de Cebollitas Asadas (3 piezas)", CAT.extras, 18, "Tres cebollitas cambray asadas.", "cebolla cambray", ""));
productos.push(p("Extra de Frijoles Puercos", CAT.extras, 35, "Porción extra de frijoles puercos.", "frijol, chorizo, queso", "l"));
productos.push(p("Bolsa de Hielo para la Carne Asada", CAT.extras, 25, "Bolsa de hielo de 2 kg para conservar la carne.", "agua", ""));

export const PRODUCTOS: readonly ProductoDef[] = productos;
