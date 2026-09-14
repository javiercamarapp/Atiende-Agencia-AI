// Agregación de correcciones humanas por RFC — puerto de
// `b2b_ai/features/bookkeeping/human_override.py::HumanOverrideManager`.
// Funcional/puro: el llamador mantiene la lista de `OverrideRecord` (mismo
// patrón "endpoint puro" que `conciliacion.ts` con `movimientos` — el
// cliente HTTP manda el historial ya persistido en cada llamada, en vez de
// que este módulo guarde estado mutable en memoria del proceso).
import type { OverrideRecord, SuggestionRetraining } from "./types.ts";

/** `get_rfc_category_feedback` — categoría más frecuente entre las
 * correcciones de un RFC (empate → `max(cats, key=cats.get)` de Python
 * conserva la PRIMERA clave insertada con el máximo valor cuando hay
 * empate — se replica iterando en orden de inserción y usando `>`
 * estricto, igual que el resto de los desempates "primero visto" de esta
 * vertical). `null` si el RFC no tiene overrides. */
export function getRfcCategoryFeedback(overrides: readonly OverrideRecord[], rfc: string): string | null {
  const counts = new Map<string, number>();
  for (const o of overrides) {
    if (o.rfcEmisor !== rfc || !o.newCategoria) continue;
    counts.set(o.newCategoria, (counts.get(o.newCategoria) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [cat, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = cat;
    }
  }
  return best;
}

/** `get_all_rfc_feedback`. */
export function getAllRfcFeedback(overrides: readonly OverrideRecord[]): ReadonlyMap<string, string> {
  const rfcs = new Set(overrides.map((o) => o.rfcEmisor).filter((rfc) => rfc));
  const out = new Map<string, string>();
  for (const rfc of rfcs) {
    const cat = getRfcCategoryFeedback(overrides, rfc);
    if (cat !== null) out.set(rfc, cat);
  }
  return out;
}

/** `get_suggestions_for_retraining` — solo sugiere si hay señal fuerte:
 * `total >= 2 && topCount/total > 0.5` (estrictamente mayor a 50%, no
 * `>=`). `confidence = round(topCount/total, 2)`. */
export function getSuggestionsForRetraining(overrides: readonly OverrideRecord[]): readonly SuggestionRetraining[] {
  const byRfc = new Map<string, Map<string, number>>();
  for (const o of overrides) {
    if (!o.rfcEmisor || !o.newCategoria) continue;
    let cats = byRfc.get(o.rfcEmisor);
    if (!cats) {
      cats = new Map();
      byRfc.set(o.rfcEmisor, cats);
    }
    cats.set(o.newCategoria, (cats.get(o.newCategoria) ?? 0) + 1);
  }

  const suggestions: SuggestionRetraining[] = [];
  for (const [rfc, cats] of byRfc) {
    if (cats.size === 0) continue;
    const total = [...cats.values()].reduce((a, b) => a + b, 0);
    let topCat = "";
    let topCount = -1;
    for (const [cat, count] of cats) {
      if (count > topCount) {
        topCount = count;
        topCat = cat;
      }
    }
    if (total >= 2 && topCount / total > 0.5) {
      suggestions.push({
        rfc,
        suggestedCategoria: topCat,
        overrideCount: topCount,
        totalCorrections: total,
        confidence: Math.round((topCount / total + Number.EPSILON) * 100) / 100,
      });
    }
  }
  return suggestions;
}
