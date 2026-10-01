// CONGELADOR de la respuesta esperada. Para cada caso ejecuta la(s) herramienta(s) de REFERENCIA con el MISMO motor de
// produccion (runDataChatTurn con un modelo guionado que emite exactamente las llamadas esperadas) contra la base
// Postgres sembrada, bajo RLS del usuario del alcance, y guarda: estado esperado, cifras (leidas de los resultados,
// nunca escritas a mano), etiquetas de periodo y los resultados completos (para la repeticion sin base).
//
// Uso (siempre contra la base efimera ya sembrada):
//   scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/congelar.ts            # reescribe datos/*.congelado.json
//   scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/congelar.ts -- --check # falla si algo cambio (drift)
//   ... -- --vertical=citas                                                                  # solo una vertical
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedCompletion, type ScriptStep } from "@atiende/agent-core/data-chat";
import { correrTurno, type ArchivoCongelado, type CasoEval, type ReferenciaLlamada } from "@atiende/agent-core/data-chat/evals";
import { abrirMotor, AHORA_EVAL, VERTICALES_EVAL, ZONA_EVAL, alcanceDe, mundoPostgres, type VerticalEval } from "./mundos.ts";
import { estadoPorOmision, historialDe, resolverCifra, riesgoPorOmision, type CasoFuente } from "./fuente.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const DIR_DATOS = path.join(AQUI, "datos");

export function rutaCongelado(v: string): string {
  return path.join(DIR_DATOS, `${v}.congelado.json`);
}

export async function cargarFuente(v: VerticalEval): Promise<readonly CasoFuente[]> {
  const mod = (await import(`./casos/${v}.ts`)) as { casos: readonly CasoFuente[] };
  return mod.casos;
}

function guionDe(c: CasoFuente): ScriptStep[] {
  const llamadas = c.llama ?? [];
  if (llamadas.length > 0) {
    return [{ toolCalls: llamadas.map((l) => ({ name: l.tool, argumentsJson: JSON.stringify(l.args) })) }, { text: "" }];
  }
  return [{ text: estadoPorOmision(c) === "clarify" ? "¿De qué periodo quieres saberlo?" : "Eso no está cubierto por mis consultas." }];
}

export async function congelarVertical(v: VerticalEval, engine: ReturnType<typeof abrirMotor>): Promise<ArchivoCongelado> {
  const fuente = await cargarFuente(v);
  const ids = new Set<string>();
  for (const c of fuente) {
    if (ids.has(c.id)) throw new Error(`id repetido: ${c.id}`);
    ids.add(c.id);
  }
  const mundo = mundoPostgres(v, engine);
  const { catalog, cerrar } = await mundo.abrir();
  let scopeLine = "";
  try {
    scopeLine = (await catalog.describeScope?.(alcanceDe(v), AbortSignal.timeout(20_000))) ?? "";
  } finally {
    await cerrar();
  }

  const casos: CasoEval[] = [];
  const referencias: Record<string, ReferenciaLlamada[]> = {};
  for (const c of fuente) {
    const base: CasoEval = {
      id: c.id,
      vertical: v,
      categoria: c.cat,
      pregunta: c.q,
      historial: historialDe(c.h),
      riesgo: c.riesgo ?? riesgoPorOmision(c.cat),
      esperado: { status: estadoPorOmision(c), llamadas: [], cifras: [], periodLabels: [], grafica: false, prohibidas: [] },
    };
    const llm = scriptedCompletion(guionDe(c));
    const { salida } = await correrTurno(base, mundo, llm.complete);

    const invalidas = salida.llamadas.filter((l) => l.errorArgs);
    if (invalidas.length > 0) throw new Error(`${c.id}: llamada esperada invalida (${invalidas.map((l) => `${l.name}: ${l.errorArgs}`).join("; ")})`);
    const esperado = estadoPorOmision(c);
    if (salida.status !== esperado) {
      throw new Error(`${c.id}: la referencia dio estado '${salida.status}' y el caso espera '${esperado}' -- ${salida.text.slice(0, 200)}`);
    }
    const cifras = (c.cifras ?? []).flatMap((s) => resolverCifra(s, salida.resultados.map((r) => r.result), c.id));
    const grafica = c.grafica ?? false;
    if (grafica && !salida.blocks.some((b) => b.chart !== undefined)) throw new Error(`${c.id}: se esperaba grafica y la referencia no trae`);

    casos.push({
      ...base,
      esperado: {
        status: salida.status,
        llamadas: c.llama ?? [],
        cifras,
        periodLabels: salida.sources.map((s) => s.periodLabel).filter((p): p is string => typeof p === "string"),
        grafica,
        prohibidas: c.prohibidas ?? [],
      },
    });
    referencias[c.id] = (c.llama ?? []).map((l, i) => ({ tool: l.tool, args: l.args, result: salida.resultados[i]!.result }));
  }
  return { version: 1, vertical: v, now: AHORA_EVAL.toISOString(), timezone: ZONA_EVAL, scopeLine, casos, referencias };
}

export function leerCongelado(v: string): ArchivoCongelado {
  return JSON.parse(readFileSync(rutaCongelado(v), "utf8")) as ArchivoCongelado;
}

export function haCongelado(v: string): boolean {
  return existsSync(rutaCongelado(v));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const check = args.includes("--check");
  const solo = args.find((a) => a.startsWith("--vertical="))?.split("=")[1];
  const url = process.env["COPILOTO_EVAL_DATABASE_URL"];
  if (!url) throw new Error("falta COPILOTO_EVAL_DATABASE_URL: corre esto con scripts/eval-copiloto/run.sh");
  const engine = abrirMotor(url);
  let drift = 0;
  try {
    mkdirSync(DIR_DATOS, { recursive: true });
    for (const v of VERTICALES_EVAL) {
      if (solo && solo !== v) continue;
      const nuevo = JSON.stringify(await congelarVertical(v, engine), null, 1) + "\n";
      const ruta = rutaCongelado(v);
      if (check) {
        const previo = existsSync(ruta) ? readFileSync(ruta, "utf8") : "";
        if (previo !== nuevo) {
          drift += 1;
          console.error(`DRIFT en ${v}: ${path.relative(process.cwd(), ruta)} no coincide con lo que producen los datos sembrados. Corre congelar sin --check y revisa el diff.`);
        } else console.log(`ok ${v}`);
      } else {
        writeFileSync(ruta, nuevo);
        console.log(`congelado ${v}`);
      }
    }
  } finally {
    await engine.stop();
  }
  if (drift > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
