// Puerto de `b2b_ai/features/migracion_catalogo/matching.py` — clasificación de una
// cuenta del catálogo origen contra las cuentas candidatas del catálogo destino, en
// orden estricto de prioridad: (1) exacto → (2) alerta de riesgo → (3) fuzzy →
// (4) sin_match (REQ-MIG-003 a REQ-MIG-006). ADR-3 del origen: solo "exacto" puede
// nacer con `estado="aprobado"`; todo lo demás nace "pendiente" sin excepción, sin
// importar qué tan alto sea el score — nunca se auto-aprueba una alerta de riesgo o
// un fuzzy con score=99, por diseño explícito del origen.
import { ratio, tokenSortRatio } from "../conciliacion/text-similarity.ts";
import type { CuentaCatalogo, MapeoMigracionCuenta, TipoMatchMigracion } from "./types.ts";

// ---------------------------------------------------------------------------------
// Normalización de texto/código
// ---------------------------------------------------------------------------------

/** `normalizar_texto` del origen — NFKD, quita diacríticos (incluida ñ→n), colapsa
 * espacios, mayúsculas. */
export function normalizarTexto(valor: string | null | undefined): string {
  const s = valor ?? "";
  const sinAcentos = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return sinAcentos.replace(/\s+/g, " ").trim().toUpperCase();
}

/** `normalizar_codigo` (público) del origen — NO quita guiones ni espacios internos,
 * solo aplica `normalizarTexto`. Usado por `esMatchExacto`/`evaluarMatchExacto`
 * standalone. */
export function normalizarCodigo(valor: string | null | undefined): string {
  return normalizarTexto(valor);
}

/** `_normalizar_codigo` (privado) del origen — SÍ quita guiones y espacios, además
 * de `normalizarTexto`. Es el que usa la clasificación real (`clasificarCuentaOrigen`
 * / el camino que consume `cross_db.py`).
 *
 * BUG DOCUMENTADO DEL ORIGEN (no corregido aquí, ver informe de auditoría de esta
 * fase): el Python original tiene DOS normalizadores de código incompatibles para
 * "match exacto" según el punto de entrada. `normalizarCodigo` (arriba) NO quita
 * guiones/espacios; `normalizarCodigoEstricto` (esta función) sí. Un par con
 * `codigo="102-001"` vs `codigo="1020 01"` (mismo nombre) se clasifica EXACTO por
 * `clasificarCuentaOrigen` (el camino de producción real) pero NO por
 * `esMatchExacto`/`evaluarMatchExacto` llamados directamente con los mismos datos.
 * Se documenta la inconsistencia en vez de unificarla silenciosamente porque no es
 * evidente cuál de las dos es "la corrección" sin una decisión de producto explícita
 * sobre qué formatos de código deben tratarse como equivalentes. */
export function normalizarCodigoEstricto(valor: string | null | undefined): string {
  return normalizarTexto(valor).replace(/ /g, "").replace(/-/g, "");
}

function normalizarNombre(valor: string | null | undefined): string {
  return normalizarTexto(valor);
}

// ---------------------------------------------------------------------------------
// (1) Match exacto standalone — REQ-MIG-003, `evaluar_match_exacto`/`es_match_exacto`
// ---------------------------------------------------------------------------------

/** Usa el normalizador de código "público" (`normalizarCodigo`, sin quitar guiones).
 * Ver nota de `normalizarCodigoEstricto` sobre la inconsistencia documentada del
 * origen entre esta función y la que usa `clasificarCuentaOrigen`. */
export function esMatchExacto(origen: CuentaCatalogo, destino: CuentaCatalogo): boolean {
  const codigoO = normalizarCodigo(origen.codigo);
  const codigoD = normalizarCodigo(destino.codigo);
  const nombreO = normalizarNombre(origen.nombre);
  const nombreD = normalizarNombre(destino.nombre);
  if (!codigoO || !nombreO || !codigoD || !nombreD) return false;
  return codigoO === codigoD && nombreO === nombreD;
}

// ---------------------------------------------------------------------------------
// Helpers de coincidencia usados por la clasificación real (con normalizador
// estricto) — `_codigo_coincide`/`_nombre_coincide` del origen.
// ---------------------------------------------------------------------------------

function codigoCoincide(origen: CuentaCatalogo, destino: CuentaCatalogo): boolean {
  const a = normalizarCodigoEstricto(origen.codigo);
  const b = normalizarCodigoEstricto(destino.codigo);
  return a.length > 0 && b.length > 0 && a === b;
}

function nombreCoincide(origen: CuentaCatalogo, destino: CuentaCatalogo): boolean {
  const a = normalizarNombre(origen.nombre);
  const b = normalizarNombre(destino.nombre);
  return a.length > 0 && b.length > 0 && a === b;
}

// ---------------------------------------------------------------------------------
// (2) Alerta de riesgo — REQ-MIG-004: código coincide XOR nombre coincide (un
// indicio de que una fila pudo editarse a mano y desalinearse del resto).
// ---------------------------------------------------------------------------------

export function esAlertaRiesgo(origen: CuentaCatalogo, destino: CuentaCatalogo): boolean {
  return codigoCoincide(origen, destino) !== nombreCoincide(origen, destino);
}

// ---------------------------------------------------------------------------------
// (3) Score compuesto fuzzy — REQ-MIG-005. Pesos EXACTOS del origen (deben sumar
// 1.0 — verificado al cargar el módulo, ver assertion abajo).
// ---------------------------------------------------------------------------------

export const PESO_NOMBRE = 0.5;
export const PESO_NIVEL = 0.15;
export const PESO_NATURALEZA = 0.15;
export const PESO_TIPO_AGREGADO = 0.1;
export const PESO_CUENTA_PADRE = 0.1;

const SUMA_PESOS = PESO_NOMBRE + PESO_NIVEL + PESO_NATURALEZA + PESO_TIPO_AGREGADO + PESO_CUENTA_PADRE;
if (Math.abs(SUMA_PESOS - 1.0) > 1e-9) {
  throw new Error(`Los pesos del score compuesto de migración de catálogo deben sumar 1.0, suman ${SUMA_PESOS}.`);
}

/** `similitud_nombre` del origen — `rapidfuzz.fuzz.token_sort_ratio` sobre texto
 * normalizado. Verificado byte-exacto (ver `text-similarity.ts`, `tokenSortRatio`). */
export function similitudNombre(a: string, b: string): number {
  return tokenSortRatio(normalizarNombre(a), normalizarNombre(b));
}

function coincideCuentaPadre(origen: CuentaCatalogo, destino: CuentaCatalogo): boolean {
  if (!origen.cuentaPadreCodigo || !destino.cuentaPadreCodigo) return false;
  return normalizarCodigoEstricto(origen.cuentaPadreCodigo) === normalizarCodigoEstricto(destino.cuentaPadreCodigo);
}

/** `calcular_score_compuesto` — 0-100, redondeado a 2 decimales, con clamp
 * defensivo [0,100] igual que el origen (`round(min(100.0, max(0.0, score)), 2)`). */
export function calcularScoreCompuesto(origen: CuentaCatalogo, destino: CuentaCatalogo): number {
  const score =
    similitudNombre(origen.nombre, destino.nombre) * PESO_NOMBRE +
    (origen.nivel === destino.nivel ? 100 : 0) * PESO_NIVEL +
    (normalizarTexto(origen.naturaleza) === normalizarTexto(destino.naturaleza) ? 100 : 0) * PESO_NATURALEZA +
    (normalizarTexto(origen.tipoAgregado) === normalizarTexto(destino.tipoAgregado) ? 100 : 0) * PESO_TIPO_AGREGADO +
    (coincideCuentaPadre(origen, destino) ? 100 : 0) * PESO_CUENTA_PADRE;
  const clamped = Math.min(100, Math.max(0, score));
  return Math.round((clamped + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------------
// (4) Sin match — REQ-MIG-006
// ---------------------------------------------------------------------------------

export const UMBRAL_SIN_MATCH = 60.0;
export const NOTA_SIN_MATCH = "cuenta nueva a crear en destino";

/** Resultado crudo de clasificar una cuenta origen — antes de aterrizarlo como
 * `MapeoMigracionCuenta` persistido (falta `id`/`organizationId`/timestamps). */
export interface ClasificacionCuentaOrigen {
  readonly origenCuentaId: string;
  readonly destinoCuentaId: string | null;
  readonly tipoMatch: TipoMatchMigracion;
  readonly score: number;
  readonly estado: "pendiente" | "aprobado";
  readonly nota: string | null;
}

/**
 * `clasificar_cuenta_origen` — clasifica UNA cuenta origen contra TODOS los
 * candidatos de destino, en el mismo orden de tres pasadas que el origen:
 *   1. Primer candidato con match exacto (código+nombre, normalizador estricto) →
 *      retorna inmediatamente ese exacto (`estado="aprobado"`, `score=100`).
 *   2. Si no hubo exacto: primer candidato que dispare alerta de riesgo (XOR de
 *      código/nombre) → retorna ese, sin comparar alertas entre sí
 *      (`estado="pendiente"`, `score=50`).
 *   3. Si no hubo ninguno de los dos: entre los candidatos restantes, el de MAYOR
 *      score compuesto estricto (empate → gana el primero visto en la lista) — si
 *      `score >= UMBRAL_SIN_MATCH` (60.0, el umbral SÍ cuenta como match, es `>=` no
 *      `>`) es fuzzy; si no, sin_match.
 * El orden de `candidatosDestino` importa para el desempate de alertas/fuzzy — el
 * origen asume que el llamador ya ordenó por código ascendente (así lo hacen sus
 * loaders SQL, `ORDER BY codigo`).
 */
export function clasificarCuentaOrigen(origen: CuentaCatalogo, candidatosDestino: readonly CuentaCatalogo[]): ClasificacionCuentaOrigen {
  // Pasada 1: exacto.
  for (const destino of candidatosDestino) {
    if (codigoCoincide(origen, destino) && nombreCoincide(origen, destino)) {
      return {
        origenCuentaId: origen.id,
        destinoCuentaId: destino.id,
        tipoMatch: "exacto",
        score: 100,
        estado: "aprobado",
        nota: "match exacto: código y nombre normalizados idénticos entre origen y destino",
      };
    }
  }

  // Pasada 2: alerta de riesgo (primer candidato que la dispara).
  for (const destino of candidatosDestino) {
    if (esAlertaRiesgo(origen, destino)) {
      const codigoCoincideAqui = codigoCoincide(origen, destino);
      const campoCoincide = codigoCoincideAqui ? "código" : "nombre";
      const campoDifiere = codigoCoincideAqui ? "nombre" : "código";
      return {
        origenCuentaId: origen.id,
        destinoCuentaId: destino.id,
        tipoMatch: "alerta_riesgo",
        score: 50,
        estado: "pendiente",
        nota: `alerta de riesgo: coincide el ${campoCoincide} pero difiere el ${campoDifiere} (origen: codigo="${origen.codigo}" nombre="${origen.nombre}"; destino: codigo="${destino.codigo}" nombre="${destino.nombre}"). Requiere aprobación humana explícita antes de usarse para migrar pólizas (ADR-3, REQ-MIG-004).`,
      };
    }
  }

  // Pasada 3: fuzzy — mejor score compuesto entre los candidatos sin coincidencia de
  // código NI de nombre (esos ya se resolvieron arriba).
  let mejorDestino: CuentaCatalogo | null = null;
  // Sentinela -1 (no 0), igual que el origen (`mejor_score = -1.0`): si TODOS los
  // candidatos restantes obtuvieran score=0 (caso extremo, matemáticamente posible
  // solo si ningún factor coincide), el origen igual selecciona el primero visto
  // como "mejor" en vez de caer en sin_match sin comparar — arrancar en 0 en vez de
  // -1 cambiaría ese caso límite.
  let mejorScore = -1;
  for (const destino of candidatosDestino) {
    if (codigoCoincide(origen, destino) || nombreCoincide(origen, destino)) continue;
    const score = calcularScoreCompuesto(origen, destino);
    if (score > mejorScore) {
      mejorScore = score;
      mejorDestino = destino;
    }
  }

  if (mejorDestino === null || mejorScore < UMBRAL_SIN_MATCH) {
    return {
      origenCuentaId: origen.id,
      destinoCuentaId: null,
      tipoMatch: "sin_match",
      score: Math.round((Math.max(mejorScore, 0) + Number.EPSILON) * 100) / 100,
      estado: "pendiente",
      nota: NOTA_SIN_MATCH,
    };
  }

  return {
    origenCuentaId: origen.id,
    destinoCuentaId: mejorDestino.id,
    tipoMatch: "fuzzy",
    score: mejorScore,
    estado: "pendiente", // ADR-3: fuzzy NUNCA nace aprobado, sin importar el score.
    nota: `match fuzzy score=${mejorScore.toFixed(2)} ('${origen.codigo} ${origen.nombre}' -> '${mejorDestino.codigo} ${mejorDestino.nombre}'); requiere revisión humana`,
  };
}

/** Clasifica un catálogo origen completo contra un catálogo destino completo —
 * `clasificar_catalogo_cross_db` sin la parte de I/O (recibe las listas ya
 * cargadas, en vez de abrir conexiones — ver `cross_db-port.ts` para el contrato de
 * carga real). */
export function clasificarCatalogo(catalogoOrigen: readonly CuentaCatalogo[], catalogoDestino: readonly CuentaCatalogo[]): readonly ClasificacionCuentaOrigen[] {
  return catalogoOrigen.map((origen) => clasificarCuentaOrigen(origen, catalogoDestino));
}

export type { MapeoMigracionCuenta };
export { ratio };
