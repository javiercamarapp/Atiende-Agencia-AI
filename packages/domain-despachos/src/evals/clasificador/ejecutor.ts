// Conjunto dorado del clasificador contable (D-P3-13): corre cada caso por `clasificarCfdi` + compuerta y mide acierto.
// Sin LLM ni red: determinista. Reporta el porcentaje; NO bloquea hasta que Javier fije el umbral (ver README.md).
import casosJson from "./casos.json" with { type: "json" };
import { clasificarCfdi, evaluarCompuertaClasificacion } from "../../bookkeeping/clasificacion-cfdi.ts";
import type { CorreccionClasificacion } from "../../bookkeeping/clasificacion-cfdi.ts";

export interface CasoClasificador {
  readonly id: string;
  readonly descripcion: string;
  readonly claveProdServ?: string;
  readonly tipo: string;
  readonly direccion: "emitido" | "recibido" | "indeterminado";
  /** null = empate legítimo: no hay una categoría correcta única. */
  readonly categoriaEsperada: string | null;
  /** true = el sistema DEBE mandarlo a revisión humana (empate, desacuerdo o sin coincidencias). */
  readonly debeIrARevision: boolean;
  readonly nota?: string;
}

export const CASOS_CLASIFICADOR = (casosJson as { casos: readonly CasoClasificador[] }).casos;

export interface ResultadoCaso {
  readonly id: string;
  readonly categoria: string | null;
  readonly confianza: number | null;
  readonly empate: boolean;
  readonly requiereRevision: boolean;
  readonly aciertoCategoria: boolean | null;
  readonly aciertoRevision: boolean | null;
  /** La categoría salió mal y la compuerta la dejó pasar sin revisión: el único error silencioso. */
  readonly errorSilencioso: boolean;
}

export interface ReporteClasificador {
  readonly total: number;
  readonly conCategoriaEsperada: number;
  readonly aciertosCategoria: number;
  readonly porcentajeAciertoCategoria: number;
  readonly deberianIrARevision: number;
  readonly aciertosRevision: number;
  readonly porcentajeAciertoRevision: number;
  readonly empates: number;
  readonly empatesARevision: number;
  readonly porcentajeEmpateARevision: number;
  readonly erroresSilenciosos: number;
  readonly porcentajeErrorSilencioso: number;
  readonly fallos: readonly string[];
}

export function evaluarCaso(caso: CasoClasificador, correcciones: readonly CorreccionClasificacion[] = []): ResultadoCaso {
  const r = clasificarCfdi(
    { tipo: caso.tipo, direccion: caso.direccion, rfcEmisor: "AAA010101AAA", conceptos: [{ descripcion: caso.descripcion, claveProdServ: caso.claveProdServ ?? null }] },
    correcciones,
  );
  if (r === null) {
    return { id: caso.id, categoria: null, confianza: null, empate: false, requiereRevision: true, aciertoCategoria: caso.categoriaEsperada === null ? null : false, aciertoRevision: caso.debeIrARevision ? true : null, errorSilencioso: false };
  }
  const gate = evaluarCompuertaClasificacion(r.confianza);
  const aciertoCategoria = caso.categoriaEsperada === null ? null : r.categoria === caso.categoriaEsperada;
  return {
    id: caso.id,
    categoria: r.categoria,
    confianza: r.confianza,
    empate: r.empate,
    requiereRevision: gate.requiereRevision,
    aciertoCategoria,
    aciertoRevision: caso.debeIrARevision ? gate.requiereRevision : null,
    errorSilencioso: aciertoCategoria === false && !gate.requiereRevision,
  };
}

const pct = (a: number, b: number): number => (b === 0 ? 100 : Math.round((a / b) * 1000) / 10);

export function correrConjuntoDorado(casos: readonly CasoClasificador[] = CASOS_CLASIFICADOR): { readonly reporte: ReporteClasificador; readonly resultados: readonly ResultadoCaso[] } {
  const resultados = casos.map((c) => evaluarCaso(c));
  const conCat = resultados.filter((r) => r.aciertoCategoria !== null);
  const aciertosCat = conCat.filter((r) => r.aciertoCategoria === true).length;
  const deben = resultados.filter((r) => r.aciertoRevision !== null);
  const aciertosRev = deben.filter((r) => r.aciertoRevision === true).length;
  const empates = resultados.filter((r) => r.empate);
  const empatesRev = empates.filter((r) => r.requiereRevision).length;
  const silenciosos = resultados.filter((r) => r.errorSilencioso).length;
  const fallos = resultados.filter((r) => r.aciertoCategoria === false || r.aciertoRevision === false).map((r) => r.id);
  return {
    resultados,
    reporte: {
      total: resultados.length,
      conCategoriaEsperada: conCat.length,
      aciertosCategoria: aciertosCat,
      porcentajeAciertoCategoria: pct(aciertosCat, conCat.length),
      deberianIrARevision: deben.length,
      aciertosRevision: aciertosRev,
      porcentajeAciertoRevision: pct(aciertosRev, deben.length),
      empates: empates.length,
      empatesARevision: empatesRev,
      porcentajeEmpateARevision: pct(empatesRev, empates.length),
      erroresSilenciosos: silenciosos,
      porcentajeErrorSilencioso: pct(silenciosos, resultados.length),
      fallos,
    },
  };
}

export function formatearReporte(r: ReporteClasificador): string {
  return [
    `Conjunto dorado del clasificador: ${r.total} casos`,
    `- Acierto de categoría: ${r.aciertosCategoria}/${r.conCategoriaEsperada} (${r.porcentajeAciertoCategoria}%)`,
    `- Casos que debían ir a revisión y fueron: ${r.aciertosRevision}/${r.deberianIrARevision} (${r.porcentajeAciertoRevision}%)`,
    `- Empates enviados a revisión: ${r.empatesARevision}/${r.empates} (${r.porcentajeEmpateARevision}%)`,
    `- Errores silenciosos (categoría mala sin revisión): ${r.erroresSilenciosos} (${r.porcentajeErrorSilencioso}% del total)`,
    r.fallos.length > 0 ? `- Casos con fallo: ${r.fallos.join(", ")}` : "- Sin fallos",
  ].join("\n");
}
