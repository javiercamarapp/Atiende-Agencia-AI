// R-01 -- cuenta demo "Los Taquitos de PM": plan de seed REPETIBLE e idempotente.
//
// Este modulo es PURO: valida el recorte de datos de PM (scripts/seed-pm-demo/data/pm-seed-data.json,
// derivado de pm-datos.json: cuestionario del dueño + repo, sin volumenes de pedidos) y lo convierte en
// (a) un plan tipado (`buildPmSeedPlan`) y (b) el cuerpo de UN bloque plpgsql idempotente
// (`renderPmSeedPlpgsql`). Nunca abre una conexion: quien lo ejecuta es la CLI
// `scripts/seed-pm-demo/seed-pm-demo.ts` (con banderas explicitas, ver ahi) o el verify contra Postgres
// real `scripts/verify-restaurantes-seed-pm/` (que lo ejecuta dos veces para probar idempotencia).
//
// Reglas del modelo PM que el plan garantiza (y `buildPmSeedPlan` verifica antes de emitir SQL):
//   * 7 sucursales (T1, T2, T3, T4 Galerias, T5 Playa/Chicxulub, T7, T8). El catalogo y el precio de cada una
//     salen de `precios_por_sucursal` de cada producto, ligados a los menus impresos T1-2026, T5-2026 y T3-2025
//     (scripts/seed-pm-demo/data/menus-impresos/): una sucursal sin llave de precio NO vende ese producto.
//     T2, T7 y T8 no se cargan mientras Javier no conteste P5 (quedan inactivas y sin catalogo); T4 se registra
//     inactiva y sin catalogo (sin pedidos, P9); T5 queda inactiva (fuera de temporada) pero con su catalogo.
//   * Todo producto de alcohol queda `no_domicilio = true` (el cuestionario prohibe alcohol a domicilio).
//   * `products.price` es solo el precio de REFERENCIA (T1-2026, o el primero disponible); la cotizacion usa el
//     `branch_products.price` de cada sucursal. Nunca hay centavos ni fracciones de kilo (P11).
//   * Horario 12:00-01:00 todos los dias (una franja: la hora de cambio de turno no esta definida y no
//     se inventa), pedido minimo a domicilio $200, propina solo con tarjeta.
//   * Promociones: solo el 2x1 del lunes (solo recoger). El combo del martes no se modela (ver
//     `promociones_no_modeladas` en los datos).
//   * Sin gasto de proveedores: la voz se carga DESHABILITADA (`habilitado = false`).
//   * Sin secretos ni usuarios: nunca crea credenciales; la membresia del dueño es opcional y solo
//     enlaza a un usuario de staff que YA existe.
import { validarHorario } from "../horarios.ts";
import { COMPORTAMIENTO_VOZ_MAX, comportamientoVozPm } from "../voz/perfil-voz-pm.ts";
import { PM_AGENT_NAME_POR_OMISION } from "../whatsapp/perfil-pm.ts";

export interface PmSeedBranch {
  readonly id: string;
  readonly nombre: string;
  readonly slug: string;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  /** `true` = las coordenadas son aproximadas (del repo): se guardan en la sucursal pero NO entran en `known_zone`. */
  readonly coordenadas_aproximadas?: boolean;
  /** Una sucursal activa necesita su catalogo (>= `MIN_PRODUCTOS_SUCURSAL_ACTIVA` productos). */
  readonly activa: boolean;
  readonly zona_cliente?: string;
  readonly nota?: string;
  /** Slugs que esta sucursal tuvo en versiones anteriores del seed (p. ej. `t4-pendiente`). Re-ejecutar el seed sobre una base con
   * la version anterior RENOMBRA la fila existente en vez de insertar otra y chocar con unique(slug) o duplicarla. */
  readonly slugs_anteriores?: readonly string[];
  /** Nombres anteriores (misma razon: el seed ya no identifica sucursales solo por nombre). */
  readonly nombres_anteriores?: readonly string[];
}

/** `impreso` = precio del menu impreso de la sucursal; `provisional_P5` = propuesta pendiente del OK de Javier (solo T2, T7 y T8). */
export type PmFuentePrecio = "impreso" | "provisional_P5";

export interface PmSeedProduct {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  readonly es_alcohol: boolean;
  readonly popular: boolean;
  /** Item de los menus impresos del que sale el precio (categoria + nombre impreso). Obligatorio si alguna fuente es `impreso`. */
  readonly impreso?: { readonly categoria: string; readonly item: string };
  /** id de sucursal (T1, T3...) -> precio entero en MXN. Si una sucursal no tiene la llave, el producto no existe en ella. */
  readonly precios_por_sucursal: Readonly<Record<string, number>>;
  /** Procedencia de cada precio; mismas llaves que `precios_por_sucursal`. */
  readonly fuente_precio: Readonly<Record<string, PmFuentePrecio>>;
}

export interface PmSeedPromotion {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: "bogo";
  readonly dias: readonly number[];
  readonly canales: readonly ("domicilio" | "recoger")[];
  readonly productos: readonly string[];
  readonly descripcion: string;
  /** Sucursales donde aplica (dato para la migracion de alcance por sucursal de PM-C2; hoy el SQL del seed no lo usa). */
  readonly sucursales?: readonly string[];
}

export interface PmSeedData {
  readonly version: string;
  readonly organizacion: { readonly nombre: string; readonly slug: string; readonly ciudad: string; readonly zona_horaria: string };
  readonly sucursales: readonly PmSeedBranch[];
  readonly horario_general: { readonly abre: string; readonly cierra: string; readonly dias: readonly number[] };
  readonly reglas: { readonly pedido_minimo_domicilio: number; readonly pedido_minimo_recoger: number | null; readonly propina_politica: "nunca" | "siempre" | "solo_tarjeta" };
  readonly categorias: readonly string[];
  readonly productos: readonly PmSeedProduct[];
  readonly promociones: readonly PmSeedPromotion[];
  readonly promociones_no_modeladas: readonly { readonly id: string; readonly nombre: string; readonly motivo: string }[];
  readonly agente: { readonly voice_id: string; readonly saludo: string };
  /** Configuracion del agente de WhatsApp (migraciones 029/033): perfil `taqueria_pm` con los textos editables del dueño. */
  readonly agente_whatsapp: {
    readonly perfil: "taqueria_pm";
    /** `null` = el dueño aun no lo define: no se inventa. */
    readonly nombre_agente: string | null;
    readonly tono: "calido_cercano" | "formal_directo" | "profesional_neutro" | "divertido_desenfadado";
    readonly tiempo_entrega: string;
    readonly salsas: string;
    readonly promociones: string;
    readonly motivos_escalacion_apagados: readonly string[];
    readonly reglas_duras: readonly string[];
  };
  /** Datos que el dueño (o un tercero) aun no entrego y que NO se inventan: alimentan el checklist de onboarding (R-33). */
  readonly pendientes_dueno: readonly PmSeedPendiente[];
}

export interface PmSeedPendiente {
  readonly id: string;
  readonly titulo: string;
  readonly detalle: string;
  readonly quien: "dueno" | "distribuidor_pos" | "plataforma";
  readonly pantalla: string;
  /** `resuelta` = Javier ya contesto (p. ej. `P5` abre la carga de T2, T7 y T8). Sin valor = abierta. */
  readonly estado?: "abierta" | "resuelta";
}

export interface PmAgentFiles {
  /** agente-pm-tools.json ya parseado. */
  readonly tools: unknown;
  /** agente-pm-evals.json ya parseado. */
  readonly evals: unknown;
}

export class PmSeedError extends Error {}

/** Limites reales de `restaurantes.branch_voice_config` (migracion 025). */
export const COMPORTAMIENTO_MAX = COMPORTAMIENTO_VOZ_MAX;
export const MENSAJE_INICIAL_MAX = 500;

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new PmSeedError(`slugify: "${text}" no produce un slug valido`);
  return slug;
}

function fail(message: string): never {
  throw new PmSeedError(message);
}

function esPrecio(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 100000;
}

/** El comportamiento de voz sembrado sale del MISMO perfil que WhatsApp (`comportamientoVozPm`), no de un archivo aparte. Falla si
 * PROMETE el combo del martes (nachos con aguas de cortesia: no esta cargado, P13) o si no trae la instruccion de que lo confirma la
 * sucursal; la palabra "martes" si puede aparecer porque el prompt debe decir justo eso. */
export function validarComportamientoVoz(comportamiento: string): void {
  if (/2 aguas de cortes[ií]a|dos aguas de cortes[ií]a|nachos[^.\n]{0,40}\b(2|dos) aguas|elige (dos|2) aguas/i.test(comportamiento)) {
    fail("El comportamiento de voz promete el combo del martes (aguas de cortesia), que NO esta cargado como promocion (P13).");
  }
  if (!/la confirma la sucursal al recoger/.test(comportamiento)) fail("El comportamiento de voz no dice que el combo del martes lo confirma la sucursal al recoger.");
  if (comportamiento.length > COMPORTAMIENTO_VOZ_MAX) fail(`El comportamiento del agente mide ${comportamiento.length} caracteres; el maximo es ${COMPORTAMIENTO_VOZ_MAX}.`);
}

/** Valida los archivos del agente (tools y evals) y la coherencia entre ellos. El prompt ya no es un archivo: ver `validarComportamientoVoz`. */
export function validarArchivosAgente(files: PmAgentFiles): { readonly herramientas: readonly string[]; readonly casos: number } {
  if (!Array.isArray(files.tools) || files.tools.length === 0) fail("tools.json debe ser una lista no vacia.");
  const nombres: string[] = [];
  for (const tool of files.tools as Array<Record<string, unknown>>) {
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" || typeof tool.input_schema !== "object" || tool.input_schema === null) {
      fail("Cada herramienta de tools.json necesita name, description e input_schema.");
    }
    if (nombres.includes(tool.name)) fail(`Herramienta duplicada en tools.json: ${tool.name}`);
    nombres.push(tool.name);
  }
  const evals = files.evals as { casos?: Array<Record<string, unknown>> } | null;
  if (!evals || !Array.isArray(evals.casos) || evals.casos.length === 0) fail("evals.json debe traer una lista `casos`.");
  const ids = new Set<string>();
  for (const caso of evals.casos) {
    if (typeof caso.id !== "string" || !caso.id) fail("Un caso de evals.json no tiene id.");
    if (ids.has(caso.id)) fail(`Caso duplicado en evals.json: ${caso.id}`);
    ids.add(caso.id);
  }
  return { herramientas: nombres, casos: evals.casos.length };
}

export interface PmSeedPlan {
  readonly organization: { readonly name: string; readonly slug: string; readonly timezone: string };
  readonly branches: readonly {
    /** id del seed (T1, T2...): llave de `products[].branchPrices`. */
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: "active" | "inactive";
    readonly phone: string | null;
    readonly address: string | null;
    readonly lat: number | null;
    readonly lng: number | null;
    readonly displayOrder: number;
    /** Identidades anteriores de la sucursal (ver `PmSeedBranch`): el SQL las renombra a `slug`/`name` en vez de duplicarlas. */
    readonly legacySlugs: readonly string[];
    readonly legacyNames: readonly string[];
    /** Cuantos productos vende la sucursal (0 = registrada sin catalogo). */
    readonly catalogSize: number;
  }[];
  readonly categories: readonly { readonly name: string; readonly slug: string; readonly displayOrder: number }[];
  readonly products: readonly {
    readonly name: string;
    readonly categorySlug: string;
    /** Precio de REFERENCIA (T1-2026 o el primero disponible): la cotizacion usa `branchPrices`. */
    readonly price: number;
    /** id de sucursal -> precio de esa sucursal. */
    readonly branchPrices: Readonly<Record<string, number>>;
    readonly description: string | null;
    readonly isPopular: boolean;
    readonly noDomicilio: boolean;
    readonly displayOrder: number;
  }[];
  readonly zones: readonly { readonly name: string; readonly lat: number; readonly lng: number }[];
  readonly policy: { readonly horario: unknown; readonly pedidoMinimoDomicilio: number; readonly pedidoMinimoRecoger: number | null; readonly propinaPolitica: string };
  readonly promotions: readonly {
    readonly code: string;
    readonly name: string;
    readonly description: string;
    readonly type: "bogo";
    readonly daysOfWeek: readonly number[];
    readonly channels: readonly string[];
    readonly productNames: readonly string[];
    /** Ids de sucursal donde aplica (PM-C2); `null` = sin restriccion declarada. El SQL del seed todavia no lo usa. */
    readonly branchIds: readonly string[] | null;
    /** Se aplica sola (sin codigo) al cotizar en el canal y dia que corresponden. El agente de WhatsApp NO manda codigos de
     * promocion: sin esto el 2x1 del lunes nunca se aplicaria y el cliente no veria el descuento en la cotizacion. */
    readonly autoApply: true;
  }[];
  readonly voice: { readonly voiceId: string; readonly comportamiento: string; readonly greetings: readonly { readonly branchSlug: string; readonly mensajeInicial: string }[] };
  /** Fila de `restaurantes.whatsapp_agent_config` de la organizacion (la voz sigue DESHABILITADA). */
  readonly whatsappAgent: {
    readonly perfil: "taqueria_pm";
    readonly agentName: string | null;
    readonly businessName: string;
    readonly toneStyle: string;
    readonly deliveryTimeText: string;
    readonly salsasText: string;
    readonly promosText: string;
    readonly escalationReasonsOff: readonly string[];
  };
  /** Pendientes del dueño que NO se inventan (checklist R-33). */
  readonly pendientes: readonly PmSeedPendiente[];
  /** Presente solo con `{ demo: true }`: la organizacion queda marcada en `restaurantes.demo_organization` (migracion 037). */
  readonly demo: { readonly seedVersion: string } | null;
  /** Resumen legible para el modo dry-run. */
  readonly summary: {
    readonly branches: number;
    readonly activeBranches: number;
    readonly products: number;
    readonly alcoholProducts: number;
    readonly branchProducts: number;
    readonly zones: number;
    readonly promotions: number;
    readonly skippedPromotions: readonly string[];
    /** Productos por id de sucursal. */
    readonly productsByBranch: Readonly<Record<string, number>>;
  };
}

/** Construye el plan y verifica TODAS las invariantes del modelo PM; lanza `PmSeedError` si los datos
 * las rompen (nunca emite un seed a medias). */
export interface PmSeedOptions {
  /** `true` = carga la cuenta como DEMO: slug `<slug>-demo`, nombre con sufijo "(demo)" y marca en `demo_organization`.
   * Sin la bandera el comportamiento es el de siempre (la cuenta real de PM). */
  readonly demo?: boolean;
}

/** Limites de `restaurantes.whatsapp_agent_config` (migraciones 029/033). */
export const WHATSAPP_AGENT_LIMITES = { agentName: 60, businessName: 120, deliveryTimeText: 200, salsasText: 300, promosText: 300 } as const;
const MOTIVOS_APAGABLES = ["pedido_grande", "zona_ambigua", "producto_agotado", "no_entiende"];
const TONOS = ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"];

export const PM_DEMO_SLUG_SUFFIX = "-demo";

/** Una sucursal ACTIVA vende al menos esto: el menu impreso mas chico (T3-2025) trae 211 productos. */
export const MIN_PRODUCTOS_SUCURSAL_ACTIVA = 150;
/** Sucursales cuyo catalogo espera la respuesta P5 de Javier (plan-integracion-cerebro, «Lo que NO entra»). */
export const SUCURSALES_PENDIENTES_P5: readonly string[] = ["T2", "T7", "T8"];
const PRECIO_BASE_ORDEN: readonly string[] = ["T1", "T5", "T3"];
const FRACCION_DE_KILO = / — (250|500|750) g$/;

/** Lo que cada sucursal NO vende segun los menus impresos y el repo (plan PM-C1 y P10): por categoria o por nombre. */
const EXCLUSIONES_POR_SUCURSAL: Readonly<Record<string, { readonly categorias: readonly string[]; readonly nombres: readonly string[] }>> = {
  T2: { categorias: ["Comida Regional", "Flautas de PM"], nombres: ["Ensalada de PM", "Jericallas", "Café"] },
  T3: { categorias: ["Comida Regional", "Flautas de PM", "Pizza Quesobich"], nombres: ["Ensalada de PM"] },
  T5: { categorias: ["Comida Regional", "Flautas de PM"], nombres: ["Sprite", "Sprite Cero"] },
};

export function buildPmSeedPlan(data: PmSeedData, agent: PmAgentFiles, options: PmSeedOptions = {}): PmSeedPlan {
  validarArchivosAgente(agent);

  if (!data.organizacion?.nombre || !/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(data.organizacion.slug)) fail("Organizacion invalida (nombre o slug).");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: data.organizacion.zona_horaria });
  } catch {
    fail(`Zona horaria invalida: ${data.organizacion.zona_horaria}`);
  }

  // --- sucursales -----------------------------------------------------------------------------
  if (data.sucursales.length !== 7) fail(`PM tiene 7 sucursales; los datos traen ${data.sucursales.length}.`);
  const slugs = new Set<string>();
  const nombres = new Set<string>();
  const branchIds = new Set<string>();
  for (const b of data.sucursales) {
    if (!/^[A-Za-z0-9]+$/.test(b.id) || branchIds.has(b.id)) fail(`Id de sucursal invalido o duplicado: ${b.id}`);
    branchIds.add(b.id);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(b.slug)) fail(`Slug de sucursal invalido: ${b.slug}`);
    if (slugs.has(b.slug) || nombres.has(b.nombre)) fail(`Sucursal duplicada: ${b.nombre}`);
    slugs.add(b.slug);
    nombres.add(b.nombre);
    for (const viejo of b.slugs_anteriores ?? []) if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(viejo) || viejo === b.slug) fail(`${b.nombre}: slug anterior invalido o igual al actual (${viejo}).`);
    for (const viejo of b.nombres_anteriores ?? []) if (!viejo.trim() || viejo === b.nombre) fail(`${b.nombre}: nombre anterior vacio o igual al actual.`);
    if ((b.lat === null) !== (b.lng === null)) fail(`${b.nombre}: lat y lng deben venir juntas.`);
    if (b.lat !== null && (b.lat < -90 || b.lat > 90 || (b.lng as number) < -180 || (b.lng as number) > 180)) fail(`${b.nombre}: coordenadas fuera de rango.`);
  }
  // Una identidad anterior nunca puede coincidir con la actual de OTRA sucursal: el renombrado dejaria dos filas peleando el mismo slug.
  for (const b of data.sucursales) {
    for (const viejo of b.slugs_anteriores ?? []) if (slugs.has(viejo)) fail(`${b.nombre}: el slug anterior "${viejo}" es el actual de otra sucursal.`);
    for (const viejo of b.nombres_anteriores ?? []) if (nombres.has(viejo)) fail(`${b.nombre}: el nombre anterior "${viejo}" es el actual de otra sucursal.`);
  }
  const t4 = data.sucursales.find((b) => b.id === "T4");
  if (!t4 || t4.activa) fail("T4 (Galerias) debe estar registrada como inactiva: no recibe pedidos (P9).");
  const p5Resuelta = (data.pendientes_dueno ?? []).some((p) => p.id === "P5" && p.estado === "resuelta");

  // --- horario / reglas ------------------------------------------------------------------------
  let horario: ReturnType<typeof validarHorario>;
  try {
    horario = validarHorario([{ dias: [...data.horario_general.dias], abre: data.horario_general.abre, cierra: data.horario_general.cierra }]);
  } catch (err) {
    return fail(`Horario invalido: ${(err as Error).message}`);
  }
  const { pedido_minimo_domicilio: minDom, pedido_minimo_recoger: minRec, propina_politica: propina } = data.reglas;
  if (!esPrecio(minDom)) fail("pedido_minimo_domicilio invalido.");
  if (minRec !== null && (typeof minRec !== "number" || minRec < 0)) fail("pedido_minimo_recoger invalido.");
  if (propina !== "nunca" && propina !== "siempre" && propina !== "solo_tarjeta") fail("propina_politica invalida.");

  // --- categorias y productos ------------------------------------------------------------------
  const categorias = data.categorias.map((name, index) => ({ name, slug: slugify(name), displayOrder: index }));
  const categoriaPorNombre = new Map(categorias.map((c) => [c.name, c.slug]));
  if (categoriaPorNombre.size !== categorias.length || new Set(categorias.map((c) => c.slug)).size !== categorias.length) fail("Categorias duplicadas.");
  const productNames = new Set<string>();
  const productsByBranch: Record<string, number> = Object.fromEntries(data.sucursales.map((br) => [br.id, 0]));
  const products = data.productos.map((p, index) => {
    const categorySlug = categoriaPorNombre.get(p.categoria);
    if (!categorySlug) fail(`Producto "${p.nombre}": categoria desconocida "${p.categoria}".`);
    if (!p.nombre.trim() || productNames.has(p.nombre)) fail(`Producto duplicado o sin nombre: "${p.nombre}".`);
    productNames.add(p.nombre);
    if (FRACCION_DE_KILO.test(p.nombre)) fail(`Producto "${p.nombre}": las fracciones de kilo (250, 500 y 750 g) no estan en ningun menu impreso (P11); solo se vende el kilo completo.`);
    const branchPrices: Record<string, number> = {};
    const entradas = Object.entries(p.precios_por_sucursal ?? {});
    if (entradas.length === 0) fail(`Producto "${p.nombre}": no tiene precio en ninguna sucursal.`);
    for (const [branchId, price] of entradas) {
      if (!branchIds.has(branchId)) fail(`Producto "${p.nombre}": sucursal desconocida "${branchId}" en precios_por_sucursal.`);
      if (!esPrecio(price)) fail(`Producto "${p.nombre}": precio invalido en ${branchId}.`);
      if (price % 1 !== 0) fail(`Producto "${p.nombre}": precio con centavos en ${branchId} (${price}); los menus impresos solo traen pesos enteros.`);
      const fuente = p.fuente_precio?.[branchId];
      if (fuente !== "impreso" && fuente !== "provisional_P5") fail(`Producto "${p.nombre}": falta fuente_precio (impreso | provisional_P5) en ${branchId}.`);
      if (fuente === "impreso" && !p.impreso) fail(`Producto "${p.nombre}": un precio impreso necesita el item del menu en \`impreso\`.`);
      const pendienteP5 = SUCURSALES_PENDIENTES_P5.includes(branchId);
      if (pendienteP5 && !p5Resuelta) fail(`Producto "${p.nombre}": ${branchId} no se carga mientras Javier no conteste P5 (pendientes_dueno P5 resuelta).`);
      if (fuente === "provisional_P5" && !pendienteP5) fail(`Producto "${p.nombre}": provisional_P5 solo aplica a T2, T7 y T8 (${branchId}).`);
      if (fuente === "impreso" && pendienteP5) fail(`Producto "${p.nombre}": ${branchId} no tiene menu impreso; su precio es provisional_P5.`);
      const exclusion = EXCLUSIONES_POR_SUCURSAL[branchId];
      if (exclusion && (exclusion.categorias.includes(p.categoria) || exclusion.nombres.includes(p.nombre))) fail(`Producto "${p.nombre}": ${branchId} no lo vende segun su menu (plan PM-C1, P10).`);
      if (branchId === "T4") fail(`Producto "${p.nombre}": T4 (Galerias) no recibe pedidos ni catalogo (P9).`);
      branchPrices[branchId] = price;
      productsByBranch[branchId] = (productsByBranch[branchId] ?? 0) + 1;
    }
    for (const branchId of Object.keys(p.fuente_precio ?? {})) if (!(branchId in branchPrices)) fail(`Producto "${p.nombre}": fuente_precio sin precio en ${branchId}.`);
    const baseId = [...PRECIO_BASE_ORDEN, ...data.sucursales.map((br) => br.id)].find((id) => id in branchPrices)!;
    return {
      name: p.nombre,
      categorySlug,
      price: branchPrices[baseId]!,
      branchPrices,
      description: p.descripcion ?? null,
      isPopular: p.popular,
      // Alcohol: nunca a domicilio (regla dura del cuestionario). La marca vive en el producto, no en la categoria:
      // Cervezas y Licores mezclan bebidas con y sin alcohol.
      noDomicilio: p.es_alcohol,
      displayOrder: index,
    };
  });
  const alcohol = products.filter((p) => p.noDomicilio).length;
  if (alcohol === 0) fail("El menu no marca ningun producto de alcohol como no_domicilio.");

  for (const b of data.sucursales) {
    const n = productsByBranch[b.id] ?? 0;
    if (b.activa && n < MIN_PRODUCTOS_SUCURSAL_ACTIVA) fail(`${b.nombre}: una sucursal activa necesita al menos ${MIN_PRODUCTOS_SUCURSAL_ACTIVA} productos (tiene ${n}).`);
  }
  const branchProducts = Object.values(productsByBranch).reduce((acc, n) => acc + n, 0);

  // --- zonas: solo los puntos de referencia de sucursales CON coordenadas --------------------------
  // `known_zone` empata colonia/referencia -> punto (lat/lng). El mapa de colonias del dueño aun no
  // existe, asi que NO se inventan colonias ni coordenadas: cada sucursal con coordenadas aporta su
  // propio punto (el nombre "Victory Altabrisa" ya empata con "Altabrisa"). Las coordenadas APROXIMADAS (T5) no
  // entran: una zona con un punto estimado no es un punto de referencia real. Sin cobertura de entrega
  // configurada (branch_delivery_zone): no se restringe ninguna entrega.
  const zones = data.sucursales.filter((b) => b.lat !== null && !b.coordenadas_aproximadas).map((b) => ({ name: b.nombre, lat: b.lat as number, lng: b.lng as number }));

  // --- promociones ---------------------------------------------------------------------------------
  const codes = new Set<string>();
  const promotions = data.promociones.map((p) => {
    if (!/^[A-Z0-9_-]{3,40}$/.test(p.codigo) || codes.has(p.codigo)) fail(`Codigo de promocion invalido o duplicado: ${p.codigo}`);
    codes.add(p.codigo);
    if (p.tipo !== "bogo") fail(`${p.codigo}: solo se carga el tipo bogo (2x1).`);
    if (p.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) fail(`${p.codigo}: dias invalidos.`);
    // PM: las promociones no aplican a domicilio.
    if (p.canales.includes("domicilio")) fail(`${p.codigo}: las promociones de PM no aplican a domicilio.`);
    if (p.canales.length === 0) fail(`${p.codigo}: debe declarar al menos un canal.`);
    for (const nombre of p.productos) if (!productNames.has(nombre)) fail(`${p.codigo}: el producto elegible "${nombre}" no existe en el menu.`);
    for (const id of p.sucursales ?? []) if (!branchIds.has(id)) fail(`${p.codigo}: la sucursal "${id}" no existe.`);
    return { code: p.codigo, name: p.nombre, description: p.descripcion, type: p.tipo, daysOfWeek: [...p.dias], channels: [...p.canales], productNames: [...p.productos], branchIds: p.sucursales ? [...p.sucursales] : null, autoApply: true as const };
  });

  // --- agente de WhatsApp (config editable del perfil PM) --------------------------------------------------
  const aw = data.agente_whatsapp;
  if (!aw || aw.perfil !== "taqueria_pm") fail("agente_whatsapp debe declarar el perfil taqueria_pm.");
  if (!TONOS.includes(aw.tono)) fail(`agente_whatsapp.tono invalido: ${aw.tono}`);
  const largo = (valor: string, campo: keyof typeof WHATSAPP_AGENT_LIMITES) => {
    if (typeof valor !== "string" || valor.trim().length === 0 || valor.length > WHATSAPP_AGENT_LIMITES[campo]) fail(`agente_whatsapp: ${campo} debe tener entre 1 y ${WHATSAPP_AGENT_LIMITES[campo]} caracteres.`);
  };
  largo(aw.tiempo_entrega, "deliveryTimeText");
  largo(aw.salsas, "salsasText");
  largo(aw.promociones, "promosText");
  if (aw.nombre_agente !== null) largo(aw.nombre_agente, "agentName");
  for (const m of aw.motivos_escalacion_apagados) if (!MOTIVOS_APAGABLES.includes(m)) fail(`agente_whatsapp: el motivo de escalacion "${m}" no se puede apagar.`);
  // Las promociones que el agente anuncia no pueden prometer algo que la base no cargo (nunca promete un descuento que la cotizacion no muestra).
  if (/martes|nachos/i.test(aw.promociones)) fail("agente_whatsapp.promociones menciona el combo del martes, que NO esta cargado como promocion.");
  const pendientes = data.pendientes_dueno ?? [];
  const idsPendientes = new Set<string>();
  for (const pend of pendientes) {
    if (!pend.id || idsPendientes.has(pend.id) || !pend.titulo || !pend.detalle) fail(`Pendiente del dueño invalido o duplicado: ${pend.id}`);
    if (pend.estado !== undefined && pend.estado !== "abierta" && pend.estado !== "resuelta") fail(`Pendiente ${pend.id}: estado invalido.`);
    idsPendientes.add(pend.id);
  }

  // --- agente -----------------------------------------------------------------------------------------
  const comportamiento = comportamientoVozPm({
    businessName: data.organizacion.nombre,
    agentName: aw.nombre_agente ?? PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: aw.tiempo_entrega,
    branches: data.sucursales.filter((b) => b.activa).map((b) => ({ propertyId: b.id, slug: b.slug, name: b.nombre, address: null })),
    salsasTexto: aw.salsas,
    promosTexto: aw.promociones,
    motivosDesactivados: aw.motivos_escalacion_apagados,
  });
  validarComportamientoVoz(comportamiento);
  const greetings = data.sucursales
    .filter((b) => b.activa)
    .map((b) => {
      const mensajeInicial = data.agente.saludo.replace("{sucursal}", b.nombre);
      if (mensajeInicial.length > MENSAJE_INICIAL_MAX) fail(`Saludo demasiado largo para ${b.nombre}.`);
      return { branchSlug: b.slug, mensajeInicial };
    });

  const demo = options.demo === true;
  return {
    organization: {
      name: demo ? `${data.organizacion.nombre} (demo)` : data.organizacion.nombre,
      slug: demo ? `${data.organizacion.slug}${PM_DEMO_SLUG_SUFFIX}` : data.organizacion.slug,
      timezone: data.organizacion.zona_horaria,
    },
    branches: data.sucursales.map((b, index) => ({
      id: b.id,
      name: b.nombre,
      slug: b.slug,
      status: b.activa ? "active" : "inactive",
      phone: b.telefono,
      address: b.direccion,
      lat: b.lat,
      lng: b.lng,
      displayOrder: index,
      legacySlugs: [...(b.slugs_anteriores ?? [])],
      legacyNames: [...(b.nombres_anteriores ?? [])],
      catalogSize: productsByBranch[b.id] ?? 0,
    })),
    categories: categorias,
    products,
    zones,
    policy: { horario, pedidoMinimoDomicilio: minDom, pedidoMinimoRecoger: minRec, propinaPolitica: propina },
    promotions,
    voice: { voiceId: data.agente.voice_id, comportamiento, greetings },
    whatsappAgent: {
      perfil: aw.perfil,
      agentName: aw.nombre_agente,
      businessName: data.organizacion.nombre,
      toneStyle: aw.tono,
      deliveryTimeText: aw.tiempo_entrega,
      salsasText: aw.salsas,
      promosText: aw.promociones,
      escalationReasonsOff: [...aw.motivos_escalacion_apagados],
    },
    pendientes: pendientes.map((p) => ({ ...p })),
    demo: demo ? { seedVersion: data.version } : null,
    summary: {
      branches: data.sucursales.length,
      activeBranches: data.sucursales.filter((b) => b.activa).length,
      products: products.length,
      alcoholProducts: alcohol,
      branchProducts,
      zones: zones.length,
      promotions: promotions.length,
      skippedPromotions: data.promociones_no_modeladas.map((p) => `${p.id}: ${p.motivo}`),
      productsByBranch,
    },
  };
}

/** Tablas y columnas que el seed necesita (migraciones 022, 023, 025 y 027). La CLI las comprueba ANTES
 * de escribir: contra una base sin migrar aborta con la lista exacta en vez de fallar a la mitad. */
export const PM_SEED_REQUIRED_SCHEMA: readonly { readonly table: string; readonly columns: readonly string[]; readonly migration: string }[] = [
  { table: "restaurantes.branch_detail", columns: ["slug", "zona_horaria"], migration: "022_zona_horaria_branch_detail.sql" },
  { table: "restaurantes.products", columns: ["no_domicilio"], migration: "023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql" },
  { table: "restaurantes.branch_policy", columns: ["horario", "pedido_minimo_domicilio", "pedido_minimo_recoger", "propina_politica"], migration: "023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql" },
  { table: "restaurantes.branch_voice_config", columns: ["habilitado", "comportamiento", "mensaje_inicial", "voice_id"], migration: "025_voz_config_conversaciones.sql" },
  { table: "restaurantes.promotions", columns: ["channels", "product_ids"], migration: "027_promociones_2x1_y_canal.sql" },
  { table: "restaurantes.promotions", columns: ["auto_apply"], migration: "031_recoger_promociones_automaticas_puentes.sql" },
  { table: "restaurantes.whatsapp_agent_config", columns: ["perfil", "agent_name", "business_name", "tone_style", "delivery_time_text", "greeting_text", "salsas_text", "promos_text", "escalation_reasons_off", "version"], migration: "033_agente_config_historial_y_callbacks_estado.sql" },
];

/** Esquema extra que solo exige la carga como demo (`--demo`): la marca de organizacion demo (migracion 037). */
export const PM_SEED_REQUIRED_SCHEMA_DEMO: typeof PM_SEED_REQUIRED_SCHEMA = [
  { table: "restaurantes.demo_organization", columns: ["organization_id", "seed_version", "activo"], migration: "037_demo_organization.sql" },
];

/** SQL de solo lectura que devuelve una fila por columna FALTANTE (vacio = esquema completo). */
export function renderSchemaPreflightSql(options: { readonly demo?: boolean } = {}): string {
  const requeridos = options.demo ? [...PM_SEED_REQUIRED_SCHEMA, ...PM_SEED_REQUIRED_SCHEMA_DEMO] : PM_SEED_REQUIRED_SCHEMA;
  const checks = requeridos.flatMap((r) =>
    r.columns.map((c) => {
      const [schema, table] = r.table.split(".");
      return `select '${r.table}.${c}' as faltante, '${r.migration}' as migracion
  where not exists (select 1 from information_schema.columns where table_schema = '${schema}' and table_name = '${table}' and column_name = '${c}')`;
    }),
  );
  return checks.join("\nunion all\n") + ";";
}

function assertSinDelimitador(json: string): void {
  if (json.includes("$pm$")) fail("Los datos contienen el delimitador $pm$ reservado del seed.");
}

/**
 * Cuerpo (`declare ... begin ... end`) de un bloque plpgsql IDEMPOTENTE que carga el plan. Se ejecuta
 * como `do $do$ <cuerpo> $do$;` (CLI) o como cuerpo de una funcion (verify). Todo esta acotado a la
 * organizacion del plan:
 *   * Si el slug ya existe en OTRA vertical, aborta (nunca pisa una organizacion ajena).
 *   * Re-ejecutar actualiza lo que el seed controla (nombre, precio, horario...) y NO toca decisiones
 *     del dueño: no vuelve a activar la voz (`habilitado`), no reinicia `times_used`/`is_active` de las
 *     promociones ni borra nada.
 * `ownerEmail` (opcional): si ya existe un usuario de staff con ese correo, lo enlaza como owner.
 */
export function renderPmSeedPlpgsql(plan: PmSeedPlan, options: { readonly ownerEmail?: string | null } = {}): string {
  const doc = {
    organization: plan.organization,
    branches: plan.branches,
    categories: plan.categories,
    products: plan.products,
    zones: plan.zones,
    policy: plan.policy,
    promotions: plan.promotions,
    voice: plan.voice,
    whatsappAgent: plan.whatsappAgent,
    demo: plan.demo,
  };
  const json = JSON.stringify(doc);
  assertSinDelimitador(json);
  const email = options.ownerEmail ? options.ownerEmail.trim().toLowerCase() : null;
  if (email && !/^[^\s@'$]+@[^\s@'$]+\.[^\s@'$]+$/.test(email)) fail("ownerEmail invalido.");
  const owner = email
    ? `
  -- Membresia owner de un usuario de staff EXISTENTE (nunca crea credenciales).
  select id into v_user from core.staff_user where lower(email) = '${email}';
  if v_user is null then
    raise notice 'seed-pm: no existe un usuario de staff con ese correo; no se crea membresia.';
  else
    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;
  end if;`
    : "";
  return `declare
  v jsonb := $pm$${json}$pm$::jsonb;
  v_org uuid;
  v_vertical text;
  v_user uuid;
begin
  -- 1) organizacion
  select id, vertical into v_org, v_vertical from core.organization where slug = v->'organization'->>'slug';
  if v_org is not null and v_vertical <> 'restaurantes' then
    raise exception 'seed-pm: el slug % ya existe en otra vertical (%); no se toca.', v->'organization'->>'slug', v_vertical;
  end if;
  if v_org is null then
    insert into core.organization (vertical, name, slug) values ('restaurantes', v->'organization'->>'name', v->'organization'->>'slug') returning id into v_org;
  else
    update core.organization set name = v->'organization'->>'name' where id = v_org;
  end if;

  -- 2) sucursales. Identidad ESTABLE = slug de branch_detail (el nombre es editable y ya cambio entre versiones del seed: #328
  -- renombro T7 y T4). 2a) una fila con un slug anterior toma el slug actual; 2b) la sucursal con el slug actual toma el nombre y
  -- estado actuales; 2c) solo lo que aun no existe (ni por slug ni por nombre anterior/actual) se inserta. Asi re-ejecutar sobre una
  -- base de la version anterior renombra en vez de duplicar o chocar con unique(slug).
  update restaurantes.branch_detail bd set slug = b.slug
    from jsonb_to_recordset(v->'branches') as b(slug text, "legacySlugs" jsonb)
    where bd.organization_id = v_org and b."legacySlugs" is not null
      and bd.slug in (select jsonb_array_elements_text(b."legacySlugs"))
      and not exists (select 1 from restaurantes.branch_detail o where o.organization_id = v_org and o.slug = b.slug);
  update core.property p set name = b.name
    from jsonb_to_recordset(v->'branches') as b(name text, "legacyNames" jsonb)
    where p.organization_id = v_org and b."legacyNames" is not null
      and p.name in (select jsonb_array_elements_text(b."legacyNames"))
      and not exists (select 1 from core.property o where o.organization_id = v_org and o.name = b.name);
  update core.property p set name = b.name
    from jsonb_to_recordset(v->'branches') as b(name text, slug text)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = b.slug
    where p.id = bd.property_id and p.name is distinct from b.name
      and not exists (select 1 from core.property o where o.organization_id = v_org and o.name = b.name and o.id <> p.id);
  insert into core.property (organization_id, vertical, name, status)
    select v_org, 'restaurantes', b.name, b.status
    from jsonb_to_recordset(v->'branches') as b(name text, slug text, status text)
    where not exists (select 1 from core.property p where p.organization_id = v_org and p.name = b.name)
      and not exists (select 1 from restaurantes.branch_detail d where d.organization_id = v_org and d.slug = b.slug);
  update core.property p set status = b.status
    from jsonb_to_recordset(v->'branches') as b(name text, status text)
    where p.organization_id = v_org and p.name = b.name and p.status is distinct from b.status;
  insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order, zona_horaria)
    select p.id, v_org, b.slug, b.phone, b.address, b.lat, b.lng, b."displayOrder", v->'organization'->>'timezone'
    from jsonb_to_recordset(v->'branches') as b(name text, slug text, phone text, address text, lat numeric, lng numeric, "displayOrder" int)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do update set slug = excluded.slug, phone = excluded.phone, address = excluded.address,
      lat = excluded.lat, lng = excluded.lng, display_order = excluded.display_order, zona_horaria = excluded.zona_horaria;

  -- 3) categorias
  insert into restaurantes.categories (organization_id, name, slug, display_order)
    select v_org, c.name, c.slug, c."displayOrder"
    from jsonb_to_recordset(v->'categories') as c(name text, slug text, "displayOrder" int)
    on conflict (organization_id, slug) do update set name = excluded.name, display_order = excluded.display_order;

  -- 4) productos (identidad: organizacion + nombre; alcohol = no_domicilio; price = precio de REFERENCIA, el de cada sucursal va en 5)
  update restaurantes.products pr
    set category_id = c.id, description = x.description, price = x.price, is_popular = x."isPopular", display_order = x."displayOrder",
        no_domicilio = x."noDomicilio", updated_at = now()
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int)
    join restaurantes.categories c on c.organization_id = v_org and c.slug = x."categorySlug"
    where pr.organization_id = v_org and pr.name = x.name;
  insert into restaurantes.products (organization_id, category_id, name, description, price, is_popular, display_order, no_domicilio)
    select v_org, c.id, x.name, x.description, x.price, x."isPopular", x."displayOrder", x."noDomicilio"
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int)
    join restaurantes.categories c on c.organization_id = v_org and c.slug = x."categorySlug"
    where not exists (select 1 from restaurantes.products pr where pr.organization_id = v_org and pr.name = x.name);

  -- 5) precio y disponibilidad POR SUCURSAL: una fila solo por cada sucursal con llave de precio en branchPrices (impreso de
  -- cada sucursal); sin llave el producto no existe ahi. Insertar deja is_available = true; re-ejecutar solo repara el precio
  -- y NUNCA vuelve a prender un producto que el cajero marco agotado.
  insert into restaurantes.branch_products (property_id, product_id, price, is_available)
    select p.id, pr.id, bpr.value::numeric, true
    from jsonb_to_recordset(v->'branches') as b(id text, name text)
    join core.property p on p.organization_id = v_org and p.name = b.name
    cross join jsonb_to_recordset(v->'products') as x(name text, "branchPrices" jsonb)
    cross join lateral jsonb_each_text(x."branchPrices") as bpr(key, value)
    join restaurantes.products pr on pr.organization_id = v_org and pr.name = x.name
    where bpr.key = b.id
    on conflict (property_id, product_id) do update set price = excluded.price, updated_at = now();

  -- 6) zonas conocidas: puntos de referencia de las sucursales con coordenadas
  update restaurantes.known_zone z set lat = x.lat, lng = x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where z.organization_id = v_org and z.name = x.name;
  insert into restaurantes.known_zone (organization_id, name, lat, lng)
    select v_org, x.name, x.lat, x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where not exists (select 1 from restaurantes.known_zone z where z.organization_id = v_org and z.name = x.name);

  -- 7) politica por sucursal: horario, minimos, propina
  insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica)
    select p.id, v_org, (v->'policy'->'horario'), (v->'policy'->>'pedidoMinimoDomicilio')::numeric, (v->'policy'->>'pedidoMinimoRecoger')::numeric, v->'policy'->>'propinaPolitica'
    from jsonb_to_recordset(v->'branches') as b(name text)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do update set horario = excluded.horario, pedido_minimo_domicilio = excluded.pedido_minimo_domicilio,
      pedido_minimo_recoger = excluded.pedido_minimo_recoger, propina_politica = excluded.propina_politica, updated_at = now();

  -- 8) voz (DESHABILITADA: sin gasto de proveedores). Re-ejecutar no la vuelve a deshabilitar ni habilitar.
  insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, voice_id, comportamiento, mensaje_inicial)
    select p.id, v_org, false, v->'voice'->>'voiceId', v->'voice'->>'comportamiento', g."mensajeInicial"
    from jsonb_to_recordset(v->'voice'->'greetings') as g("branchSlug" text, "mensajeInicial" text)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = g."branchSlug"
    join core.property p on p.id = bd.property_id
    on conflict (property_id) do update set comportamiento = excluded.comportamiento, mensaje_inicial = excluded.mensaje_inicial, updated_at = now();

  -- 9) promociones (2x1 por dia y canal sobre productos elegibles)
  -- auto_apply = true: el agente de WhatsApp no manda codigos de promocion, asi que el 2x1 solo se aplica si la propia
  -- cotizacion lo aplica sola (por dia y canal). Sin esto el descuento prometido nunca llegaba al total.
  insert into restaurantes.promotions (organization_id, code, name, description, type, value, days_of_week, channels, product_ids, auto_apply)
    select v_org, x.code, x.name, x.description, x.type, 1, (select array_agg(d::smallint) from jsonb_array_elements_text(x."daysOfWeek") d),
           (select array_agg(c) from jsonb_array_elements_text(x.channels) c),
           (select array_agg(pr.id) from jsonb_array_elements_text(x."productNames") n join restaurantes.products pr on pr.organization_id = v_org and pr.name = n),
           x."autoApply"
    from jsonb_to_recordset(v->'promotions') as x(code text, name text, description text, type text, "daysOfWeek" jsonb, channels jsonb, "productNames" jsonb, "autoApply" boolean)
    on conflict (organization_id, code) do update set name = excluded.name, description = excluded.description, type = excluded.type,
      days_of_week = excluded.days_of_week, channels = excluded.channels, product_ids = excluded.product_ids, auto_apply = excluded.auto_apply, updated_at = now();

  -- 10) agente de WhatsApp: perfil taqueria_pm de la organizacion con los datos del dueño. DO NOTHING si ya hay fila:
  -- re-ejecutar el seed NUNCA pisa lo que el dueño cambio en el editor del agente (tono, tiempos, salsas...), mismo criterio
  -- que la voz. El nombre del asistente queda en null (el dueño no lo definio): el agente se presenta como "el asistente virtual".
  insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, salsas_text, promos_text, escalation_reasons_off, enabled)
    select v_org, null, w.perfil, w."agentName", w."businessName", w."toneStyle", w."deliveryTimeText", w."salsasText", w."promosText",
           coalesce((select array_agg(m) from jsonb_array_elements_text(w."escalationReasonsOff") m), '{}'::text[]), true
    from jsonb_to_recordset(jsonb_build_array(v->'whatsappAgent')) as w(perfil text, "agentName" text, "businessName" text, "toneStyle" text,
      "deliveryTimeText" text, "salsasText" text, "promosText" text, "escalationReasonsOff" jsonb)
    on conflict (organization_id) where property_id is null do nothing;

  -- 11) solo con --demo: la organizacion queda marcada como demo (widget publico, seed de volumen y limpieza). Re-ejecutar no
  -- reactiva un widget que el operador apago (columna activo).
  if v->'demo' is not null and v->'demo' <> 'null'::jsonb then
    insert into restaurantes.demo_organization (organization_id, seed_version) values (v_org, v->'demo'->>'seedVersion')
      on conflict (organization_id) do update set seed_version = excluded.seed_version;
  end if;
${owner}
end`;
}

/** Envuelve el cuerpo como bloque anonimo (CLI). */
export function renderPmSeedDoBlock(plan: PmSeedPlan, options: { readonly ownerEmail?: string | null } = {}): string {
  return `do $seed_pm$\n${renderPmSeedPlpgsql(plan, options)}\n$seed_pm$;`;
}
