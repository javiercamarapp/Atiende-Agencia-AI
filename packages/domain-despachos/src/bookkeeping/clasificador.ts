// Clasificador de CFDI a categoría contable — puerto de
// `b2b_ai/features/bookkeeping/auto_classifier.py`.
//
// ALCANCE DELIBERADO (ver informe de auditoría de esta fase): el origen usa
// dos niveles — (1) override humano exacto por RFC, prioridad máxima, y (2)
// un clasificador ML (TF-IDF + GradientBoostingClassifier de scikit-learn,
// entrenado sobre datos SINTÉTICOS por defecto). El nivel (2) NO se porta —
// mismo criterio que Fase 5 documentó para el "nivel 4 LLM" de conciliación
// bancaria (matching-engine.ts): un modelo estadístico entrenado con
// `RandomState(seed=42)` sobre datos generados aleatoriamente no es una
// regla de negocio determinista portable ni verificable byte-exacto contra
// el intérprete Python (el propio entrenamiento depende de la versión de
// scikit-learn instalada). Lo que SÍ se porta, byte-exacto y 100% cubierto
// por golden-set, es:
//   (1) el override humano exacto por RFC (`add_override`/`predict`
//       tier 1), y
//   (2) el fallback basado en reglas (`_rule_based_predict`) — conteo de
//       keywords por categoría sobre `SYNTHETIC_PATTERNS`, el MISMO camino
//       que el Python real usa cuando `HAS_SKLEARN=False` o antes de que el
//       modelo ML termine de entrenar — es determinista y es la única ruta
//       de clasificación automática que un port fiel puede verificar
//       número por número.
import { CONFIDENCE_MEDIUM } from "./confianza.ts";
import type { TipoCfdiBookkeeping } from "./types.ts";

interface PatronSintetico {
  readonly category: string;
  readonly tipoCfdi: TipoCfdiBookkeeping;
  readonly keywords: readonly string[];
}

/** `SYNTHETIC_PATTERNS` — orden y contenido EXACTOS del origen (18
 * categorías); el orden importa para el desempate de `_rule_based_predict`
 * (ver abajo: "matches > best_score" es estrictamente mayor, así que un
 * empate deja ganando el PRIMER patrón visto en esta lista). */
export const SYNTHETIC_PATTERNS: readonly PatronSintetico[] = [
  { category: "servicios_profesionales", tipoCfdi: "I", keywords: ["honorarios", "consultoría", "asesoría", "servicio profesional", "servicios legales", "contabilidad", "auditoría", "dictamen", "ingeniería", "arquitectura", "desarrollo software", "diseño"] },
  { category: "renta_oficina", tipoCfdi: "I", keywords: ["renta", "arrendamiento", "local comercial", "oficina", "lease", "alquiler", "subarrendamiento"] },
  { category: "materia_prima", tipoCfdi: "I", keywords: ["materia prima", "material", "insumo", "componente", "suministro", "empaque", "envase"] },
  { category: "publicidad", tipoCfdi: "I", keywords: ["publicidad", "marketing", "campaña", "anuncio", "redes sociales", "google ads", "facebook ads", "promoción", "mercadotecnia"] },
  { category: "honorarios_legales", tipoCfdi: "I", keywords: ["honorarios abogado", "notario", "legal", "jurídico", "constitución", "poder", "escritura", "litigio"] },
  { category: "comision_bancaria", tipoCfdi: "I", keywords: ["comisión", "banco", "comisión bancaria", "transferencia", "dispersión", "tarjeta", "TPV"] },
  { category: "intereses_bancarios", tipoCfdi: "I", keywords: ["intereses", "rendimiento", "interés", "cetes", "inversión", "fondo"] },
  { category: "nomina", tipoCfdi: "I", keywords: ["nómina", "sueldo", "salario", "pago empleados", "compensación", "prestaciones", "aguinaldo", "prima vacacional"] },
  { category: "arrendamiento", tipoCfdi: "I", keywords: ["arrendamiento", "renta vehículo", "renta equipo", "leasing", "renta maquinaria"] },
  { category: "seguros", tipoCfdi: "I", keywords: ["seguro", "póliza", "prima seguro", "aseguradora", "cobertura", "siniestro"] },
  { category: "telefonia", tipoCfdi: "I", keywords: ["teléfono", "internet", "telecomunicaciones", "celular", "fibra óptica", "datos", "Telmex", "Telcel", "AT&T"] },
  { category: "transporte", tipoCfdi: "I", keywords: ["transporte", "flete", "envío", "paquetería", "logística", "DHL", "FedEx", "Uber"] },
  { category: "equipo_computo", tipoCfdi: "I", keywords: ["computadora", "laptop", "monitor", "impresora", "equipo cómputo", "servidor", "disco", "SSD"] },
  { category: "mantenimiento", tipoCfdi: "I", keywords: ["mantenimiento", "reparación", "limpieza", "jardinería", "plomería", "electricidad", "albañilería"] },
  { category: "papeleria", tipoCfdi: "I", keywords: ["papelería", "artículos oficina", "material oficina", "tinta", "papel", "carpeta", "oficina"] },
  { category: "venta_servicios", tipoCfdi: "E", keywords: ["servicio", "consultoría", "honorarios", "factura", "proyecto", "desarrollo"] },
  { category: "venta_mercancia", tipoCfdi: "E", keywords: ["venta", "mercancía", "producto", "artículo", "venta de", "importe"] },
];

export interface PrediccionCategoria {
  readonly categoria: string;
  readonly confidence: number;
  /** Cuántos patrones rivales empataron con el mejor (0 = ganador único). Con empate la confianza siempre cae bajo el piso. */
  readonly rivales: number;
  /** Palabras clave (del catálogo propio, nunca texto del CFDI) que sostienen la categoría ganadora. */
  readonly coincidencias: readonly string[];
}

/** Normaliza para comparar por palabra completa: minúsculas, sin acentos y solo letras/dígitos separados por un espacio. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** `kw` aparece como palabra o frase COMPLETA en `textoNormalizado` (límites de palabra; admite plural `s`/`es` al final).
 * Corrige el `includes()` por subcadena del origen: «material» ya no empata dentro de «materialización» y «disco» no dispara
 * equipo_computo dentro de «discoteca». */
export function contienePalabra(textoNormalizado: string, kw: string): boolean {
  return posicionesDePalabra(textoNormalizado, kw).length > 0;
}

/** Confianza de un empate: `0.55 - 0.10 x rivales` (piso 0.30), el mismo criterio del suelto (`services/classify.py`, commit e302c60).
 * Con 1 rival da 0.45, SIEMPRE bajo el piso 0.5 y bajo cualquier umbral >= piso: un empate nunca se aplica sin revisión humana. */
export function confianzaDeEmpate(rivales: number): number {
  return Math.round(Math.max(0.3, 0.55 - 0.1 * rivales) * 100) / 100;
}

interface Coincidencia {
  readonly categoria: string;
  readonly palabra: string;
  readonly inicio: number;
  readonly fin: number;
}

/** Posiciones de `kw` (palabra o frase completa, plural `s`/`es`) dentro de `textoNormalizado`. */
function posicionesDePalabra(textoNormalizado: string, kw: string): { readonly inicio: number; readonly fin: number }[] {
  const norm = normalizarTexto(kw);
  if (norm === "") return [];
  // `norm` solo contiene [a-z0-9 ]: no hay metacaracteres de regex que escapar.
  const re = new RegExp(`(?<![a-z0-9])${norm}(?:es|s)?(?![a-z0-9])`, "g");
  const out: { inicio: number; fin: number }[] = [];
  for (let m = re.exec(textoNormalizado); m !== null; m = re.exec(textoNormalizado)) out.push({ inicio: m.index, fin: m.index + m[0].length });
  return out;
}

/** `_rule_based_predict` CORREGIDO — conteo de keywords por PALABRA COMPLETA (sin acentos, ver `contienePalabra`) entre los patrones del
 * MISMO `tipoCfdi`. Una coincidencia corta que queda DENTRO de una frase más larga de OTRA categoría se descarta (la frase es más específica:
 * en «renta vehículo» gana arrendamiento y la palabra suelta «renta» de renta_oficina no cuenta). Gana el patrón con más coincidencias; si dos
 * o más empatan en el máximo NO se elige "el primero": se devuelve el primero por orden estable pero con `rivales > 0` y confianza
 * `confianzaDeEmpate(rivales)` (< 0.5), para que la compuerta lo mande a revisión.
 * `confidence = min(0.5 + best_score*0.15, 0.95)` con un ganador único (igual que el origen), `0.3` sin ninguna coincidencia ("otros").
 *
 * DEFECTO HEREDADO (ver e302c60 del suelto): el origen resolvía el empate con `matches > best_score` -> gana el primer patrón de la lista con
 * 0.65 >= 0.6, y por eso «renta de laptop» salía como renta_oficina sin revisión. */
export function clasificarPorReglas(descripcion: string, tipoCfdi: TipoCfdiBookkeeping): PrediccionCategoria {
  const desc = normalizarTexto(descripcion);
  const todas: Coincidencia[] = [];

  for (const pattern of SYNTHETIC_PATTERNS) {
    if (pattern.tipoCfdi !== tipoCfdi) continue;
    for (const kw of pattern.keywords) {
      // Un mismo patrón cuenta cada keyword una sola vez aunque se repita en el texto (igual que el origen).
      const pos = posicionesDePalabra(desc, kw)[0];
      if (pos) todas.push({ categoria: pattern.category, palabra: kw, inicio: pos.inicio, fin: pos.fin });
    }
  }
  const vigentes = todas.filter(
    (c) => !todas.some((o) => o.categoria !== c.categoria && o.inicio <= c.inicio && o.fin >= c.fin && o.fin - o.inicio > c.fin - c.inicio),
  );
  if (vigentes.length === 0) return { categoria: "otros", confidence: 0.3, rivales: 0, coincidencias: [] };

  const porCategoria = new Map<string, string[]>();
  for (const c of vigentes) porCategoria.set(c.categoria, [...(porCategoria.get(c.categoria) ?? []), c.palabra]);
  const puntajes = [...porCategoria].map(([categoria, palabras]) => ({ categoria, score: palabras.length, palabras }));

  const mejor = Math.max(...puntajes.map((p) => p.score));
  const empatados = puntajes.filter((p) => p.score === mejor);
  const ganador = empatados[0]!;
  const rivales = empatados.length - 1;
  if (rivales > 0) return { categoria: ganador.categoria, confidence: confianzaDeEmpate(rivales), rivales, coincidencias: [...new Set(empatados.flatMap((p) => p.palabras))] };
  return { categoria: ganador.categoria, confidence: Math.min(0.5 + mejor * 0.15, 0.95), rivales: 0, coincidencias: ganador.palabras };
}

/** `get_suggestions` (ruta de fallback, `top_n` ignorado igual que el
 * origen cuando no hay modelo ML entrenado — devuelve una sola sugerencia,
 * redondeada a 4 decimales). */
export function sugerirCategoria(descripcion: string, tipoCfdi: TipoCfdiBookkeeping): readonly PrediccionCategoria[] {
  const prediccion = clasificarPorReglas(descripcion, tipoCfdi);
  return [{ ...prediccion, confidence: Math.round((prediccion.confidence + Number.EPSILON) * 10000) / 10000 }];
}

/** Tier 1 — override humano exacto por RFC (`predict`, primeras líneas):
 * si `rfcEmisor` tiene un override registrado, se devuelve esa categoría
 * con `confidence=1.0`, sin correr ninguna clasificación. `overrides` es un
 * mapa `rfcEmisor -> categoria` que el llamador mantiene (ver
 * `overrides.ts` para la agregación desde el historial de correcciones). */
export function predecirCategoria(descripcion: string, tipoCfdi: TipoCfdiBookkeeping, rfcEmisor: string, overrides: ReadonlyMap<string, string> = new Map()): PrediccionCategoria {
  const override = overrides.get(rfcEmisor);
  if (override !== undefined) return { categoria: override, confidence: 1.0, rivales: 0, coincidencias: [] };
  return clasificarPorReglas(descripcion, tipoCfdi);
}

/** `needs_review = confidence < AutoClassifier.CONFIDENCE_MEDIUM`
 * (pipeline.py) — el gate de revisión humana usado por el orquestador. */
export function necesitaRevisionHumana(confidence: number): boolean {
  return confidence < CONFIDENCE_MEDIUM;
}
