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
//     salen de `precios_por_sucursal` de cada producto, ligados a los menus impresos T1-2026 y T5-2026
//     (scripts/seed-pm-demo/data/menus-impresos/): una sucursal sin llave de precio NO vende ese producto. La lista
//     vigente de TODAS las sucursales es la T1-2026 (cuestionario: "precios iguales en todas"); T3-2025 es la lista VIEJA
//     y solo queda como referencia de nombres. T2, T7 y T8 no se cargan mientras Javier no conteste P5 (quedan inactivas y
//     sin catalogo); T4 se registra inactiva y sin catalogo (sin pedidos, P9); T5 queda inactiva (fuera de temporada)
//     pero con su catalogo.
//   * Re-ejecutar RECONCILIA: lo que el seed ya no vende en una sucursal queda `is_available = false` (nunca se borra).
//   * Todo producto de alcohol queda `no_domicilio = true` (el cuestionario prohibe alcohol a domicilio).
//   * `products.price` es solo el precio de REFERENCIA (T1-2026, o el primero disponible); la cotizacion usa el
//     `branch_products.price` de cada sucursal. Nunca hay centavos ni fracciones de kilo (P11).
//   * Horario 12:00-01:00 todos los dias (una franja: la hora de cambio de turno no esta definida y no
//     se inventa), pedido minimo a domicilio $200, propina solo con tarjeta.
//   * Promociones (solo recoger, todas las sucursales): el 2x1 del lunes y el combo de cortesia del martes (nachos de pastor
//     con 2 aguas); las que aun no se modelen se listan en `promociones_no_modeladas` de los datos.
//   * Sin gasto de proveedores: la voz se carga DESHABILITADA (`habilitado = false`).
//   * Sin secretos ni usuarios: nunca crea credenciales; la membresia del dueño es opcional y solo
//     enlaza a un usuario de staff que YA existe.
import { validarHorario } from "../horarios.ts";
import { normalizeZoneText } from "../nearest-branch.ts";
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
  /** Direccion (del dueño) cuyas coordenadas aun NO se verificaron en una fuente citable: `lat`/`lng` siguen en null y la sucursal no
   * participa en la asignacion por distancia (no se inventan coordenadas). */
  readonly coordenadas_pendientes_de_verificar?: string;
  /** Pin de Google Maps (ficha de negocio) propuesto para esta sucursal. Se guarda APARTE de `lat`/`lng` vigentes y el plan NO lo usa: lo adopta el dueño
   * al confirmarlo (hasta entonces las coordenadas vigentes siguen desviadas; la desviacion queda documentada en `tests/colonias-pm-datos.spec.ts`). */
  readonly coordenadas_propuestas?: {
    readonly lat: number;
    readonly lng: number;
    readonly fuente: string;
    readonly vigentes_de_main?: readonly [number, number] | null;
    readonly estado: string;
    readonly pendiente_dueno?: string;
  };
  /** Slugs con los que esta sucursal se sembro en versiones ANTERIORES del seed (p. ej. "t4-pendiente" antes de llamarse
   * "galerias"): el seed re-ejecutado sobre una base vieja la reconoce por slug (estable), la RENOMBRA y no crea una segunda
   * fila que choque con `unique (organization_id, slug)`. */
  readonly slugs_anteriores?: readonly string[];
  readonly nota?: string;
  /** Directorio publico y domicilio (migracion 057). Todo opcional: sin esto la sucursal sigue a su estado (visible si esta activa,
   * reparte todos los dias). `dias_domicilio` en 0 (domingo) a 6 (sabado); null = todos los dias. */
  readonly directorio?: {
    readonly visible?: boolean | null;
    readonly acepta_domicilio?: boolean;
    readonly dias_domicilio?: readonly number[] | null;
    readonly de_temporada?: boolean;
    readonly nota?: string;
  };
}

/** Procedencia de un precio:
 *  - `impreso`: precio del menu impreso de la sucursal.
 *  - `provisional_P5`: lista 2026 de T1 cargada como propuesta mientras no se confirma el catalogo exacto (solo T2, T7 y T8).
 *  - `lista_t1_2026_cuestionario`: T3 (Pensiones) usa la lista T1-2026 porque el cuestionario dice "precios iguales en todas" (l.104-105) y
 *    los chats reales prueban que esa es la lista vigente; solo T3 y el precio debe ser IGUAL al de T1.
 *  - `lista_t1_2026`: T7 usa la lista T1-2026 (decision de Javier, 2-oct-2026, confirmada con los totales de los chats reales de T7);
 *    solo T7 y el precio debe ser IGUAL al de T1.
 *  - `proporcional_kilo`: fraccion de kilo (1/4, 1/2, 3/4, 1.5 y 2 kg) = precio del kilo de la MISMA sucursal x fraccion, redondeado a $0.50.
 *  - `decision_2oct`: precio fijado por Javier el 2-oct-2026 (extras de salsa y piña a $19). */
export type PmFuentePrecio = "impreso" | "provisional_P5" | "lista_t1_2026" | "lista_t1_2026_cuestionario" | "proporcional_kilo" | "decision_2oct";
const FUENTES_PRECIO: readonly string[] = ["impreso", "provisional_P5", "lista_t1_2026", "lista_t1_2026_cuestionario", "proporcional_kilo", "decision_2oct"];

/** Redondeo de caja de una fraccion de kilo: al $0.50 mas cercano (mitades hacia arriba). */
export function precioFraccionDeKilo(precioKilo: number, gramos: number): number {
  return Math.floor((precioKilo * gramos) / 1000 * 2 + 0.5) / 2;
}

export interface PmSeedProduct {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  readonly es_alcohol: boolean;
  readonly popular: boolean;
  /** Fraccion de kilo de OTRO producto del seed (`base`, el "— 1 kg"): sus precios salen de `precioFraccionDeKilo`. */
  readonly fraccion_kg?: { readonly base: string; readonly gramos: number };
  /** Item de los menus impresos del que sale el precio (categoria + nombre impreso). Obligatorio si alguna fuente es `impreso` o `lista_t1_2026`. */
  readonly impreso?: { readonly categoria: string; readonly item: string };
  /** id de sucursal (T1, T3...) -> precio entero en MXN. Si una sucursal no tiene la llave, el producto no existe en ella. */
  readonly precios_por_sucursal: Readonly<Record<string, number>>;
  /** Procedencia de cada precio; mismas llaves que `precios_por_sucursal`. */
  readonly fuente_precio: Readonly<Record<string, PmFuentePrecio>>;
  /** Nombres con los que la gente pide el producto ("bitek", "chela"...): se cargan en `products.search_keywords` (PM-C4). Una
   * palabra por alias, minusculas: la busqueda compara por token, sin acentos. */
  readonly alias?: readonly string[];
  /** Alias que vienen de la propuesta del piloto original (alias -> origen: chats_c3, derivado_nombre o cuestionario_pm); subconjunto de `alias`. */
  readonly alias_piloto?: Readonly<Record<string, string>>;
  /** Subconjunto de `alias` que es PROVISIONAL: propuesto en el cerebro §5.4 y pendiente del OK de Javier (P24). */
  readonly alias_provisional_P24?: readonly string[];
}

export interface PmSeedPromotion {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: "bogo" | "cortesia";
  readonly dias: readonly number[];
  readonly canales: readonly ("domicilio" | "recoger")[];
  /** bogo: productos 2x1. cortesia: productos que DISPARAN la cortesia (nachos de pastor). */
  readonly productos: readonly string[];
  /** Solo `cortesia`: productos que el cliente elige gratis (las aguas) y cuantos por cada unidad disparadora (1..10). */
  readonly cortesia_productos?: readonly string[];
  readonly cortesia_cantidad?: number;
  readonly descripcion: string;
  /** Sucursales donde aplica (migracion 038, `promotions.property_ids`); sin valor = todas las sucursales de la organizacion. */
  readonly sucursales?: readonly string[];
}

/** Procedencia de la sucursal asignada a una colonia (`known_zone.asignacion_fuente`, migracion 056). `mas_cercana_v3` = sucursal de despacho mas cercana (<= 8 km) segun `colonias-v3`. */
export type PmColoniaAsignacion = "mas_cercana_v3" | "chats_t7" | "direccion_sucursal" | "dueno_zona_centro" | "distancia_piloto" | "reasignada_desde_galerias" | "sin_asignar";
const COLONIA_ASIGNACIONES: readonly string[] = ["mas_cercana_v3", "chats_t7", "direccion_sucursal", "dueno_zona_centro", "distancia_piloto", "reasignada_desde_galerias", "sin_asignar"];
/** Motivos por los que una colonia queda SIN ASIGNAR esperando una decision del dueño. */
export type PmColoniaPendiente = "fuera_de_8km" | "homonimo_discrepancia" | "sin_coordenada";
const COLONIA_PENDIENTES: readonly string[] = ["fuera_de_8km", "homonimo_discrepancia", "sin_coordenada"];
/** Sucursales que NO reparten a domicilio (Galerias, sin pedidos; Playa, solo recoger y de temporada): nunca reciben cobertura. */
const SUCURSALES_SIN_REPARTO: readonly string[] = ["T4", "T5"];
const COORDENADA_ORIGENES: readonly string[] = ["google", "osm", "promedio"];
/** Caja de Yucatan central: una coordenada fuera de ella es un error de captura, no una colonia. */
const LAT_RANGO: readonly [number, number] = [20.5, 21.6];
const LNG_RANGO: readonly [number, number] = [-90.3, -89.2];

/** Colonia del piloto original con la(s) sucursal(es) que la atienden segun el seed. */
export interface PmSeedColonia {
  readonly nombre: string;
  readonly fuente: "piloto_original_merida_colonias" | "chats_t7";
  /** ids de sucursal (T1...) que la atienden: una o varias (cobertura multiple); vacio = sin asignar (pendiente o ambigua): el agente no la valida y la pasa a una persona. */
  readonly sucursales?: readonly string[];
  /** Compatibilidad con el formato anterior (una sola sucursal; `null` = sin asignar). Si viene `sucursales`, manda `sucursales`. */
  readonly sucursal?: string | null;
  readonly asignacion: PmColoniaAsignacion;
  readonly motivo_sin_asignar?: string;
  /** Decisiones del dueño que siguen abiertas para esta colonia (una colonia SIN asignar por esto no se asigna hasta que las resuelva). */
  readonly pendiente_dueno?: readonly PmColoniaPendiente[];
  readonly advertencia?: string;
  /** Lo que dio el piloto: sucursal mas cercana y segunda con sus km. `null` = la colonia no estaba en el export (viene de los chats). */
  readonly referencia: { readonly sucursal: string; readonly km: number; readonly segunda: string; readonly segunda_km: number; readonly alerta_ambigua: boolean } | null;
  /** Coordenada FINAL elegida (Google, OSM o promedio de ambos) con su confianza. Solo documentacion/auditoria: NO se escribe en `known_zone` (ver `colonias_meta`). `null` = sin coordenada. */
  readonly coordenada?: { readonly lat: number; readonly lng: number; readonly origen: "google" | "osm" | "promedio"; readonly confianza: string } | null;
  /** Las dos lecturas crudas de las que sale `coordenada` (para que se pueda comprobar que no se invento ninguna). */
  readonly google?: { readonly lat: number; readonly lng: number } | null;
  readonly osm?: { readonly lat: number; readonly lng: number } | null;
  /** Sucursal de despacho mas cercana (Haversine desde el pin de Google) con sus km y la segunda. */
  readonly mas_cercana?: { readonly sucursal: string; readonly km: number; readonly segunda: string; readonly segunda_km: number; readonly fuera_de_8km: boolean } | null;
  readonly revisar?: boolean;
  /** Cobertura que hoy tiene la base real (zonas-pm-v1 + v2b, 169 filas): el seed no la modifica; sirve para detectar divergencias. */
  readonly cobertura_base_real?: readonly string[];
}

export interface PmSeedData {
  readonly version: string;
  readonly organizacion: { readonly nombre: string; readonly slug: string; readonly ciudad: string; readonly zona_horaria: string };
  readonly sucursales: readonly PmSeedBranch[];
  readonly horario_general: { readonly abre: string; readonly cierra: string; readonly dias: readonly number[] };
  /** Colonias del piloto original (`known_zone` sin coordenadas + `branch_delivery_zone`); ver `colonias_meta` para la regla de asignacion. */
  readonly colonias?: readonly PmSeedColonia[];
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
    /** Tiempo de entrega propio de una sucursal (id del seed -> texto). Se siembra como fila de `whatsapp_agent_config` con `property_id`
     * (el lector prefiere la fila de la sucursal sobre la de la organizacion). */
    readonly tiempo_entrega_por_sucursal?: Readonly<Record<string, string>>;
    /** Textos que ESTE seed sembro en versiones anteriores: solo si la fila todavia dice uno de ellos (el dueño no la edito) se actualiza. */
    readonly tiempo_entrega_anteriores_sembrados?: readonly string[];
    readonly promociones_anteriores_sembradas?: readonly string[];
    /** Espera de rafagas en segundos (migracion 039, 0 a 10); sin valor no se siembra. */
    readonly espera_rafagas_segundos?: number;
    /** Aclaracion para quien lea los datos: `tono` no es el tono real del perfil taqueria_pm. */
    readonly tono_nota?: string;
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

/** El comportamiento de voz sembrado sale del MISMO perfil que WhatsApp (`comportamientoVozPm`), no de un archivo aparte. El combo del martes
 * YA esta cargado como promocion de cortesia: el prompt no puede seguir diciendo que "no lo prometa" ni que "lo confirma la sucursal", y
 * debe decir que lo aplica cotizar_pedido y que se dice tal cual lo devuelve (nunca se promete algo que la cotizacion no muestre). */
export function validarComportamientoVoz(comportamiento: string): void {
  if (/la confirma la sucursal al recoger|no lo prometa ni lo aplique|no lo prometa; la confirma/i.test(comportamiento)) {
    fail("El comportamiento de voz todavia trata el combo del martes como no cargado (H13); ya es una promocion que aplica cotizar_pedido.");
  }
  if (!/combo del martes[^.\n]{0,80}cotizar_pedido/i.test(comportamiento)) fail("El comportamiento de voz no dice que el combo del martes lo aplica cotizar_pedido.");
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
    /** Cuantos productos vende la sucursal (0 = registrada sin catalogo). */
    readonly catalogSize: number;
    /** Slugs de versiones anteriores del seed (ver `PmSeedBranch.slugs_anteriores`); vacio si nunca cambio. */
    readonly legacySlugs: readonly string[];
    /** Directorio publico y domicilio (migracion 057), con los valores por omision ya resueltos. */
    readonly visibleEnDirectorio: boolean | null;
    readonly aceptaDomicilio: boolean;
    readonly diasDomicilio: readonly number[] | null;
    readonly deTemporada: boolean;
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
    /** Alias de busqueda (`products.search_keywords`); vacio si el producto no tiene. */
    readonly searchKeywords: readonly string[];
  }[];
  /** Puntos de referencia de las sucursales con coordenadas reales; cada uno cubre SU sucursal (`branchId`). */
  readonly zones: readonly { readonly name: string; readonly lat: number; readonly lng: number; readonly branchId: string }[];
  /** Colonias sin coordenadas (migracion 056) con las sucursales que las cubren (`branchIds`; vacio = sin asignar) y lo que dio el piloto. */
  readonly colonias: readonly {
    readonly name: string;
    readonly fuente: string;
    readonly asignacionFuente: PmColoniaAsignacion;
    readonly branchIds: readonly string[];
    readonly refSlug: string | null;
    readonly refKm: number | null;
    readonly ref2Slug: string | null;
    readonly ref2Km: number | null;
  }[];
  readonly policy: { readonly horario: unknown; readonly pedidoMinimoDomicilio: number; readonly pedidoMinimoRecoger: number | null; readonly propinaPolitica: string };
  readonly promotions: readonly {
    readonly code: string;
    readonly name: string;
    readonly description: string;
    readonly type: "bogo" | "cortesia";
    readonly daysOfWeek: readonly number[];
    readonly channels: readonly string[];
    readonly productNames: readonly string[];
    /** Solo `cortesia` (migracion 031): productos de cortesia a elegir y piezas por unidad disparadora; `null` en bogo. */
    readonly courtesyProductNames: readonly string[] | null;
    readonly courtesyQuantity: number | null;
    /** Ids de sucursal donde aplica (migracion 038, `promotions.property_ids`); `null` = todas las sucursales. El SQL del seed
     * los resuelve a `core.property.id` de la organizacion del plan. */
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
    /** Espera de rafagas (migracion 039); `null` = no se siembra. */
    readonly replyDebounceSeconds: number | null;
    /** Filas propias de una sucursal (id del seed -> tiempo de entrega): copian la fila de la organizacion salvo `deliveryTimeText`. */
    readonly deliveryByBranch: readonly { readonly branchId: string; readonly deliveryTimeText: string }[];
    /** Textos que este seed sembro antes: solo si la fila los conserva (sin edicion del dueño) se reemplazan por los nuevos. */
    readonly legacyDeliveryTimeTexts: readonly string[];
    readonly legacyPromosTexts: readonly string[];
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
    readonly colonias: number;
    readonly coloniasAsignadas: number;
    readonly coloniasSinAsignar: number;
    /** Colonias cubiertas por dos o mas sucursales (cobertura multiple). */
    readonly coloniasCubiertasPorDos: number;
    /** Filas de `branch_delivery_zone` que aportan las colonias (una por colonia y sucursal; sin contar los puntos de sucursal). */
    readonly coberturasColonias: number;
    /** Colonias de la lista que SON el punto de referencia de una sucursal (p. ej. Francisco de Montejo): no se duplican, ya existen como zona. */
    readonly coloniasEnZonaDeSucursal: number;
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
/** Un nombre con peso de fraccion ("Pastor — 500 g", "— 1.5 kg", "— 2 kg") es una fraccion de kilo y necesita `fraccion_kg`. */
const NOMBRE_FRACCION_DE_KILO = / — (250 g|500 g|750 g|1\.5 kg|2 kg)$/;
const GRAMOS_FRACCION = [250, 500, 750, 1500, 2000] as const;

/** Lo que cada sucursal NO vende segun los menus impresos y el repo (plan PM-C1 y P10): por categoria o por nombre. */
const EXCLUSIONES_POR_SUCURSAL: Readonly<Record<string, { readonly categorias: readonly string[]; readonly nombres: readonly string[] }>> = {
  // Cuestionario l.76: "las pequeñas tienen el mismo menu, pero sin la comida regional". Las flautas siguen fuera de T2 y T3 hasta que Javier
  // conteste P10 (solo estan impresas en T1); Heineken Silver solo existe impresa en T5.
  T2: { categorias: ["Comida Regional", "Flautas de PM"], nombres: ["Heineken Silver"] },
  T3: { categorias: ["Comida Regional", "Flautas de PM"], nombres: ["Heineken Silver"] },
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
    for (const anterior of b.slugs_anteriores ?? []) {
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(anterior)) fail(`${b.nombre}: slug anterior invalido: ${anterior}`);
    }
    const prop = b.coordenadas_propuestas;
    if (prop && (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng) || prop.lat < LAT_RANGO[0] || prop.lat > LAT_RANGO[1] || prop.lng < LNG_RANGO[0] || prop.lng > LNG_RANGO[1])) {
      fail(`${b.nombre}: coordenadas_propuestas fuera de Yucatan.`);
    }
    const dias = b.directorio?.dias_domicilio;
    if (dias && (dias.length === 0 || dias.length > 7 || dias.some((x) => !Number.isInteger(x) || x < 0 || x > 6))) fail(`${b.nombre}: directorio.dias_domicilio debe ser una lista de 1 a 7 dias entre 0 (domingo) y 6 (sabado), o null.`);
    if ((b.lat === null) !== (b.lng === null)) fail(`${b.nombre}: lat y lng deben venir juntas.`);
    if (b.lat !== null && (b.lat < -90 || b.lat > 90 || (b.lng as number) < -180 || (b.lng as number) > 180)) fail(`${b.nombre}: coordenadas fuera de rango.`);
  }
  // Un slug anterior nunca puede ser el slug vigente de otra sucursal (la renombraria por error).
  for (const b of data.sucursales) {
    for (const anterior of b.slugs_anteriores ?? []) {
      if (slugs.has(anterior)) fail(`${b.nombre}: el slug anterior "${anterior}" es el slug vigente de otra sucursal.`);
    }
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
    const esFraccion = NOMBRE_FRACCION_DE_KILO.test(p.nombre);
    if (esFraccion !== (p.fraccion_kg !== undefined)) fail(`Producto "${p.nombre}": una fraccion de kilo (nombre "— 250 g | 500 g | 750 g | 1.5 kg | 2 kg") debe declarar \`fraccion_kg\` y solo ellas.`);
    if (p.fraccion_kg) {
      const base = data.productos.find((x) => x.nombre === p.fraccion_kg!.base);
      if (!base || !/ — 1 kg$/.test(base.nombre)) fail(`Producto "${p.nombre}": su base "${p.fraccion_kg.base}" debe ser el producto "— 1 kg" del seed.`);
      if (!(GRAMOS_FRACCION as readonly number[]).includes(p.fraccion_kg.gramos)) fail(`Producto "${p.nombre}": fraccion de ${p.fraccion_kg.gramos} g no vendible (solo 250, 500, 750, 1500 y 2000).`);
      const etiqueta = p.fraccion_kg.gramos >= 1500 ? `${p.fraccion_kg.gramos / 1000} kg` : `${p.fraccion_kg.gramos} g`;
      if (p.nombre !== `${base!.nombre.replace(/ — 1 kg$/, "")} — ${etiqueta}`) fail(`Producto "${p.nombre}": el nombre no corresponde a su base y a sus gramos (se esperaba "${base!.nombre.replace(/ — 1 kg$/, "")} — ${etiqueta}").`);
    }
    const branchPrices: Record<string, number> = {};
    const entradas = Object.entries(p.precios_por_sucursal ?? {});
    if (entradas.length === 0) fail(`Producto "${p.nombre}": no tiene precio en ninguna sucursal.`);
    for (const [branchId, price] of entradas) {
      if (!branchIds.has(branchId)) fail(`Producto "${p.nombre}": sucursal desconocida "${branchId}" en precios_por_sucursal.`);
      if (!esPrecio(price)) fail(`Producto "${p.nombre}": precio invalido en ${branchId}.`);
      const fuente = p.fuente_precio?.[branchId];
      if (fuente === undefined || !FUENTES_PRECIO.includes(fuente)) fail(`Producto "${p.nombre}": falta fuente_precio (${FUENTES_PRECIO.join(" | ")}) en ${branchId}.`);
      // Pesos enteros salvo las fracciones de kilo, que pueden traer $0.50 (3/4 de un kilo de $950 = $712.50, como en caja).
      if (price % 1 !== 0 && !(fuente === "proporcional_kilo" && (price * 2) % 1 === 0)) fail(`Producto "${p.nombre}": precio con centavos en ${branchId} (${price}); los menus impresos solo traen pesos enteros.`);
      if (fuente === "proporcional_kilo") {
        const base = p.fraccion_kg ? data.productos.find((x) => x.nombre === p.fraccion_kg!.base) : undefined;
        const precioKilo = base?.precios_por_sucursal?.[branchId];
        if (!p.fraccion_kg || precioKilo === undefined) fail(`Producto "${p.nombre}": precio proporcional_kilo en ${branchId} sin fraccion_kg o sin precio del kilo en esa sucursal.`);
        else if (price !== precioFraccionDeKilo(precioKilo, p.fraccion_kg.gramos)) fail(`Producto "${p.nombre}": en ${branchId} vale ${price} pero ${p.fraccion_kg.gramos} g de un kilo de ${precioKilo} es ${precioFraccionDeKilo(precioKilo, p.fraccion_kg.gramos)}.`);
      } else if (p.fraccion_kg) fail(`Producto "${p.nombre}": una fraccion de kilo solo admite fuente proporcional_kilo (${branchId}).`);
      if ((fuente === "impreso" || fuente === "lista_t1_2026") && !p.impreso) fail(`Producto "${p.nombre}": un precio impreso necesita el item del menu en \`impreso\`.`);
      if (fuente === "lista_t1_2026" && (branchId !== "T7" || price !== p.precios_por_sucursal.T1)) fail(`Producto "${p.nombre}": lista_t1_2026 solo aplica a T7 y con el MISMO precio que T1 (${branchId}).`);
      if (fuente === "lista_t1_2026_cuestionario" && (branchId !== "T3" || price !== p.precios_por_sucursal.T1)) fail(`Producto "${p.nombre}": lista_t1_2026_cuestionario solo aplica a T3 y con el MISMO precio que T1 (${branchId}).`);
      if (fuente === "lista_t1_2026_cuestionario" && !p.impreso) fail(`Producto "${p.nombre}": un precio de la lista T1-2026 necesita el item del menu en \`impreso\`.`);
      if (fuente === "impreso" && branchId === "T3") fail(`Producto "${p.nombre}": T3 usa la lista T1-2026 (lista_t1_2026_cuestionario), no la lista 2025 impresa.`);
      if (fuente === "decision_2oct" && !/^Extra (Salsa|Piña)$/.test(p.nombre)) fail(`Producto "${p.nombre}": decision_2oct solo vale para Extra Salsa y Extra Piña.`);
      const pendienteP5 = SUCURSALES_PENDIENTES_P5.includes(branchId);
      if (pendienteP5 && !p5Resuelta) fail(`Producto "${p.nombre}": ${branchId} no se carga mientras Javier no conteste P5 (pendientes_dueno P5 resuelta).`);
      if (fuente === "provisional_P5" && !pendienteP5) fail(`Producto "${p.nombre}": provisional_P5 solo aplica a T2, T7 y T8 (${branchId}).`);
      if (fuente === "impreso" && pendienteP5) fail(`Producto "${p.nombre}": ${branchId} no tiene menu impreso; su precio es provisional_P5.`);
      if (fuente === "lista_t1_2026" && !pendienteP5) fail(`Producto "${p.nombre}": lista_t1_2026 solo aplica a T7 (${branchId}).`);
      const exclusion = EXCLUSIONES_POR_SUCURSAL[branchId];
      if (exclusion && (exclusion.categorias.includes(p.categoria) || exclusion.nombres.includes(p.nombre))) fail(`Producto "${p.nombre}": ${branchId} no lo vende segun su menu (plan PM-C1, P10).`);
      if (branchId === "T4") fail(`Producto "${p.nombre}": T4 (Galerias) no recibe pedidos ni catalogo (P9).`);
      branchPrices[branchId] = price;
      productsByBranch[branchId] = (productsByBranch[branchId] ?? 0) + 1;
    }
    for (const branchId of Object.keys(p.fuente_precio ?? {})) if (!(branchId in branchPrices)) fail(`Producto "${p.nombre}": fuente_precio sin precio en ${branchId}.`);
    const searchKeywords = p.alias ?? [];
    for (const alias of searchKeywords) {
      if (!/^[a-záéíóúüñ0-9][a-záéíóúüñ0-9.-]{0,38}$/.test(alias)) fail(`Producto "${p.nombre}": alias invalido "${alias}" (una palabra en minusculas, sin espacios).`);
    }
    if (new Set(searchKeywords).size !== searchKeywords.length) fail(`Producto "${p.nombre}": alias duplicados.`);
    for (const [alias, origen] of Object.entries(p.alias_piloto ?? {})) {
      if (!searchKeywords.includes(alias)) fail(`Producto "${p.nombre}": alias del piloto "${alias}" no esta en alias.`);
      if (!/^(chats_c3|derivado_nombre|cuestionario_pm)/.test(origen)) fail(`Producto "${p.nombre}": el alias "${alias}" viene de un origen no aprobado (${origen}); solo chats_c3, derivado_nombre y cuestionario_pm.`);
    }
    for (const provisional of p.alias_provisional_P24 ?? []) {
      if (!searchKeywords.includes(provisional)) fail(`Producto "${p.nombre}": alias provisional "${provisional}" no esta en alias.`);
    }
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
      searchKeywords,
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
  const zones = data.sucursales.filter((b) => b.lat !== null && !b.coordenadas_aproximadas).map((b) => ({ name: b.nombre, lat: b.lat as number, lng: b.lng as number, branchId: b.id }));

  // --- colonias del piloto original: SIN coordenadas (no se inventan), con la sucursal que las cubre ----------------
  const slugPorId = new Map(data.sucursales.map((b) => [b.id, b.slug] as const));
  const zonasDePunto = new Map(zones.map((z) => [normalizeZoneText(z.name), z] as const));
  // Una colonia puede llamarse como una sucursal SIN punto de referencia (Pensiones, Galerias): es la colonia, no la zona de la sucursal.
  const nombresNormalizados = new Set<string>(zonasDePunto.keys());
  const enZonaDeSucursal = new Set<string>();
  const colonias = (data.colonias ?? []).flatMap((c) => {
    if (typeof c.nombre !== "string" || c.nombre.trim().length === 0 || c.nombre.length > 120) fail(`Colonia invalida: ${JSON.stringify(c.nombre)}`);
    const clave = normalizeZoneText(c.nombre);
    if (clave.length < 4) fail(`Colonia "${c.nombre}": el nombre normalizado debe tener al menos 4 caracteres.`);
    if (!COLONIA_ASIGNACIONES.includes(c.asignacion)) fail(`Colonia "${c.nombre}": asignacion invalida (${c.asignacion}).`);
    const sucursales = c.sucursales ?? (c.sucursal ? [c.sucursal] : []);
    if (new Set(sucursales).size !== sucursales.length) fail(`Colonia "${c.nombre}": sucursal repetida en la cobertura.`);
    if ((sucursales.length === 0) !== (c.asignacion === "sin_asignar")) fail(`Colonia "${c.nombre}": sin_asignar y sin sucursales deben coincidir.`);
    for (const id of sucursales) if (!branchIds.has(id) || SUCURSALES_SIN_REPARTO.includes(id)) fail(`Colonia "${c.nombre}": la sucursal ${id} no existe o no reparte a domicilio.`);
    if (c.fuente !== "piloto_original_merida_colonias" && c.fuente !== "chats_t7") fail(`Colonia "${c.nombre}": fuente invalida.`);
    for (const m of c.pendiente_dueno ?? []) if (!COLONIA_PENDIENTES.includes(m)) fail(`Colonia "${c.nombre}": pendiente_dueno invalido (${m}).`);
    if (c.coordenada) {
      const { lat, lng, origen } = c.coordenada;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < LAT_RANGO[0] || lat > LAT_RANGO[1] || lng < LNG_RANGO[0] || lng > LNG_RANGO[1]) fail(`Colonia "${c.nombre}": coordenada fuera de Yucatan.`);
      if (!COORDENADA_ORIGENES.includes(origen)) fail(`Colonia "${c.nombre}": origen de coordenada invalido (${origen}).`);
      // Ninguna coordenada se inventa: sale de una de las dos lecturas crudas o del punto medio de ambas.
      const igual = (x: { lat: number; lng: number } | null | undefined, lat2: number, lng2: number) => x != null && Math.abs(x.lat - lat2) < 1e-6 && Math.abs(x.lng - lng2) < 1e-6;
      const ok =
        origen === "google" ? igual(c.google, lat, lng) : origen === "osm" ? igual(c.osm, lat, lng) : c.google != null && c.osm != null && igual({ lat: (c.google.lat + c.osm.lat) / 2, lng: (c.google.lng + c.osm.lng) / 2 }, lat, lng);
      if (!ok) fail(`Colonia "${c.nombre}": la coordenada no coincide con su lectura de ${origen}; no se aceptan coordenadas inventadas.`);
    }
    const ref = c.referencia;
    if (ref !== null) {
      if (!slugPorId.has(ref.sucursal) || !slugPorId.has(ref.segunda)) fail(`Colonia "${c.nombre}": la referencia del piloto nombra una sucursal que no existe.`);
      if (!(ref.km >= 0) || !(ref.segunda_km >= 0)) fail(`Colonia "${c.nombre}": los km del piloto no pueden ser negativos.`);
    }
    const zonaPunto = zonasDePunto.get(clave);
    if (zonaPunto) {
      // La colonia ES el punto de referencia de una sucursal: ya existe como zona (paso 6) y esa sucursal la cubre. Solo se admite si coincide.
      if (sucursales.length !== 1 || sucursales[0] !== zonaPunto.branchId) fail(`Colonia "${c.nombre}": coincide con el punto de la sucursal ${zonaPunto.branchId} y debe cubrirla solo esa sucursal.`);
      if (enZonaDeSucursal.has(clave)) fail(`Colonia duplicada (o igual al nombre de una sucursal): ${c.nombre}`);
      enZonaDeSucursal.add(clave);
      return [];
    }
    if (nombresNormalizados.has(clave)) fail(`Colonia duplicada (o igual al nombre de una sucursal): ${c.nombre}`);
    nombresNormalizados.add(clave);
    return [
      {
        name: c.nombre.trim(),
        fuente: c.fuente,
        asignacionFuente: c.asignacion,
        branchIds: sucursales,
        refSlug: ref ? slugPorId.get(ref.sucursal)! : null,
        refKm: ref ? ref.km : null,
        ref2Slug: ref ? slugPorId.get(ref.segunda)! : null,
        ref2Km: ref ? ref.segunda_km : null,
      },
    ];
  });

  // --- promociones ---------------------------------------------------------------------------------
  const codes = new Set<string>();
  const promotions = data.promociones.map((p) => {
    if (!/^[A-Z0-9_-]{3,40}$/.test(p.codigo) || codes.has(p.codigo)) fail(`Codigo de promocion invalido o duplicado: ${p.codigo}`);
    codes.add(p.codigo);
    if (p.tipo !== "bogo" && p.tipo !== "cortesia") fail(`${p.codigo}: solo se cargan los tipos bogo (2x1) y cortesia.`);
    if (p.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) fail(`${p.codigo}: dias invalidos.`);
    // PM: las promociones no aplican a domicilio.
    if (p.canales.includes("domicilio")) fail(`${p.codigo}: las promociones de PM no aplican a domicilio.`);
    if (p.canales.length === 0) fail(`${p.codigo}: debe declarar al menos un canal.`);
    for (const nombre of p.productos) if (!productNames.has(nombre)) fail(`${p.codigo}: el producto elegible "${nombre}" no existe en el menu.`);
    for (const id of p.sucursales ?? []) if (!branchIds.has(id)) fail(`${p.codigo}: la sucursal "${id}" no existe.`);
    if (p.tipo === "cortesia") {
      const cortesia = p.cortesia_productos ?? [];
      if (cortesia.length === 0 || p.productos.length === 0) fail(`${p.codigo}: una cortesia necesita productos disparadores y productos de cortesia.`);
      for (const nombre of cortesia) if (!productNames.has(nombre)) fail(`${p.codigo}: el producto de cortesia "${nombre}" no existe en el menu.`);
      if (!Number.isInteger(p.cortesia_cantidad) || (p.cortesia_cantidad as number) < 1 || (p.cortesia_cantidad as number) > 10) fail(`${p.codigo}: cortesia_cantidad debe ser un entero de 1 a 10.`);
    } else if (p.cortesia_productos !== undefined || p.cortesia_cantidad !== undefined) fail(`${p.codigo}: cortesia_productos y cortesia_cantidad solo aplican al tipo cortesia.`);
    return {
      code: p.codigo,
      name: p.nombre,
      description: p.descripcion,
      type: p.tipo,
      daysOfWeek: [...p.dias],
      channels: [...p.canales],
      productNames: [...p.productos],
      courtesyProductNames: p.tipo === "cortesia" ? [...(p.cortesia_productos as readonly string[])] : null,
      courtesyQuantity: p.tipo === "cortesia" ? (p.cortesia_cantidad as number) : null,
      branchIds: p.sucursales ? [...p.sucursales] : null,
      autoApply: true as const,
    };
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
  if (/martes|nachos/i.test(aw.promociones) && !promotions.some((p) => p.type === "cortesia" && p.daysOfWeek.includes(2))) fail("agente_whatsapp.promociones menciona el combo del martes, que NO esta cargado como promocion.");
  if (/lunes|2x1/i.test(aw.promociones) && !promotions.some((p) => p.type === "bogo" && p.daysOfWeek.includes(1))) fail("agente_whatsapp.promociones menciona el 2x1 del lunes, que NO esta cargado como promocion.");
  if (aw.espera_rafagas_segundos !== undefined && (!Number.isInteger(aw.espera_rafagas_segundos) || aw.espera_rafagas_segundos < 0 || aw.espera_rafagas_segundos > 10)) fail("agente_whatsapp.espera_rafagas_segundos debe ser un entero de 0 a 10 (check de la migracion 039).");
  const tiempoPorSucursal = Object.entries(aw.tiempo_entrega_por_sucursal ?? {}).map(([branchId, texto]) => {
    if (!branchIds.has(branchId)) fail(`agente_whatsapp.tiempo_entrega_por_sucursal: la sucursal "${branchId}" no existe.`);
    largo(texto, "deliveryTimeText");
    return { branchId, deliveryTimeText: texto };
  });
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
      catalogSize: productsByBranch[b.id] ?? 0,
      legacySlugs: [...(b.slugs_anteriores ?? [])],
      visibleEnDirectorio: b.directorio?.visible ?? null,
      aceptaDomicilio: b.directorio?.acepta_domicilio ?? true,
      diasDomicilio: b.directorio?.dias_domicilio ? [...b.directorio.dias_domicilio] : null,
      deTemporada: b.directorio?.de_temporada ?? false,
    })),
    categories: categorias,
    products,
    zones,
    colonias,
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
      replyDebounceSeconds: aw.espera_rafagas_segundos ?? null,
      deliveryByBranch: tiempoPorSucursal,
      legacyDeliveryTimeTexts: [...(aw.tiempo_entrega_anteriores_sembrados ?? [])],
      legacyPromosTexts: [...(aw.promociones_anteriores_sembradas ?? [])],
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
      colonias: colonias.length,
      coloniasAsignadas: colonias.filter((c) => c.branchIds.length > 0).length,
      coloniasSinAsignar: colonias.filter((c) => c.branchIds.length === 0).length,
      coloniasCubiertasPorDos: colonias.filter((c) => c.branchIds.length > 1).length,
      coberturasColonias: colonias.reduce((n, c) => n + c.branchIds.length, 0),
      coloniasEnZonaDeSucursal: enZonaDeSucursal.size,
      promotions: promotions.length,
      skippedPromotions: data.promociones_no_modeladas.map((p) => `${p.id}: ${p.motivo}`),
      productsByBranch,
    },
  };
}

/** Tablas y columnas que el seed necesita (migraciones 022, 023, 025, 027, 031, 033, 038 y 039). La CLI las comprueba ANTES
 * de escribir: contra una base sin migrar aborta con la lista exacta en vez de fallar a la mitad. */
export const PM_SEED_REQUIRED_SCHEMA: readonly { readonly table: string; readonly columns: readonly string[]; readonly migration: string }[] = [
  { table: "restaurantes.branch_detail", columns: ["slug", "zona_horaria"], migration: "022_zona_horaria_branch_detail.sql" },
  { table: "restaurantes.products", columns: ["no_domicilio"], migration: "023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql" },
  { table: "restaurantes.branch_policy", columns: ["horario", "pedido_minimo_domicilio", "pedido_minimo_recoger", "propina_politica"], migration: "023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql" },
  // Directorio publico y domicilio por sucursal: el seed escribe estas columnas en el paso 7.
  { table: "restaurantes.branch_policy", columns: ["visible_en_directorio", "acepta_domicilio", "dias_domicilio", "de_temporada"], migration: "057_sucursal_directorio_y_domicilio.sql" },
  { table: "restaurantes.branch_voice_config", columns: ["habilitado", "comportamiento", "mensaje_inicial", "voice_id"], migration: "025_voz_config_conversaciones.sql" },
  { table: "restaurantes.promotions", columns: ["channels", "product_ids"], migration: "027_promociones_2x1_y_canal.sql" },
  { table: "restaurantes.promotions", columns: ["auto_apply"], migration: "031_recoger_promociones_automaticas_puentes.sql" },
  // El 2x1 y el combo valen en todas las sucursales (property_ids null), pero el seed sigue exigiendo la 038: sin esa columna el INSERT
  // de promociones falla a la mitad. El seed se niega a cargar antes de que la migracion exista.
  { table: "restaurantes.promotions", columns: ["property_ids"], migration: "038_promociones_por_sucursal.sql" },
  // Combo de cortesia del martes (031): las columnas de la propia promocion de cortesia.
  { table: "restaurantes.promotions", columns: ["courtesy_product_ids", "courtesy_quantity"], migration: "031_recoger_promociones_automaticas_puentes.sql" },
  // Espera de rafagas y umbral de pedido grande: el seed siembra reply_debounce_seconds y copia large_order_text a la fila de sucursal.
  // Colonias sin coordenadas y su procedencia: el seed inserta known_zone con lat/lng nulos y estas columnas.
  { table: "restaurantes.known_zone", columns: ["fuente", "asignacion_fuente", "ref_sucursal_slug", "ref_km", "ref2_sucursal_slug", "ref2_km"], migration: "056_known_zone_colonias_sin_coordenadas.sql" },
  { table: "restaurantes.whatsapp_agent_config", columns: ["large_order_text", "reply_debounce_seconds"], migration: "039_agente_config_umbral_y_rafagas.sql" },
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
    colonias: plan.colonias,
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

  -- 2) sucursales: core.property (por nombre dentro de la organizacion) + branch_detail.
  -- 2a) IDENTIDAD ESTABLE: una sucursal que ya existe con un nombre o slug de una version anterior del seed (T4 se llamaba
  -- "T4 (pendiente de datos)" / slug t4-pendiente; T7, "Victory Platz (García Lavín)") se RENOMBRA, en vez de insertar una
  -- segunda fila que choque con unique (organization_id, slug). Se reconoce por el slug vigente o por sus slugs anteriores.
  update core.property p set name = b.name
    from jsonb_to_recordset(v->'branches') as b(name text, slug text, "legacySlugs" jsonb)
    join restaurantes.branch_detail bd on bd.organization_id = v_org
      and (bd.slug = b.slug or bd.slug in (select jsonb_array_elements_text(b."legacySlugs")))
    where p.id = bd.property_id and p.organization_id = v_org and p.name is distinct from b.name
      and not exists (select 1 from core.property q where q.organization_id = v_org and q.name = b.name and q.id <> p.id);
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
        no_domicilio = x."noDomicilio", updated_at = now(),
        -- alias de busqueda: se UNEN a los que ya tenga el producto (nunca se borran los que agrego el dueño)
        search_keywords = array(select distinct k from unnest(pr.search_keywords || array(select jsonb_array_elements_text(x."searchKeywords"))) as k order by k)
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int, "searchKeywords" jsonb)
    join restaurantes.categories c on c.organization_id = v_org and c.slug = x."categorySlug"
    where pr.organization_id = v_org and pr.name = x.name;
  insert into restaurantes.products (organization_id, category_id, name, description, price, is_popular, display_order, no_domicilio, search_keywords)
    select v_org, c.id, x.name, x.description, x.price, x."isPopular", x."displayOrder", x."noDomicilio", array(select jsonb_array_elements_text(x."searchKeywords"))
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int, "searchKeywords" jsonb)
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
  -- 5b) RECONCILIACION: una fila de branch_products de una sucursal DE ESTE seed, de un producto que el seed conoce, cuya llave de precio ya
  -- no esta en branchPrices (p. ej. Heineken Silver en T2) se BORRA: la sucursal ya no lo vende y, si vuelve al plan despues, el upsert de
  -- arriba lo reinserta disponible (apagarlo dejaria una fila viva-pero-apagada que ningun re-seed volveria a prender). Acotado: solo la
  -- organizacion del plan, solo sucursales del plan y solo productos del plan; lo que el dueño agrego por su cuenta (producto fuera del
  -- seed) no se toca. Nada referencia branch_products por llave foranea (los pedidos guardan sus renglones en jsonb).
  delete from restaurantes.branch_products bp
    using restaurantes.products pr, core.property p, jsonb_to_recordset(v->'branches') as b(id text, name text)
    where bp.product_id = pr.id and pr.organization_id = v_org
      and bp.property_id = p.id and p.organization_id = v_org and p.name = b.name
      and exists (select 1 from jsonb_to_recordset(v->'products') as k(name text) where k.name = pr.name)
      and not exists (select 1 from jsonb_to_recordset(v->'products') as x(name text, "branchPrices" jsonb) where x.name = pr.name and x."branchPrices" -> b.id is not null);

  -- 6) zonas conocidas: puntos de referencia de las sucursales con coordenadas
  update restaurantes.known_zone z set lat = x.lat, lng = x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where z.organization_id = v_org and z.name = x.name;
  insert into restaurantes.known_zone (organization_id, name, lat, lng)
    select v_org, x.name, x.lat, x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where not exists (select 1 from restaurantes.known_zone z where z.organization_id = v_org and z.name = x.name);
  -- 6b) colonias del piloto original, SIN coordenadas (migracion 056). Insertar solo si el nombre no existe (no pisa una zona del dueño con
  -- coordenadas); re-ejecutar solo repara la procedencia y la referencia de las filas que este seed creo (fuente propia), nunca el nombre ni las
  -- coordenadas.
  insert into restaurantes.known_zone (organization_id, name, lat, lng, fuente, asignacion_fuente, ref_sucursal_slug, ref_km, ref2_sucursal_slug, ref2_km)
    select v_org, x.name, null, null, x.fuente, x."asignacionFuente", x."refSlug", x."refKm", x."ref2Slug", x."ref2Km"
    from jsonb_to_recordset(v->'colonias') as x(name text, fuente text, "asignacionFuente" text, "refSlug" text, "refKm" numeric, "ref2Slug" text, "ref2Km" numeric)
    where not exists (select 1 from restaurantes.known_zone z where z.organization_id = v_org and z.name = x.name);
  update restaurantes.known_zone z set fuente = x.fuente, asignacion_fuente = x."asignacionFuente", ref_sucursal_slug = x."refSlug", ref_km = x."refKm",
      ref2_sucursal_slug = x."ref2Slug", ref2_km = x."ref2Km"
    from jsonb_to_recordset(v->'colonias') as x(name text, fuente text, "asignacionFuente" text, "refSlug" text, "refKm" numeric, "ref2Slug" text, "ref2Km" numeric)
    where z.organization_id = v_org and z.name = x.name and z.fuente in ('piloto_original_merida_colonias', 'chats_t7');
  -- 6c) cobertura de entrega (branch_delivery_zone): el punto de referencia de cada sucursal cubre SU sucursal y cada colonia asignada cubre la suya (o las suyas: cobertura multiple, una fila por sucursal).
  -- Solo se agrega a una zona que NO tiene ninguna cobertura todavia: una colonia que el dueño MOVIO a otra sucursal en la pantalla de Reglas de la
  -- sucursal no se repone en la original (si la dejo sin ninguna sucursal, el seed la vuelve a asignar). Una colonia SIN asignar (sin sucursales) no
  -- recibe ninguna: el agente no la valida y la pasa a una persona.
  insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
    select p.id, z.id, v_org
    from (
      select x.name as zname, x."branchId" as bid from jsonb_to_recordset(v->'zones') as x(name text, "branchId" text)
      union all
      select c.name, cb.id from jsonb_to_recordset(v->'colonias') as c(name text, "branchIds" jsonb), jsonb_array_elements_text(c."branchIds") as cb(id)
    ) cov
    join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = cov.bid
    join core.property p on p.organization_id = v_org and p.name = b.name
    join restaurantes.known_zone z on z.organization_id = v_org and z.name = cov.zname
    where not exists (select 1 from restaurantes.branch_delivery_zone bz where bz.zone_id = z.id)
    on conflict do nothing;

  -- 7) politica por sucursal: horario, minimos, propina
  insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica, visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada)
    select p.id, v_org, (v->'policy'->'horario'), (v->'policy'->>'pedidoMinimoDomicilio')::numeric, (v->'policy'->>'pedidoMinimoRecoger')::numeric, v->'policy'->>'propinaPolitica',
           b."visibleEnDirectorio", coalesce(b."aceptaDomicilio", true),
           case when jsonb_typeof(b."diasDomicilio") = 'array' then (select array_agg(d::smallint) from jsonb_array_elements_text(b."diasDomicilio") d) end,
           coalesce(b."deTemporada", false)
    from jsonb_to_recordset(v->'branches') as b(name text, "visibleEnDirectorio" boolean, "aceptaDomicilio" boolean, "diasDomicilio" jsonb, "deTemporada" boolean)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do update set horario = excluded.horario, pedido_minimo_domicilio = excluded.pedido_minimo_domicilio,
      pedido_minimo_recoger = excluded.pedido_minimo_recoger, propina_politica = excluded.propina_politica,
      visible_en_directorio = excluded.visible_en_directorio, acepta_domicilio = excluded.acepta_domicilio,
      dias_domicilio = excluded.dias_domicilio, de_temporada = excluded.de_temporada, updated_at = now();

  -- 8) voz (DESHABILITADA: sin gasto de proveedores). Re-ejecutar no la vuelve a deshabilitar ni habilitar.
  insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, voice_id, comportamiento, mensaje_inicial)
    select p.id, v_org, false, v->'voice'->>'voiceId', v->'voice'->>'comportamiento', g."mensajeInicial"
    from jsonb_to_recordset(v->'voice'->'greetings') as g("branchSlug" text, "mensajeInicial" text)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = g."branchSlug"
    join core.property p on p.id = bd.property_id
    on conflict (property_id) do update set comportamiento = excluded.comportamiento, mensaje_inicial = excluded.mensaje_inicial, updated_at = now();

  -- 9) promociones (2x1 y combo de cortesia por dia y canal sobre productos elegibles)
  -- auto_apply = true: el agente de WhatsApp no manda codigos de promocion, asi que el 2x1 solo se aplica si la propia
  -- cotizacion lo aplica sola (por dia y canal). Sin esto el descuento prometido nunca llegaba al total.
  -- property_ids (migracion 038): las sucursales donde vale la promocion, resueltas por el id del seed (T2, T3...) contra las
  -- sucursales DE ESTA organizacion; null = todas. Re-ejecutar repara el alcance (lo controla el seed, como los canales).
  -- cortesia (migracion 031): product_ids = productos que la disparan; courtesy_product_ids = las aguas a elegir; courtesy_quantity = piezas por unidad.
  insert into restaurantes.promotions (organization_id, code, name, description, type, value, days_of_week, channels, product_ids, auto_apply, property_ids, courtesy_product_ids, courtesy_quantity)
    select v_org, x.code, x.name, x.description, x.type, 1, (select array_agg(d::smallint) from jsonb_array_elements_text(x."daysOfWeek") d),
           (select array_agg(c) from jsonb_array_elements_text(x.channels) c),
           (select array_agg(pr.id) from jsonb_array_elements_text(x."productNames") n join restaurantes.products pr on pr.organization_id = v_org and pr.name = n),
           x."autoApply",
           case when x."branchIds" is null or x."branchIds" = 'null'::jsonb then null
                else (select array_agg(p.id order by p.id) from jsonb_array_elements_text(x."branchIds") sid
                      join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = sid
                      join core.property p on p.organization_id = v_org and p.name = b.name) end,
           case when x."courtesyProductNames" is null or x."courtesyProductNames" = 'null'::jsonb then null
                else (select array_agg(pr.id) from jsonb_array_elements_text(x."courtesyProductNames") n join restaurantes.products pr on pr.organization_id = v_org and pr.name = n) end,
           x."courtesyQuantity"
    from jsonb_to_recordset(v->'promotions') as x(code text, name text, description text, type text, "daysOfWeek" jsonb, channels jsonb, "productNames" jsonb, "branchIds" jsonb, "autoApply" boolean, "courtesyProductNames" jsonb, "courtesyQuantity" smallint)
    on conflict (organization_id, code) do update set name = excluded.name, description = excluded.description, type = excluded.type,
      days_of_week = excluded.days_of_week, channels = excluded.channels, product_ids = excluded.product_ids, auto_apply = excluded.auto_apply,
      property_ids = excluded.property_ids, courtesy_product_ids = excluded.courtesy_product_ids, courtesy_quantity = excluded.courtesy_quantity, updated_at = now();

  -- 10) agente de WhatsApp: perfil taqueria_pm de la organizacion con los datos del dueño. Re-ejecutar NUNCA pisa lo que el dueño cambio en el
  -- editor del agente (tono, tiempos, salsas...), mismo criterio que la voz: sobre una fila existente solo
  --   * rellena reply_debounce_seconds si esta vacio (null);
  --   * reemplaza delivery_time_text / promos_text si todavia dicen EXACTAMENTE un texto que este seed sembro antes (legacy*): ahi no hay edicion
  --     del dueño que proteger, y asi la cuenta real recibe la correccion sin pisar nada ajeno.
  -- El nombre del asistente queda en null (el dueño no lo definio): el agente se presenta como "el asistente virtual".
  insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, salsas_text, promos_text, escalation_reasons_off, reply_debounce_seconds, enabled)
    select v_org, null, w.perfil, w."agentName", w."businessName", w."toneStyle", w."deliveryTimeText", w."salsasText", w."promosText",
           coalesce((select array_agg(m) from jsonb_array_elements_text(w."escalationReasonsOff") m), '{}'::text[]), w."replyDebounceSeconds", true
    from jsonb_to_recordset(jsonb_build_array(v->'whatsappAgent')) as w(perfil text, "agentName" text, "businessName" text, "toneStyle" text,
      "deliveryTimeText" text, "salsasText" text, "promosText" text, "escalationReasonsOff" jsonb, "replyDebounceSeconds" smallint)
    on conflict (organization_id) where property_id is null do update set
      reply_debounce_seconds = coalesce(restaurantes.whatsapp_agent_config.reply_debounce_seconds, excluded.reply_debounce_seconds),
      delivery_time_text = case when restaurantes.whatsapp_agent_config.delivery_time_text in (select jsonb_array_elements_text(v->'whatsappAgent'->'legacyDeliveryTimeTexts'))
                                then excluded.delivery_time_text else restaurantes.whatsapp_agent_config.delivery_time_text end,
      promos_text = case when restaurantes.whatsapp_agent_config.promos_text in (select jsonb_array_elements_text(v->'whatsappAgent'->'legacyPromosTexts'))
                         then excluded.promos_text else restaurantes.whatsapp_agent_config.promos_text end,
      updated_at = now();
  -- 10b) tiempo de entrega PROPIO de una sucursal (T7: tiempos medidos en sus chats): una fila con property_id. El lector prefiere la fila de
  -- la sucursal sobre la de la organizacion Y la usa ENTERA (no mezcla campos), asi que la fila copia todo lo de la organizacion y solo cambia
  -- delivery_time_text. DO NOTHING si ya existe: lo que el dueño edite en el panel no se pisa. Si luego edita la fila de la organizacion,
  -- esta copia no se entera (se edita en la sucursal).
  insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, enabled)
    select o.organization_id, p.id, o.perfil, o.agent_name, o.business_name, o.tone_style, d."deliveryTimeText", o.greeting_text, o.salsas_text, o.promos_text, o.escalation_reasons_off, o.large_order_text, o.reply_debounce_seconds, o.enabled
    from jsonb_to_recordset(v->'whatsappAgent'->'deliveryByBranch') as d("branchId" text, "deliveryTimeText" text)
    join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = d."branchId"
    join core.property p on p.organization_id = v_org and p.name = b.name
    join restaurantes.whatsapp_agent_config o on o.organization_id = v_org and o.property_id is null
    on conflict (organization_id, property_id) where property_id is not null do nothing;

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
