// «Recomendaciones» del CFO de la plataforma.
//
// Las CIFRAS salen del codigo (cockpit.ts / packages/billing/src/cockpit): aqui se convierten en HECHOS numerados con el numero
// ya redactado. El modelo (barato y con ZDR, via la tabla central actividad -> modelo: rol `plataforma:recomendaciones_cfo` ->
// actividad `reporte_analisis_financiero`) SOLO explica y prioriza esos hechos. Defensas:
//   * Sin PII en el prompt: cada cliente viaja como alias (C1, C2...) con su vertical y su plan; el nombre se repone al final.
//   * Ninguna cifra inventada: toda cifra de una recomendacion del modelo debe aparecer literalmente en los hechos que cita; si
//     no, esa recomendacion se descarta. Sin recomendaciones validas (o sin modelo) -> reglas deterministas.
//   * Nunca lanza: un modelo caido, lento o que responde basura cae a las reglas.
import type { LlmGateway } from "@atiende/agent-core";
import type { Cockpit } from "./cockpit.ts";

export const RECOMENDACIONES_CFO_LLM_ROLE = "plataforma:recomendaciones_cfo";
export const RECOMENDACIONES_CFO_TENANT_ID = "plataforma";
export const RECOMENDACIONES_CFO_TIMEOUT_MS = 20_000;
const MAX_HECHOS = 30;
const MAX_RECOMENDACIONES = 6;

export interface Hecho {
  readonly id: string;
  /** Texto con alias (lo que ve el modelo). */
  readonly texto: string;
  /** Accion deterministica (respaldo sin modelo). */
  readonly accion: string;
  readonly titulo: string;
  /** Pesos en juego, para priorizar las reglas. */
  readonly impactoMxn: number;
}

export interface Recomendacion {
  readonly titulo: string;
  readonly explicacion: string;
  readonly accion: string;
  readonly prioridad: number;
  readonly hechos: readonly string[];
}

export interface ResultadoRecomendaciones {
  readonly fuente: "modelo" | "reglas";
  readonly modelo: string | null;
  readonly costoUsd: number | null;
  readonly recomendaciones: readonly Recomendacion[];
  /** Hechos con el nombre real (para mostrar de donde sale cada cifra). */
  readonly hechos: ReadonlyArray<{ readonly id: string; readonly texto: string }>;
  /** Recomendaciones del modelo descartadas por citar una cifra que no esta en sus hechos. */
  readonly descartadas: number;
}

const f0 = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 0 });
const f1 = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 1 });
const mxn = (n: number) => `${f0(n)} MXN`;

/** Alias estable por orden de ingreso (C1 = el de mayor ingreso). */
export function aliasDeClientes(c: Cockpit): ReadonlyMap<string, string> {
  const orden = [...c.economia].sort((a, b) => (b.ingresoMxn ?? 0) - (a.ingresoMxn ?? 0) || a.organizationId.localeCompare(b.organizationId));
  return new Map(orden.map((f, i) => [f.organizationId, `C${i + 1}`]));
}

export function hechosDelCockpit(c: Cockpit): readonly Hecho[] {
  const alias = aliasDeClientes(c);
  const hechos: Omit<Hecho, "id">[] = [];
  const s = c.saas;

  for (const v of c.agregados.porVertical) {
    if (v.llamadas > 0 && v.duracionPromedioMin !== null) {
      const margen = v.margenBrutoPct ?? v.contribucionPct;
      hechos.push({
        titulo: `Duración de llamadas en ${v.clave}`,
        texto: `Vertical ${v.clave}: ${f0(v.llamadas)} llamadas de ${f1(v.duracionPromedioMin)} min en promedio; margen ${margen === null ? "sin dato" : `${f1(margen)} %`}.`,
        accion: `Revisar el guion de voz de ${v.clave} para acortar las llamadas o ajustar los minutos incluidos del plan.`,
        impactoMxn: v.costoDirectoMxn,
      });
    }
  }

  for (const f of c.economia) {
    const a = alias.get(f.organizationId) ?? "C?";
    const quien = `${a} (${f.vertical}, plan ${f.planNombre ?? "sin plan"})`;
    const m = f.proyeccion.margenMxn ?? f.contribucionMxn;
    const mp = f.proyeccion.margenPct ?? f.contribucionPct;
    if (f.banderas.includes("no_rentable") && m !== null) {
      hechos.push({
        titulo: `${a} no es rentable`,
        texto: `${quien} cierra el mes con margen de ${mxn(m)}${mp === null ? "" : ` (${f1(mp)} %)`}: costo ${mxn(f.proyeccion.costoMxn ?? f.costoDirectoMxn ?? 0)} contra ingreso ${mxn(f.proyeccion.ingresoMxn ?? f.ingresoMxn ?? 0)}.`,
        accion: "Subir el precio o pasarlo a un plan medido con excedente por minuto.",
        impactoMxn: Math.abs(m),
      });
    } else if (f.banderas.includes("margen_bajo") && mp !== null) {
      hechos.push({
        titulo: `${a} con margen bajo`,
        texto: `${quien} tiene margen de ${f1(mp)} %, bajo el umbral de ${f1(c.supuestos.umbralMargenPct.valor)} %.`,
        accion: "Revisar su uso por minuto y su precio en la próxima renovación.",
        impactoMxn: Math.abs((f.ingresoMxn ?? 0) * (c.supuestos.umbralMargenPct.valor - mp)) / 100,
      });
    }
    for (const [pool, nombre, unidad] of [
      [f.poolVoz, "voz", "min"],
      [f.poolWa, "WhatsApp", "conversaciones"],
    ] as const) {
      if (pool && pool.pctProyectado !== null && (f.banderas.includes("sobre_el_tope") || f.banderas.includes("cerca_del_tope")) && pool.pctProyectado >= c.supuestos.umbralPoolPct.valor) {
        hechos.push({
          titulo: `${a} cerca o arriba de lo incluido (${nombre})`,
          texto: `${quien} lleva ${f0(pool.usado)} de ${f0(pool.incluido)} ${unidad} de ${nombre} (${f1(pool.pct ?? 0)} %); proyectado al cierre ${f1(pool.pctProyectado)} %.`,
          accion: "Ofrecerle el siguiente plan antes del cierre o confirmar el cobro del excedente.",
          impactoMxn: f.mrrMxn ?? 0,
        });
      }
    }
    if (f.banderas.includes("pago_fallido")) {
      hechos.push({ titulo: `${a} con pago pendiente`, texto: `${quien} tiene el pago pendiente; MRR en riesgo ${mxn(f.mrrMxn ?? 0)}.`, accion: "Contactar para actualizar el método de pago antes de suspender.", impactoMxn: f.mrrMxn ?? 0 });
    }
    if (f.banderas.includes("pico_costo")) {
      hechos.push({ titulo: `Pico de costo en ${a}`, texto: `${quien} gasta por día más de ${f0(c.supuestos.umbralPicoCostoPct.valor)} % arriba del mes anterior.`, accion: "Revisar si hay un bucle del agente o un uso nuevo que deba cobrarse.", impactoMxn: f.costoDirectoMxn ?? 0 });
    }
  }

  const sinCosto = c.economia.filter((f) => f.costoDirectoMxn === null).length;
  if (sinCosto > 0) hechos.push({ titulo: "Costos sin dato", texto: `${f0(sinCosto)} clientes tienen un costo sin dato (falta un costo unitario o el tipo de cambio).`, accion: "Capturar el costo por minuto del proveedor de voz que falta en Supuestos.", impactoMxn: 0 });

  if (s.fx.disponible && s.fx.exposicionPct !== null) {
    hechos.push({
      titulo: "Exposición al dólar",
      texto: `El ${f1(s.fx.exposicionPct)} % del ingreso se va en costos en dólares; si el dólar sube 10 % el margen baja ${mxn(s.fx.sensibilidad10PctMxn)}${s.fx.movimiento30dPct === null ? "" : `; el tipo de cambio se movió ${f1(s.fx.movimiento30dPct)} % contra el cierre del mes anterior`}.`,
      accion: "Considerar precios con ajuste cambiario en contratos nuevos.",
      impactoMxn: s.fx.sensibilidad10PctMxn,
    });
  }
  if (s.concentracion.top1Pct !== null && s.concentracion.top1Pct >= 30) {
    hechos.push({ titulo: "Concentración de ingreso", texto: `El cliente más grande es el ${f1(s.concentracion.top1Pct)} % del ingreso (top 5: ${f1(s.concentracion.top5Pct ?? 0)} %).`, accion: "Priorizar la venta a clientes nuevos para bajar la dependencia.", impactoMxn: (s.mrrMxn * s.concentracion.top1Pct) / 100 });
  }
  if (s.burn.disponible && s.burn.burnNetoMxn > 0) {
    hechos.push({
      titulo: "Burn del mes",
      texto: `El mes ${s.burn.proyectado ? "proyecta" : "cerró con"} un burn de ${mxn(s.burn.burnNetoMxn)}${s.burn.runwayMeses === null ? " (sin saldo de caja capturado)" : ` y ${f1(s.burn.runwayMeses)} meses de runway`}.`,
      accion: "Revisar gasto fijo y marketing contra el ingreso nuevo del mes.",
      impactoMxn: s.burn.burnNetoMxn,
    });
  }
  if (s.cac.disponible && s.cac.paybackMeses !== null) {
    hechos.push({ titulo: "Payback del CAC", texto: `El CAC es ${mxn(s.cac.cacMxn ?? 0)} y se recupera en ${f1(s.cac.paybackMeses)} meses de contribución.`, accion: "Comparar el payback contra la vida esperada del cliente antes de subir el gasto de marketing.", impactoMxn: s.cac.marketingMxn });
  }
  const ultimo = s.serie.at(-1);
  if (ultimo && ultimo.churnMxn !== null && ultimo.churnMxn > 0) {
    hechos.push({ titulo: "Churn del mes", texto: `Se perdieron ${mxn(ultimo.churnMxn)} de MRR por churn; NRR ${ultimo.nrrPct === null ? "sin dato" : `${f1(ultimo.nrrPct)} %`}.`, accion: "Llamar a los clientes que se fueron para entender por qué.", impactoMxn: ultimo.churnMxn });
  }

  return hechos
    .sort((a, b) => b.impactoMxn - a.impactoMxn)
    .slice(0, MAX_HECHOS)
    .map((h, i) => ({ ...h, id: `h${i + 1}` }));
}

/** Respaldo determinista: una recomendacion por hecho, priorizada por pesos en juego. */
export function recomendacionesPorReglas(hechos: readonly Hecho[]): readonly Recomendacion[] {
  return hechos.slice(0, MAX_RECOMENDACIONES).map((h, i) => ({ titulo: h.titulo, explicacion: h.texto, accion: h.accion, prioridad: Math.min(5, i + 1), hechos: [h.id] }));
}

const NUMERO_RE = /\d[\d,]*(?:\.\d+)?/gu;
const normalizar = (n: string) => n.replace(/,/gu, "");

/** Toda cifra del texto debe estar en los hechos citados (los alias C1.. y los ids h1.. no cuentan como cifras). */
export function citaSoloCifrasDeHechos(texto: string, hechos: readonly Hecho[]): boolean {
  const permitidas = new Set<string>();
  for (const h of hechos) for (const m of h.texto.matchAll(NUMERO_RE)) permitidas.add(normalizar(m[0]));
  const limpio = texto.replace(/\b[Ch]\d+\b/gu, "");
  for (const m of limpio.matchAll(NUMERO_RE)) if (!permitidas.has(normalizar(m[0]))) return false;
  return true;
}

const SYSTEM = [
  "Eres el CFO de una plataforma SaaS B2B mexicana. Recibes HECHOS ya calculados (con sus cifras) sobre ingresos, costos, márgenes y uso.",
  "Tu trabajo: explicar y priorizar. Devuelve como máximo 6 recomendaciones, de la más a la menos urgente.",
  "Reglas estrictas: usa SOLO las cifras que aparecen literalmente en los hechos que citas; no calcules cifras nuevas ni redondees distinto; cita los ids de los hechos en `hechos`;",
  "refiérete a los clientes solo por su alias (C1, C2...); escribe en español de México, directo y breve (título de máximo 80 caracteres, explicación y acción de máximo 300 caracteres cada una).",
].join(" ");

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recomendaciones"],
  properties: {
    recomendaciones: {
      type: "array",
      maxItems: MAX_RECOMENDACIONES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["titulo", "explicacion", "accion", "prioridad", "hechos"],
        properties: {
          titulo: { type: "string" },
          explicacion: { type: "string" },
          accion: { type: "string" },
          prioridad: { type: "integer", minimum: 1, maximum: 5 },
          hechos: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
        },
      },
    },
  },
} as const;

function conNombres(texto: string, c: Cockpit): string {
  const alias = aliasDeClientes(c);
  const porAlias = new Map([...alias.entries()].map(([id, a]) => [a, c.economia.find((f) => f.organizationId === id)?.nombre ?? a]));
  return texto.replace(/\bC\d+\b/gu, (a) => porAlias.get(a) ?? a);
}

export async function generarRecomendaciones(c: Cockpit, gateway: LlmGateway | undefined, timeoutMs = RECOMENDACIONES_CFO_TIMEOUT_MS): Promise<ResultadoRecomendaciones> {
  const hechos = hechosDelCockpit(c);
  const visibles = hechos.map((h) => ({ id: h.id, texto: conNombres(h.texto, c) }));
  const reglas = (descartadas: number): ResultadoRecomendaciones => ({
    fuente: "reglas",
    modelo: null,
    costoUsd: null,
    recomendaciones: recomendacionesPorReglas(hechos).map((r) => ({ ...r, titulo: conNombres(r.titulo, c), explicacion: conNombres(r.explicacion, c) })),
    hechos: visibles,
    descartadas,
  });
  if (!gateway || hechos.length === 0) return reglas(0);

  const controller = new AbortController();
  const reloj = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const llamada = gateway.complete({
      tenantId: RECOMENDACIONES_CFO_TENANT_ID,
      runId: `cfo-recomendaciones:${c.mes}`,
      lane: "background",
      role: RECOMENDACIONES_CFO_LLM_ROLE,
      request: {
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ mes: c.mes, hechos: hechos.map((h) => ({ id: h.id, texto: h.texto })) }) }],
        maxOutputTokens: 1500,
        temperature: 0.2,
        responseFormat: { name: "recomendaciones_cfo", schema: ESQUEMA as unknown as Record<string, unknown> },
        signal: controller.signal,
      },
    });
    const r = await Promise.race([llamada, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    const crudo = JSON.parse(r.text) as { recomendaciones?: unknown };
    const lista = Array.isArray(crudo.recomendaciones) ? crudo.recomendaciones : [];
    const porId = new Map(hechos.map((h) => [h.id, h]));
    let descartadas = 0;
    const validas: Recomendacion[] = [];
    for (const x of lista.slice(0, MAX_RECOMENDACIONES)) {
      const o = x as Partial<Recomendacion>;
      const ids = Array.isArray(o.hechos) ? o.hechos.filter((id): id is string => typeof id === "string" && porId.has(id)) : [];
      const textos = [o.titulo, o.explicacion, o.accion];
      if (ids.length === 0 || textos.some((t) => typeof t !== "string" || t.trim() === "" || t.length > 400)) {
        descartadas += 1;
        continue;
      }
      const citados = ids.map((id) => porId.get(id)!);
      if (!textos.every((t) => citaSoloCifrasDeHechos(t as string, citados))) {
        descartadas += 1;
        continue;
      }
      const prioridad = typeof o.prioridad === "number" && Number.isInteger(o.prioridad) ? Math.min(5, Math.max(1, o.prioridad)) : 3;
      validas.push({ titulo: conNombres((o.titulo as string).trim(), c), explicacion: conNombres((o.explicacion as string).trim(), c), accion: conNombres((o.accion as string).trim(), c), prioridad, hechos: ids });
    }
    if (validas.length === 0) return reglas(descartadas);
    validas.sort((a, b) => a.prioridad - b.prioridad);
    return { fuente: "modelo", modelo: r.model, costoUsd: r.costUsd, recomendaciones: validas, hechos: visibles, descartadas };
  } catch {
    return reglas(0);
  } finally {
    clearTimeout(reloj);
  }
}
