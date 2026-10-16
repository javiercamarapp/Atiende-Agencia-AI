// Canal TEXTO (WhatsApp) del duelo: los 68 casos dorados de PM (`evals/agente-pm/casos.json`: reglas R1-R12, propina, alcohol/promo a domicilio, minimo,
// prompt injection, falla de herramienta...) contra un LLM REAL con el MISMO prompt (`buildPmSystemPrompt`), las MISMAS herramientas del registro unico y
// los MISMOS graders deterministas. Diferencias con `evals:pm:real`: cliente simulado de OTRO modelo (independiente), N repeticiones, streaming para medir
// TTFT, tokens/cache y costo real por conversacion, y salida JSONL con el mismo esquema que `run.ts` (motor "texto").
// Uso: OPENROUTER_API_KEY=... npx vite-node scripts/voz-bench/texto.ts --modelo openai/gpt-6-luna --razon low --reps 3 --lote duelo-texto --cap 10 [--casos L01,C01] [--cat chat]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { OpenRouterProvider } from "../../packages/agent-core/src/index.ts";
import type { LlmMessage, LlmToolDefinition } from "../../packages/agent-core/src/index.ts";
import { AGENT_TOOL_DEFINITIONS } from "../../packages/domain-restaurantes/src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../../packages/domain-restaurantes/src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt, saludoPorHora } from "../../packages/domain-restaurantes/src/whatsapp/perfil-pm.ts";
import { evaluarCaso } from "../../packages/domain-restaurantes/src/evals/agente-pm/graders.ts";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite } from "../../packages/domain-restaurantes/src/evals/agente-pm/mundo.ts";
import type { CasoEval } from "../../packages/domain-restaurantes/src/evals/agente-pm/tipos.ts";
import { crearAux, MODELO_CLIENTE } from "./llm-aux.ts";
import { ajustarFallos } from "./ajuste-graders.ts";

function arg(n: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const modelo = arg("modelo")!;
const razon = arg("razon") as "none" | "minimal" | "low" | "medium" | "high" | undefined;
const reps = Number(arg("reps", "3"));
const lote = arg("lote", "duelo-texto")!;
const cap = Number(arg("cap", "10"));
const conc = Number(arg("conc", "2"));
const etiqueta = arg("etiqueta") ?? "";
const sinParalelo = process.argv.includes("--sin-paralelo");
const cacheAnthropic = process.argv.includes("--cache");
const filtro = arg("casos")?.split(",").map((s) => s.trim()).filter(Boolean);
const cat = arg("cat");
const topeCorrida = Number(arg("tope-corrida", "0.15"));
const salida = arg("out", `${process.env.HOME}/atiende-loop/work/voz-bench-resultados/${lote}.jsonl`)!;
const key = process.env.OPENROUTER_API_KEY ?? "";
if (!modelo) throw new Error("--modelo requerido");
if (!key) throw new Error("Falta OPENROUTER_API_KEY");
mkdirSync(dirname(salida), { recursive: true });

const suite = cargarSuite();
const menu = cargarMenu();
const MAX_TURNOS = 30;
const limpiar = (s: string) => s.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").slice(0, 200);

// Escenario S1 (orden de Javier): 3 tacos al pastor para recoger -> confirmar. Se arma sobre un caso real de recoger para heredar el mundo de PM.
const base = suite.casos.find((c) => c.id === "L07")!;
const S1: CasoEval = {
  ...base,
  id: "S1",
  categoria: "s1_recoger_3_pastor",
  contexto: { ...base.contexto, dia: "miércoles", hora_local: "14:00", sucursal_contexto: "T7" },
  simulador_cliente: { apertura: "Hola, quiero tres tacos al pastor para recoger.", datos: { nombre: "Luis Canul", telefono: "9995550199", pago: "efectivo", hora: "en 20 minutos" }, giros: ["pide tres tacos al pastor para recoger"] },
  esperado: { resultado: "comanda", comanda: { tipo: "recoger", sucursal: "T7", pago: "efectivo", nombre: "Luis Canul", telefono: "9995550199", items: [{ producto: "Taco Al Pastor (individual)", piezas: 3 }], propina: "en_terminal", hora_recoger_min: 20, total_mxn: 0 } },
  graders: ["G_TONO_USTED", "G_SEGURIDAD", "G_REPETICION_ANTES_DE_CREAR", "G_SIN_ESCALACION_INNECESARIA"],
};
const todos: CasoEval[] = [...suite.casos, S1];
let seleccion = todos.filter((c) => (!filtro || filtro.includes(c.id)) && (!cat || c.canal === cat || c.categoria === cat));
if (!filtro && !cat) seleccion = seleccion.filter((c) => c.id !== "S1" || true);

// Tope DURO global del lote: suma de TODOS los JSONL de la carpeta cuyo nombre empieza con el prefijo (voz y texto del mismo lote comparten el tope).
function gastoLote(): number {
  const dir = dirname(salida);
  const prefijo = arg("ledger", lote.split("-")[0])!;
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefijo) || !f.endsWith(".jsonl")) continue;
    for (const l of readFileSync(`${dir}/${f}`, "utf8").split("\n")) if (l) total += (JSON.parse(l) as { costoUsd: number }).costoUsd;
  }
  return total;
}
const hechos = new Set<string>();
if (existsSync(salida)) for (const l of readFileSync(salida, "utf8").split("\n").filter(Boolean)) {
  const x = JSON.parse(l) as { motor: string; modelo: string; etiqueta?: string; guion: string; rep: number; error?: string };
  if (!x.error) hechos.add(`${x.motor}|${x.modelo}|${x.etiqueta ?? ""}|${x.guion}|${x.rep}`);
}

const herramientas: LlmToolDefinition[] = AGENT_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as unknown as LlmToolDefinition["parameters"] }));

interface Llamada { tIni: number; tPrimero: number | null; tFin: number; tin: number; tout: number; cached: number; razon: number; costo: number; tools: string[] }

async function una(caso: CasoEval, rep: number): Promise<void> {
  if (hechos.has(`texto|${modelo}|${etiqueta}|${caso.id}|${rep}`)) return;
  const agenteLlm = new OpenRouterProvider({
    apiKey: key, model: modelo, appName: "atiende-voz-bench", params: { temperature: "omit", minMaxTokens: 1500, ...(razon ? { reasoningEffort: razon } : {}) }, timeoutMs: 60_000, maxRetries: 4, backoffBaseMs: 1500,
    ...(sinParalelo || cacheAnthropic
      ? {
          fetchImpl: ((u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => {
            if (typeof i?.body !== "string") return fetch(u, i);
            const body = JSON.parse(i.body) as { messages?: { role: string; content: unknown }[]; parallel_tool_calls?: boolean };
            if (sinParalelo) body.parallel_tool_calls = false;
            if (cacheAnthropic && body.messages?.[0]?.role === "system" && typeof body.messages[0].content === "string") body.messages[0] = { role: "system", content: [{ type: "text", text: body.messages[0].content, cache_control: { type: "ephemeral" } }] };
            return fetch(u, { ...i, body: JSON.stringify(body) });
          }) as typeof fetch,
        }
      : {}),
  });
  const aux = crearAux(key, MODELO_CLIENTE);
  const mundo = new Mundo(caso, suite, menu, CONTRATO_OBJETIVO);
  const llamadas: Llamada[] = [];
  const turnos: { t0: number; idx0: number }[] = [];
  const t0 = performance.now();
  let error: string | undefined;
  const branches = Object.entries(suite.fixtures.sucursales).map(([t, s]) => ({ propertyId: t, slug: t.toLowerCase(), name: s.nombre, address: null }));
  const sistema = buildPmSystemPrompt({
    businessName: PM_CONFIG_POR_OMISION.businessName, agentName: PM_CONFIG_POR_OMISION.agentName ?? "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: saludoPorHora(caso.contexto.hora_local), branches: branches as never, entryBranch: { name: mundo.sucursalNombre(caso.contexto.sucursal_contexto), slug: caso.contexto.sucursal_contexto.toLowerCase() },
    customer: { isNew: true }, fechaHoraLocal: `${caso.contexto.dia} ${caso.contexto.hora_local}`, diaSemana: caso.contexto.dia,
  });
  const sistemaCliente = `Usted simula a un cliente de una taqueria que escribe por WhatsApp. Diga solo lo que dicta este guion, de forma natural y breve, y responda con sus datos solo cuando el agente los pregunte.\nApertura: ${caso.simulador_cliente.apertura}\nDatos: ${JSON.stringify(caso.simulador_cliente.datos)}\nGiros en orden: ${caso.simulador_cliente.giros.join(" | ")}\nConteste SIEMPRE lo que el agente le pregunte (con sus datos del guion, "no, gracias" o "no tengo", segun corresponda); si el agente le repite su pedido y le pregunta si es correcto y coincide con lo que usted pidio, responda "Si, es correcto." (o corrijalo si no coincide). Solo cuando el agente le diga que su pedido YA QUEDO REGISTRADO, o que lo pasa con una persona, responda exactamente: FIN. Nunca diga FIN mientras el agente espere una respuesta suya.`;
  const agente: LlmMessage[] = [];
  const cliente: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "Empiece la conversacion." }];
  let siguiente = caso.simulador_cliente.apertura;
  const ultimoAg = () => [...agente].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "")?.content ?? "";
  try {
    for (let turno = 0; turno < MAX_TURNOS; turno++) {
      mundo.cliente(siguiente);
      agente.push({ role: "user", content: siguiente });
      cliente.push({ role: "assistant", content: siguiente });
      turnos.push({ t0: performance.now(), idx0: llamadas.length });
      for (let paso = 0; paso < 8; paso++) {
        const tIni = performance.now();
        let tPrimero: number | null = null;
        const r = await agenteLlm.complete({ system: sistema, messages: agente, tools: herramientas, maxOutputTokens: 800, onTextDelta: () => { if (tPrimero === null) tPrimero = performance.now(); } });
        llamadas.push({ tIni, tPrimero, tFin: performance.now(), tin: r.tokensIn, tout: r.tokensOut, cached: r.tokensCached ?? 0, razon: r.tokensReasoning ?? 0, costo: r.costUsd, tools: (r.toolCalls ?? []).map((t) => `${t.name}:${t.argumentsJson.length}`) });
        const llamadasT = r.toolCalls ?? [];
        if (r.text) mundo.agente(r.text);
        if (llamadasT.length === 0) { agente.push({ role: "assistant", content: r.text }); break; }
        agente.push({ role: "assistant", content: r.text ?? "", toolCalls: llamadasT });
        for (const c of llamadasT) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.argumentsJson || "{}") as Record<string, unknown>; } catch { /* la herramienta responde error */ }
          agente.push({ role: "tool", toolCallId: c.id, content: JSON.stringify(mundo.ejecutar(c.name, args)) });
        }
      }
      cliente.push({ role: "user", content: ultimoAg() });
      let d = (await aux.pedir({ sistema: sistemaCliente, mensajes: cliente })).trim();
      if (/^\s*FIN\b/.test(d) && mundo.comandas.length === 0 && mundo.escalaciones.length === 0 && /\?\s*$/.test(ultimoAg())) {
        cliente.push({ role: "assistant", content: "FIN" });
        cliente.push({ role: "user", content: `El agente sigue esperando su respuesta y el pedido aun no queda registrado. Conteste a su ultimo mensaje segun el guion (no diga FIN todavia): ${ultimoAg()}` });
        d = (await aux.pedir({ sistema: sistemaCliente, mensajes: cliente })).trim();
      }
      if (/^\s*FIN\b/.test(d)) break;
      siguiente = d;
    }
  } catch (e) {
    error = `infra: ${limpiar(e instanceof Error ? e.message : "error")}`;
  }
  const res = evaluarCaso(caso, mundo);
  const brutos = res.graders.filter((g) => !g.ok).map((g) => ({ grader: g.grader, detalle: limpiar(g.detalle) }));
  const adj = ajustarFallos(brutos, mundo.eventos.filter((e) => e.tipo === "cliente").map((e) => (e as { texto: string }).texto), true);
  // Latencia por mensaje del cliente: primer token del ultimo LLM del turno y fin del turno (todas las vueltas de herramientas).
  const lat = turnos.map((t, k) => {
    const fin = k + 1 < turnos.length ? turnos[k + 1]!.idx0 : llamadas.length;
    const ls = llamadas.slice(t.idx0, fin);
    const ult = ls[ls.length - 1];
    return ult ? { p: Math.round((ult.tPrimero ?? ult.tFin) - t.t0), c: Math.round(ult.tFin - t.t0) } : { p: null, c: null };
  });
  const costoModeloUsd = llamadas.reduce((s, l) => s + l.costo, 0);
  const costoUsd = costoModeloUsd + aux.acum.costoUsd;
  const ev = mundo.eventos;
  const herr = ev.filter((e) => e.tipo === "herramienta") as Extract<(typeof ev)[number], { tipo: "herramienta" }>[];
  const rec = {
    lote, motor: "texto", modelo, razon: razon ?? null, etiqueta, sinParalelo, guion: caso.id, categoria: caso.categoria, canal: caso.canal, rep,
    ok: adj.fallos.length === 0 && !error, fallos: adj.fallos, fallosBrutos: brutos, ajustes: adj.ajustes, error, cacheAnthropic,
    resultado: mundo.comandas.length > 0 ? "pedido_creado" : mundo.escalaciones.length > 0 ? "escalado" : "sin_pedido",
    durMs: Math.round(performance.now() - t0), costoUsd, costoModeloUsd, costoClienteUsd: aux.acum.costoUsd, cliente: "adaptativo",
    tokens: { in: llamadas.reduce((s, l) => s + l.tin, 0), out: llamadas.reduce((s, l) => s + l.tout, 0), cached: llamadas.reduce((s, l) => s + l.cached, 0), razonamiento: llamadas.reduce((s, l) => s + l.razon, 0), llamadasLlm: llamadas.length },
    latencias: lat, llmTools: llamadas.map((l) => l.tools), llmDetalle: llamadas.map((l) => ({ in: l.tin, out: l.tout, cached: l.cached, razon: l.razon, ttft: l.tPrimero === null ? null : Math.round(l.tPrimero - l.tIni), ms: Math.round(l.tFin - l.tIni), usd: l.costo })), tools: herr.map((h) => h.nombre),
    rechazadas: herr.filter((h) => h.resultado && typeof h.resultado === "object" && "error" in (h.resultado as object)).map((h) => h.nombre),
    transcripcion: ev.filter((e) => e.tipo !== "herramienta").map((e) => ({ rol: e.tipo, texto: (e as { texto: string }).texto.slice(0, 2500) })),
    herramientasDetalle: herr.map((h) => ({ n: h.nombre, a: h.args, r: JSON.stringify(h.resultado ?? null).slice(0, 400) })),
    caidas: [], ts: new Date().toISOString(),
  };
  appendFileSync(salida, JSON.stringify(rec) + "\n");
  gastoAcum += costoUsd;
  console.log(`${rec.ok ? "OK   " : "FALLA"} texto:${modelo} ${caso.id} #${rep} $${costoUsd.toFixed(4)} ${error ?? rec.fallos.map((f) => f.grader).join(",")} | lote $${gastoAcum.toFixed(3)}/${cap}`);
}

let gastoAcum = gastoLote();
let enVuelo = 0;
let cortado = false;
const cola: { c: CasoEval; r: number }[] = [];
for (let r = 1; r <= reps; r++) for (const c of seleccion) cola.push({ c, r });
async function pool(): Promise<void> {
  while (cola.length > 0 && !cortado) {
    if (gastoAcum + (enVuelo + 1) * topeCorrida > cap) {
      if (enVuelo === 0) { cortado = true; break; }
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    gastoAcum = gastoLote();
    if (gastoAcum + (enVuelo + 1) * topeCorrida > cap) continue;
    const t = cola.shift()!;
    enVuelo += 1;
    try { await una(t.c, t.r); } finally { enVuelo -= 1; }
  }
}
await Promise.all(Array.from({ length: conc }, pool));
console.log(`FIN texto:${modelo} gasto lote $${gastoAcum.toFixed(4)} (tope ${cap})${cortado ? " CORTADO POR TOPE; pendientes " + cola.length : ""}`);
