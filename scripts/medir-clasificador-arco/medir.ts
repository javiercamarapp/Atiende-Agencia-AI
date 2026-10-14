// Medicion UNICA del detector ARCO hibrido (regex + clasificador LLM REAL) contra los corpus de aceptacion. NO corre en CI (gasta tokens): se corre a mano,
// con la llave de OpenRouter en el ENTORNO (nunca se imprime ni se guarda):
//   set -a; . ~/atiende-loop/.env.voz-bench; set +a
//   npx vite-node scripts/medir-clasificador-arco/medir.ts -- --modelo openai/gpt-6-luna --salida docs/ARCO-CLASIFICADOR-MEDICION.json
// Imprime recall y falsos positivos por corpus, la mezcla regex/modelo, tokens, costo por mensaje y latencia. Tope duro de gasto: --tope-usd (3 por omision).
import { writeFileSync } from "node:fs";
import { crearClasificadorArco, debeClasificarArco, intencionesPorMensaje } from "../../packages/domain-restaurantes/src/privacidad/index.ts";
import type { CompletarJson, EventoClasificador } from "../../packages/domain-restaurantes/src/privacidad/index.ts";
import { CORPUS_545 as DEV, RAFAGAS_545 as RAFAGAS_DEV } from "../../packages/domain-restaurantes/tests/arco-corpus-545-dev.ts";
import { CORPUS_545 as CIEGO, RAFAGAS_545 as RAFAGAS_CIEGO } from "../../packages/domain-restaurantes/tests/arco-corpus-545-ciego.ts";
import { CORPUS as C533 } from "../../packages/domain-restaurantes/tests/arco-corpus-revisor.ts";
import { CORPUS_PROPIO } from "../../packages/domain-restaurantes/tests/arco-corpus-propio.ts";

const arg = (n: string, d: string): string => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const MODELO = arg("modelo", "openai/gpt-6-luna");
const TOPE_USD = Number(arg("tope-usd", "3"));
const SALIDA = arg("salida", "");
const SOLO_REGEX = process.argv.includes("--solo-regex");
const KEY = process.env.OPENROUTER_API_KEY;
if (!SOLO_REGEX && !KEY) throw new Error("falta OPENROUTER_API_KEY en el entorno");

let gastado = 0;
const eventos: EventoClasificador[] = [];
const completar: CompletarJson = async (e) => {
  if (gastado >= TOPE_USD) throw new Error("tope de gasto de la medicion alcanzado");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: e.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODELO,
      messages: [{ role: "system", content: e.system }, { role: "user", content: e.user }],
      max_tokens: 1500,
      reasoning: { effort: "low" },
      usage: { include: true },
      response_format: { type: "json_schema", json_schema: { name: e.schemaName, strict: true, schema: e.schema } },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const j = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  gastado += j.usage?.cost ?? 0;
  return { text: j.choices?.[0]?.message?.content ?? "", ...(j.model ? { model: j.model } : {}), ...(j.usage?.prompt_tokens !== undefined ? { tokensIn: j.usage.prompt_tokens } : {}), ...(j.usage?.completion_tokens !== undefined ? { tokensOut: j.usage.completion_tokens } : {}), ...(j.usage?.cost !== undefined ? { costUsd: j.usage.cost } : {}) };
};
// El timeout de PRODUCCION es 2 s; en la medicion se sube a 15 s para medir la CALIDAD del modelo y la latencia real por separado (se reporta p50/p95 y cuantas pasarian de 2 s).
const clasificador = crearClasificadorArco({ completar, timeoutMs: 15_000, topeDiarioPorOrganizacion: 100_000, alFinalizar: (e) => eventos.push(e) });

async function enLotes<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } }));
  return out;
}

type Fila = readonly [string, string];
async function medirCorpus(nombre: string, corpus: readonly Fila[]) {
  const det = await enLotes(corpus, 6, async ([t]) => {
    const solo = await intencionesPorMensaje([t], undefined, "org");
    const hib = SOLO_REGEX ? solo : await intencionesPorMensaje([t], clasificador, "org");
    const fuerte = (xs: typeof solo) => xs.some((x) => x.intent.kind === "request" || (x.intent.kind === "menu" && x.intent.fuerza === "fuerte"));
    return { t, regex: solo.length > 0, regexFuerte: fuerte(solo), hib: hib.length > 0, hibFuerte: fuerte(hib) };
  });
  let p = 0, n = 0, fnR = 0, fnH = 0, fpR = 0, fpH = 0, fpHF = 0, regFnH = 0;
  const fnLista: string[] = [], fpLista: string[] = [];
  corpus.forEach(([t, e], i) => {
    const d = det[i]!;
    if (e === "P") { p++; if (!d.regex) fnR++; if (!d.hib) { fnH++; fnLista.push(t); } if (!d.hibFuerte) regFnH++; }
    if (e === "N") { n++; if (d.regex) fpR++; if (d.hib) { fpH++; fpLista.push(t); } if (d.hibFuerte) fpHF++; }
  });
  const r = { corpus: nombre, P: p, N: n, recallRegex: 1 - fnR / p, recallHibrido: 1 - fnH / p, fpRegex: fpR, fpHibrido: fpH, fpHibridoFuertes: fpHF, pSoloDebilHibrido: regFnH - fnH };
  console.log(JSON.stringify(r));
  return { ...r, fn: nombre.includes("ciego") ? fnLista.length : fnLista, fp: nombre.includes("ciego") ? fpLista.length : fpLista };
}

const resultados = [];
resultados.push(await medirCorpus("revisor-545-dev", DEV));
resultados.push(await medirCorpus("revisor-545-ciego", CIEGO));
resultados.push(await medirCorpus("revisor-533", C533));
resultados.push(await medirCorpus("propio", CORPUS_PROPIO));

// Rafagas (cada mensaje por separado, como en produccion).
let rOk = 0, rTot = 0;
for (const [msgs, e] of [...RAFAGAS_DEV, ...RAFAGAS_CIEGO]) {
  const hib = SOLO_REGEX ? await intencionesPorMensaje(msgs, undefined, "org") : await intencionesPorMensaje(msgs, clasificador, "org");
  const detectado = hib.length > 0;
  rTot++; if ((e === "P") === detectado) rOk++;
}
console.log(JSON.stringify({ rafagas: `${rOk}/${rTot}` }));

const ok = eventos.filter((e) => e.ok);
const ms = ok.map((e) => e.ms).sort((a, b) => a - b);
const pct = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
const tot = { llamadas: eventos.length, fallas: eventos.length - ok.length, costoUsd: eventos.reduce((s, e) => s + (e.costUsd ?? 0), 0), tokensIn: eventos.reduce((s, e) => s + (e.tokensIn ?? 0), 0), tokensOut: eventos.reduce((s, e) => s + (e.tokensOut ?? 0), 0), p50ms: pct(0.5), p95ms: pct(0.95), masDe2s: ms.filter((x) => x > 2000).length };
const totalMensajes = [...DEV, ...CIEGO, ...C533, ...CORPUS_PROPIO].length;
const pasanPrefiltro = [...DEV, ...CIEGO, ...C533, ...CORPUS_PROPIO].filter(([t]) => debeClasificarArco(t)).length;
const resumen = { modelo: MODELO, ...tot, costoPorLlamadaUsd: tot.llamadas ? tot.costoUsd / tot.llamadas : 0, mensajesEvaluados: totalMensajes, pasanElPrefiltro: pasanPrefiltro, costoPorMensajeEntranteUsd: totalMensajes ? tot.costoUsd / totalMensajes : 0 };
console.log(JSON.stringify(resumen));
if (SALIDA) writeFileSync(SALIDA, JSON.stringify({ resumen, resultados, rafagas: `${rOk}/${rTot}`, fecha: new Date().toISOString().slice(0, 10) }, null, 2));
