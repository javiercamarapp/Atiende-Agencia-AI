// Banco de voz de Atiende: corre los guiones de la prueba ciega es-MX (packages/domain-restaurantes/src/voz/simulador, el MISMO motor de tools
// y los MISMOS graders que usa produccion) N veces por motor/modelo y guarda un registro JSONL por corrida.
//   Motor A  --motor gemini            Gemini 3.8 Live real (sesion de texto con respuesta de audio nativo; el audio del agente se transcribe).
//   Motor B  --motor cascada --modelo  SOLO la parte LLM + herramientas de la cascada v2 (OpenRouter, streaming, costo real). NO mide STT, TTS, audio ni telefonia.
// Uso (manual, cuesta dinero, nunca en CI):
//   OPENROUTER_API_KEY=... GEMINI_API_KEY=... npx vite-node scripts/voz-bench/run.ts --motor cascada --modelo anthropic/claude-haiku-5.5 --reps 3 --lote lote1 --cap 25
// Las llaves salen SOLO del entorno; nada se imprime ni se guarda.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { crearProveedorGeminiLlamada } from "../../packages/voice-core/src/llamada/gemini-live-sesion.ts";
import { crearProveedorCascadaLlamada } from "../../packages/voice-core/src/llamada/cascada-openrouter.ts";
import { GEMINI_LIVE_MODELO } from "../../packages/voice-core/src/gemini-live-provider.ts";
import { correrGuion } from "../../packages/domain-restaurantes/src/voz/simulador/correr-guion.ts";
import { evaluarLlamada } from "../../packages/domain-restaurantes/src/voz/simulador/graders-voz.ts";
import { GUIONES_ES_MX } from "../../packages/domain-restaurantes/src/voz/simulador/guiones-es-mx.ts";
import { crearMundoVoz } from "../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";
import { instruccionVozPm } from "../../packages/domain-restaurantes/src/voz/simulador/prompt-voz.ts";
import { esperarCalma, instrumentar, latenciasPorTurno, nuevaMedicion } from "./instrumento.ts";
import { crearPuertoBench } from "./puerto-llm.ts";
import { crearAux, MODELO_CLIENTE } from "./llm-aux.ts";
import { ajustarFallos } from "./ajuste-graders.ts";
import { correrGuionAdaptativo } from "./voz-adaptativo.ts";

// RELOJ CONGELADO en "lunes 18:30" (America/Merida), la misma hora que el prompt del agente. El servidor valida horarios y "recoger en N minutos" con
// Date.now(): sin esto los guiones de recoger dependen de la hora real en que corre el banco (a las 22-23 h reprueban a todos los modelos por igual).
// --reloj-real lo desactiva.
const RELOJ_FIJO = process.argv.includes("--reloj-real") ? null : Date.UTC(2026, 9, 13, 0, 30);
if (RELOJ_FIJO !== null) {
  const RealDate = Date;
  class DateFija extends RealDate {
    constructor(...a: unknown[]) {
      super(...((a.length === 0 ? [RELOJ_FIJO] : a) as [number]));
    }
    static override now(): number {
      return RELOJ_FIJO as number;
    }
  }
  globalThis.Date = DateFija as unknown as DateConstructor;
}

function arg(nombre: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const motor = arg("motor") as "gemini" | "cascada";
const modelo = arg("modelo") ?? (motor === "gemini" ? process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODELO : "");
const razon = arg("razon") as "none" | "minimal" | "low" | "medium" | "high" | undefined;
const reps = Number(arg("reps", "3"));
const lote = arg("lote", "lote1")!;
const cap = Number(arg("cap", "25"));
const conc = Number(arg("conc", "2"));
const sinParalelo = process.argv.includes("--sin-paralelo");
const cacheAnthropic = process.argv.includes("--cache");
const maxTok = arg("min-max-tokens") ? Number(arg("min-max-tokens")) : undefined;
const etiqueta = arg("etiqueta") ?? "";
const clienteModo = arg("cliente", "adaptativo") as "adaptativo" | "guionado";
const filtro = arg("guiones")?.split(",").map((s) => s.trim()).filter(Boolean);
const salida = arg("out", `${process.env.HOME}/atiende-loop/work/voz-bench-resultados/${lote}.jsonl`)!;
const topeMotor = Number(arg("tope-corrida", motor === "gemini" ? "0.6" : "0.08"));
if (motor !== "gemini" && motor !== "cascada") throw new Error("--motor gemini|cascada");
if (motor === "cascada" && !modelo) throw new Error("--modelo requerido para la cascada");
const apiKeyOr = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKeyOr) throw new Error("Falta OPENROUTER_API_KEY (cliente simulado)");
const apiKeyG = process.env.GEMINI_API_KEY ?? "";
if (motor === "cascada" && !apiKeyOr) throw new Error("Falta OPENROUTER_API_KEY");
if (motor === "gemini" && !apiKeyG) throw new Error("Falta GEMINI_API_KEY");
mkdirSync(dirname(salida), { recursive: true });

// Gasto acumulado del lote = suma de TODAS las corridas del archivo (todos los motores). Tope DURO.
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

const mundoRef = crearMundoVoz();
const branches = [
  { propertyId: mundoRef.propertyId, slug: "fco-montejo", name: "Francisco de Montejo", address: null },
  { propertyId: "altabrisa", slug: "altabrisa", name: "Altabrisa", address: null },
];
const instruccion = instruccionVozPm(branches, "lunes 18:30", "lunes", "fco-montejo");
const guiones = GUIONES_ES_MX.filter((g) => !g.soloFalso && (!filtro || filtro.some((f) => g.id.startsWith(f))));

const ttsFalso: typeof fetch = async () => new Response(new Uint8Array(0), { status: 200 });
const limpiar = (s: string) => s.replace(/key=[^&\s]+/g, "key=***").replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/AIza[0-9A-Za-z_-]+/g, "AIza***").slice(0, 200);

let gasto = gastoLote();
let enVuelo = 0;
let cortado = false;
const trabajos: { g: (typeof guiones)[number]; rep: number }[] = [];
for (let r = 1; r <= reps; r++) for (const g of guiones) trabajos.push({ g, rep: r });
const yaHechos = new Set<string>();
if (existsSync(salida)) for (const l of readFileSync(salida, "utf8").split("\n").filter(Boolean)) {
  const x = JSON.parse(l) as { motor: string; modelo: string; razon: string | null; etiqueta?: string; guion: string; rep: number; error?: string };
  if (!(x as { error?: string }).error) yaHechos.add(`${x.motor}|${x.modelo}|${x.razon ?? ""}|${x.etiqueta ?? ""}|${x.guion}|${x.rep}`);
}

async function una(g: (typeof guiones)[number], rep: number): Promise<void> {
  const clave = `${motor}|${modelo}|${razon ?? ""}|${etiqueta}|${g.id}|${rep}`;
  if (yaHechos.has(clave)) return;
  const m = nuevaMedicion();
  const t0 = performance.now();
  const aux = crearAux(apiKeyOr, MODELO_CLIENTE);
  let ok = false;
  let fallos: { grader: string; detalle: string }[] = [];
  let fallosBrutos: { grader: string; detalle: string }[] = [];
  let ajustes: string[] = [];
  let error: string | undefined;
  let resultado = "";
  let tools: { nombre: string; args: unknown; resultado: unknown }[] = [];
  const chars = { agente: 0, cliente: 0 };
  let sistema = "";
  let turnosVozR: number | undefined;
  let transcripcion: { rol: string; texto: string }[] = [];
  try {
    const fabrica = () => {
      const base =
        motor === "gemini"
          ? crearProveedorGeminiLlamada({ apiKey: apiKeyG, model: modelo })
          : crearProveedorCascadaLlamada({ apiKey: "bench", llm: crearPuertoBench({ apiKey: apiKeyOr, modelo, ...(razon ? { razonamiento: razon } : {}), ...(sinParalelo ? { sinParalelo: true } : {}), ...(cacheAnthropic ? { cacheAnthropic: true } : {}), ...(maxTok ? { minMaxTokens: maxTok, maxTokens: maxTok } : {}) }, m), fetchFn: ttsFalso });
      return instrumentar(base, m);
    };
    const llamada =
      clienteModo === "adaptativo"
        ? await correrGuionAdaptativo(g, { instruccion, voiceId: "Kore", proveedor: fabrica, pedirCliente: aux.pedir, ...(motor === "gemini" ? { estabilizar: () => esperarCalma(m) } : {}) })
        : await correrGuion(g, { instruccion, voiceId: "Kore", proveedor: fabrica });
    const graders = await evaluarLlamada(llamada);
    fallosBrutos = graders.filter((x) => !x.ok).map((x) => ({ grader: x.grader, detalle: limpiar(x.detalle) }));
    const adj = ajustarFallos(fallosBrutos, llamada.transcripcion.filter((t) => t.rol === "cliente").map((t) => t.texto), false);
    fallos = adj.fallos;
    ajustes = adj.ajustes;
    ok = fallos.length === 0;
    resultado = String(llamada.resultado);
    turnosVozR = (llamada as { turnosVoz?: number }).turnosVoz;
    tools = llamada.tools.map((t) => ({ nombre: t.nombre, args: t.args, resultado: t.resultado }));
    for (const t of llamada.transcripcion) if (t.rol === "agente") chars.agente += t.texto.length; else if (t.rol === "cliente") chars.cliente += t.texto.length;
    transcripcion = llamada.transcripcion.map((t) => ({ rol: t.rol, texto: t.texto.slice(0, 2500) }));
    sistema = llamada.transcripcion.filter((t) => t.rol === "agente").map((t) => t.texto).join("").slice(0, 0);
  } catch (e) {
    error = limpiar(e instanceof Error ? e.message : "error");
  }
  if (!error && m.caidas.some((c) => c.startsWith("llm:"))) error = `infra: ${m.caidas.find((c) => c.startsWith("llm:"))}`;
  const durMs = performance.now() - t0;
  const costoModeloUsd = motor === "gemini" ? m.costoMicro / 1e6 : m.llamadasLlm.reduce((s, l) => s + l.costoUsd, 0);
  const costoClienteUsd = aux.acum.costoUsd;
  const costoUsd = costoModeloUsd + costoClienteUsd;
  const rechazadas = tools.filter((t) => t.resultado && typeof t.resultado === "object" && "error" in (t.resultado as object)).map((t) => t.nombre);
  const rec = {
    lote, motor, modelo, razon: razon ?? null, etiqueta, sinParalelo, reloj: RELOJ_FIJO !== null, guion: g.id, rep, ok, fallos, fallosBrutos, ajustes, error, resultado, turnosVoz: (typeof turnosVozR === 'number' ? turnosVozR : null), durMs: Math.round(durMs), costoUsd, costoModeloUsd, costoClienteUsd, cliente: clienteModo,
    costoRealPct: motor === "gemini" ? (m.costoMicro > 0 ? m.costoRealMicro / m.costoMicro : 0) : 1,
    tokens: { in: m.llamadasLlm.reduce((s, l) => s + l.tokensIn, 0), out: m.llamadasLlm.reduce((s, l) => s + l.tokensOut, 0), cached: m.llamadasLlm.reduce((s, l) => s + l.tokensCached, 0), razonamiento: m.llamadasLlm.reduce((s, l) => s + l.tokensReasoning, 0), llamadasLlm: m.llamadasLlm.length },
    llmTools: m.llamadasLlm.map((l) => l.detalleTools ?? []),
    llmDetalle: m.llamadasLlm.map((l) => ({ in: l.tokensIn, out: l.tokensOut, cached: l.tokensCached, razon: l.tokensReasoning, ttft: l.ttftMs ?? null, ms: l.totalMs ?? null, usd: l.costoUsd })),
    cacheAnthropic, minMaxTokens: maxTok ?? 1500,
    modelosAtendieron: [...new Set(m.llamadasLlm.map((l) => l.modelo))],
    latencias: latenciasPorTurno(m).map((l) => ({ p: l.primeroMs === null ? null : Math.round(l.primeroMs), c: l.completoMs === null ? null : Math.round(l.completoMs) })),
    tools: tools.map((t) => t.nombre), rechazadas, chars, caidas: m.caidas, transcripcion, herramientasDetalle: tools.map((t) => ({ n: t.nombre, a: t.args, r: JSON.stringify(t.resultado ?? null).slice(0, 400) })), ts: new Date().toISOString(),
  };
  void sistema;
  appendFileSync(salida, JSON.stringify(rec) + "\n");
  gasto += costoUsd;
  console.log(`${ok ? "OK   " : "FALLA"} ${motor}:${modelo} ${g.id} #${rep} $${costoUsd.toFixed(4)} ${error ?? fallos.map((f) => f.grader).join(",")} | lote $${gasto.toFixed(3)}/${cap}`);
}

async function pool(): Promise<void> {
  while (trabajos.length > 0 && !cortado) {
    // Tope duro: el gasto real ya registrado + lo que puede costar lo que esta en vuelo + esta corrida no pasa del tope.
    if (gasto + (enVuelo + 1) * topeMotor > cap) {
      if (enVuelo === 0) {
        cortado = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    gasto = gastoLote();
    if (gasto + (enVuelo + 1) * topeMotor > cap) continue;
    const t = trabajos.shift()!;
    enVuelo += 1;
    try {
      await una(t.g, t.rep);
    } finally {
      enVuelo -= 1;
    }
  }
}
await Promise.all(Array.from({ length: conc }, pool));
console.log(`FIN ${motor}:${modelo} gasto lote $${gasto.toFixed(4)} (tope ${cap})${cortado ? " CORTADO POR TOPE; pendientes " + trabajos.length : ""}`);
