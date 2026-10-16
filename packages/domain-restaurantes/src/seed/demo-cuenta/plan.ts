// Validacion de la definicion (`DemoCuentaDef`) y construccion del PLAN que renderiza `sql.ts` y consume `mundo.ts`. Puro: sin red ni fs. Si la definicion
// rompe una invariante lanza `DemoCuentaError` (nunca emite un plan a medias).
import { esTipoConocimiento, validarEntradaConocimiento } from "../../conocimiento/dominio.ts";
import { CONOCIMIENTO_TOPE_PROMPT } from "../../conocimiento/types.ts";
import { validarHorario, type HorarioSucursal } from "../../horarios.ts";
import { descripcionCompleta, ETIQUETA_GRAMOS, precioFraccion } from "./menu-util.ts";
import type { DemoCuentaDef, ProductoDef, SucursalDef, SucursalId } from "./tipos.ts";

export class DemoCuentaError extends Error {}

function fail(message: string): never {
  throw new DemoCuentaError(message);
}

export const SLUG_DEMO_VIEJA = "demo-restaurantes";
export const GRAMOS_VALIDOS: readonly number[] = [250, 500, 750, 1000, 1500, 2000];
export const LIMITES_AGENTE = { agentName: 60, businessName: 120, deliveryTimeText: 200, salsasText: 300, promosText: 300, largeOrderText: 200, greetingText: 80 } as const;
const TONOS = ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"];
const TLD_RESERVADOS = /\.(example|test|invalid|localhost)$/;
const TELEFONO_FICTICIO = /^(\d{2} 5555 01\d{2}|\d{3} 555 01\d{2})$/;
export const PESOS_CON_FRACCION = /^(.+) — (250 g|500 g|750 g|1\.5 kg|2 kg)$/;
const NOMBRE_KILO_BASE = /^(.+) — 1 kg$/;
const MAX_PRECIO = 20_000;

export function normalizar(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function slugify(text: string): string {
  const slug = normalizar(text).replace(/ /g, "-");
  if (!slug) fail(`slugify: "${text}" no produce un slug valido`);
  return slug;
}

/** Precio de lista de un producto en una sucursal (null si no se vende). Reglas: fraccion de kilo = kilo de la sucursal x peso (a $0.50); precio propio; o base x factor de ciudad (pesos enteros; de $100 en adelante, multiplos de $5). */
export function precioEnSucursal(def: DemoCuentaDef, producto: ProductoDef, id: SucursalId): number | null {
  if (producto.noSeVendeEn?.includes(id)) return null;
  if (producto.fraccionKg) {
    const base = def.productos.find((x) => x.nombre === producto.fraccionKg!.base);
    if (!base) return null;
    const precioKilo = precioEnSucursal(def, base, id);
    return precioKilo === null ? null : precioFraccion(precioKilo, producto.fraccionKg.gramos);
  }
  const propio = producto.precios?.[id];
  if (propio !== undefined) return propio;
  const bruto = producto.precio * def.factorPrecio[id];
  return bruto < 100 ? Math.round(bruto) : Math.round(bruto / 5) * 5;
}

export interface PlanSucursal {
  readonly id: SucursalId;
  readonly name: string;
  readonly slug: string;
  readonly status: "active";
  readonly phone: string;
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
  readonly displayOrder: number;
  readonly zonaHoraria: string;
  readonly horario: HorarioSucursal;
  readonly pedidoMinimoDomicilio: number;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: string;
  readonly aceptaDomicilio: boolean;
  readonly diasDomicilio: readonly number[] | null;
  readonly deliveryTimeText: string;
  readonly catalogSize: number;
}

export interface PlanProducto {
  readonly name: string;
  readonly categorySlug: string;
  readonly price: number;
  readonly branchPrices: Readonly<Record<string, number>>;
  /** Sucursales donde existe pero hoy esta agotado. */
  readonly unavailableIn: readonly string[];
  readonly description: string;
  readonly isPopular: boolean;
  readonly noDomicilio: boolean;
  readonly displayOrder: number;
  readonly searchKeywords: readonly string[];
}

export interface PlanPromocion {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly type: "bogo" | "cortesia" | "percentage";
  readonly value: number;
  readonly minOrderTotal: number | null;
  readonly daysOfWeek: readonly number[] | null;
  readonly channels: readonly string[];
  readonly productNames: readonly string[];
  readonly courtesyProductNames: readonly string[] | null;
  readonly courtesyQuantity: number | null;
  readonly branchIds: readonly string[] | null;
  readonly autoApply: true;
}

export interface DemoCuentaPlan {
  readonly organization: { readonly name: string; readonly slug: string; readonly seedVersion: string };
  readonly branches: readonly PlanSucursal[];
  readonly categories: readonly { readonly name: string; readonly slug: string; readonly displayOrder: number }[];
  readonly products: readonly PlanProducto[];
  readonly zones: readonly { readonly name: string; readonly lat: number; readonly lng: number; readonly branchId: string }[];
  readonly colonias: readonly { readonly name: string; readonly branchIds: readonly string[]; readonly refSlug: string; readonly refKm: number; readonly ref2Slug: string | null; readonly ref2Km: number | null }[];
  readonly promotions: readonly PlanPromocion[];
  readonly conocimiento: readonly { readonly titulo: string; readonly texto: string; readonly tipo: string; readonly prioridad: number }[];
  readonly whatsappAgent: {
    readonly perfil: "generico";
    readonly agentName: string;
    readonly businessName: string;
    readonly toneStyle: string;
    readonly deliveryTimeText: string;
    readonly greetingText: string;
    readonly salsasText: string;
    readonly promosText: string;
    readonly largeOrderText: string;
    readonly replyDebounceSeconds: number;
    readonly deliveryByBranch: readonly { readonly branchId: string; readonly deliveryTimeText: string }[];
  };
  readonly demo: { readonly seedVersion: string };
  readonly summary: {
    readonly branches: number;
    readonly products: number;
    readonly alcoholProducts: number;
    readonly branchProducts: number;
    readonly unavailableBranchProducts: number;
    readonly colonias: number;
    readonly coberturas: number;
    readonly promotions: number;
    readonly conocimiento: number;
    readonly categories: number;
    readonly productsByBranch: Readonly<Record<string, number>>;
  };
}

const esPrecioValido = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_PRECIO;
const dosDecimales = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

function validarSucursal(b: SucursalDef, vistos: { slugs: Set<string>; ids: Set<string>; nombres: Set<string>; telefonos: Set<string> }): HorarioSucursal {
  if (vistos.ids.has(b.id)) fail(`Sucursal duplicada: ${b.id}`);
  vistos.ids.add(b.id);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(b.slug) || vistos.slugs.has(b.slug)) fail(`Slug de sucursal invalido o duplicado: ${b.slug}`);
  vistos.slugs.add(b.slug);
  if (!b.nombre.trim() || vistos.nombres.has(normalizar(b.nombre))) fail(`Nombre de sucursal invalido o duplicado: ${b.nombre}`);
  vistos.nombres.add(normalizar(b.nombre));
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: b.zonaHoraria });
  } catch {
    fail(`${b.nombre}: zona horaria invalida (${b.zonaHoraria}).`);
  }
  if (!TELEFONO_FICTICIO.test(b.telefono)) fail(`${b.nombre}: el telefono ${b.telefono} no esta en el bloque ficticio (lada + 5555 01xx o 555 01xx).`);
  if (vistos.telefonos.has(b.telefono)) fail(`${b.nombre}: telefono repetido.`);
  vistos.telefonos.add(b.telefono);
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng) || b.lat < 14 || b.lat > 33 || b.lng < -119 || b.lng > -86) fail(`${b.nombre}: coordenadas fuera de Mexico.`);
  if (!esPrecioValido(b.pedidoMinimoDomicilio)) fail(`${b.nombre}: pedido minimo a domicilio invalido.`);
  if (b.pedidoMinimoRecoger !== null && (!Number.isFinite(b.pedidoMinimoRecoger) || b.pedidoMinimoRecoger < 0)) fail(`${b.nombre}: pedido minimo para recoger invalido.`);
  if (!["nunca", "siempre", "solo_tarjeta"].includes(b.propina)) fail(`${b.nombre}: propina invalida.`);
  if (!(b.radioRepartoKm > 0 && b.radioRepartoKm <= 20)) fail(`${b.nombre}: radio de reparto invalido.`);
  if (!(b.pesoVolumen > 0) || !(b.fraccionRecoger >= 0 && b.fraccionRecoger <= 1)) fail(`${b.nombre}: pesos de volumen invalidos.`);
  if (b.diasDomicilio && (b.diasDomicilio.length === 0 || b.diasDomicilio.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) fail(`${b.nombre}: dias de domicilio invalidos.`);
  if (b.tiempoEntrega.length === 0 || b.tiempoEntrega.length > LIMITES_AGENTE.deliveryTimeText) fail(`${b.nombre}: texto de tiempo de entrega invalido.`);
  try {
    return validarHorario(b.horario.map((t) => ({ dias: [...t.dias], abre: t.abre, cierra: t.cierra })));
  } catch (err) {
    return fail(`${b.nombre}: horario invalido: ${(err as Error).message}`);
  }
}

export function construirPlanDemoCuenta(def: DemoCuentaDef): DemoCuentaPlan {
  const org = def.organizacion;
  if (!org.nombre.trim() || !/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(org.slug)) fail("Organizacion invalida (nombre o slug).");
  if (org.slug === SLUG_DEMO_VIEJA) fail(`El slug ${SLUG_DEMO_VIEJA} es de la demo vieja: esta cuenta no puede usarlo.`);
  if (!org.version || org.version.length > 60) fail("version de la definicion invalida (1 a 60 caracteres).");

  // --- marca -------------------------------------------------------------------------------------------------------------------------------------
  const m = def.marca;
  if (!TLD_RESERVADOS.test(m.dominio)) fail(`El dominio ${m.dominio} no usa un TLD reservado (.example, .test, .invalid).`);
  for (const [clave, correo] of Object.entries(m.correos)) {
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/.test(correo) || !correo.endsWith(`@${m.dominio}`)) fail(`Correo ${clave} invalido o fuera del dominio ficticio: ${correo}`);
  }
  for (const color of Object.values(m.colores)) if (!/^#[0-9a-f]{6}$/i.test(color)) fail(`Color de marca invalido: ${color}`);
  if (!m.slogan.trim() || !m.nombre.trim()) fail("La marca necesita nombre y slogan.");

  // --- sucursales ---------------------------------------------------------------------------------------------------------------------------------
  if (def.sucursales.length < 5 || def.sucursales.length > 7) fail(`La cadena debe tener entre 5 y 7 sucursales (tiene ${def.sucursales.length}).`);
  const vistos = { slugs: new Set<string>(), ids: new Set<string>(), nombres: new Set<string>(), telefonos: new Set<string>() };
  const horarios = new Map<string, HorarioSucursal>();
  for (const b of def.sucursales) horarios.set(b.id, validarSucursal(b, vistos));
  const ciudades = new Set(def.sucursales.map((b) => b.ciudad));
  if (ciudades.size < 3) fail("La cadena debe estar en al menos 3 ciudades.");
  const ids = new Set<string>(def.sucursales.map((b) => b.id));
  for (const id of ids) if (!(id in def.factorPrecio) || !(def.factorPrecio[id as SucursalId] > 0)) fail(`Falta factor de precio de ${id}.`);
  const slugPorId = new Map(def.sucursales.map((b) => [b.id, b.slug] as const));

  // --- categorias y productos ---------------------------------------------------------------------------------------------------------------------
  const categorias = def.categorias.map((name, displayOrder) => ({ name, slug: slugify(name), displayOrder }));
  if (new Set(categorias.map((c) => c.slug)).size !== categorias.length) fail("Categorias duplicadas.");
  const categoriaSlug = new Map(categorias.map((c) => [c.name, c.slug] as const));
  const nombres = new Map<string, ProductoDef>();
  for (const prod of def.productos) {
    const clave = normalizar(prod.nombre);
    if (!prod.nombre.trim() || nombres.has(clave)) fail(`Producto duplicado o sin nombre: "${prod.nombre}".`);
    nombres.set(clave, prod);
  }
  const productsByBranch: Record<string, number> = Object.fromEntries(def.sucursales.map((b) => [b.id, 0]));
  let alcohol = 0;
  let branchProducts = 0;
  let unavailable = 0;
  const usadasEnCategoria = new Set<string>();
  const products: PlanProducto[] = def.productos.map((prod, displayOrder) => {
    const categorySlug = categoriaSlug.get(prod.categoria);
    if (!categorySlug) fail(`Producto "${prod.nombre}": categoria desconocida "${prod.categoria}".`);
    usadasEnCategoria.add(prod.categoria);
    if (prod.descripcion.trim().length < 5) fail(`Producto "${prod.nombre}": descripcion demasiado corta.`);
    if (prod.ingredientes.length === 0) fail(`Producto "${prod.nombre}": declare sus ingredientes (el agente no inventa).`);
    if (new Set(prod.alergenos).size !== prod.alergenos.length) fail(`Producto "${prod.nombre}": alergenos repetidos.`);
    for (const alias of prod.alias ?? []) if (!/^[a-záéíóúüñ0-9][a-záéíóúüñ0-9.-]{0,38}$/.test(alias)) fail(`Producto "${prod.nombre}": alias invalido "${alias}" (una palabra en minusculas).`);
    // Kilos: el nombre con peso y `fraccionKg` van juntos; la base debe ser "— 1 kg" y el nombre debe corresponder al peso.
    const fraccion = PESOS_CON_FRACCION.exec(prod.nombre);
    if ((fraccion !== null) !== (prod.fraccionKg !== undefined)) fail(`Producto "${prod.nombre}": una fraccion de peso ("— 250 g | 500 g | 750 g | 1.5 kg | 2 kg") debe declarar fraccionKg y solo ellas.`);
    if (prod.fraccionKg) {
      const base = def.productos.find((x) => x.nombre === prod.fraccionKg!.base);
      if (!base || !NOMBRE_KILO_BASE.test(base.nombre)) fail(`Producto "${prod.nombre}": su base "${prod.fraccionKg.base}" debe ser un producto "— 1 kg".`);
      if (!GRAMOS_VALIDOS.includes(prod.fraccionKg.gramos) || prod.fraccionKg.gramos === 1000) fail(`Producto "${prod.nombre}": fraccion de ${prod.fraccionKg.gramos} g no valida (250, 500, 750, 1500 o 2000).`);
      const etiqueta = ETIQUETA_GRAMOS[prod.fraccionKg.gramos] ?? (prod.fraccionKg.gramos === 750 ? "750 g" : "");
      if (prod.nombre !== `${NOMBRE_KILO_BASE.exec(base.nombre)![1]} — ${etiqueta}`) fail(`Producto "${prod.nombre}": el nombre no corresponde a su base y a sus gramos.`);
      if (base.categoria !== prod.categoria) fail(`Producto "${prod.nombre}": debe estar en la categoria de su kilo base.`);
      if ((base.noSeVendeEn ?? []).join() !== (prod.noSeVendeEn ?? []).join()) fail(`Producto "${prod.nombre}": se vende en las mismas sucursales que su kilo base.`);
    } else if (!(prod.precio > 0)) {
      fail(`Producto "${prod.nombre}": precio base invalido.`);
    }
    for (const s of [...(prod.noSeVendeEn ?? []), ...(prod.agotadoEn ?? []), ...Object.keys(prod.precios ?? {})]) if (!ids.has(s)) fail(`Producto "${prod.nombre}": sucursal desconocida "${s}".`);
    for (const s of prod.agotadoEn ?? []) if (prod.noSeVendeEn?.includes(s)) fail(`Producto "${prod.nombre}": no puede estar agotado donde no se vende (${s}).`);
    const branchPrices: Record<string, number> = {};
    for (const b of def.sucursales) {
      const precio = precioEnSucursal(def, prod, b.id);
      if (precio === null) continue;
      if (!esPrecioValido(precio) || !dosDecimales(precio)) fail(`Producto "${prod.nombre}": precio invalido en ${b.id} (${precio}).`);
      // Pesos enteros salvo las fracciones de peso, que pueden traer $0.50.
      if (precio % 1 !== 0 && !(prod.fraccionKg && (precio * 2) % 1 === 0)) fail(`Producto "${prod.nombre}": precio con centavos en ${b.id} (${precio}).`);
      branchPrices[b.id] = precio;
      productsByBranch[b.id] = (productsByBranch[b.id] ?? 0) + 1;
      branchProducts += 1;
      if (prod.agotadoEn?.includes(b.id)) unavailable += 1;
    }
    if (Object.keys(branchPrices).length === 0) fail(`Producto "${prod.nombre}": no se vende en ninguna sucursal.`);
    if (prod.esAlcohol) alcohol += 1;
    // El motor pide confirmacion de mayoria de edad solo en estas dos categorias: el alcohol debe vivir ahi.
    if (prod.esAlcohol && !/^(Cervezas|Licores y Cocktails)$/.test(prod.categoria)) fail(`Producto "${prod.nombre}": el alcohol debe estar en «Cervezas» o «Licores y Cocktails».`);
    if (!prod.esAlcohol && /^(Cervezas|Licores y Cocktails)$/.test(prod.categoria) && !/(sin alcohol|cero)/i.test(prod.nombre)) fail(`Producto "${prod.nombre}": en una categoria de alcohol solo cabe una bebida sin alcohol si su nombre lo dice.`);
    const primero = def.sucursales.find((b) => b.id in branchPrices)!;
    return {
      name: prod.nombre,
      categorySlug,
      price: branchPrices[primero.id]!,
      branchPrices,
      unavailableIn: [...(prod.agotadoEn ?? [])],
      description: descripcionCompleta(prod),
      isPopular: prod.popular === true,
      noDomicilio: prod.esAlcohol === true,
      displayOrder,
      searchKeywords: [...(prod.alias ?? [])],
    };
  });
  if (alcohol === 0) fail("El menu no marca ningun producto de alcohol como no_domicilio.");
  for (const c of categorias) if (!usadasEnCategoria.has(c.name)) fail(`Categoria sin productos: ${c.name}`);
  if (products.length < 220 || products.length > 300) fail(`El menu debe tener entre 220 y 300 productos (tiene ${products.length}).`);
  for (const b of def.sucursales) if ((productsByBranch[b.id] ?? 0) < 200) fail(`${b.nombre}: una sucursal necesita al menos 200 productos (tiene ${productsByBranch[b.id] ?? 0}).`);

  // --- modificadores ------------------------------------------------------------------------------------------------------------------------------
  const idsMod = new Set<string>();
  for (const mod of def.modificadores) {
    if (!mod.id || idsMod.has(mod.id)) fail(`Modificador duplicado o sin id: ${mod.id}`);
    idsMod.add(mod.id);
    if (!(Number.isInteger(mod.min) && Number.isInteger(mod.max) && mod.min >= 0 && mod.max >= mod.min && mod.max <= 5)) fail(`Modificador ${mod.id}: limites invalidos (min ${mod.min}, max ${mod.max}).`);
    if (mod.opciones.length === 0 || new Set(mod.opciones).size !== mod.opciones.length) fail(`Modificador ${mod.id}: opciones vacias o repetidas.`);
    if (mod.max > mod.opciones.length && mod.tipo !== "extra") fail(`Modificador ${mod.id}: el maximo supera sus opciones.`);
    if (mod.aplicaA.length === 0) fail(`Modificador ${mod.id}: debe aplicar a algo.`);
    for (const destino of mod.aplicaA) if (!categoriaSlug.has(destino) && !nombres.has(normalizar(destino))) fail(`Modificador ${mod.id}: «${destino}» no es una categoria ni un producto.`);
  }

  // --- colonias -----------------------------------------------------------------------------------------------------------------------------------
  const puntosSucursal = new Set(def.sucursales.map((b) => normalizar(b.nombre)));
  const coloniasVistas = new Set<string>();
  const radio = new Map(def.sucursales.map((b) => [b.id, b.radioRepartoKm] as const));
  let coberturas = 0;
  const colonias = def.colonias.map((c) => {
    const clave = normalizar(c.nombre);
    if (clave.length < 4 || c.nombre.length > 120) fail(`Colonia invalida: ${c.nombre}`);
    if (coloniasVistas.has(clave) || puntosSucursal.has(clave)) fail(`Colonia duplicada (o igual al nombre de una sucursal): ${c.nombre}`);
    coloniasVistas.add(clave);
    if (c.sucursales.length === 0 || new Set(c.sucursales).size !== c.sucursales.length) fail(`Colonia ${c.nombre}: sucursales vacias o repetidas.`);
    for (const s of c.sucursales) {
      if (!ids.has(s)) fail(`Colonia ${c.nombre}: la sucursal ${s} no existe.`);
      const suc = def.sucursales.find((b) => b.id === s)!;
      if (!suc.acepta_domicilio) fail(`Colonia ${c.nombre}: ${s} no reparte a domicilio.`);
    }
    if (!(c.km > 0)) fail(`Colonia ${c.nombre}: km invalidos.`);
    if (c.km > radio.get(c.sucursales[0]!)!) fail(`Colonia ${c.nombre}: ${c.km} km exceden el radio de reparto de ${c.sucursales[0]}.`);
    // Coherencia ciudad-colonia: las sucursales que comparten una colonia deben ser de la misma ciudad.
    const ciudadesColonia = new Set(c.sucursales.map((s) => def.sucursales.find((b) => b.id === s)!.ciudad));
    if (ciudadesColonia.size !== 1) fail(`Colonia ${c.nombre}: la cubren sucursales de ciudades distintas.`);
    coberturas += c.sucursales.length;
    return {
      name: c.nombre,
      branchIds: [...c.sucursales],
      refSlug: slugPorId.get(c.sucursales[0]!)!,
      refKm: c.km,
      ref2Slug: c.sucursales[1] ? slugPorId.get(c.sucursales[1])! : null,
      ref2Km: c.sucursales[1] ? Math.round((c.km + 1.2) * 10) / 10 : null,
    };
  });
  for (const b of def.sucursales) if (b.acepta_domicilio && colonias.filter((c) => c.branchIds[0] === b.id).length < 10) fail(`${b.nombre}: necesita al menos 10 colonias de reparto.`);

  // --- promociones --------------------------------------------------------------------------------------------------------------------------------
  const codigos = new Set<string>();
  const nombresExactos = new Set(def.productos.map((x) => x.nombre));
  const promotions: PlanPromocion[] = def.promociones.map((pr) => {
    if (!/^[A-Z0-9_-]{3,40}$/.test(pr.codigo) || codigos.has(pr.codigo)) fail(`Codigo de promocion invalido o duplicado: ${pr.codigo}`);
    codigos.add(pr.codigo);
    if (pr.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(pr.dias).size !== pr.dias.length) fail(`${pr.codigo}: dias invalidos.`);
    if (pr.canales.length === 0 || pr.canales.length > 2 || new Set(pr.canales).size !== pr.canales.length) fail(`${pr.codigo}: canales invalidos.`);
    for (const n of [...(pr.productos ?? []), ...(pr.cortesiaProductos ?? [])]) if (!nombresExactos.has(n)) fail(`${pr.codigo}: el producto "${n}" no existe en el menu.`);
    for (const s of pr.sucursales ?? []) if (!ids.has(s)) fail(`${pr.codigo}: la sucursal "${s}" no existe.`);
    if (pr.montoMinimo !== undefined && !(pr.montoMinimo > 0)) fail(`${pr.codigo}: monto minimo invalido.`);
    if (pr.tipo === "bogo") {
      if (!pr.productos || pr.productos.length === 0) fail(`${pr.codigo}: un 2x1 necesita productos elegibles.`);
      if (pr.cortesiaProductos || pr.cortesiaCantidad !== undefined || pr.porcentaje !== undefined) fail(`${pr.codigo}: un 2x1 no lleva cortesia ni porcentaje.`);
    } else if (pr.tipo === "cortesia") {
      if (!pr.productos?.length || !pr.cortesiaProductos?.length) fail(`${pr.codigo}: una cortesia necesita productos disparadores y de cortesia.`);
      if (!Number.isInteger(pr.cortesiaCantidad) || (pr.cortesiaCantidad as number) < 1 || (pr.cortesiaCantidad as number) > 10) fail(`${pr.codigo}: cortesiaCantidad debe ser un entero de 1 a 10.`);
      if (pr.porcentaje !== undefined) fail(`${pr.codigo}: una cortesia no lleva porcentaje.`);
    } else if (pr.tipo === "percentage") {
      if (!(Number.isInteger(pr.porcentaje) && (pr.porcentaje as number) >= 1 && (pr.porcentaje as number) <= 100)) fail(`${pr.codigo}: el porcentaje debe ser un entero de 1 a 100.`);
      if (pr.cortesiaProductos || pr.cortesiaCantidad !== undefined) fail(`${pr.codigo}: un porcentaje no lleva cortesia.`);
    } else fail(`${pr.codigo}: tipo invalido.`);
    return {
      code: pr.codigo,
      name: pr.nombre,
      description: pr.descripcion,
      type: pr.tipo,
      value: pr.tipo === "percentage" ? (pr.porcentaje as number) : 1,
      minOrderTotal: pr.montoMinimo ?? null,
      daysOfWeek: pr.dias.length > 0 ? [...pr.dias] : null,
      channels: [...pr.canales],
      productNames: [...(pr.productos ?? [])],
      courtesyProductNames: pr.tipo === "cortesia" ? [...(pr.cortesiaProductos as readonly string[])] : null,
      courtesyQuantity: pr.tipo === "cortesia" ? (pr.cortesiaCantidad as number) : null,
      branchIds: pr.sucursales ? [...pr.sucursales] : null,
      autoApply: true as const,
    };
  });
  // Los requisitos del encargo: un 2x1 que no sea lunes, una cortesia por monto, un combo del dia y una promo solo para recoger.
  const bogo = promotions.find((x) => x.type === "bogo");
  if (!bogo || !bogo.daysOfWeek || bogo.daysOfWeek.includes(1)) fail("Debe haber un 2x1 que no sea lunes.");
  if (!promotions.some((x) => x.type === "cortesia" && x.minOrderTotal !== null)) fail("Debe haber una cortesia por monto de pedido.");
  if (!promotions.some((x) => x.type === "cortesia" && x.daysOfWeek !== null && x.daysOfWeek.length === 1)) fail("Debe haber un combo del dia (cortesia de un dia).");
  if (!promotions.some((x) => x.channels.length === 1 && x.channels[0] === "recoger")) fail("Debe haber una promo solo para recoger.");

  // --- conocimiento -------------------------------------------------------------------------------------------------------------------------------
  const titulos = new Set<string>();
  let caracteres = 0;
  const conocimiento = def.conocimiento.map((c) => {
    if (!esTipoConocimiento(c.tipo)) fail(`Conocimiento "${c.titulo}": tipo invalido (${c.tipo}).`);
    const v = validarEntradaConocimiento({ titulo: c.titulo, texto: c.texto }, [...nombresExactos]);
    if (!v.ok) fail(`Conocimiento "${c.titulo}": ${v.mensaje}`);
    if (titulos.has(v.titulo)) fail(`Conocimiento duplicado: ${v.titulo}`);
    titulos.add(v.titulo);
    caracteres += v.titulo.length + v.texto.length;
    if (!Number.isInteger(c.prioridad) || c.prioridad < 0 || c.prioridad > 100) fail(`Conocimiento "${c.titulo}": prioridad de 0 a 100.`);
    return { titulo: v.titulo, texto: v.texto, tipo: c.tipo, prioridad: c.prioridad };
  });
  if (conocimiento.length < 15) fail("El conocimiento debe tener al menos 15 entradas.");
  if (caracteres > CONOCIMIENTO_TOPE_PROMPT * 0.85) fail(`El conocimiento (${caracteres} caracteres) rebasa el 85% del tope del prompt (${CONOCIMIENTO_TOPE_PROMPT}).`);

  // --- agente -------------------------------------------------------------------------------------------------------------------------------------
  const a = def.agente;
  const largo = (valor: string, campo: keyof typeof LIMITES_AGENTE) => {
    if (typeof valor !== "string" || valor.trim().length === 0 || valor.length > LIMITES_AGENTE[campo]) fail(`agente: ${campo} debe tener entre 1 y ${LIMITES_AGENTE[campo]} caracteres.`);
  };
  largo(a.nombre, "agentName");
  largo(a.saludo, "greetingText");
  largo(a.salsas, "salsasText");
  largo(a.promociones, "promosText");
  largo(a.tiempoEntrega, "deliveryTimeText");
  largo(a.umbralPedidoGrande, "largeOrderText");
  largo(m.nombre, "businessName");
  if (!TONOS.includes(a.tono)) fail(`agente: tono invalido (${a.tono}).`);
  if (!Number.isInteger(a.esperaRafagasSegundos) || a.esperaRafagasSegundos < 0 || a.esperaRafagasSegundos > 10) fail("agente: la espera de rafagas debe ser un entero de 0 a 10.");
  // Lo que el agente anuncia debe existir como promocion cargada (nunca promete un descuento que la cotizacion no muestre).
  if (/jueves|2x1/i.test(a.promociones) && !promotions.some((x) => x.type === "bogo" && x.daysOfWeek?.includes(4))) fail("agente.promociones menciona el 2x1 del jueves, que NO esta cargado.");
  if (/mi[eé]rcoles|burrito/i.test(a.promociones) && !promotions.some((x) => x.type === "cortesia" && x.daysOfWeek?.includes(3))) fail("agente.promociones menciona el combo del miercoles, que NO esta cargado.");
  if (/martes/i.test(a.promociones) && !promotions.some((x) => x.type === "percentage" && x.daysOfWeek?.includes(2))) fail("agente.promociones menciona el martes, que NO esta cargado.");

  const branches: PlanSucursal[] = def.sucursales.map((b, displayOrder) => ({
    id: b.id,
    name: b.nombre,
    slug: b.slug,
    status: "active",
    phone: b.telefono,
    address: b.direccion,
    lat: b.lat,
    lng: b.lng,
    displayOrder,
    zonaHoraria: b.zonaHoraria,
    horario: horarios.get(b.id)!,
    pedidoMinimoDomicilio: b.pedidoMinimoDomicilio,
    pedidoMinimoRecoger: b.pedidoMinimoRecoger,
    propinaPolitica: b.propina,
    aceptaDomicilio: b.acepta_domicilio,
    diasDomicilio: b.diasDomicilio ? [...b.diasDomicilio] : null,
    deliveryTimeText: b.tiempoEntrega,
    catalogSize: productsByBranch[b.id] ?? 0,
  }));

  return {
    organization: { name: `${org.nombre} (demo)`, slug: org.slug, seedVersion: org.version },
    branches,
    categories: categorias,
    products,
    zones: def.sucursales.map((b) => ({ name: b.nombre, lat: b.lat, lng: b.lng, branchId: b.id })),
    colonias,
    promotions,
    conocimiento,
    whatsappAgent: {
      perfil: "generico",
      agentName: a.nombre,
      businessName: m.nombre,
      toneStyle: a.tono,
      deliveryTimeText: a.tiempoEntrega,
      greetingText: a.saludo,
      salsasText: a.salsas,
      promosText: a.promociones,
      largeOrderText: a.umbralPedidoGrande,
      replyDebounceSeconds: a.esperaRafagasSegundos,
      deliveryByBranch: def.sucursales.map((b) => ({ branchId: b.id, deliveryTimeText: b.tiempoEntrega })),
    },
    demo: { seedVersion: org.version },
    summary: {
      branches: branches.length,
      products: products.length,
      alcoholProducts: alcohol,
      branchProducts,
      unavailableBranchProducts: unavailable,
      colonias: colonias.length,
      coberturas,
      promotions: promotions.length,
      conocimiento: conocimiento.length,
      categories: categorias.length,
      productsByBranch,
    },
  };
}
