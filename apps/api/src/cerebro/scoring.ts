// Scoring DETERMINISTA del Cerebro de ventas (SA-L-41). Sin LLM, sin red, sin reloj: el mismo prospecto con la misma
// taxonomia y la misma version de reglas da SIEMPRE el mismo score. Funcion pura.
//
// Cuatro dimensiones, cada una de 0 a 100:
//   - ajuste (ICP):   subtipo y tamano dentro del ICP de la taxonomia (25 + 25) + senales de dimension "ajuste" (hasta 50).
//   - urgencia:       senales de dimension "urgencia" de la taxonomia (hasta 100).
//   - cierre:         senales de dimension "cierre" (hasta 60) + base de licitud (hasta 25) + persona de contacto con evidencia (15).
//   - completitud:    campos capturados (siempre se calcula, no depende de senales).
//
// EXPLICACION punto por punto: cada dimension trae `items` ({regla, puntos, evidencia{fuente, fecha, url?, valor?}}) y el
// puntaje ES la suma exacta de los puntos de sus items (los topes se aplican al construir los items, nunca despues).
//
// SENAL INSUFICIENTE: con menos de 3 senales distintas y validas (tipo, fuente y fecha), ajuste, urgencia y cierre quedan en
// `null` ("sin calificar", nunca 0) y la explicacion dice que falta y como conseguirlo. La completitud si se calcula.
//
// Las reglas de las senales (que senal suma cuanto y a que dimension) viven en la TAXONOMIA versionada de la vertical
// (core.cerebro_taxonomia): editarla crea una version nueva y por tanto una version nueva de las reglas. `score_version`
// guarda `reglas-v1/tax-N` para saber con que reglas se calculo cada score.

export const REGLAS_VERSION = "reglas-v1";
export const SENALES_MINIMAS = 3;

export type DimensionScore = "ajuste" | "urgencia" | "cierre";
export const DIMENSIONES_CON_SENAL: readonly DimensionScore[] = ["ajuste", "urgencia", "cierre"];

export const TOPE_AJUSTE_SUBTIPO = 25;
export const TOPE_AJUSTE_TAMANO = 25;
export const TOPE_AJUSTE_SENALES = 50;
export const TOPE_URGENCIA_SENALES = 100;
export const TOPE_CIERRE_SENALES = 60;
export const PUNTOS_CIERRE_PERSONA = 15;
export const PUNTOS_CIERRE_BASE: Readonly<Record<string, number>> = {
  interes_declarado: 25,
  relacion_previa: 20,
  referido_con_consentimiento: 15,
  fuente_publica_b2b: 5,
};
const FUENTE_CAPTURA = "captura en Cerebro de ventas";

export interface SenalProspecto {
  readonly tipo: string;
  readonly valor: string | null;
  readonly fuente: string;
  readonly url: string | null;
  /** Fecha de observacion (YYYY-MM-DD o ISO 8601). */
  readonly observadoEn: string;
}

export interface SenalTaxonomia {
  readonly tipo: string;
  readonly nombre: string;
  readonly dimension: DimensionScore;
  readonly puntos: number;
  readonly comoConseguirla: string;
}

/** Lo que el scoring necesita de una version de la taxonomia de la vertical. */
export interface TaxonomiaScoring {
  readonly version: number;
  readonly subtiposObjetivo: readonly string[];
  readonly tamanosObjetivo: readonly string[];
  readonly senales: readonly SenalTaxonomia[];
}

export interface ProspectoScoring {
  readonly subtipo: string | null;
  readonly tamano: string | null;
  readonly ciudad: string | null;
  readonly entidad: string | null;
  readonly municipio: string | null;
  readonly sitioWeb: string | null;
  readonly sitioVerificado: boolean;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly baseLicitud: string | null;
  readonly senales: readonly SenalProspecto[];
  /** Personas de contacto registradas (cada una ya trae evidencia por CHECK en la base). */
  readonly personasConEvidencia: number;
  /** Fecha (ISO) de la ultima edicion del prospecto: es la "fecha" de la evidencia de los campos capturados. */
  readonly actualizadoEn: string;
}

export interface EvidenciaScore {
  readonly fuente: string;
  readonly fecha: string;
  readonly url?: string;
  readonly valor?: string;
}

export interface ItemScore {
  readonly regla: string;
  readonly puntos: number;
  readonly evidencia: EvidenciaScore;
}

export interface DimensionExplicada {
  /** `null` = sin calificar (senal insuficiente). */
  readonly puntaje: number | null;
  readonly items: readonly ItemScore[];
}

export interface FaltanteSenal {
  readonly tipo: string;
  readonly nombre: string;
  readonly comoConseguirla: string;
}

export interface InsuficienteScore {
  readonly mensaje: string;
  readonly senalesValidas: number;
  readonly minimo: number;
  readonly faltan: readonly FaltanteSenal[];
}

export interface ExplicacionScore {
  readonly version: string;
  readonly reglasVersion: string;
  readonly taxonomiaVersion: number | null;
  readonly calculadoEn: string;
  readonly dimensiones: {
    readonly ajuste: DimensionExplicada;
    readonly urgencia: DimensionExplicada;
    readonly cierre: DimensionExplicada;
    readonly completitud: DimensionExplicada;
  };
  readonly insuficiente: InsuficienteScore | null;
}

export interface ResultadoScore {
  readonly ajuste: number | null;
  readonly urgencia: number | null;
  readonly cierre: number | null;
  readonly completitud: number;
  readonly version: string;
  readonly explicacion: ExplicacionScore;
}

function fechaCorta(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function textoLleno(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Senales validas y distintas por tipo (se conserva la primera de cada tipo, en el orden recibido). */
export function senalesValidas(senales: readonly SenalProspecto[]): readonly SenalProspecto[] {
  const vistas = new Set<string>();
  const out: SenalProspecto[] = [];
  for (const s of senales) {
    if (!textoLleno(s.tipo) || !textoLleno(s.fuente) || !textoLleno(s.observadoEn)) continue;
    if (Number.isNaN(Date.parse(s.observadoEn))) continue;
    if (vistas.has(s.tipo)) continue;
    vistas.add(s.tipo);
    out.push(s);
  }
  return out;
}

/** Aplica el tope de la dimension al construir los items: la suma de los items queda <= tope y es exactamente el puntaje. */
function acumular(candidatos: readonly ItemScore[], tope: number): ItemScore[] {
  let restante = tope;
  const out: ItemScore[] = [];
  for (const c of candidatos) {
    if (restante <= 0) break;
    const puntos = Math.min(c.puntos, restante);
    if (puntos <= 0) continue;
    out.push(puntos < c.puntos ? { ...c, puntos, regla: `${c.regla} (tope de ${tope} puntos)` } : c);
    restante -= puntos;
  }
  return out;
}

function sumar(items: readonly ItemScore[]): number {
  return items.reduce((s, i) => s + i.puntos, 0);
}

function itemsDeSenales(dimension: DimensionScore, validas: readonly SenalProspecto[], taxonomia: TaxonomiaScoring | null): ItemScore[] {
  if (!taxonomia) return [];
  const porTipo = new Map(validas.map((s) => [s.tipo, s] as const));
  const out: ItemScore[] = [];
  // Orden estable: el de la taxonomia (no el orden en que se capturaron las senales).
  for (const def of taxonomia.senales) {
    if (def.dimension !== dimension || !Number.isFinite(def.puntos) || def.puntos <= 0) continue;
    const s = porTipo.get(def.tipo);
    if (!s) continue;
    out.push({
      regla: `Señal: ${def.nombre}`,
      puntos: Math.trunc(def.puntos),
      evidencia: { fuente: s.fuente, fecha: fechaCorta(s.observadoEn), ...(s.url ? { url: s.url } : {}), ...(textoLleno(s.valor) ? { valor: s.valor } : {}) },
    });
  }
  return out;
}

function calcularFaltantes(validas: readonly SenalProspecto[], taxonomia: TaxonomiaScoring | null): FaltanteSenal[] {
  const necesarias = Math.max(1, SENALES_MINIMAS - validas.length);
  if (!taxonomia) return [];
  const presentes = new Set(validas.map((s) => s.tipo));
  const orden: Record<DimensionScore, number> = { ajuste: 0, urgencia: 1, cierre: 2 };
  return taxonomia.senales
    .filter((d) => !presentes.has(d.tipo))
    .slice()
    .sort((a, b) => b.puntos - a.puntos || orden[a.dimension] - orden[b.dimension] || a.tipo.localeCompare(b.tipo))
    .slice(0, necesarias)
    .map((d) => ({ tipo: d.tipo, nombre: d.nombre, comoConseguirla: d.comoConseguirla }));
}

function mensajeInsuficiente(n: number, faltan: readonly FaltanteSenal[]): string {
  if (faltan.length === 0) {
    return `SENAL INSUFICIENTE: falta registrar ${SENALES_MINIMAS - n} señal(es) más con fuente y fecha, como conseguirlo: busca al negocio en su sitio, Google Maps y redes y anota la URL donde viste cada dato.`;
  }
  const falta = faltan.map((f) => f.nombre).join("; ");
  const como = faltan.map((f) => f.comoConseguirla).join(" ");
  return `SENAL INSUFICIENTE: falta ${falta}, como conseguirlo: ${como}`;
}

export function versionDeScore(taxonomia: TaxonomiaScoring | null): string {
  return `${REGLAS_VERSION}/${taxonomia ? `tax-${taxonomia.version}` : "sin-taxonomia"}`;
}

function calcularCompletitud(p: ProspectoScoring): DimensionExplicada {
  const fecha = fechaCorta(p.actualizadoEn);
  const ev = (valor?: string): EvidenciaScore => ({ fuente: FUENTE_CAPTURA, fecha, ...(valor ? { valor } : {}) });
  const candidatos: ItemScore[] = [];
  if (textoLleno(p.subtipo)) candidatos.push({ regla: "Subtipo capturado", puntos: 15, evidencia: ev(p.subtipo) });
  if (textoLleno(p.tamano)) candidatos.push({ regla: "Tamaño capturado", puntos: 15, evidencia: ev(p.tamano) });
  if (textoLleno(p.ciudad)) candidatos.push({ regla: "Ciudad capturada", puntos: 10, evidencia: ev(p.ciudad) });
  if (textoLleno(p.entidad) || textoLleno(p.municipio)) candidatos.push({ regla: "Entidad o municipio capturado", puntos: 10, evidencia: ev(textoLleno(p.entidad) ? p.entidad : (p.municipio ?? undefined)) });
  if (textoLleno(p.sitioWeb)) candidatos.push({ regla: "Sitio web capturado", puntos: 10, evidencia: ev() });
  if (p.sitioVerificado) candidatos.push({ regla: "Sitio web verificado", puntos: 10, evidencia: ev() });
  // Sin PII: la explicacion nunca copia el telefono ni el correo.
  if (textoLleno(p.telefono) || textoLleno(p.correo)) candidatos.push({ regla: "Dato de contacto empresarial registrado", puntos: 15, evidencia: ev("registrado") });
  if (p.personasConEvidencia > 0) candidatos.push({ regla: "Persona de contacto con evidencia", puntos: 15, evidencia: ev(String(p.personasConEvidencia)) });
  const items = acumular(candidatos, 100);
  return { puntaje: sumar(items), items };
}

/**
 * Calcula el score. `ahora` solo alimenta `calculadoEn` (metadato): NO interviene en ningun puntaje.
 */
export function calcularScore(prospecto: ProspectoScoring, taxonomia: TaxonomiaScoring | null, ahora: Date): ResultadoScore {
  const validas = senalesValidas(prospecto.senales);
  const insuficiente = validas.length < SENALES_MINIMAS;
  const version = versionDeScore(taxonomia);
  const fechaCaptura = fechaCorta(prospecto.actualizadoEn);

  let ajuste: DimensionExplicada = { puntaje: null, items: [] };
  let urgencia: DimensionExplicada = { puntaje: null, items: [] };
  let cierre: DimensionExplicada = { puntaje: null, items: [] };
  let insuficienteInfo: InsuficienteScore | null = null;

  if (insuficiente) {
    const faltan = calcularFaltantes(validas, taxonomia);
    insuficienteInfo = { mensaje: mensajeInsuficiente(validas.length, faltan), senalesValidas: validas.length, minimo: SENALES_MINIMAS, faltan };
  } else {
    const candAjuste: ItemScore[] = [];
    if (taxonomia && textoLleno(prospecto.subtipo) && taxonomia.subtiposObjetivo.includes(prospecto.subtipo)) {
      candAjuste.push({ regla: "Subtipo dentro del ICP de la vertical", puntos: TOPE_AJUSTE_SUBTIPO, evidencia: { fuente: FUENTE_CAPTURA, fecha: fechaCaptura, valor: prospecto.subtipo } });
    }
    if (taxonomia && textoLleno(prospecto.tamano) && taxonomia.tamanosObjetivo.includes(prospecto.tamano)) {
      candAjuste.push({ regla: "Tamaño dentro del ICP de la vertical", puntos: TOPE_AJUSTE_TAMANO, evidencia: { fuente: FUENTE_CAPTURA, fecha: fechaCaptura, valor: prospecto.tamano } });
    }
    const itemsAjuste = [...acumular(candAjuste, TOPE_AJUSTE_SUBTIPO + TOPE_AJUSTE_TAMANO), ...acumular(itemsDeSenales("ajuste", validas, taxonomia), TOPE_AJUSTE_SENALES)];
    ajuste = { puntaje: sumar(itemsAjuste), items: itemsAjuste };

    const itemsUrgencia = acumular(itemsDeSenales("urgencia", validas, taxonomia), TOPE_URGENCIA_SENALES);
    urgencia = { puntaje: sumar(itemsUrgencia), items: itemsUrgencia };

    const candCierre: ItemScore[] = [];
    const puntosBase = prospecto.baseLicitud ? (PUNTOS_CIERRE_BASE[prospecto.baseLicitud] ?? 0) : 0;
    if (puntosBase > 0) {
      candCierre.push({ regla: `Base de licitud: ${prospecto.baseLicitud}`, puntos: puntosBase, evidencia: { fuente: FUENTE_CAPTURA, fecha: fechaCaptura, valor: prospecto.baseLicitud ?? undefined } });
    }
    if (prospecto.personasConEvidencia > 0) {
      candCierre.push({ regla: "Persona de contacto con evidencia", puntos: PUNTOS_CIERRE_PERSONA, evidencia: { fuente: FUENTE_CAPTURA, fecha: fechaCaptura, valor: String(prospecto.personasConEvidencia) } });
    }
    const itemsCierre = [...acumular(itemsDeSenales("cierre", validas, taxonomia), TOPE_CIERRE_SENALES), ...acumular(candCierre, 100 - TOPE_CIERRE_SENALES)];
    cierre = { puntaje: sumar(itemsCierre), items: itemsCierre };
  }

  const completitud = calcularCompletitud(prospecto);
  const calculadoEn = ahora.toISOString();
  return {
    ajuste: ajuste.puntaje,
    urgencia: urgencia.puntaje,
    cierre: cierre.puntaje,
    completitud: completitud.puntaje ?? 0,
    version,
    explicacion: {
      version,
      reglasVersion: REGLAS_VERSION,
      taxonomiaVersion: taxonomia ? taxonomia.version : null,
      calculadoEn,
      dimensiones: { ajuste, urgencia, cierre, completitud },
      insuficiente: insuficienteInfo,
    },
  };
}
