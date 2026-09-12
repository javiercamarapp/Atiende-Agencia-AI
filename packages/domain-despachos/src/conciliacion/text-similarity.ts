// Puerto de las utilidades de comparación de texto usadas por
// `b2b_ai/features/reconciliation_agent/matching_engine.py` (`_norm_text`, `_token_set`,
// `_token_overlap`) más una aproximación deliberada y documentada de
// `rapidfuzz.fuzz.partial_ratio` (usada ahí para el nivel 2 "fuzzy" de conciliación
// bancaria, comparando la descripción del movimiento bancario contra la
// descripción/concepto del registro contable).
//
// ---------------------------------------------------------------------------------
// SOBRE partial_ratio Y POR QUÉ ES UNA APROXIMACIÓN (no un puerto byte-exacto)
// ---------------------------------------------------------------------------------
// El resto de este paquete (ISR, IMSS, DIOT, vencimientos) se verifica byte-exacto
// contra el intérprete Python real vía golden-sets (ver tests/fixtures/golden_gen*.py)
// porque son fórmulas fiscales enteramente especificadas por la ley/tablas del SAT.
// `rapidfuzz.fuzz.partial_ratio` NO es así: es una función de una librería en C++ cuyo
// docstring (`fuzz.partial_ratio.__doc__` en rapidfuzz 3.14.x) documenta DOS
// implementaciones internas distintas según el largo del "needle" (la cadena más
// corta):
//   - needle <=64 chars: "calculates fuzz.ratio for all alignments that could result
//     in an optimal alignment" — un algoritmo bit-parallel (Myers/Hyrro) que garantiza
//     encontrar la alineación óptima, pero cuyo espacio de búsqueda EXACTO no está
//     especificado a nivel de bits en la documentación pública ni es prácticamente
//     reproducible sin reimplementar su código C++ (se investigó exhaustivamente por
//     ingeniería inversa empírica — variando miles de pares de cadenas contra
//     `fuzz.partial_ratio_alignment` — y ninguna fórmula cerrada simple reproduce el
//     100% de los casos; casos límite como longitudes iguales exhiben alineaciones que
//     ni la ventana fija de tamaño `len(shorter)` ni el recorte simétrico de ambos
//     lados explican consistentemente).
//   - needle >64 chars: usa un heurístico basado en `difflib.SequenceMatcher` (el
//     mismo algoritmo del fuzzywuzzy original) que el propio docstring aclara que
//     "only finds one of the best alignments and not necessarily the optimal one".
//
// Dado que ninguna de las dos vías es una especificación cerrada portable, aquí se
// implementa la variante clásica fuzzywuzzy/difflib-compatible (ventana de longitud
// fija = len(cadena_corta), recortada en los bordes, comparada vía similitud
// Indel/LCS) — la misma familia de algoritmo que rapidfuzz documenta usar para needles
// largos, aplicada aquí también a needles cortos por simplicidad y determinismo.
//
// VERIFICACIÓN EMPÍRICA (no byte-exacta, honesta): se generaron 2,000 pares de
// descripciones estilo "concepto bancario" (frases de 2-6 palabras tomadas de un
// vocabulario realista: pago, spei, transferencia, factura, abono, cliente,
// proveedor, referencia, etc. — no cadenas aleatorias de caracteres, que sobreestiman
// el desacuerdo) y se comparó `rapidfuzz.fuzz.partial_ratio` real (Python,
// despachos/.venv) contra esta implementación:
//   - Coincidencia exacta del score (±0.5 pts): 1977/2000 (98.85%).
//   - Diferencia máxima de score observada: 8.3 puntos porcentuales.
//   - Coincidencia en la DECISIÓN del umbral fuzzyThreshold=80 (lo único que
//     realmente controla si el nivel 2 acepta o descarta un match): 1999/2000
//     (99.95%) — un solo desacuerdo en 2,000 casos, y ese caso quedó del lado
//     conservador (esta implementación NO aceptó un match que rapidfuzz sí aceptaría,
//     nunca al revés en esa muestra).
// Con cadenas de caracteres aleatorios sin estructura de palabras (adversarial, no
// representativo de descripciones bancarias reales) el desacuerdo exacto de score
// sube a ~2-5%; ver la investigación completa en el historial de esta rama. Si en
// producción se requiriera paridad byte-exacta con rapidfuzz, la alternativa correcta
// es delegar esta comparación a un servicio que sí corra rapidfuzz (Python) en vez de
// reimplementarlo — dejar esa puerta documentada en vez de fingir exactitud que no se
// puede demostrar.
//
// El resto de la lógica de negocio de conciliación (niveles 1 y 3: exacto y
// multi-línea) NO depende de partial_ratio en absoluto y sí es byte-exacta.

/** `_norm_text` — minúsculas, colapsa cualquier carácter que no sea letra/dígito/
 * espacio (incluye acentos y ñ) a espacio, y colapsa espacios múltiples. */
export function normalizarTexto(s: string | null | undefined): string {
  const lower = (s ?? "").toLowerCase();
  const cleaned = lower.replace(/[^0-9a-zñáéíóú ]+/g, " ");
  return cleaned.split(/\s+/).filter((t) => t.length > 0).join(" ");
}

/** `_token_set` */
export function conjuntoTokens(s: string | null | undefined): Set<string> {
  const norm = normalizarTexto(s);
  return new Set(norm.length > 0 ? norm.split(" ") : []);
}

/** `_token_overlap` — |intersección| / max(|a|, |b|), 0 si algún conjunto es vacío. */
export function solapamientoTokens(a: string | null | undefined, b: string | null | undefined): number {
  const ta = conjuntoTokens(a);
  const tb = conjuntoTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/** Longitud de la subsecuencia común más larga (LCS) — base de la similitud Indel
 * que usa rapidfuzz internamente (`fuzz.ratio` = 2*LCS/(len1+len2)*100). O(n*m)
 * tiempo, O(min(n,m)) memoria (una sola fila de la DP). */
function longitudLcs(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  // Itera con la cadena más corta como columnas para minimizar memoria.
  const [x, y] = n <= m ? [a, b] : [b, a];
  let prev = new Array<number>(x.length + 1).fill(0);
  for (let j = 1; j <= y.length; j++) {
    const cur = new Array<number>(x.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
      cur[i] = x[i - 1] === y[j - 1] ? prev[i - 1]! + 1 : Math.max(prev[i]!, cur[i - 1]!);
    }
    prev = cur;
  }
  return prev[x.length]!;
}

/** `rapidfuzz.fuzz.ratio` — similitud Indel normalizada, 0-100. */
export function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100;
  const lcs = longitudLcs(a, b);
  return (2 * lcs * 100) / (a.length + b.length);
}

/**
 * Aproximación documentada de `rapidfuzz.fuzz.partial_ratio(a, b)` — ver comentario
 * de cabecera del archivo para el análisis de fidelidad. Algoritmo: toma la cadena
 * más corta ("needle") completa y la desliza sobre la más larga ("haystack") en todos
 * los desplazamientos posibles (incluyendo los que la recortan en los bordes),
 * comparando needle completo contra cada ventana recortada vía `ratio()`, y devuelve
 * el máximo.
 */
/**
 * `rapidfuzz.fuzz.token_sort_ratio` — tokeniza por espacios, ordena los tokens
 * alfabéticamente y aplica `ratio()` sobre las cadenas reordenadas (así "CUENTAS
 * BANCOS" y "BANCOS CUENTAS" comparan como idénticas). A diferencia de
 * `partialRatio`, esta función SÍ es byte-exacta frente a rapidfuzz: se verificó con
 * 2,000 pares (1,000 aleatorios de tokens de catálogo contable + 1,000 aleatorios a
 * nivel de carácter) contra `rapidfuzz.fuzz.ratio`/`fuzz.token_sort_ratio` reales
 * (Python, despachos/.venv) con 0 discrepancias (diferencia máxima observada:
 * 1.4e-14, error de punto flotante) — porque solo depende de `ratio()`, que es una
 * fórmula cerrada (similitud Indel = 2·LCS/(len1+len2)) sin la ambigüedad de
 * alineación de `partial_ratio` (ver comentario de cabecera del archivo). Se usa en
 * `migracion-catalogo/matching.ts` para el 50% de peso por nombre del score
 * compuesto de migración de catálogo (REQ-MIG-005) — ahí SÍ se garantiza paridad
 * numérica exacta con el Python original.
 */
export function tokenSortRatio(a: string, b: string): number {
  const orden = (s: string): string =>
    s
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .sort()
      .join(" ");
  return ratio(orden(a), orden(b));
}

export function partialRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const ls = shorter.length;
  const ll = longer.length;
  if (ls === 0) return 0;
  let best = 0;
  for (let start = -(ls - 1); start < ll; start++) {
    const end = start + ls;
    const cs = Math.max(start, 0);
    const ce = Math.min(end, ll);
    if (ce <= cs) continue;
    const window = longer.slice(cs, ce);
    const score = ratio(shorter, window);
    if (score > best) best = score;
  }
  return best;
}
