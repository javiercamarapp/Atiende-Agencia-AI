// Clasificación contable de un CFDI persistido — D-P3-13 (paridad3). Compone, SIN LLM:
//   1. correcciones del despacho por RFC emisor (y ClaveProdServ opcional) — `method = 'correccion'`, confianza 0.95;
//   2. ClaveProdServ de los conceptos (tabla `CP_A_CATEGORIA`) — `method = 'claveprodserv'`;
//   3. palabras clave de la descripción por palabra completa (`clasificarPorReglas`) — `method = 'reglas'`.
// Un empate (dos categorías con la misma evidencia, o ClaveProdServ y descripción en desacuerdo) baja la confianza a
// `0.55 - 0.10 x rivales` (siempre < piso) y por eso SIEMPRE cae a revisión humana en la compuerta (`evaluarCompuertaClasificacion`).
// Referencia del suelto: `b2b_ai/services/classify.py` (ClaveProdServ + keywords, empate e302c60) y `common/confidence.py` (piso 0.5,
// umbral por despacho >= piso).
import { SYNTHETIC_PATTERNS, clasificarPorReglas, confianzaDeEmpate } from "./clasificador.ts";
import { CONFIDENCE_FLOOR, DEFAULT_CONFIDENCE_THRESHOLD } from "./confianza.ts";
import type { TipoCfdiBookkeeping } from "./types.ts";

export type MetodoClasificacion = "reglas" | "claveprodserv" | "correccion";

/** Categorías contables finas = las del catálogo de mapeos (`DEFAULT_MAPPINGS`) + `otros`. La migración 026 las deja en el CHECK de
 * `invoice_classification.categoria` (el test `clasificacion-cfdi-sql.spec.ts` verifica que SQL y TypeScript no se desincronicen). */
export const CATEGORIAS_CONTABLES: readonly string[] = [...new Set([...SYNTHETIC_PATTERNS.map((p) => p.category), "otros"])];

/** Categorías gruesas históricas de `invoice.categoria` / `invoice_classification.categoria` (migración 001). */
export const CATEGORIAS_GRUESAS: readonly string[] = ["gasto_operativo", "activo_fijo", "inversion", "honorarios", "nomina", "sin_clasificar"];

export const COTA_CONFIANZA_CORRECCION = 0.95;

/** Prefijos de ClaveProdServ (catálogo SAT c_ClaveProdServ, familia/clase de 6 dígitos) -> categoría contable fina. Solo lo que el
 * catálogo SAT define sin ambigüedad; lo demás se resuelve por descripción o va a revisión. Nómina NO se detecta por ClaveProdServ
 * (84111505 también se usa en honorarios): se detecta por TipoDeComprobante = N.
 * PENDIENTE DE VALIDAR CON EL CONTADOR/FISCALISTA: la tabla es un subconjunto conservador; cada fila se puede quitar sin romper nada (sin ella el
 * CFDI se clasifica por descripción o va a revisión). */
export const CP_A_CATEGORIA: readonly { readonly prefijo: string; readonly categoria: string }[] = [
  { prefijo: "801015", categoria: "servicios_profesionales" }, // consultoría de negocios
  { prefijo: "801016", categoria: "servicios_profesionales" }, // gerencia de proyectos
  { prefijo: "841115", categoria: "servicios_profesionales" }, // servicios contables
  { prefijo: "841116", categoria: "servicios_profesionales" }, // auditoría
  { prefijo: "811015", categoria: "servicios_profesionales" }, // ingeniería
  { prefijo: "801216", categoria: "honorarios_legales" }, // servicios legales
  { prefijo: "801217", categoria: "honorarios_legales" },
  { prefijo: "801315", categoria: "renta_oficina" }, // alquiler de propiedades inmobiliarias
  { prefijo: "801316", categoria: "renta_oficina" },
  { prefijo: "801416", categoria: "publicidad" }, // actividades de ventas y promoción
  { prefijo: "821015", categoria: "publicidad" }, // publicidad
  { prefijo: "821016", categoria: "publicidad" },
  { prefijo: "841215", categoria: "comision_bancaria" }, // servicios bancarios
  { prefijo: "841315", categoria: "seguros" }, // servicios de seguros
  { prefijo: "781015", categoria: "transporte" }, // transporte de carga
  { prefijo: "781018", categoria: "transporte" },
  { prefijo: "781022", categoria: "transporte" }, // mensajería y paquetería
  { prefijo: "781815", categoria: "mantenimiento" }, // mantenimiento de vehículos
  { prefijo: "721015", categoria: "mantenimiento" }, // servicios de apoyo a la construcción y mantenimiento
  { prefijo: "761115", categoria: "mantenimiento" }, // limpieza
  { prefijo: "432115", categoria: "equipo_computo" }, // computadoras
  { prefijo: "432116", categoria: "equipo_computo" },
  { prefijo: "432118", categoria: "equipo_computo" },
  { prefijo: "432119", categoria: "equipo_computo" },
  { prefijo: "432121", categoria: "equipo_computo" }, // impresoras
  { prefijo: "432018", categoria: "equipo_computo" }, // almacenamiento de datos
  { prefijo: "441115", categoria: "equipo_computo" },
  { prefijo: "441216", categoria: "papeleria" }, // suministros de escritorio
  { prefijo: "441217", categoria: "papeleria" }, // instrumentos de escritura
  { prefijo: "441220", categoria: "papeleria" }, // carpetas y archivo
  { prefijo: "141115", categoria: "papeleria" }, // productos de papel
  { prefijo: "811617", categoria: "telefonia" }, // telecomunicaciones
  { prefijo: "831115", categoria: "telefonia" },
  { prefijo: "831116", categoria: "telefonia" },
];

export interface CorreccionClasificacion {
  readonly rfcEmisor: string;
  /** ClaveProdServ exacta de 8 dígitos; null = vale para cualquier concepto de ese emisor. */
  readonly claveProdServ: string | null;
  readonly categoria: string;
  /** Cuenta del catálogo del cliente que reemplaza el cargo del mapeo por omisión; null = la del mapeo. */
  readonly cuenta: string | null;
}

export interface ConceptoClasificable {
  readonly descripcion?: string | null;
  readonly claveProdServ?: string | null;
}

export interface EntradaClasificacionCfdi {
  readonly tipo: string;
  readonly direccion?: "emitido" | "recibido" | "indeterminado" | null;
  readonly rfcEmisor: string;
  readonly conceptos: readonly ConceptoClasificable[];
}

export interface ResultadoClasificacionCfdi {
  readonly categoria: string;
  readonly confianza: number;
  readonly metodo: MetodoClasificacion;
  readonly razon: string;
  readonly empate: boolean;
  readonly rivales: number;
  /** Cuenta de la corrección aplicada (solo `metodo = 'correccion'`). */
  readonly cuenta: string | null;
}

const MAX_TEXTO_CLASIFICABLE = 4000;

function categoriasPorClave(conceptos: readonly ConceptoClasificable[]): string[] {
  const cats: string[] = [];
  for (const c of conceptos) {
    const cp = (c.claveProdServ ?? "").trim();
    if (!/^\d{8}$/.test(cp)) continue;
    const hit = CP_A_CATEGORIA.find((e) => cp.startsWith(e.prefijo));
    if (hit && !cats.includes(hit.categoria)) cats.push(hit.categoria);
  }
  return cats;
}

/** Busca la corrección que aplica: primero la del RFC con la ClaveProdServ de algún concepto, luego la del RFC sin ClaveProdServ. */
export function buscarCorreccion(rfcEmisor: string, conceptos: readonly ConceptoClasificable[], correcciones: readonly CorreccionClasificacion[]): CorreccionClasificacion | null {
  const rfc = rfcEmisor.trim().toUpperCase();
  const delRfc = correcciones.filter((c) => c.rfcEmisor.trim().toUpperCase() === rfc);
  if (delRfc.length === 0) return null;
  const claves = new Set(conceptos.map((c) => (c.claveProdServ ?? "").trim()).filter((cp) => cp !== ""));
  return delRfc.find((c) => c.claveProdServ !== null && claves.has(c.claveProdServ)) ?? delRfc.find((c) => c.claveProdServ === null) ?? null;
}

/**
 * Clasifica un CFDI. `null` = este tipo de comprobante no se clasifica solo (nota de crédito E, traslado T, pago P): ya tienen su propio
 * motivo de revisión y su póliza se registra a mano. Nómina (N) es siempre `nomina` por el tipo de comprobante.
 */
export function clasificarCfdi(entrada: EntradaClasificacionCfdi, correcciones: readonly CorreccionClasificacion[] = []): ResultadoClasificacionCfdi | null {
  if (entrada.tipo === "N") {
    return { categoria: "nomina", confianza: 0.95, metodo: "reglas", razon: "TipoDeComprobante=N", empate: false, rivales: 0, cuenta: null };
  }
  if (entrada.tipo !== "I") return null;

  const correccion = buscarCorreccion(entrada.rfcEmisor, entrada.conceptos, correcciones);
  if (correccion) {
    return {
      categoria: correccion.categoria,
      confianza: COTA_CONFIANZA_CORRECCION,
      metodo: "correccion",
      razon: correccion.claveProdServ ? "Corrección previa del despacho para este emisor y ClaveProdServ" : "Corrección previa del despacho para este emisor",
      empate: false,
      rivales: 0,
      cuenta: correccion.cuenta,
    };
  }

  // Una venta (CFDI emitido) usa los patrones de ingreso; todo lo demás (recibido o sentido aún desconocido) los de gasto.
  const tipoClasificador: TipoCfdiBookkeeping = entrada.direccion === "emitido" ? "E" : "I";
  const texto = entrada.conceptos.map((c) => c.descripcion ?? "").join(" ").slice(0, MAX_TEXTO_CLASIFICABLE);
  const porPalabras = clasificarPorReglas(texto, tipoClasificador);
  const hayPalabras = porPalabras.categoria !== "otros";
  const cats = tipoClasificador === "I" ? categoriasPorClave(entrada.conceptos) : [];

  if (cats.length === 0) {
    return {
      categoria: porPalabras.categoria,
      confianza: porPalabras.confidence,
      metodo: "reglas",
      razon: !hayPalabras ? "Sin coincidencias en la descripción ni ClaveProdServ conocida" : porPalabras.rivales > 0 ? `Empate entre ${porPalabras.rivales + 1} categorías: ${porPalabras.coincidencias.join(", ")}` : `Coincidencias: ${porPalabras.coincidencias.join(", ")}`,
      empate: porPalabras.rivales > 0,
      rivales: porPalabras.rivales,
      cuenta: null,
    };
  }

  if (cats.length > 1) {
    const rivales = cats.length - 1;
    return { categoria: cats[0]!, confianza: confianzaDeEmpate(rivales), metodo: "claveprodserv", razon: `La ClaveProdServ de los conceptos apunta a ${cats.length} categorías distintas`, empate: true, rivales, cuenta: null };
  }

  const cp = cats[0]!;
  if (hayPalabras && porPalabras.categoria !== cp) {
    return { categoria: cp, confianza: confianzaDeEmpate(1), metodo: "claveprodserv", razon: "La ClaveProdServ y la descripción apuntan a categorías distintas", empate: true, rivales: 1, cuenta: null };
  }
  const concuerdan = hayPalabras && porPalabras.rivales === 0;
  return {
    categoria: cp,
    confianza: concuerdan ? 0.9 : 0.8,
    metodo: "claveprodserv",
    razon: concuerdan ? `ClaveProdServ y descripción coinciden (${porPalabras.coincidencias.join(", ")})` : "ClaveProdServ del concepto",
    empate: false,
    rivales: 0,
    cuenta: null,
  };
}

export interface OpcionesCompuerta {
  readonly piso?: number;
  readonly umbral?: number;
}

export interface ResultadoCompuerta {
  readonly requiereRevision: boolean;
  readonly motivo: "clasificacion_baja" | null;
}

/** Compuerta de la clasificación: confianza bajo el piso duro (0.5) o bajo el umbral del despacho (0.7 por omisión) -> revisión humana. */
export function evaluarCompuertaClasificacion(confianza: number, opciones: OpcionesCompuerta = {}): ResultadoCompuerta {
  const piso = opciones.piso ?? CONFIDENCE_FLOOR;
  const umbral = Math.max(opciones.umbral ?? DEFAULT_CONFIDENCE_THRESHOLD, piso);
  const requiere = confianza < piso || confianza < umbral;
  return { requiereRevision: requiere, motivo: requiere ? "clasificacion_baja" : null };
}

/** Invariante del suelto: el umbral del despacho no puede ser menor que el piso duro (si lo fuera, el piso nunca actuaría primero). */
export function validarUmbralConfianza(umbral: unknown): { readonly ok: true; readonly umbral: number } | { readonly ok: false; readonly mensaje: string } {
  if (typeof umbral !== "number" || !Number.isFinite(umbral)) return { ok: false, mensaje: "umbralConfianza: se esperaba un número." };
  if (umbral > 1) return { ok: false, mensaje: "umbralConfianza: no puede ser mayor que 1." };
  if (umbral < CONFIDENCE_FLOOR) return { ok: false, mensaje: `umbralConfianza: no puede ser menor que el piso de confianza (${CONFIDENCE_FLOOR}).` };
  return { ok: true, umbral: Math.round(umbral * 1000) / 1000 };
}
