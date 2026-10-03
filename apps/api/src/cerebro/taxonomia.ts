// Taxonomia por vertical del Cerebro de ventas (SA-L-38): lectura, validacion y guardado versionado. Editar = insertar una
// version nueva (core.save_cerebro_taxonomia_for_superadmin); nunca hay UPDATE de una version. El PRECIO nunca se guarda: sale
// de core.plan y, si no hay, se muestra "precio por definir" (jamas un precio inventado).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { avisarCerebroNoMigrado, esCerebroNoMigrado } from "./acceso.ts";
import type { DimensionScore, TaxonomiaScoring } from "./scoring.ts";

export const VERTICALES = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
export type VerticalCerebro = (typeof VERTICALES)[number];

export interface SubtipoTaxonomia {
  readonly clave: string;
  readonly nombre: string;
}
export interface RangoTamano {
  readonly clave: string;
  readonly etiqueta: string;
}
export interface SenalDef {
  readonly tipo: string;
  readonly nombre: string;
  readonly dimension: DimensionScore;
  readonly puntos: number;
  readonly como_conseguirla: string;
}
export interface IcpTaxonomia {
  readonly descripcion: string;
  readonly subtipos_objetivo: readonly string[];
  readonly tamanos_objetivo: readonly string[];
}
export interface ObjecionTaxonomia {
  readonly objecion: string;
  readonly respuesta: string;
}
export interface MensajeBase {
  readonly canal: string;
  readonly variante: string;
  readonly texto: string;
}

export interface PrecioPlan {
  readonly estado: "definido" | "por_definir";
  readonly texto: string;
  readonly baseMxnCentavos: number | null;
  readonly asientoMxnCentavos: number | null;
  readonly asientosIncluidos: number | null;
}

export interface TaxonomiaVersion {
  readonly id: string;
  readonly vertical: string;
  readonly version: number;
  readonly vigente: boolean;
  readonly subtipos: readonly SubtipoTaxonomia[];
  readonly rangosTamano: { readonly unidad: string; readonly rangos: readonly RangoTamano[] };
  readonly senales: readonly SenalDef[];
  readonly icp: IcpTaxonomia;
  readonly objeciones: readonly ObjecionTaxonomia[];
  readonly mensajesBase: readonly MensajeBase[];
  readonly contexto: Readonly<Record<string, unknown>>;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly precio: PrecioPlan;
  readonly estadoValidacion: string;
  readonly notaCambio: string | null;
  readonly vigenteDesde: string;
  readonly creadoEn: string;
}

interface TaxonomiaRow {
  id: string;
  vertical: string;
  version: number | string;
  vigente: boolean;
  subtipos: SubtipoTaxonomia[];
  rangos_tamano: { unidad: string; rangos: RangoTamano[] };
  senales: SenalDef[];
  icp: IcpTaxonomia;
  objeciones: ObjecionTaxonomia[];
  mensajes_base: MensajeBase[];
  contexto: Record<string, unknown>;
  plan_id: string | null;
  plan_nombre: string | null;
  plan_precio_base_mxn_centavos: number | string | null;
  plan_precio_asiento_mxn_centavos: number | string | null;
  plan_asientos_incluidos: number | string | null;
  estado_validacion: string;
  nota_cambio: string | null;
  vigente_desde: string | Date;
  creado_en: string | Date;
}

/** Centavos a "$1,234.50" sin Intl ni toLocale (formato es-MX: coma de miles, punto decimal). */
export function formatearMxn(centavos: number): string {
  const pesos = Math.floor(centavos / 100);
  const resto = centavos % 100;
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return resto === 0 ? `$${miles}` : `$${miles}.${String(resto).padStart(2, "0")}`;
}

function aNumeroONull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** El precio sale SIEMPRE de core.plan. Sin plan o con precio null: "precio por definir". */
export function precioDePlan(planId: string | null, base: number | null, asiento: number | null, incluidos: number | null): PrecioPlan {
  if (planId === null || (base === null && asiento === null)) {
    return { estado: "por_definir", texto: "Precio por definir", baseMxnCentavos: base, asientoMxnCentavos: asiento, asientosIncluidos: incluidos };
  }
  const partes: string[] = [];
  if (base !== null && base > 0) partes.push(`${formatearMxn(base)} MXN base al mes`);
  if (asiento !== null) partes.push(`${formatearMxn(asiento)} MXN al mes por asiento${incluidos ? ` (${incluidos} incluidos)` : ""}`);
  if (partes.length === 0) return { estado: "por_definir", texto: "Precio por definir", baseMxnCentavos: base, asientoMxnCentavos: asiento, asientosIncluidos: incluidos };
  return { estado: "definido", texto: partes.join(" + "), baseMxnCentavos: base, asientoMxnCentavos: asiento, asientosIncluidos: incluidos };
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function mapTaxonomia(r: TaxonomiaRow): TaxonomiaVersion {
  const base = aNumeroONull(r.plan_precio_base_mxn_centavos);
  const asiento = aNumeroONull(r.plan_precio_asiento_mxn_centavos);
  const incluidos = aNumeroONull(r.plan_asientos_incluidos);
  return {
    id: r.id,
    vertical: r.vertical,
    version: Number(r.version),
    vigente: r.vigente === true,
    subtipos: r.subtipos,
    rangosTamano: r.rangos_tamano,
    senales: r.senales,
    icp: r.icp,
    objeciones: r.objeciones,
    mensajesBase: r.mensajes_base,
    contexto: r.contexto,
    planId: r.plan_id,
    planNombre: r.plan_nombre,
    precio: precioDePlan(r.plan_id, base, asiento, incluidos),
    estadoValidacion: r.estado_validacion,
    notaCambio: r.nota_cambio,
    vigenteDesde: iso(r.vigente_desde),
    creadoEn: iso(r.creado_en),
  };
}

export type ListaTaxonomia = { readonly disponible: true; readonly versiones: readonly TaxonomiaVersion[] } | { readonly disponible: false };

export async function listarTaxonomia(db: TenantDbSession, callerId: string): Promise<ListaTaxonomia> {
  return runWithSavepointFallback<ListaTaxonomia>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<TaxonomiaRow>("select * from core.list_cerebro_taxonomia_for_superadmin($1);", [callerId]);
      return { disponible: true as const, versiones: rows.map(mapTaxonomia) };
    },
    isRecoverable: esCerebroNoMigrado,
    fallback: async () => {
      avisarCerebroNoMigrado("list_cerebro_taxonomia_for_superadmin");
      return { disponible: false as const };
    },
  });
}

/** Version vigente (mayor version) de cada vertical. */
export function vigentesPorVertical(versiones: readonly TaxonomiaVersion[]): Map<string, TaxonomiaVersion> {
  const m = new Map<string, TaxonomiaVersion>();
  for (const v of versiones) if (v.vigente) m.set(v.vertical, v);
  return m;
}

export function toScoringTaxonomia(t: TaxonomiaVersion | undefined): TaxonomiaScoring | null {
  if (!t) return null;
  return {
    version: t.version,
    subtiposObjetivo: t.icp.subtipos_objetivo ?? [],
    tamanosObjetivo: t.icp.tamanos_objetivo ?? [],
    senales: t.senales.map((s) => ({ tipo: s.tipo, nombre: s.nombre, dimension: s.dimension, puntos: s.puntos, comoConseguirla: s.como_conseguirla })),
  };
}

// ---- Validacion del contenido editado (antes de tocar la base) ----

const SLUG_RE = /^[a-z0-9][a-z0-9_]{1,59}$/;
// Promesas de cifras: porcentajes, montos y "garantiza". Espejo (mas estricto) del guard SQL de la migracion 0049.
const PROMESA_CIFRAS_RE = /([0-9][0-9.,]*\s*%|\$\s*[0-9]|[0-9]\s*(mxn|pesos)|garantiz)/iu;
// Licitaciones: nunca prometer adjudicaciones ni insinuar influencia.
const PROMESA_LICITACION_RE = /(adjudic|influenc|contactos? en (la )?(dependencia|gobierno))/iu;
const MAX_ITEMS = 60;
const DIMENSIONES = new Set(["ajuste", "urgencia", "cierre"]);

export interface ContenidoTaxonomia {
  readonly subtipos?: readonly SubtipoTaxonomia[];
  readonly rangos_tamano?: { readonly unidad: string; readonly rangos: readonly RangoTamano[] };
  readonly senales?: readonly SenalDef[];
  readonly icp?: IcpTaxonomia;
  readonly objeciones?: readonly ObjecionTaxonomia[];
  readonly mensajes_base?: readonly MensajeBase[];
  readonly contexto?: Readonly<Record<string, unknown>>;
}

type Validado<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function texto(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

/** Valida el contenido enviado por la pantalla de taxonomia. Solo las claves presentes se validan. */
export function validarContenidoTaxonomia(vertical: string, raw: unknown): Validado<ContenidoTaxonomia> {
  if (!esObjeto(raw)) return { ok: false, error: "contenido debe ser un objeto." };
  const out: Record<string, unknown> = {};

  if ("subtipos" in raw) {
    if (!Array.isArray(raw.subtipos) || raw.subtipos.length === 0 || raw.subtipos.length > MAX_ITEMS) return { ok: false, error: "subtipos debe ser una lista de 1 a 60 elementos." };
    const claves = new Set<string>();
    const lista: SubtipoTaxonomia[] = [];
    for (const s of raw.subtipos) {
      const clave = esObjeto(s) ? texto(s.clave, 60) : null;
      const nombre = esObjeto(s) ? texto(s.nombre, 120) : null;
      if (!clave || !SLUG_RE.test(clave) || !nombre) return { ok: false, error: "Cada subtipo necesita clave (minúsculas, números y guion bajo) y nombre." };
      if (claves.has(clave)) return { ok: false, error: `La clave de subtipo "${clave}" está repetida.` };
      claves.add(clave);
      lista.push({ clave, nombre });
    }
    out.subtipos = lista;
  }

  if ("rangos_tamano" in raw) {
    const r = raw.rangos_tamano;
    const unidad = esObjeto(r) ? texto(r.unidad, 60) : null;
    if (!esObjeto(r) || !unidad || !Array.isArray(r.rangos) || r.rangos.length === 0 || r.rangos.length > MAX_ITEMS) return { ok: false, error: "rangos_tamano necesita unidad y de 1 a 60 rangos." };
    const claves = new Set<string>();
    const rangos: RangoTamano[] = [];
    for (const x of r.rangos) {
      const clave = esObjeto(x) ? texto(x.clave, 60) : null;
      const etiqueta = esObjeto(x) ? texto(x.etiqueta, 60) : null;
      if (!clave || !SLUG_RE.test(clave) || !etiqueta) return { ok: false, error: "Cada rango de tamaño necesita clave y etiqueta." };
      if (claves.has(clave)) return { ok: false, error: `La clave de rango "${clave}" está repetida.` };
      claves.add(clave);
      rangos.push({ clave, etiqueta });
    }
    out.rangos_tamano = { unidad, rangos };
  }

  if ("senales" in raw) {
    if (!Array.isArray(raw.senales) || raw.senales.length > MAX_ITEMS) return { ok: false, error: "senales debe ser una lista de hasta 60 elementos." };
    const tipos = new Set<string>();
    const lista: SenalDef[] = [];
    for (const s of raw.senales) {
      const tipo = esObjeto(s) ? texto(s.tipo, 60) : null;
      const nombre = esObjeto(s) ? texto(s.nombre, 160) : null;
      const como = esObjeto(s) ? texto(s.como_conseguirla, 400) : null;
      const dimension = esObjeto(s) && typeof s.dimension === "string" && DIMENSIONES.has(s.dimension) ? (s.dimension as DimensionScore) : null;
      const puntos = esObjeto(s) && typeof s.puntos === "number" && Number.isInteger(s.puntos) && s.puntos >= 1 && s.puntos <= 100 ? s.puntos : null;
      if (!tipo || !SLUG_RE.test(tipo) || !nombre || !como || !dimension || puntos === null) {
        return { ok: false, error: "Cada señal necesita tipo, nombre, dimensión (ajuste, urgencia o cierre), puntos enteros de 1 a 100 y cómo conseguirla." };
      }
      if (tipos.has(tipo)) return { ok: false, error: `El tipo de señal "${tipo}" está repetido.` };
      tipos.add(tipo);
      lista.push({ tipo, nombre, dimension, puntos, como_conseguirla: como });
    }
    out.senales = lista;
  }

  if ("icp" in raw) {
    const i = raw.icp;
    const descripcion = esObjeto(i) ? texto(i.descripcion, 600) : null;
    const subs = esObjeto(i) && Array.isArray(i.subtipos_objetivo) && i.subtipos_objetivo.every((x) => typeof x === "string") ? (i.subtipos_objetivo as string[]) : null;
    const tams = esObjeto(i) && Array.isArray(i.tamanos_objetivo) && i.tamanos_objetivo.every((x) => typeof x === "string") ? (i.tamanos_objetivo as string[]) : null;
    if (!descripcion || !subs || !tams) return { ok: false, error: "icp necesita descripción, subtipos_objetivo y tamanos_objetivo." };
    out.icp = { descripcion, subtipos_objetivo: [...new Set(subs)], tamanos_objetivo: [...new Set(tams)] };
  }

  if ("objeciones" in raw) {
    if (!Array.isArray(raw.objeciones) || raw.objeciones.length > MAX_ITEMS) return { ok: false, error: "objeciones debe ser una lista de hasta 60 elementos." };
    const lista: ObjecionTaxonomia[] = [];
    for (const o of raw.objeciones) {
      const objecion = esObjeto(o) ? texto(o.objecion, 300) : null;
      const respuesta = esObjeto(o) ? texto(o.respuesta, 600) : null;
      if (!objecion || !respuesta) return { ok: false, error: "Cada objeción necesita objeción y respuesta." };
      lista.push({ objecion, respuesta });
    }
    out.objeciones = lista;
  }

  if ("mensajes_base" in raw) {
    if (!Array.isArray(raw.mensajes_base) || raw.mensajes_base.length === 0 || raw.mensajes_base.length > MAX_ITEMS) return { ok: false, error: "mensajes_base debe ser una lista de 1 a 60 elementos." };
    const lista: MensajeBase[] = [];
    for (const m of raw.mensajes_base) {
      const canal = esObjeto(m) ? texto(m.canal, 30) : null;
      const variante = esObjeto(m) ? texto(m.variante, 30) : null;
      const t = esObjeto(m) ? texto(m.texto, 1200) : null;
      if (!canal || !variante || !t) return { ok: false, error: "Cada mensaje base necesita canal, variante y texto." };
      if (PROMESA_CIFRAS_RE.test(t)) return { ok: false, error: "Un mensaje base no puede prometer cifras (porcentajes, montos ni garantías)." };
      if (vertical === "licitaciones" && PROMESA_LICITACION_RE.test(t)) return { ok: false, error: "En licitaciones un mensaje base nunca puede prometer adjudicaciones ni insinuar influencia." };
      lista.push({ canal, variante, texto: t });
    }
    out.mensajes_base = lista;
  }

  if ("contexto" in raw) {
    if (!esObjeto(raw.contexto) || JSON.stringify(raw.contexto).length > 8000) return { ok: false, error: "contexto debe ser un objeto de hasta 8 KB." };
    out.contexto = raw.contexto;
  }

  return { ok: true, valor: out as ContenidoTaxonomia };
}

/** Coherencia del ICP contra los subtipos y rangos finales (los enviados o, si faltan, los de la version vigente). */
export function validarCoherenciaIcp(contenido: ContenidoTaxonomia, vigente: TaxonomiaVersion | undefined): string | null {
  const icp = contenido.icp ?? vigente?.icp;
  const subtipos = contenido.subtipos ?? vigente?.subtipos;
  const rangos = contenido.rangos_tamano?.rangos ?? vigente?.rangosTamano.rangos;
  if (!icp) return null;
  if (subtipos) {
    const claves = new Set(subtipos.map((s) => s.clave));
    const falta = icp.subtipos_objetivo.find((c) => !claves.has(c));
    if (falta) return `El ICP apunta al subtipo "${falta}", que no existe en los subtipos.`;
  }
  if (rangos) {
    const claves = new Set(rangos.map((r) => r.clave));
    const falta = icp.tamanos_objetivo.find((c) => !claves.has(c));
    if (falta) return `El ICP apunta al rango de tamaño "${falta}", que no existe en los rangos.`;
  }
  return null;
}

export type ResultadoGuardarTaxonomia = { readonly estado: "guardada"; readonly taxonomia: TaxonomiaVersion } | { readonly estado: "no_migrada" } | { readonly estado: "rechazada"; readonly mensaje: string };

export async function guardarTaxonomia(
  db: TenantDbSession,
  callerId: string,
  vertical: string,
  contenido: ContenidoTaxonomia,
  planId: string | null,
  nota: string | null,
  validada: boolean,
): Promise<ResultadoGuardarTaxonomia> {
  return runWithSavepointFallback<ResultadoGuardarTaxonomia>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ version: number | string }>(
        "select version from core.save_cerebro_taxonomia_for_superadmin($1, $2, $3::jsonb, $4, $5, $6);",
        [callerId, vertical, JSON.stringify(contenido), planId, nota, validada],
      );
      const version = Number(rows[0]?.version);
      const lista = await db.query<TaxonomiaRow>("select * from core.list_cerebro_taxonomia_for_superadmin($1);", [callerId]);
      const guardada = lista.rows.map(mapTaxonomia).find((t) => t.vertical === vertical && t.version === version);
      if (!guardada) throw new Error("save_cerebro_taxonomia_for_superadmin no devolvió la versión guardada.");
      return { estado: "guardada" as const, taxonomia: guardada };
    },
    isRecoverable: (err) => esCerebroNoMigrado(err) || (typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code === "22023"),
    fallback: async (err) => {
      if (esCerebroNoMigrado(err)) {
        avisarCerebroNoMigrado("save_cerebro_taxonomia_for_superadmin");
        return { estado: "no_migrada" as const };
      }
      // 22023: parametro invalido segun la funcion SQL (plan inexistente o de otra vertical, vertical invalida, contenido incompleto).
      return { estado: "rechazada" as const, mensaje: err instanceof Error ? err.message.replace(/^save_cerebro_taxonomia_for_superadmin:\s*/u, "") : "Contenido inválido." };
    },
  });
}
