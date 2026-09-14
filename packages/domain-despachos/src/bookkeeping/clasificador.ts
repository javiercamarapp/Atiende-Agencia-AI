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
}

/** `_rule_based_predict` — conteo de keywords (substring, case-insensitive)
 * por patrón del MISMO `tipoCfdi`; gana el patrón con más matches, empate →
 * gana el primero visto (`matches > best_score`, estrictamente mayor).
 * `confidence = min(0.5 + best_score*0.15, 0.95)` si hubo al menos un match,
 * si no `0.3` (sin match → categoría "otros"). */
export function clasificarPorReglas(descripcion: string, tipoCfdi: TipoCfdiBookkeeping): PrediccionCategoria {
  const desc = descripcion.toLowerCase();
  let bestCat = "otros";
  let bestScore = 0;

  for (const pattern of SYNTHETIC_PATTERNS) {
    if (pattern.tipoCfdi !== tipoCfdi) continue;
    const matches = pattern.keywords.reduce((acc, kw) => acc + (desc.includes(kw.toLowerCase()) ? 1 : 0), 0);
    if (matches > bestScore) {
      bestScore = matches;
      bestCat = pattern.category;
    }
  }

  const confidence = bestScore > 0 ? Math.min(0.5 + bestScore * 0.15, 0.95) : 0.3;
  return { categoria: bestCat, confidence };
}

/** `get_suggestions` (ruta de fallback, `top_n` ignorado igual que el
 * origen cuando no hay modelo ML entrenado — devuelve una sola sugerencia,
 * redondeada a 4 decimales). */
export function sugerirCategoria(descripcion: string, tipoCfdi: TipoCfdiBookkeeping): readonly PrediccionCategoria[] {
  const { categoria, confidence } = clasificarPorReglas(descripcion, tipoCfdi);
  return [{ categoria, confidence: Math.round((confidence + Number.EPSILON) * 10000) / 10000 }];
}

/** Tier 1 — override humano exacto por RFC (`predict`, primeras líneas):
 * si `rfcEmisor` tiene un override registrado, se devuelve esa categoría
 * con `confidence=1.0`, sin correr ninguna clasificación. `overrides` es un
 * mapa `rfcEmisor -> categoria` que el llamador mantiene (ver
 * `overrides.ts` para la agregación desde el historial de correcciones). */
export function predecirCategoria(descripcion: string, tipoCfdi: TipoCfdiBookkeeping, rfcEmisor: string, overrides: ReadonlyMap<string, string> = new Map()): PrediccionCategoria {
  const override = overrides.get(rfcEmisor);
  if (override !== undefined) return { categoria: override, confidence: 1.0 };
  return clasificarPorReglas(descripcion, tipoCfdi);
}

/** `needs_review = confidence < AutoClassifier.CONFIDENCE_MEDIUM`
 * (pipeline.py) — el gate de revisión humana usado por el orquestador. */
export function necesitaRevisionHumana(confidence: number): boolean {
  return confidence < CONFIDENCE_MEDIUM;
}
