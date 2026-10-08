// Esquemas de entrada de `/admin/cfo/*` (query y cuerpos). El repositorio no tiene Zod como dependencia; estos validadores cerrados
// cumplen el mismo papel: lista cerrada de llaves, tipos estrictos, rangos y topes, y mensajes claros en español.
//  - Query inválida (fecha, rango > 400 días, > 20 sucursales, enumerados) -> 422.
//  - Cuerpo inválido -> 422; cuerpo demasiado grande -> 413 (lo corta `readJsonCapped`).
//  - Lo que la base rechaza con 22023 llega después como 400 (ver `cfo.ts`).
import { ApiError } from "@atiende/core-auth";
import { COMPARAR_CFO, CONCEPTOS_COSTO, GRANULARIDADES_CFO, RANGOS_CONFIG_CFO } from "@atiende/domain-restaurantes/cfo";
import type { CompararCfo, ConceptoCosto, FiltroPedidosDetalle, Granularidad, VistaExportacionCfo } from "@atiende/domain-restaurantes/cfo";
import { Errors } from "../../../errors.ts";

export const CFO_MAX_DIAS = 400;
export const CFO_MAX_SUCURSALES_QUERY = 20;
// 4 MB: por debajo del límite de cuerpo de las Vercel Functions (~4.5 MB), para que el 413 sea el JSON propio y no el de la plataforma.
export const CFO_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const CFO_PEDIDOS_LIMITE_MAX = 100;
export const CFO_COSTOS_LOTE_MAX = 50;

export const invalido = (message: string): ApiError => new ApiError(422, "validation_error", message);

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Años admitidos: fuera de este rango Postgres/JS dejan de coincidir (año 0000, 9999) y los cálculos de periodo anterior se salen de rango. */
export const CFO_ANIO_MIN = 2000;
export const CFO_ANIO_MAX = 2100;
const anioOk = (a: number): boolean => a >= CFO_ANIO_MIN && a <= CFO_ANIO_MAX;

/** Fecha de calendario real (no acepta 2026-02-30) dentro de 2000..2100. */
export function fechaValida(s: string): boolean {
  if (!FECHA_RE.test(s)) return false;
  if (!anioOk(Number(s.slice(0, 4)))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function diasInclusive(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}

export interface ConsultaParseada {
  readonly desde: string;
  readonly hasta: string;
  /** null = «todas» (las permitidas del actor). */
  readonly sucursales: readonly string[] | null;
  readonly comparar: CompararCfo;
  readonly granularidad: Granularidad;
}

export function parsearRango(desde: string | undefined, hasta: string | undefined): { desde: string; hasta: string } {
  if (desde === undefined || hasta === undefined) throw invalido("desde y hasta son obligatorios (YYYY-MM-DD).");
  if (!fechaValida(desde) || !fechaValida(hasta)) throw invalido(`desde y hasta deben ser fechas válidas YYYY-MM-DD (años ${CFO_ANIO_MIN} a ${CFO_ANIO_MAX}).`);
  if (desde > hasta) throw invalido("desde no puede ser posterior a hasta.");
  if (diasInclusive(desde, hasta) > CFO_MAX_DIAS) throw invalido(`El rango máximo es de ${CFO_MAX_DIAS} días.`);
  return { desde, hasta };
}

export function parsearSucursales(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw === "" || raw === "todas") return null;
  if (raw.length > 20 * 40) throw invalido("sucursales: lista demasiado larga.");
  const ids = raw.split(",").map((x) => x.trim());
  if (ids.some((x) => x === "")) throw invalido("sucursales: la lista tiene elementos vacíos.");
  if (ids.some((x) => !UUID_RE.test(x))) throw invalido("sucursales: cada elemento debe ser un identificador de sucursal.");
  const unicos = [...new Set(ids.map((x) => x.toLowerCase()))];
  if (unicos.length > CFO_MAX_SUCURSALES_QUERY) throw invalido(`sucursales: máximo ${CFO_MAX_SUCURSALES_QUERY} sucursales por consulta.`);
  return unicos;
}

export function parsearConsulta(q: (k: string) => string | undefined): ConsultaParseada {
  const { desde, hasta } = parsearRango(q("desde"), q("hasta"));
  const comparar = q("comparar") ?? "periodo_anterior";
  if (!(COMPARAR_CFO as readonly string[]).includes(comparar)) throw invalido("comparar debe ser periodo_anterior, anio_anterior o mismo_dia_semana_4.");
  const granularidad = q("granularidad") ?? "dia";
  if (!(GRANULARIDADES_CFO as readonly string[]).includes(granularidad)) throw invalido("granularidad debe ser dia, semana o mes.");
  return { desde, hasta, sucursales: parsearSucursales(q("sucursales")), comparar: comparar as CompararCfo, granularidad: granularidad as Granularidad };
}

export function parsearOrden(raw: string | undefined): "impacto" | "urgencia" {
  if (raw === undefined) return "impacto";
  if (raw !== "impacto" && raw !== "urgencia") throw invalido("orden debe ser impacto o urgencia.");
  return raw;
}

// ---- /pedidos ------------------------------------------------------------------------------------------------------------------------------

const FILTRO_TEXTO = ["canal", "source", "status", "payment_method", "producto_ref"] as const;
const FILTRO_BOOL = ["es_venta", "es_compensacion", "con_descuento", "entrega_tarde"] as const;
const FILTRO_ENTERO = ["hora_local", "dow_negocio"] as const;

export function parsearFiltroPedidos(raw: string | undefined): FiltroPedidosDetalle {
  if (raw === undefined || raw === "") return {};
  if (raw.length > 500) throw invalido("filtro: demasiado largo.");
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw invalido("filtro debe ser un objeto JSON.");
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw invalido("filtro debe ser un objeto JSON.");
  const out: Record<string, string | boolean | number> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if ((FILTRO_TEXTO as readonly string[]).includes(k)) {
      if (typeof v !== "string" || v === "" || v.length > 100) throw invalido(`filtro.${k} debe ser texto (hasta 100 caracteres).`);
      out[k] = v;
    } else if ((FILTRO_BOOL as readonly string[]).includes(k)) {
      if (typeof v !== "boolean") throw invalido(`filtro.${k} debe ser verdadero o falso.`);
      out[k] = v;
    } else if ((FILTRO_ENTERO as readonly string[]).includes(k)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23 || (k === "dow_negocio" && (v < 1 || v > 7))) throw invalido(`filtro.${k} fuera de rango.`);
      out[k] = v;
    } else {
      throw invalido(`filtro: la llave «${k}» no está permitida.`);
    }
  }
  return out as FiltroPedidosDetalle;
}

export function parsearLimite(raw: string | undefined): number {
  if (raw === undefined) return 50;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > CFO_PEDIDOS_LIMITE_MAX) throw invalido(`limite debe ser un entero entre 1 y ${CFO_PEDIDOS_LIMITE_MAX}.`);
  return Number(raw);
}

export function parsearCursor(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}\|\d{1,18}$/.test(raw)) throw invalido("cursor inválido.");
  return raw;
}

// ---- /config -------------------------------------------------------------------------------------------------------------------------------

const ENTEROS_CONFIG: ReadonlySet<string> = new Set(["frecuenteN", "frecuenteDias", "activoDias", "perdidoDias", "promesaMin", "entregaP90MaxMin", "srCuadreVerdeCentavos"]);
const SNAKE: Readonly<Record<string, string>> = {
  frecuenteN: "frecuente_n", frecuenteDias: "frecuente_dias", activoDias: "activo_dias", perdidoDias: "perdido_dias", promesaMin: "promesa_min", ivaPct: "iva_pct", caidaPct: "caida_pct",
  ticketBajaPct: "ticket_baja_pct", cancelacionXMediana: "cancelacion_x_mediana", descuentoMaxPct: "descuento_max_pct", costoAgenteAlzaPct: "costo_agente_alza_pct",
  cierreBajaPp: "cierre_baja_pp", entregaP90MaxMin: "entrega_p90_max_min", srCuadreVerdePct: "sr_cuadre_verde_pct", srCuadreAmbarPct: "sr_cuadre_ambar_pct",
  srCuadreVerdeCentavos: "sr_cuadre_verde_centavos", comisionTerminalPct: "comision_terminal_pct",
};

/** Cuerpo `{ ivaPct: 16, … }` (camelCase, solo las llaves a cambiar) -> llaves SQL de `cfo_config_guardar`. */
export function parsearConfig(body: unknown): Record<string, number | null> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalido("Se esperaba un objeto con las llaves de configuración a cambiar.");
  const entradas = Object.entries(body as Record<string, unknown>);
  if (entradas.length === 0) throw invalido("No hay cambios que guardar.");
  const out: Record<string, number | null> = {};
  for (const [k, v] of entradas) {
    if (!Object.hasOwn(RANGOS_CONFIG_CFO, k)) throw invalido(`La llave «${k}» no es una configuración del CFO.`);
    if (k === "comisionTerminalPct" && v === null) {
      out[SNAKE[k]!] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw invalido(`${k} debe ser un número.`);
    if (ENTEROS_CONFIG.has(k) && !Number.isInteger(v)) throw invalido(`${k} debe ser un entero.`);
    const [min, max] = RANGOS_CONFIG_CFO[k]!;
    if (v < min || v > max) throw invalido(`${k} debe estar entre ${min} y ${max}.`);
    out[SNAKE[k]!] = v;
  }
  const act = out["activo_dias"];
  const per = out["perdido_dias"];
  if (act !== undefined && per !== undefined && act !== null && per !== null && act >= per) throw invalido("activoDias debe ser menor que perdidoDias.");
  return out;
}

// ---- /costos -------------------------------------------------------------------------------------------------------------------------------

export interface CostoEntrada {
  readonly propertyId: string | null;
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly concepto: ConceptoCosto;
  readonly montoCentavos: number | null;
  readonly pct: number | null;
  readonly nota: string | null;
}

export function normalizarMes(raw: unknown, campo = "mes"): string {
  if (typeof raw !== "string") throw invalido(`${campo} debe ser YYYY-MM o YYYY-MM-01.`);
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(raw);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || !anioOk(Number(m[1]))) throw invalido(`${campo} debe ser YYYY-MM o YYYY-MM-01.`);
  return `${m[1]}-${m[2]}-01`;
}

export function parsearCostos(body: unknown): CostoEntrada[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalido("Se esperaba { costos: [...] }.");
  const costos = (body as Record<string, unknown>)["costos"];
  if (Object.keys(body as object).some((k) => k !== "costos")) throw invalido("Solo se admite la llave «costos».");
  if (!Array.isArray(costos) || costos.length < 1 || costos.length > CFO_COSTOS_LOTE_MAX) throw invalido(`costos debe traer de 1 a ${CFO_COSTOS_LOTE_MAX} renglones.`);
  return costos.map((x, i) => {
    const p = `costos[${i}]`;
    if (x === null || typeof x !== "object" || Array.isArray(x)) throw invalido(`${p} debe ser un objeto.`);
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["propertyId", "mes", "concepto", "montoCentavos", "pct", "nota"].includes(k)) throw invalido(`${p}: la llave «${k}» no está permitida.`);
    const propertyId = o["propertyId"] ?? null;
    if (propertyId !== null && (typeof propertyId !== "string" || !UUID_RE.test(propertyId))) throw invalido(`${p}.propertyId debe ser una sucursal o null (costo de la organización).`);
    const concepto = o["concepto"];
    if (typeof concepto !== "string" || !(CONCEPTOS_COSTO as readonly string[]).includes(concepto)) throw invalido(`${p}.concepto no es válido.`);
    const monto = o["montoCentavos"] ?? null;
    const pct = o["pct"] ?? null;
    if ((monto === null) === (pct === null)) throw invalido(`${p}: mande exactamente uno de montoCentavos o pct.`);
    if (monto !== null && (typeof monto !== "number" || !Number.isSafeInteger(monto) || monto < 0 || monto > 10_000_000_000_000)) throw invalido(`${p}.montoCentavos debe ser un entero en centavos (0 o más).`);
    if (pct !== null && (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100)) throw invalido(`${p}.pct debe estar entre 0 y 100.`);
    if ((concepto === "food_cost_objetivo_pct") !== (pct !== null)) throw invalido(`${p}: el porcentaje aplica solo a food_cost_objetivo_pct, y ese concepto exige porcentaje.`);
    const nota = o["nota"] ?? null;
    if (nota !== null && (typeof nota !== "string" || nota.length > 300)) throw invalido(`${p}.nota debe ser texto de hasta 300 caracteres.`);
    return { propertyId: propertyId === null ? null : (propertyId as string).toLowerCase(), mes: normalizarMes(o["mes"], `${p}.mes`), concepto: concepto as ConceptoCosto, montoCentavos: monto as number | null, pct: pct as number | null, nota: nota as string | null };
  });
}

export function parsearHistorial(q: (k: string) => string | undefined): { propertyId: string | null; mes: string; concepto: ConceptoCosto } {
  const p = q("propertyId");
  if (p !== undefined && p !== "" && p !== "organizacion" && !UUID_RE.test(p)) throw invalido("propertyId debe ser una sucursal u «organizacion».");
  const concepto = q("concepto");
  if (concepto === undefined || !(CONCEPTOS_COSTO as readonly string[]).includes(concepto)) throw invalido("concepto no es válido.");
  return { propertyId: p === undefined || p === "" || p === "organizacion" ? null : p.toLowerCase(), mes: normalizarMes(q("mes")), concepto: concepto as ConceptoCosto };
}

export function parsearRangoMeses(q: (k: string) => string | undefined, hoy: string): { mesDesde: string; mesHasta: string } {
  const hasta = q("mesHasta") !== undefined ? normalizarMes(q("mesHasta"), "mesHasta") : `${hoy.slice(0, 7)}-01`;
  const desde = q("mesDesde") !== undefined ? normalizarMes(q("mesDesde"), "mesDesde") : (() => {
    const [a, m] = hasta.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(a, m - 1 - 11, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  })();
  if (desde > hasta) throw invalido("mesDesde no puede ser posterior a mesHasta.");
  if (diasInclusive(desde, hasta) > CFO_MAX_DIAS) throw invalido("El rango de meses máximo es de unos 13 meses (400 días).");
  return { mesDesde: desde, mesHasta: hasta };
}

// ---- SoftRestaurant ------------------------------------------------------------------------------------------------------------------------

export interface CuerpoSr {
  readonly propertyId: string;
  readonly nombreArchivo: string;
  readonly tabla: ReadonlyArray<ReadonlyArray<string | number | null>>;
  readonly tipo?: "resumen_servicio" | "cuentas";
}

export const SR_MAX_FILAS_TABLA = 20_000 + 30; // cuentas + renglones de título/encabezado
export const SR_MAX_COLUMNAS = 100;

export function parsearCuerpoSr(body: unknown): CuerpoSr {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalido("Se esperaba { propertyId, nombreArchivo, tabla }.");
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["propertyId", "nombreArchivo", "tabla", "tipo"].includes(k)) throw invalido(`La llave «${k}» no está permitida.`);
  const propertyId = o["propertyId"];
  if (typeof propertyId !== "string" || !UUID_RE.test(propertyId)) throw invalido("propertyId debe ser la sucursal a la que pertenece el archivo (un archivo = una sucursal).");
  const nombre = o["nombreArchivo"];
  if (typeof nombre !== "string" || nombre.length < 1 || nombre.length > 120 || /[/\\]/.test(nombre) || [...nombre].some((ch) => ch.charCodeAt(0) < 32)) throw invalido("nombreArchivo debe tener de 1 a 120 caracteres, sin ruta.");
  const tipo = o["tipo"];
  if (tipo !== undefined && tipo !== "resumen_servicio" && tipo !== "cuentas") throw invalido("tipo debe ser resumen_servicio o cuentas.");
  const tabla = o["tabla"];
  if (!Array.isArray(tabla) || tabla.length < 1) throw invalido("tabla debe ser una lista de renglones (la primera fila con encabezados).");
  if (tabla.length > SR_MAX_FILAS_TABLA) throw Errors.payloadTooLarge(`La tabla trae ${tabla.length} filas; el máximo es 20 000 cuentas (o 2 000 renglones de resumen) por archivo.`);
  for (const [i, fila] of tabla.entries()) {
    if (!Array.isArray(fila) || fila.length > SR_MAX_COLUMNAS) throw invalido(`tabla[${i}] debe ser una lista de hasta ${SR_MAX_COLUMNAS} celdas.`);
    for (const c of fila) if (c !== null && typeof c !== "string" && typeof c !== "number") throw invalido(`tabla[${i}] solo admite texto, número o null.`);
  }
  return { propertyId: propertyId.toLowerCase(), nombreArchivo: nombre, tabla: tabla as CuerpoSr["tabla"], ...(tipo ? { tipo } : {}) };
}

// ---- exportaciones -------------------------------------------------------------------------------------------------------------------------

const VISTAS_EXPORTACION: readonly VistaExportacionCfo[] = ["resumen", "ventas", "sucursales", "estado_resultados", "clientes", "platillos", "patrones", "operacion", "softrestaurant"];

export function parsearExportacion(body: unknown): { vista: VistaExportacionCfo; formato: "xlsx" | "pdf"; desde: string; hasta: string; sucursales: readonly string[] | null } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalido("Se esperaba { vista, formato, desde, hasta }.");
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["vista", "formato", "desde", "hasta", "sucursales"].includes(k)) throw invalido(`La llave «${k}» no está permitida.`);
  if (typeof o["vista"] !== "string" || !(VISTAS_EXPORTACION as readonly string[]).includes(o["vista"])) throw invalido("vista no es válida.");
  if (o["formato"] !== "xlsx" && o["formato"] !== "pdf") throw invalido("formato debe ser xlsx o pdf.");
  const { desde, hasta } = parsearRango(typeof o["desde"] === "string" ? o["desde"] : undefined, typeof o["hasta"] === "string" ? o["hasta"] : undefined);
  return { vista: o["vista"] as VistaExportacionCfo, formato: o["formato"], desde, hasta, sucursales: parsearSucursales(typeof o["sucursales"] === "string" ? (o["sucursales"] as string) : undefined) };
}
