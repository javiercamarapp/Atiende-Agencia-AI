// Herramienta de AUTORIA: ejecuta llamadas de referencia contra la base sembrada y las imprime (estado, periodo, columnas y
// filas) para saber que datos existen antes de escribir casos. No escribe nada.
// Uso: scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/explorar.ts -- restaurantes '[["ventas_por_dia",{"periodo":"ayer"}]]'
import { scriptedCompletion } from "@atiende/agent-core/data-chat";
import { correrTurno, type CasoEval } from "@atiende/agent-core/data-chat/evals";
import { abrirMotor, mundoPostgres, esVertical } from "./mundos.ts";

const [vertical, json] = process.argv.slice(2).filter((a) => a !== "--");
if (!vertical || !esVertical(vertical) || !json) throw new Error("uso: explorar.ts <vertical> '<[[tool,{args}],...]>'");
const url = process.env["COPILOTO_EVAL_DATABASE_URL"];
if (!url) throw new Error("falta COPILOTO_EVAL_DATABASE_URL (usa run.sh)");
const engine = abrirMotor(url);
try {
  const mundo = mundoPostgres(vertical, engine);
  const llamadas = JSON.parse(json) as [string, Record<string, string | number>][];
  for (const [tool, args] of llamadas) {
    const caso = { id: "x", vertical, categoria: "directa", pregunta: "explorar", historial: [], riesgo: "bajo", esperado: { status: "ok", llamadas: [], cifras: [], periodLabels: [], grafica: false, prohibidas: [] } } as CasoEval;
    const llm = scriptedCompletion([{ toolCalls: [{ name: tool, argumentsJson: JSON.stringify(args) }] }, { text: "" }]);
    const { salida } = await correrTurno(caso, mundo, llm.complete);
    const r = salida.resultados[0]?.result;
    console.log(`\n### ${tool} ${JSON.stringify(args)} -> ${salida.status}${r ? ` | ${r.status} | ${r.periodLabel ?? "-"} | ${r.scopeLabel}` : " | (sin resultado) " + salida.text.slice(0, 160)}`);
    if (r) {
      console.log(`   cols: ${r.columns.map((c) => `${c.key}:${c.kind}`).join(", ")}`);
      console.log(`   summary: ${r.summary ?? "-"}`);
      for (const row of r.rows.slice(0, 8)) console.log(`   ${JSON.stringify(row)}`);
      if (r.rows.length > 8) console.log(`   ... ${r.rows.length} filas`);
    }
  }
} finally {
  await engine.stop();
}
