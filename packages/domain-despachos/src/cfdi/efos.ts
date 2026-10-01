// ═══════════════════════════════════════════════════════════════════════════
// LISTA 69-B DEL SAT (EFOS) — contribuyentes que facturan operaciones presuntamente
// inexistentes (art. 69-B CFF). Dos piezas puras, sin I/O ni llamadas al SAT:
//
//  1. `parsearListado69B()` — lee el CSV público "Listado completo 69-B" (publicado
//     por el SAT cada mes) y lo normaliza a filas tipadas. El parser localiza la fila
//     de encabezado por NOMBRE de columna (no por posición), porque el archivo trae
//     renglones de título antes del encabezado y el SAT ha movido columnas entre
//     publicaciones. Sin la columna RFC o sin la de situación el archivo se rechaza
//     entero (`Efos69bFormatoError`): ingerir una lista a medias es peor que no
//     ingerirla. NOTA DE VERIFICACIÓN: los nombres de columna se transcribieron del
//     formato público conocido y se cubren con un fixture sintético con RFC ficticios
//     (tests/fixtures/efos-69b-muestra.csv); no se pudo bajar el archivo real en este
//     entorno (sin llamadas al SAT), así que la primera ingesta real debe revisarse.
//
//  2. `hallazgoEfosParaCfdi()` — decide qué alerta corresponde a un RFC emisor según su
//     situación en la lista:
//       definitivo          -> ISSUE (valido=false): el SAT ya declaró inexistentes las
//                              operaciones; no son deducibles ni acreditables.
//       presunto            -> WARNING + revisión humana: aún puede desvirtuar; el
//                              receptor tiene un plazo legal para acreditar la
//                              materialidad o corregir su situación.
//       desvirtuado /
//       sentencia_favorable -> nota informativa, SIN efecto en validez ni revisión: el
//                              contribuyente salió de la presunción.
//     Se compone SOBRE el resultado de `validarCfdiDespachos` (no lo modifica), igual
//     que esa función compone sobre `validarCfdi` de @atiende/billing.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import type { HallazgoCfdi } from "@atiende/billing";
import type { ResultadoValidacionCfdiDespachos } from "./reglas-fiscales-avanzadas.ts";

export type EfosSituacion = "presunto" | "desvirtuado" | "definitivo" | "sentencia_favorable";

export interface EfosContribuyente {
  readonly rfc: string;
  readonly nombre: string;
  readonly situacion: EfosSituacion;
  /** Número y fecha del oficio global de presunción (texto libre del SAT), si viene. */
  readonly oficioPresuncion: string | null;
  /** Fechas de publicación en la página del SAT (ISO YYYY-MM-DD), por etapa. */
  readonly fechaPresuncionSat: string | null;
  readonly fechaDesvirtuadoSat: string | null;
  readonly fechaDefinitivoSat: string | null;
  readonly fechaSentenciaFavorableSat: string | null;
}

export interface EfosFilaDescartada {
  /** Número de línea 1-based dentro del texto original. */
  readonly linea: number;
  readonly motivo: "rfc_invalido" | "situacion_desconocida" | "rfc_duplicado";
}

export interface EfosListadoParseado {
  readonly filas: readonly EfosContribuyente[];
  readonly descartadas: readonly EfosFilaDescartada[];
  /** SHA-256 hex del texto normalizado (sin BOM, saltos LF) — llave de idempotencia por periodo. */
  readonly fuenteSha256: string;
}

export class Efos69bFormatoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Efos69bFormatoError";
  }
}

export const EFOS_RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
export const EFOS_PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** El archivo del SAT históricamente se publica en Windows-1252; si los bytes no son
 * UTF-8 válido se decodifican como Windows-1252 (nunca se pierden acentos en silencio). */
export function decodificarListado69B(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** CSV RFC 4180 mínimo: comillas dobles, comillas escapadas ("") y saltos de línea
 * dentro de campos entrecomillados. Devuelve cada registro con su línea inicial. */
function parsearCsv(texto: string): { linea: number; celdas: string[] }[] {
  const out: { linea: number; celdas: string[] }[] = [];
  let celdas: string[] = [];
  let campo = "";
  let enComillas = false;
  let linea = 1;
  let lineaInicio = 1;
  let hayContenido = false;
  const cerrarCampo = () => {
    celdas.push(campo);
    campo = "";
  };
  const cerrarRegistro = () => {
    cerrarCampo();
    if (hayContenido || celdas.some((c) => c !== "")) out.push({ linea: lineaInicio, celdas });
    celdas = [];
    hayContenido = false;
  };
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!;
    if (enComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else enComillas = false;
      } else {
        if (ch === "\n") linea++;
        campo += ch;
      }
      continue;
    }
    if (ch === '"') {
      enComillas = true;
      hayContenido = true;
    } else if (ch === ",") {
      cerrarCampo();
      hayContenido = true;
    } else if (ch === "\n") {
      cerrarRegistro();
      linea++;
      lineaInicio = linea;
    } else {
      campo += ch;
      hayContenido = true;
    }
  }
  if (campo !== "" || celdas.length > 0 || hayContenido) cerrarRegistro();
  return out;
}

function parsearFecha(valor: string | undefined): string | null {
  if (!valor) return null;
  const v = valor.trim();
  let y: number, m: number, d: number;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dmy) {
    d = Number(dmy[1]);
    m = Number(dmy[2]);
    y = Number(dmy[3]);
  } else if (ymd) {
    y = Number(ymd[1]);
    m = Number(ymd[2]);
    d = Number(ymd[3]);
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parsearSituacion(valor: string): EfosSituacion | null {
  const n = normalizar(valor);
  if (n.includes("definitivo")) return "definitivo";
  if (n.includes("desvirtuado")) return "desvirtuado";
  if (n.includes("sentencia")) return "sentencia_favorable";
  if (n.includes("presunto")) return "presunto";
  return null;
}

export function parsearListado69B(textoOriginal: string): EfosListadoParseado {
  const texto = textoOriginal.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const registros = parsearCsv(texto);

  const idxEncabezado = registros.findIndex((r) => {
    const n = r.celdas.map(normalizar);
    return n.includes("rfc") && n.some((c) => c.includes("situacion"));
  });
  if (idxEncabezado === -1) throw new Efos69bFormatoError("No se encontró la fila de encabezado (columnas RFC y Situación del contribuyente).");

  const enc = registros[idxEncabezado]!.celdas.map(normalizar);
  const col = (pred: (h: string) => boolean): number => enc.findIndex(pred);
  const cRfc = col((h) => h === "rfc");
  const cSituacion = col((h) => h.includes("situacion"));
  const cNombre = col((h) => h.startsWith("nombre"));
  const cOficio = col((h) => h.startsWith("numero y fecha de oficio global de presuncion sat"));
  const cPresunto = col((h) => h.includes("publicacion pagina sat presuntos"));
  const cDesvirtuado = col((h) => h.includes("publicacion pagina sat desvirtuados"));
  const cDefinitivo = col((h) => h.includes("publicacion pagina sat definitivos"));
  const cSentencia = col((h) => h.includes("publicacion pagina sat sentencia favorable"));
  const celda = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");

  const filas: EfosContribuyente[] = [];
  const descartadas: EfosFilaDescartada[] = [];
  const vistos = new Set<string>();

  for (const reg of registros.slice(idxEncabezado + 1)) {
    const rfc = celda(reg.celdas, cRfc).toUpperCase();
    // Renglones de pie/ruido sin RFC ni situación no cuentan como descartes.
    if (rfc === "" && celda(reg.celdas, cSituacion) === "") continue;
    if (!EFOS_RFC_RE.test(rfc)) {
      descartadas.push({ linea: reg.linea, motivo: "rfc_invalido" });
      continue;
    }
    const situacion = parsearSituacion(celda(reg.celdas, cSituacion));
    if (situacion === null) {
      descartadas.push({ linea: reg.linea, motivo: "situacion_desconocida" });
      continue;
    }
    if (vistos.has(rfc)) {
      descartadas.push({ linea: reg.linea, motivo: "rfc_duplicado" });
      continue;
    }
    vistos.add(rfc);
    filas.push({
      rfc,
      nombre: celda(reg.celdas, cNombre),
      situacion,
      oficioPresuncion: celda(reg.celdas, cOficio) || null,
      fechaPresuncionSat: parsearFecha(celda(reg.celdas, cPresunto)),
      fechaDesvirtuadoSat: parsearFecha(celda(reg.celdas, cDesvirtuado)),
      fechaDefinitivoSat: parsearFecha(celda(reg.celdas, cDefinitivo)),
      fechaSentenciaFavorableSat: parsearFecha(celda(reg.celdas, cSentencia)),
    });
  }

  if (filas.length === 0) throw new Efos69bFormatoError("El archivo no contiene ninguna fila válida: no se ingiere una lista vacía.");

  return { filas, descartadas, fuenteSha256: createHash("sha256").update(texto, "utf8").digest("hex") };
}

// ---------------------------------------------------------------------------
// Consulta y hallazgos
// ---------------------------------------------------------------------------

/** Resultado de consultar uno o varios RFC contra la lista vigente (último periodo ingerido). */
export interface EfosConsulta {
  /** `no_disponible`: la base aún no tiene la migración o no se ha ingerido ninguna lista.
   * Es un estado honesto, NUNCA equivale a "limpio". */
  readonly estado: "disponible" | "no_disponible";
  readonly periodoLista: string | null;
  readonly coincidencias: readonly EfosContribuyente[];
}

export const EFOS_NO_DISPONIBLE: EfosConsulta = { estado: "no_disponible", periodoLista: null, coincidencias: [] };

export const CODIGO_EFOS_DEFINITIVO = "efos_69b_definitivo";
export const CODIGO_EFOS_PRESUNTO = "efos_69b_presunto";

export interface HallazgoEfos {
  readonly issue: HallazgoCfdi | null;
  readonly warning: string | null;
  readonly requiereRevision: boolean;
}

export function hallazgoEfosParaCfdi(rfcEmisor: string, contribuyente: EfosContribuyente | null, periodoLista: string | null): HallazgoEfos {
  if (contribuyente === null) return { issue: null, warning: null, requiereRevision: false };
  const ref = periodoLista ? ` (lista 69-B del periodo ${periodoLista})` : "";
  switch (contribuyente.situacion) {
    case "definitivo":
      return {
        issue: {
          codigo: CODIGO_EFOS_DEFINITIVO,
          mensaje: `El emisor ${rfcEmisor} aparece como DEFINITIVO en la lista 69-B del SAT${ref}: sus operaciones se consideran inexistentes y no son deducibles ni acreditables.`,
          ref: "Art. 69-B CFF",
        },
        warning: null,
        requiereRevision: true,
      };
    case "presunto":
      return {
        issue: null,
        warning: `El emisor ${rfcEmisor} aparece como PRESUNTO en la lista 69-B del SAT${ref}: revisa la materialidad de la operación y el plazo legal para acreditarla antes de deducir o acreditar IVA.`,
        requiereRevision: true,
      };
    case "desvirtuado":
      return { issue: null, warning: `Informativo: el emisor ${rfcEmisor} figura en la lista 69-B como DESVIRTUADO${ref}; sin efecto sobre la validez del CFDI.`, requiereRevision: false };
    case "sentencia_favorable":
      return { issue: null, warning: `Informativo: el emisor ${rfcEmisor} figura en la lista 69-B con SENTENCIA FAVORABLE${ref}; sin efecto sobre la validez del CFDI.`, requiereRevision: false };
  }
}

/** Compone el hallazgo EFOS sobre el resultado de `validarCfdiDespachos` sin mutarlo. */
export function aplicarEfosAlResultado(resultado: ResultadoValidacionCfdiDespachos, hallazgo: HallazgoEfos): ResultadoValidacionCfdiDespachos {
  if (hallazgo.issue === null && hallazgo.warning === null) return resultado;
  const issues = hallazgo.issue ? [...resultado.issues, hallazgo.issue] : resultado.issues;
  const warnings = hallazgo.warning ? [...resultado.warnings, hallazgo.warning] : resultado.warnings;
  return {
    ...resultado,
    ok: resultado.ok && hallazgo.issue === null,
    issues,
    warnings,
    checks: { pass: resultado.checks.pass, fail: resultado.checks.fail + (hallazgo.issue ? 1 : 0) },
    requiresHumanReview: resultado.requiresHumanReview || hallazgo.requiereRevision,
  };
}

/** Mes (YYYY-MM) en que SAT publica cada edición; helper para que el job/ruta validen el periodo. */
export function esPeriodoEfosValido(periodo: string): boolean {
  return EFOS_PERIODO_RE.test(periodo);
}
