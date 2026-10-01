// Agregacion y reporte (JSON + Markdown) de una corrida del arnes: ranking por exactitud / cifras inventadas /
// herramienta / latencia / costo, puertas de aprobacion del plan (docs/EVAL-COPILOTO.md) y recomendacion por rol.
import { candidatoPorId, type ModeloCandidato, type RolEval } from "./candidatos.js";
import type { RegistroTurno, ResultadoCorrida } from "./runner.js";
import { CATEGORIAS_CASO } from "./types.js";

/** Umbrales del plan (investigacion-modelos-copiloto.md, seccion 4). */
export const PUERTAS = {
  herramienta: 0.95,
  cifras: 0.98,
  jsonLlamadas: 0.995,
  rechazo: 0.95,
  narrativaDescartadaMax: 0.1,
  p95LatenciaMs: 6_000,
  inventadasMax: 0,
  /** Fraccion minima de los turnos planeados que debe haberse evaluado para poder dictaminar. */
  coberturaMin: 0.9,
} as const;

export interface ResumenModelo {
  readonly modelo: string;
  readonly etiqueta: string;
  readonly evaluados: number;
  readonly noCorridos: number;
  readonly erroresProveedor: number;
  readonly sinRuta: number;
  readonly cobertura: number;
  readonly exactitud: number;
  readonly passK: number | null;
  readonly herramienta: number;
  readonly argumentos: number;
  readonly periodo: number | null;
  readonly jsonLlamadas: number;
  readonly llamadas: number;
  readonly llamadasInvalidas: number;
  readonly cifras: number | null;
  readonly inventadas: number;
  readonly casosConInventadas: number;
  readonly narrativaDescartada: number;
  readonly rechazo: number | null;
  readonly espanolReglas: number;
  readonly juezMedia: number | null;
  readonly latenciaP50Ms: number;
  readonly latenciaP95Ms: number;
  readonly costoUsd: number;
  readonly costoPorPreguntaUsd: number;
  readonly exactitudPorCategoria: Readonly<Record<string, number | null>>;
  readonly puertas: Readonly<Record<string, boolean | null>>;
  readonly pasaPuertas: boolean;
}

const rate = (ok: number, n: number): number | null => (n === 0 ? null : ok / n);

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const s = [...valores].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
}

function tasaGrader(regs: readonly RegistroTurno[], grader: string): number | null {
  let n = 0;
  let ok = 0;
  for (const r of regs) {
    const g = r.evaluacion?.graders.find((x) => x.grader === grader);
    if (!g) continue;
    n += 1;
    if (g.ok) ok += 1;
  }
  return rate(ok, n);
}

export function resumirModelo(res: ResultadoCorrida, modelo: string, expectativas: ReadonlyMap<string, { llamadas: number }>): ResumenModelo {
  const todos = res.registros.filter((r) => r.modelo === modelo);
  const ev = todos.filter((r) => r.estado === "evaluado" && r.evaluacion && r.salida);
  const planeados = res.casosPlaneados * res.k;
  const noCorridos = res.noCorridos.filter((n) => n.modelo === modelo).length;

  const okCaso = ev.filter((r) => r.evaluacion!.ok).length;
  // pass^K: un caso pasa solo si se evaluaron las K repeticiones y todas pasaron.
  const porCaso = new Map<string, RegistroTurno[]>();
  for (const r of ev) porCaso.set(r.casoId, [...(porCaso.get(r.casoId) ?? []), r]);
  let completos = 0;
  let pasanK = 0;
  for (const regs of porCaso.values()) {
    if (regs.length < res.k) continue;
    completos += 1;
    if (regs.every((r) => r.evaluacion!.ok)) pasanK += 1;
  }

  const llamadas = ev.reduce((a, r) => a + r.salida!.llamadas.length, 0);
  const invalidas = ev.reduce((a, r) => a + r.salida!.llamadas.filter((l) => l.errorArgs).length, 0);
  const inventadas = ev.reduce((a, r) => a + r.evaluacion!.inventadas.length, 0);
  const conInventadas = ev.filter((r) => r.evaluacion!.inventadas.length > 0).length;
  const conNarrativa = ev.filter((r) => r.salida!.status === "ok" && r.salida!.textoModelo.trim().length > 0);
  const descartadas = conNarrativa.filter((r) => r.evaluacion!.narrativaDescartada).length;

  const negativas = ev.filter((r) => r.categoria === "fuera_catalogo" || r.categoria === "ambigua" || r.categoria === "trampa");
  const unaHerramienta = ev.filter((r) => (expectativas.get(r.casoId)?.llamadas ?? 0) === 1);
  const lat = (unaHerramienta.length > 0 ? unaHerramienta : ev).map((r) => r.salida!.latenciaLlmMs);
  const costo = ev.reduce((a, r) => a + r.salida!.costoUsd, 0);
  const jueces = ev.map((r) => r.juez?.nota).filter((n): n is number => typeof n === "number");

  const exactitudPorCategoria: Record<string, number | null> = {};
  for (const cat of CATEGORIAS_CASO) {
    const deCat = ev.filter((r) => r.categoria === cat);
    exactitudPorCategoria[cat] = rate(deCat.filter((r) => r.evaluacion!.ok).length, deCat.length);
  }

  const herramienta = tasaGrader(ev, "herramienta") ?? 0;
  const cifras = tasaGrader(ev, "cifras_exactas");
  const jsonLlamadas = llamadas === 0 ? 1 : (llamadas - invalidas) / llamadas;
  const rechazo = rate(negativas.filter((r) => r.evaluacion!.ok).length, negativas.length);
  const narrativaDescartada = conNarrativa.length === 0 ? 0 : descartadas / conNarrativa.length;
  const cobertura = planeados === 0 ? 0 : ev.length / planeados;
  const p95 = percentil(lat, 0.95);

  const puertas: Record<string, boolean | null> = {
    herramienta: ev.length === 0 ? null : herramienta >= PUERTAS.herramienta,
    cero_inventadas: ev.length === 0 ? null : inventadas <= PUERTAS.inventadasMax,
    cifras: cifras === null ? null : cifras >= PUERTAS.cifras,
    json: ev.length === 0 ? null : jsonLlamadas >= PUERTAS.jsonLlamadas,
    rechazo: rechazo === null ? null : rechazo >= PUERTAS.rechazo,
    narrativa_descartada: ev.length === 0 ? null : narrativaDescartada <= PUERTAS.narrativaDescartadaMax,
    latencia_p95: ev.length === 0 ? null : p95 <= PUERTAS.p95LatenciaMs,
    cobertura: cobertura >= PUERTAS.coberturaMin,
  };
  const pasaPuertas = ev.length > 0 && Object.values(puertas).every((v) => v === true || v === null) && puertas["cobertura"] === true;

  return {
    modelo,
    etiqueta: candidatoPorId(modelo)?.etiqueta ?? modelo,
    evaluados: ev.length,
    noCorridos,
    erroresProveedor: todos.filter((r) => r.estado === "error_proveedor").length,
    sinRuta: todos.filter((r) => r.estado === "sin_ruta").length,
    cobertura,
    exactitud: ev.length === 0 ? 0 : okCaso / ev.length,
    passK: completos === 0 ? null : pasanK / completos,
    herramienta,
    argumentos: tasaGrader(ev, "argumentos") ?? 0,
    periodo: tasaGrader(ev, "periodo"),
    jsonLlamadas,
    llamadas,
    llamadasInvalidas: invalidas,
    cifras,
    inventadas,
    casosConInventadas: conInventadas,
    narrativaDescartada,
    rechazo,
    espanolReglas: ev.length === 0 ? 0 : ev.filter((r) => r.espanolReglas?.ok !== false).length / ev.length,
    juezMedia: jueces.length === 0 ? null : jueces.reduce((a, b) => a + b, 0) / jueces.length,
    latenciaP50Ms: percentil(lat, 0.5),
    latenciaP95Ms: p95,
    costoUsd: costo,
    costoPorPreguntaUsd: ev.length === 0 ? 0 : costo / ev.length,
    exactitudPorCategoria,
    puertas,
    pasaPuertas,
  };
}

/** Orden del ranking: pasa puertas, exactitud, menos inventadas, herramienta, menor latencia, menor costo. */
export function ordenarRanking(a: ResumenModelo, b: ResumenModelo): number {
  if (a.pasaPuertas !== b.pasaPuertas) return a.pasaPuertas ? -1 : 1;
  if (b.exactitud !== a.exactitud) return b.exactitud - a.exactitud;
  if (a.inventadas !== b.inventadas) return a.inventadas - b.inventadas;
  if (b.herramienta !== a.herramienta) return b.herramienta - a.herramienta;
  if (a.latenciaP95Ms !== b.latenciaP95Ms) return a.latenciaP95Ms - b.latenciaP95Ms;
  return a.costoPorPreguntaUsd - b.costoPorPreguntaUsd;
}

export interface RecomendacionRol {
  readonly rol: RolEval;
  readonly primario: string | null;
  readonly respaldos: readonly string[];
  readonly razon: string;
}

const laboratorio = (id: string): string => id.split("/")[0] ?? id;

/** Recomendacion por rol. Reglas fijas (documentadas): solo modelos que PASAN LAS PUERTAS y no son de calibracion;
 *  chat_general = el mas barato (desempata exactitud); reintento_guardia = el de mayor exactitud distinto del
 *  primario; respaldo = siguientes mas baratos de OTROS laboratorios. Sin datos suficientes: se dice, no se inventa. */
export function recomendarPorRol(resumenes: readonly ResumenModelo[], candidatos: readonly ModeloCandidato[] = []): RecomendacionRol[] {
  const esCalibracion = (id: string) => (candidatos.find((c) => c.id === id) ?? candidatoPorId(id))?.roles.includes("calibracion") ?? false;
  const aptos = resumenes.filter((r) => r.pasaPuertas && !esCalibracion(r.modelo));
  const porCosto = [...aptos].sort((a, b) => a.costoPorPreguntaUsd - b.costoPorPreguntaUsd || b.exactitud - a.exactitud);
  const out: RecomendacionRol[] = [];

  const primario = porCosto[0] ?? null;
  out.push(
    primario
      ? { rol: "chat_general", primario: primario.modelo, respaldos: [], razon: `el mas barato que pasa todas las puertas (exactitud ${(primario.exactitud * 100).toFixed(1)}%, ${primario.costoPorPreguntaUsd.toFixed(5)} USD por pregunta)` }
      : { rol: "chat_general", primario: null, respaldos: [], razon: "ningun modelo pasa todas las puertas con cobertura suficiente: no se recomienda ninguno (ver el mejor por exactitud en el ranking)" },
  );

  const respaldos: string[] = [];
  for (const r of porCosto) {
    if (r.modelo === primario?.modelo) continue;
    if (laboratorio(r.modelo) === laboratorio(primario?.modelo ?? "")) continue;
    if (respaldos.some((x) => laboratorio(x) === laboratorio(r.modelo))) continue;
    respaldos.push(r.modelo);
    if (respaldos.length >= 2) break;
  }
  out.push({ rol: "respaldo", primario: respaldos[0] ?? null, respaldos: respaldos.slice(1), razon: respaldos.length ? "siguientes mas baratos que pasan las puertas, de laboratorios distintos al primario" : "no hay respaldos que pasen las puertas" });

  const reintento = [...aptos].filter((r) => r.modelo !== primario?.modelo).sort((a, b) => b.exactitud - a.exactitud || a.inventadas - b.inventadas || a.costoPorPreguntaUsd - b.costoPorPreguntaUsd)[0];
  out.push({ rol: "reintento_guardia", primario: reintento?.modelo ?? null, respaldos: [], razon: reintento ? `mayor exactitud entre los que pasan las puertas, distinto del primario (${(reintento.exactitud * 100).toFixed(1)}%)` : "sin candidato que pase las puertas distinto del primario" });

  const cfo = resumenes.filter((r) => r.evaluados > 0 && candidatos.some((c) => c.id === r.modelo && c.roles.includes("cfo_superadmin")));
  out.push({ rol: "cfo_superadmin", primario: null, respaldos: [], razon: cfo.length ? "se decide con el subconjunto CFO (fase cfo): ver su reporte" : "sin datos: el subconjunto CFO/superadmin no tiene catalogo en main (SA-L-15); la fase cfo queda pendiente" });
  return out;
}

export interface ReporteCorrida {
  readonly generado: string;
  readonly fase: string;
  readonly k: number;
  readonly maxUsd: number;
  readonly gastoUsd: number;
  readonly abortada: ResultadoCorrida["abortada"];
  readonly detalleAborto?: string;
  readonly casosPlaneados: number;
  readonly resumenes: readonly ResumenModelo[];
  readonly ranking: readonly string[];
  readonly recomendaciones: readonly RecomendacionRol[];
  readonly descartados: ResultadoCorrida["descartados"];
  readonly noCorridos: number;
}

export function construirReporte(res: ResultadoCorrida, expectativas: ReadonlyMap<string, { llamadas: number }>, candidatos: readonly ModeloCandidato[] = [], generado = new Date().toISOString()): ReporteCorrida {
  const resumenes = res.modelos.map((m) => resumirModelo(res, m, expectativas)).sort(ordenarRanking);
  return {
    generado,
    fase: res.fase,
    k: res.k,
    maxUsd: res.maxUsd,
    gastoUsd: res.gastoUsd,
    abortada: res.abortada,
    ...(res.detalleAborto ? { detalleAborto: res.detalleAborto } : {}),
    casosPlaneados: res.casosPlaneados,
    resumenes,
    ranking: resumenes.map((r) => r.modelo),
    recomendaciones: recomendarPorRol(resumenes, candidatos),
    descartados: res.descartados,
    noCorridos: res.noCorridos.length,
  };
}

const pct = (n: number | null): string => (n === null ? "n/d" : `${(n * 100).toFixed(1)}%`);
const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 5 : 3)}`;
const si = (v: boolean | null): string => (v === null ? "n/d" : v ? "si" : "NO");

export function reporteMarkdown(r: ReporteCorrida): string {
  const L: string[] = [];
  L.push(`# Reporte de evaluacion del Copiloto: fase ${r.fase}`);
  L.push("");
  L.push(`- Generado: ${r.generado}`);
  L.push(`- Casos planeados: ${r.casosPlaneados} x K=${r.k} por modelo; modelos: ${r.resumenes.length}`);
  L.push(`- Gasto real (usage.cost): ${usd(r.gastoUsd)} de un tope de ${usd(r.maxUsd)}`);
  if (r.abortada) L.push(`- CORRIDA ABORTADA (${r.abortada}): ${r.detalleAborto ?? ""}. Turnos no corridos: ${r.noCorridos}.`);
  L.push("");
  L.push("## Ranking");
  L.push("");
  L.push("Orden: pasa puertas, exactitud, menos cifras inventadas, herramienta, menor latencia p95, menor costo.");
  L.push("");
  L.push("| # | Modelo | Puertas | Exactitud | pass^K | Herramienta | Cifras | Inventadas | JSON | Rechazo | Narr. descartada | p50 / p95 ms | USD/pregunta | Espanol (reglas / juez) | Cobertura |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  r.resumenes.forEach((m, i) => {
    L.push(
      `| ${i + 1} | ${m.etiqueta} (\`${m.modelo}\`) | ${m.pasaPuertas ? "pasa" : "no"} | ${pct(m.exactitud)} | ${pct(m.passK)} | ${pct(m.herramienta)} | ${pct(m.cifras)} | ${m.inventadas} (${m.casosConInventadas} casos) | ${pct(m.jsonLlamadas)} | ${pct(m.rechazo)} | ${pct(m.narrativaDescartada)} | ${m.latenciaP50Ms.toFixed(0)} / ${m.latenciaP95Ms.toFixed(0)} | ${usd(m.costoPorPreguntaUsd)} | ${pct(m.espanolReglas)} / ${m.juezMedia === null ? "n/d" : m.juezMedia.toFixed(2)} | ${pct(m.cobertura)} |`,
    );
  });
  L.push("");
  L.push("## Puertas (umbrales del plan)");
  L.push("");
  L.push(`Herramienta >= ${PUERTAS.herramienta * 100}%, cero cifras inventadas, cifras exactas >= ${PUERTAS.cifras * 100}%, JSON valido >= ${PUERTAS.jsonLlamadas * 100}%, rechazos y aclaraciones >= ${PUERTAS.rechazo * 100}%, narrativa descartada <= ${PUERTAS.narrativaDescartadaMax * 100}%, p95 <= ${PUERTAS.p95LatenciaMs} ms, cobertura >= ${PUERTAS.coberturaMin * 100}%.`);
  L.push("");
  L.push("| Modelo | Herramienta | Cero inventadas | Cifras | JSON | Rechazo | Narrativa | p95 | Cobertura |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const m of r.resumenes) {
    const p = m.puertas;
    L.push(`| ${m.etiqueta} | ${si(p["herramienta"] ?? null)} | ${si(p["cero_inventadas"] ?? null)} | ${si(p["cifras"] ?? null)} | ${si(p["json"] ?? null)} | ${si(p["rechazo"] ?? null)} | ${si(p["narrativa_descartada"] ?? null)} | ${si(p["latencia_p95"] ?? null)} | ${si(p["cobertura"] ?? null)} |`);
  }
  L.push("");
  L.push("## Exactitud por categoria");
  L.push("");
  L.push(`| Modelo | ${CATEGORIAS_CASO.join(" | ")} |`);
  L.push(`|---|${CATEGORIAS_CASO.map(() => "---").join("|")}|`);
  for (const m of r.resumenes) L.push(`| ${m.etiqueta} | ${CATEGORIAS_CASO.map((c) => pct(m.exactitudPorCategoria[c] ?? null)).join(" | ")} |`);
  L.push("");
  L.push("## Recomendacion por rol");
  L.push("");
  for (const rec of r.recomendaciones) {
    const nombre = (id: string | null) => (id ? `${candidatoPorId(id)?.etiqueta ?? id} (\`${id}\`)` : "ninguno");
    L.push(`- **${rec.rol}**: ${nombre(rec.primario)}${rec.respaldos.length ? `; respaldos: ${rec.respaldos.map(nombre).join(", ")}` : ""}. ${rec.razon}.`);
  }
  if (r.descartados.length > 0) {
    L.push("");
    L.push("## Modelos descartados por ruta");
    L.push("");
    for (const d of r.descartados) L.push(`- \`${d.modelo}\`: ${d.motivo}`);
  }
  L.push("");
  L.push("Los modelos de calibracion (Haiku 4.5, Grok 4.3) nunca se recomiendan. Un modelo sin ruta EE.UU./ZDR se descarta; la politica no se relaja.");
  return L.join("\n");
}
