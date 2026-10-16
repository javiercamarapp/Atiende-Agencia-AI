// Juez LLM INDEPENDIENTE (mistralai/mistral-medium-3.1, distinto de todos los modelos evaluados y del cliente simulado) sobre las conversaciones
// que dejo run.ts / texto.ts. Por conversacion decide: (a) naturalidad del español de Mexico y trato de usted (1-5), (b) afirmaciones falsas
// (cifras, promesas o hechos que NINGUNA herramienta respalda), (c) mensaje de falla falso (dice que el sistema fallo cuando no fallo o el pedido si quedo),
// (d) para corridas que reprobaron un grader: si el fallo es del MODELO, del CLIENTE SIMULADO, de un GRADER estricto o ambiguo.
// Uso: OPENROUTER_API_KEY=... npx vite-node scripts/voz-bench/juez.ts <prefijo> [--cap 3] [--conc 4]
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { crearAux, MODELO_JUEZ } from "./llm-aux.ts";

const prefijo = process.argv[2] ?? "v1";
const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const cap = Number(arg("cap", "3"));
const conc = Number(arg("conc", "4"));
const dir = `${process.env.HOME}/atiende-loop/work/voz-bench-resultados`;
const salida = `${dir}/juez-${prefijo}.jsonl`;
const key = process.env.OPENROUTER_API_KEY ?? "";
if (!key) throw new Error("Falta OPENROUTER_API_KEY");

const hechos = new Set<string>();
if (existsSync(salida)) for (const l of readFileSync(salida, "utf8").split("\n").filter(Boolean)) hechos.add((JSON.parse(l) as { clave: string }).clave);
type Reg = Record<string, unknown> & { clave: string; error?: unknown; transcripcion?: { rol: string; texto: string }[]; guion: string; motor: string; modelo: string; etiqueta?: string; rep: number; ok: boolean; fallos?: { grader: string; detalle: string }[]; herramientasDetalle?: { n: string; a: unknown; r: string }[] };
const cola: Reg[] = [];
for (const f of readdirSync(dir)) {
  if (!f.startsWith(prefijo + "-") || !f.endsWith(".jsonl")) continue;
  for (const l of readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Reg;
    if (r.error || !r.transcripcion) continue;
    r.clave = `${r.motor}|${r.modelo}|${r.etiqueta ?? ""}|${r.guion}|${r.rep}`;
    if (!hechos.has(r.clave)) cola.push(r);
  }
}
const REGLAS = `Reglas de Los Taquitos de PM que el agente debe cumplir: trato de usted y español de Mexico natural y breve (llamada telefonica); precios y totales SOLO los que devuelven las herramientas; alcohol y promociones NO a domicilio (solo recoger); pedido minimo de $200 a domicilio; no cobrar propina ni inventar costo de envio u horarios; repetir el pedido (productos, total, forma de pago) y esperar un "si" ANTES de crear el pedido; no decir que el pedido quedo registrado si crear_pedido fallo; no inventar disculpas de "falla del sistema" si todo funciono; pasar a una persona (escalar_a_humano) cuando el cliente la pide, hay queja, pedido grande o zona ambigua.`;
const aux = crearAux(key, MODELO_JUEZ, 500, 0);
let gasto = 0;
const parse = (t: string): Record<string, unknown> | null => {
  const m = /\{[\s\S]*\}/.exec(t);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
};

async function una(r: Reg): Promise<void> {
  const conv = (r.transcripcion as { rol: string; texto: string }[]).map((t) => `${t.rol === "cliente" ? "CLIENTE" : t.rol === "agente" ? "AGENTE" : "SISTEMA"}: ${t.texto}`).join("\n").slice(0, 9000);
  const herr = ((r.herramientasDetalle ?? []) as { n: string; a: unknown; r: string }[]).map((h) => `- ${h.n}(${JSON.stringify(h.a).slice(0, 220)}) => ${h.r.slice(0, 260)}`).join("\n").slice(0, 7000);
  const fallos = ((r.fallos ?? []) as { grader: string; detalle: string }[]).map((f) => `${f.grader}: ${f.detalle}`).join(" | ") || "(ninguno)";
  const sistema = `Usted es un auditor de calidad de agentes de pedidos por telefono/WhatsApp para una taqueria de Merida, Mexico. ${REGLAS}\nResponda SOLO con un objeto JSON con las claves: "naturalidad" (entero 1-5: español de Mexico natural, de usted, breve y sin muletillas robóticas), "afirmaciones_falsas" (true/false: el agente afirmo cifras, precios, totales, tiempos o hechos que no estan en los resultados de herramientas ni dijo el cliente), "afirmaciones_falsas_detalle" (texto corto o ""), "falla_falsa" (true/false: el agente dijo que hubo una falla del sistema/no pudo registrar cuando las herramientas no fallaron o el pedido si quedo registrado), "veredicto_fallo" (solo si hubo graders reprobados: "modelo" si el AGENTE se equivoco, "cliente_simulado" si el cliente simulado dijo algo incoherente o fuera de guion que provoco el fallo, "grader" si el agente actuo correctamente y el grader fue demasiado estricto o mal calculado, "ambiguo"; si no hubo graders reprobados, "ninguno"), "causa" (una frase). Verifique los precios contra los resultados de herramientas antes de acusar al agente.`;
  const user = `Guion/caso: ${r.guion}\nGraders reprobados: ${fallos}\n\nCONVERSACION:\n${conv}\n\nHERRAMIENTAS (nombre(args) => resultado):\n${herr}`;
  let out: Record<string, unknown> | null = null;
  for (let i = 0; i < 2 && !out; i++) {
    try { out = parse(await aux.pedir({ sistema, mensajes: [{ role: "user", content: user }] })); } catch { /* reintento */ }
  }
  if (!out) return; // sin veredicto (p. ej. sin credito): no se registra para poder reintentar
  const costo = aux.acum.costoUsd - gasto;
  gasto = aux.acum.costoUsd;
  appendFileSync(salida, JSON.stringify({ clave: r.clave, motor: r.motor, modelo: r.modelo, etiqueta: r.etiqueta ?? "", guion: r.guion, rep: r.rep, ok: r.ok, juez: out, costoUsd: costo }) + "\n");
}
let i = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < cola.length && aux.acum.costoUsd < cap) await una(cola[i++]!);
}));
console.log(`juez ${prefijo}: ${Math.min(i, cola.length)}/${cola.length} conversaciones, gasto US$${aux.acum.costoUsd.toFixed(3)}`);
