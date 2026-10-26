/* eslint-disable @typescript-eslint/no-explicit-any -- script de medicion: las dependencias del directorio de QA se importan dinamicamente y no tienen tipos */
// Arnes de voz con MODELO REAL y cliente por TEXTO (sin audio ni telefonia). Mide el acierto del agente de voz de la taqueria PM como el arnes de WhatsApp.
//
// Lo que es REAL: la instruccion de la llamada (la arma el servidor: POST /internal/restaurantes/voz/llamada/contexto), el controlador de llamada con su maquina de estados,
// la sesion de la cascada v2 (`crearProveedorCascadaV2`: bucle modelo -> herramienta -> modelo, regla confirmar -> crear, recorte, frases), el MISMO puerto LLM del worker
// (`crearPuertoLlmVozV2`: Sonnet 5.5 esfuerzo bajo con retencion cero por OpenRouter), las herramientas por HTTP contra la API real local y el Postgres efimero.
// Lo que es SIMULADO: el cliente (LLM barato con guion) y su STT (`ruido-stt.ts`: cifras, confusiones, muletillas), el TTS (silencio proporcional) y la telefonia.
// Gemini Live (escalon 1 de produccion) NO se usa: ver README.md para el equivalente y sus limites.
//
// Seguridad: aborta si el directorio de QA esta fuera del repo, si la API/base no son locales o el Meta no es el simulado, o si VOZ_CORTE_USD es invalido (ver guardas.ts).
// Uso (desde el directorio de QA con stack.ts / lib.ts / llm.ts y la API local):
//   VOZ_QA_DIR=<dir de QA> OPENROUTER_API_KEY=... VOZ_REP=1 [VOZ_CORTE_USD=1.5] [VOZ_FILTRO=^P0] [VOZ_MODELO=<id>] vite-node -c vite-node.config.ts ejecutar.ts
// Sale con codigo 3 si se corto por el tope de gasto de la corrida (quedan escenarios pendientes: volver a lanzar con el mismo VOZ_REP continua donde se quedo).
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATOS_POR_OMISION, ESCENARIOS, RELOJES } from "./escenarios.ts";
import type { Chk, Escenario, Evento } from "./escenarios.ts";
import { cortarMensaje, rngDesdeSemilla, ruidoStt } from "./ruido-stt.ts";
import { TopeExcedido, dirQaDentroDelRepo, elegirTelefonoLibre, esTelefonoFicticio, excedeTope, gastoPropioUsd, parseCorte, redactar, sumarCosto, validarAislamiento, validarEntorno } from "./guardas.ts";

// Aislamiento: el directorio de QA (de donde se CARGA codigo) debe estar dentro del repo/worktree; ver guardas.ts.
const QA = dirQaDentroDelRepo(process.env.VOZ_QA_DIR, fileURLToPath(new URL("../../", import.meta.url)));
const { startStack, setClock, PROP } = await import(`${QA}/stack.ts`);
const { chat, usoRealOpenRouter, gasto } = await import(`${QA}/llm.ts`);
const { nextClientMsg } = await import(`${QA}/lib.ts`);
const { motivoPrecioInvalido } = await import(`${QA}/inv-precio.ts`);
const P = new URL("../../packages", import.meta.url).pathname;
const { ControladorLlamada } = await import(`${P}/voice-core/src/llamada/controlador.ts`);
const { LIMITES_POR_DEFECTO } = await import(`${P}/voice-core/src/llamada/maquina.ts`);
const { crearEjecutorTools } = await import(`${P}/voice-core/src/llamada/ejecutor-tools.ts`);
const { extraerTelefonoSipFrom } = await import(`${P}/voice-core/src/llamada/sip.ts`);
const { crearProveedorCascadaV2 } = await import(`${P}/voice-core/src/llamada/cascada-v2/index.ts`);
const { VOZ_PLATAFORMA } = await import(`${P}/voice-core/src/config-plataforma.ts`);
const { crearPuertoLlmVozV2 } = await import(`${P}/../apps/voice-worker/src/llm-openrouter.ts`);
const { REGISTRO_TOOLS_PM, HERRAMIENTAS_VOZ_SOLO_LECTURA } = await import(`${P}/domain-restaurantes/src/voz/llamada/ejecutor-tools.ts`);
const { REGLAS_CIERRE_PM } = await import(`${P}/domain-restaurantes/src/voz/llamada/maquina.ts`);
const { VOICE_TOOL_HTTP_PATHS } = await import(`${P}/domain-restaurantes/src/agent-tools/registry.ts`);
const { canonicalizeMexicanPhone } = await import(`${P}/domain-restaurantes/src/phone.ts`);

const REP = process.env.VOZ_REP ?? "1";
const CORTE = parseCorte(process.env.VOZ_CORTE_USD); // finito y > 0, o aborta
const MODELO = process.env.VOZ_MODELO || VOZ_PLATAFORMA.cascadaV2.llm.modelo;
const ESFUERZO = (process.env.VOZ_ESFUERZO as "low" | "medium" | "high" | undefined) ?? VOZ_PLATAFORMA.cascadaV2.llm.esfuerzo;
const NIVEL_RUIDO = Number(process.env.VOZ_RUIDO ?? "1");
const FILTRO = process.env.VOZ_FILTRO ? new RegExp(process.env.VOZ_FILTRO) : null;
const JUEZ = process.env.VOZ_JUEZ ?? "anthropic/claude-haiku-5.5";
const SIN_COMPUERTA = process.env.VOZ_SIN_COMPUERTA === "1";
const SIN_ZDR = process.env.VOZ_SIN_ZDR === "1"; // NO es medicion oficial: se registra en cada resultado
const RES = process.env.VOZ_RES_DIR ?? `${QA}/results`;
mkdirSync(RES, { recursive: true });
const ARCHIVO = `${RES}/voz-real-${process.env.VOZ_ETQ ?? "main"}-rep${REP}.json`;

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("falta OPENROUTER_API_KEY en el entorno");

validarEntorno(process.env); // antes de arrancar nada: ninguna variable heredada puede apuntar fuera de loopback
const s = await startStack();
// Aislamiento: la API y la base deben ser locales y el Meta debe ser el simulado; si no, se aborta ANTES de tocar nada.
try { validarAislamiento(s, process.env); } catch (x) { try { await s.stop?.(); } catch { /* */ } throw x; }
// Datos de la semilla LOCAL de la cuenta de PM (slug publico de la sucursal demo); el id de la organizacion se lee de la base efimera, no va en el codigo.
const org = process.env.VOZ_ORG_SLUG ?? "los-taquitos-de-pm";
const HDR_TOOL: Record<string, string> = { "content-type": "application/json", "x-atiende-tool-secret": "qa-voice-tool-secret-local" };
const HDR_INT: Record<string, string> = { "content-type": "application/json", "x-atiende-internal-secret": "qa-internal-secret-local" };
const SLUG = { T1: "prol-montejo", T3: "pensiones", T7: "garcia-lavin" } as const;
const ORG_ID: string = process.env.VOZ_ORG_ID ?? (await s.pool.query("select id from core.organization where slug = $1", [org])).rows[0]?.id;
if (!ORG_ID) { await s.stop?.(); throw new Error(`la organizacion ${org} no existe en la base efimera (semilla local)`); }
const priceMap = new Map<string, number>();
for (const r of (await s.pool.query("select property_id, product_id, price::float p from restaurantes.branch_products")).rows) priceMap.set(`${r.property_id}:${r.product_id}`, r.p);

// ---- LLM de la cascada: el puerto del worker, SIN tocar su enrutamiento (ZDR) ----
// VOZ_SIN_ZDR=1: SOLO para modelos baratos sin endpoint de retencion cero (control de costo); la medicion oficial va con el enrutamiento de produccion.
const fetchSinZdr: typeof fetch | undefined = SIN_ZDR
  ? (async (url: any, init: any) => { try { const b = JSON.parse(String(init?.body)); if (b.provider) { delete b.provider.zdr; delete b.provider.only; b.provider.data_collection = "deny"; } b.usage = { include: true }; return fetch(url, { ...init, body: JSON.stringify(b) }); } catch { return fetch(url, init); } }) as typeof fetch
  : undefined;
const llmPuerto = crearPuertoLlmVozV2(key, fetchSinZdr, { modelo: MODELO, config: { ...VOZ_PLATAFORMA, cascadaV2: { ...VOZ_PLATAFORMA.cascadaV2, llm: { ...VOZ_PLATAFORMA.cascadaV2.llm, esfuerzo: ESFUERZO } } } });

// ---- STT y TTS falsos: el cliente entra por texto; el TTS devuelve silencio proporcional a los caracteres (sin esperar) ----
// El cliente "habla" entregando el texto como si fuera el FINAL del STT (`turnoFinal`): es el mismo camino que usa el audio real (alTurnoFinal limpia la espera de la regla
// confirmar -> crear, corta al agente si hablaba y avisa al controlador). `enviarTexto` NO hace eso y dejaria `crear_pedido` bloqueado para siempre (hallazgo del arnes).
let eventosStt: { turnoFinal(t: string): void; parcial(t: string): void } | null = null;
const sttFalso = { abrir: async (_o: unknown, ev: { turnoFinal(t: string): void; parcial(t: string): void }) => { eventosStt = ev; return { enviarAudio: () => undefined, cerrar: async () => undefined }; } };
const ttsFalso = {
  abrir: async () => ({
    flushesDisponibles: () => 1000,
    sintetizar: async function* (texto: string) { yield new Uint8Array(Math.min(48_000 * 20, texto.length * 2400)); },
    cerrar: async () => undefined,
  }),
};

// Gasto de la llamada EN CURSO (agente). Vive fuera de correrLlamada para contarse aunque la llamada termine en excepcion.
const costoLlamada = { micro: 0, real: true };
const verificarTope = () => {
  const g = gastoPropioUsd({ cerradoUsd: llmAcum, llamadaEnCursoUsd: costoLlamada.micro / 1e6, clienteJuezUsd: gasto.usd });
  if (excedeTope(g, CORTE)) throw new TopeExcedido(g, CORTE);
};

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]!; };

interface TurnoRegistro { quien: "cliente" | "agente" | "sistema"; dicho?: string; oido?: string; cambios?: readonly string[]; texto?: string; msPrimeraFrase?: number | null; msTurno?: number; herramientas?: string[] }

async function correrLlamada(e: Escenario, phone: string, instruccion: string, voiceId: string, semilla: string) {
  const mundo = { organizationId: ORG_ID, propertyId: PROP[e.sucursal], callbacks: [] };
  const lat: number[] = [];
  const callId = `vm-${e.id}-${Date.now()}`;
  const tk = (await (await fetch(`${s.api}/v1/restaurantes/${org}/voice/call-token`, { method: "POST", headers: HDR_TOOL, body: JSON.stringify({ call_id: callId, caller_phone: phone, branch_slug: SLUG[e.sucursal] }) })).json()) as { call_token: string };
  const hdr = { ...HDR_TOOL, "x-atiende-call-token": tk.call_token };
  const transporte = async (nombre: string, args: Record<string, unknown>, senal: AbortSignal) => {
    const t0 = Date.now();
    const r = await fetch(`${s.api}/v1/restaurantes/${org}${(VOICE_TOOL_HTTP_PATHS as Record<string, string>)[nombre]}`, { method: "POST", headers: hdr, body: JSON.stringify(args), signal: senal });
    const txt = await r.text(); let body: any; try { body = JSON.parse(txt); } catch { body = { error: txt.slice(0, 200) }; }
    lat.push(Date.now() - t0);
    return { resultado: r.status >= 400 ? { error: body.message ?? body.error ?? `HTTP ${r.status}` } : body, entidadId: nombre === "crear_pedido" ? body?.order?.id ?? null : null };
  };
  const v2log: { evento: string; campos: any }[] = [];
  const base = crearProveedorCascadaV2({
    deepgramApiKey: null, llm: llmPuerto, modeloLlm: MODELO, stt: sttFalso as never, tts: ttsFalso as never, herramientasEnParalelo: HERRAMIENTAS_VOZ_SOLO_LECTURA,
    ...(SIN_COMPUERTA ? {} : { confirmacionAntesDeCrear: { confirmar: "confirmar_resumen", crear: "crear_pedido" } }),
    log: (l: any) => void v2log.push(l),
  });
  const costo = costoLlamada;
  let primeraFraseT: number | null = null;
  const abrirSesion = (ap: any, h: any) => base.abrirSesion(ap, {
    ...h,
    agenteDijo: (t: string) => { if (primeraFraseT === null) primeraFraseT = performance.now(); h.agenteDijo(t); },
    costo: (m: number, real?: boolean, comp?: any) => { if (comp?.proveedor?.startsWith("openrouter")) { costo.micro = sumarCosto(costo.micro, m); if (real === false) costo.real = false; } h.costo?.(m, real, comp); },
  });
  const limites = { ...LIMITES_POR_DEFECTO };
  const tools: any[] = []; const pregrabados: any[] = []; const logs: any[] = []; const kpi: any[] = [];
  const ctrl = new ControladorLlamada({
    callId, reglas: REGLAS_CIERRE_PM,
    construirEscalacion: (motivo: string, resumen: string) => ({ nombre: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen } }),
    propertyId: mundo.propertyId, organizationId: mundo.organizationId,
    abrirSesion, ejecutor: crearEjecutorTools({ registro: REGISTRO_TOOLS_PM, transporte: transporte as never, timeoutMs: limites.toolTimeoutMs }),
    instruccion, voiceId, limites, reproducir: (m: any) => void pregrabados.push(m), cortarAudio: () => undefined, log: (l: any) => void logs.push(l), kpi: (k: any) => void kpi.push(k), dormir: async () => undefined, trazarTool: (t: any) => void tools.push(t),
  });
  void extraerTelefonoSipFrom; void canonicalizeMexicanPhone;
  const rng = rngDesdeSemilla(semilla);
  const registro: TurnoRegistro[] = [];
  const histCliente: { who: "cliente" | "agente"; text: string }[] = [];
  const { iniciada } = await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
  const sincronizar = async () => { await base.inactivo(); await ctrl.vacio(); await base.inactivo(); await ctrl.vacio(); };
  const ultimoAgente = () => { const tr = ctrl.transcripcion as { rol: string; texto: string }[]; let i = tr.length - 1; const ps: string[] = []; while (i >= 0 && tr[i]!.rol !== "cliente") { if (tr[i]!.rol === "agente") ps.unshift(tr[i]!.texto); i -= 1; } return ps.join(" ").replace(/\s+/g, " ").trim(); };
  const guion = e.turnos.filter((t): t is string => typeof t === "string");
  let gi = 0; let extra = 0;
  const datos = e.datos ?? DATOS_POR_OMISION;

  const hablar = async (dicho: string, opciones: { interrumpe?: boolean; sinRuido?: boolean } = {}) => {
    verificarTope(); // tope por turno, no solo por escenario
    const r = opciones.sinRuido || e.sinRuido ? { texto: dicho, cambios: [] as string[] } : ruidoStt(dicho, rng, { nivel: NIVEL_RUIDO });
    if (opciones.interrumpe) eventosStt?.parcial(r.texto.split(" ").slice(0, 3).join(" "));
    const nTools0 = tools.length;
    primeraFraseT = null;
    const t0 = performance.now();
    if (!eventosStt) throw new Error("el STT falso no se abrio");
    eventosStt.turnoFinal(r.texto);
    await sincronizar();
    const t1 = performance.now();
    const agente = ultimoAgente();
    registro.push({ quien: "cliente", dicho, oido: r.texto, cambios: r.cambios });
    registro.push({ quien: "agente", texto: agente || "(silencio del agente)", msPrimeraFrase: primeraFraseT === null ? null : Math.round(primeraFraseT - t0), msTurno: Math.round(t1 - t0), herramientas: tools.slice(nTools0).map((t: any) => t.nombre) });
    histCliente.push({ who: "cliente", text: dicho }, { who: "agente", text: agente || "(silencio del agente)" });
  };
  const generar = async (intenciones: readonly string[]) => {
    verificarTope();
    const persona = { goal: `Llamas por telefono a una taqueria: ${e.titulo}. Hablas como en una llamada: frases cortas, sin escribir cifras ni signos raros.`, hints: intenciones, datos };
    const { msg } = await nextClientMsg(persona, histCliente as never, histCliente.length === 0, "voz");
    const limpio = (msg ?? "").replace(/\s+/g, " ").trim();
    return limpio || "Hola";
  };

  if (iniciada) {
    for (let k = 0; k < e.turnos.length && ctrl.maquina.estadoActual !== "cerrada"; k += 1) {
      const t = e.turnos[k]!;
      if (typeof t === "string") { await hablar(await generar(guion.slice(gi, gi + 3))); gi += 1; continue; }
      const ev = t as Evento;
      if (ev.k === "interrumpe") await hablar(ev.dice, { interrumpe: true });
      else if (ev.k === "cortada") await hablar(cortarMensaje(ev.dice, rng), { sinRuido: true });
      else if (ev.k === "ruido") { await ctrl.ruido(); registro.push({ quien: "sistema", texto: "(ruido)" }); await sincronizar(); }
      else if (ev.k === "no_entendido") { await ctrl.noEntendido(); registro.push({ quien: "sistema", texto: "(no se entiende lo que dice)" }); await sincronizar(); }
      else if (ev.k === "silencio") {
        const n0 = (ctrl.transcripcion as unknown[]).length;
        await ctrl.silencio(ev.ms); await sincronizar();
        registro.push({ quien: "sistema", texto: `(silencio ${ev.ms / 1000}s)` });
        const tr = (ctrl.transcripcion as { rol: string; texto: string }[]).slice(n0).filter((x) => x.rol === "agente").map((x) => x.texto).join(" ");
        if (tr) registro.push({ quien: "agente", texto: tr });
      } else if (ev.k === "cuelga") { await ctrl.clienteCuelga(); registro.push({ quien: "sistema", texto: "(cuelga)" }); }
    }
    while (e.sigue && ctrl.maquina.estadoActual !== "cerrada" && extra < 5) {
      const q = `restaurantes.orders where customer_phone like $1`;
      const n = (await s.pool.query(`select count(*)::int c from ${q}`, [`%${phone.slice(-10)}`])).rows[0].c;
      const cb = (await s.pool.query(`select count(*)::int c from restaurantes.callback_requests where customer_phone like $1`, [`%${phone.slice(-10)}`])).rows[0].c;
      if ((n > 0 && extra >= 1) || cb > 0) break;
      await hablar(await generar(["(responde a lo que te pregunta el asistente; si te repite tu pedido con el total, confirma con 'sí, es correcto')"])); extra += 1;
    }
  }
  await sincronizar();
  if (iniciada && ctrl.maquina.estadoActual !== "cerrada") await ctrl.clienteCuelga();
  await sincronizar();
  try { await (base as any).cerrar?.(); } catch { /* */ }
  const resultado = iniciada ? (ctrl.maquina.resultado ?? "abandonado") : "no_iniciada";
  return { iniciada, resultado, transcripcion: ctrl.transcripcion as { rol: string; texto: string }[], registro, tools, pregrabados, kpi, logs, toolLatMs: lat, costoMicro: costo.micro, costoReal: costo.real, v2log };
}

// ---- checks deterministas ----
function evaluar(c: Chk, i: { orders: any[]; callbacks: any[]; agenteTexto: string }): string | null {
  const { orders, callbacks, agenteTexto } = i;
  switch (c.t) {
    case "sinPedido": return orders.length ? `no debia crear pedido y creo ${orders.length}` : null;
    case "pedidos": return orders.length === c.n ? null : `pedidos=${orders.length} (esperado ${c.n})`;
    case "maxPedidos": return orders.length <= c.n ? null : `DUPLICADO: ${orders.length} pedidos (max ${c.n})`;
    case "total": return orders.some((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} no esta en ${JSON.stringify(c.en)}`;
    case "totalSiCrea": return orders.every((o) => c.en.includes(o.total)) ? null : `total ${JSON.stringify(orders.map((o) => o.total))} fuera de ${JSON.stringify(c.en)}`;
    case "callback": return callbacks.length && (!c.motivos || callbacks.some((cb) => c.motivos!.includes(cb.reason))) ? null : `no registro escalacion (callback)${c.motivos ? ` con motivo ${c.motivos.join("|")}` : ""}`;
    case "sinCallback": return callbacks.length ? `escalo una consulta informativa (${callbacks.map((cb) => cb.reason).join(",")})` : null;
    case "sinTexto": return new RegExp(c.re, "i").test(agenteTexto) ? `el agente dijo algo prohibido (/${c.re}/)` : null;
    case "texto": return new RegExp(c.re, "i").test(agenteTexto) ? null : `el agente no dijo /${c.re}/`;
    case "sinItem": return orders.some((o) => new RegExp(c.re, "i").test(JSON.stringify(o.items))) ? `pedido contiene /${c.re}/` : null;
    case "canal": return orders.length && orders.every((o) => o.canal === c.v) ? null : `canal ${JSON.stringify(orders.map((o) => o.canal))} != ${c.v}`;
    case "sinDomicilio": return orders.some((o) => o.canal === "domicilio") ? "creo pedido a domicilio" : null;
    case "piezas": { const re = new RegExp(c.re, "i"); const n = orders.reduce((a, o) => a + o.items.filter((it: any) => re.test(it.name)).reduce((b: number, it: any) => b + Number(it.quantity), 0), 0); return n === c.n ? null : `piezas /${c.re}/ = ${n} (esperado ${c.n})`; }
  }
}

const JUEZ_SYS = `Eres un evaluador estricto del agente de VOZ (llamada telefonica) de una taqueria. Recibes el escenario (lo que DEBE y NO DEBE hacer), la transcripcion y el estado real de la base de datos.
En la transcripcion, cada turno del cliente muestra [dijo] lo que el cliente DIJO y [STT] lo que el reconocimiento de voz le ENTREGO al agente (puede traer errores: cifras, nombres mal escritos, muletillas). Juzga el comportamiento del agente
frente a lo que recibio y a lo que el cliente quiso decir. Si el agente dijo que el pedido quedo registrado y la BD no lo tiene, es FALLA grave. Si un check determinista fallo pero crees que el agente obro bien, dilo en el motivo.
Las horas deben decirse habladas («doce y media», no «12:30»). Un turno largo (varias frases) es un defecto de voz menor, no una falla por si solo.
Responde SOLO JSON: {"veredicto":"PASA"|"PARCIAL"|"FALLA","motivo":"1-2 frases","causa":"modelo|prompt|herramienta|ruido_stt|arnes|ninguna","severidad":"P0|P1|P2|P3|ninguna"}
causa: modelo = el agente razono o decidio mal pese a un prompt/herramienta correctos; prompt = falta o se contradice una regla de la instruccion; herramienta = la herramienta/servidor dio un resultado o error incorrecto; ruido_stt = el error de transcripcion bastaba para confundir a cualquier agente; arnes = el cliente simulado o el guion se comporto de forma inverosimil.`;

// Lectura sin comprobar antes la existencia (evita la carrera comprobar-usar). Si el archivo NO existe se empieza de cero; si existe pero esta corrupto
// (o no es una lista) se respalda y se ABORTA: seguir sobrescribiria resultados que costaron dinero.
const previo: any[] = (() => {
  let txt: string;
  try { txt = readFileSync(ARCHIVO, "utf8"); } catch (x) { if ((x as NodeJS.ErrnoException).code === "ENOENT") return []; throw x; }
  try { const j = JSON.parse(txt); if (Array.isArray(j)) return j; } catch { /* corrupto: abajo */ }
  const resp = `${ARCHIVO}.corrupto-${Date.now()}`;
  copyFileSync(ARCHIVO, resp);
  throw new Error(`el JSON previo ${ARCHIVO} esta corrupto o no es una lista; respaldado en ${resp}. Revisalo o muevelo antes de volver a correr (no se sobrescribe).`);
})();
// No se mezclan en un mismo archivo resultados de modelos o de enrutamientos (ZDR) distintos: usa otro VOZ_ETQ o VOZ_REP.
for (const r of previo) {
  if ((r.modelo !== undefined && r.modelo !== MODELO) || (r.sinZdr !== undefined && r.sinZdr !== SIN_ZDR)) throw new Error(`${ARCHIVO} tiene resultados de otro modelo/enrutamiento (${r.modelo}, sinZdr=${r.sinZdr}); usa otro VOZ_ETQ o VOZ_REP.`);
}
// Todo lo que viene de la red (respuestas de modelos y de la API, transcripciones) se sanea antes de escribirlo: sin caracteres de control y con tope de largo por texto.
const sanear = (v: unknown, prof = 0): unknown => {
  if (typeof v === "string") return redactar(Array.from(v.slice(0, 20000)).filter((c) => { const n = c.charCodeAt(0); return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127); }).join(""));
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (prof > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 2000).map((x) => sanear(x, prof + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 200).map(([k, x]) => [k.slice(0, 80), sanear(x, prof + 1)]));
  return null;
};
// Escritura atomica (archivo temporal + rename) del resultado saneado.
const guardar = () => { const tmp = `${ARCHIVO}.tmp`; writeFileSync(tmp, JSON.stringify(sanear(results), null, 1), { mode: 0o600 }); renameSync(tmp, ARCHIVO); };
// Excepciones y llamadas invalidas por infraestructura se reintentan (hasta 3 intentos); despues se quedan registradas como estan.
const reintentable = (r: any) => (r.excepcion || r.invalida) && !(r.intentos >= 3);
const hechos = new Set(previo.filter((r) => !reintentable(r)).map((r) => r.id));
// Los reintentables SE CONSERVAN en el archivo (con sus intentos y su gasto): si la corrida se corta antes de repetirlos no se pierden; al repetirlos se reemplazan.
const results: any[] = [...previo];
const uso0 = (await usoRealOpenRouter()) ?? 0;
let pendientes = 0; let cortado = false; let llmAcum = 0;
const esperados = ESCENARIOS.filter((e) => !FILTRO || FILTRO.test(e.id)).length;
const config = { modelo: MODELO, sinZdr: SIN_ZDR, oficial: !SIN_ZDR, esfuerzo: ESFUERZO, ruido: NIVEL_RUIDO, compuerta: !SIN_COMPUERTA, totalEscenarios: ESCENARIOS.length, filtro: process.env.VOZ_FILTRO ?? null };
if (SIN_ZDR) console.error("[voz-real] AVISO: VOZ_SIN_ZDR=1 -> corrida NO OFICIAL (sin retencion cero); no usar como medicion de produccion");
console.error(`[voz-real] rep=${REP} modelo=${MODELO} esfuerzo=${ESFUERZO} ruido=${NIVEL_RUIDO} compuerta=${!SIN_COMPUERTA} sinZdr=${SIN_ZDR} corte=$${CORTE} uso0=${uso0.toFixed(4)}`);

for (const e of ESCENARIOS) {
  if (FILTRO && !FILTRO.test(e.id)) continue;
  if (hechos.has(e.id)) continue;
  // El /key de OpenRouter se actualiza con retraso: el corte usa el mayor entre su delta y la cuenta propia (costo real de las llamadas del agente + cliente simulado + juez).
  const uso = (await usoRealOpenRouter()) ?? uso0;
  if (excedeTope(Math.max(uso - uso0, llmAcum + gasto.usd), CORTE)) { cortado = true; pendientes += 1; continue; }
  setClock(RELOJES[e.reloj]);
  // Telefono de prueba (521 999 555 01xx; marca de dato de prueba, no rango reservado en Mexico: la garantia es el aislamiento): jamas aleatorio; se elige uno sin pedidos ni escalaciones previas en la base efimera.
  const phone = await elegirTelefonoLibre(async (p10) => Number((await s.pool.query(`select (select count(*) from restaurantes.orders where customer_phone like $1) + (select count(*) from restaurantes.callback_requests where customer_phone like $1) c`, [`%${p10}`])).rows[0].c), ESCENARIOS.indexOf(e));
  if (!esTelefonoFicticio(phone)) throw new Error("telefono fuera del rango ficticio");
  const phone10 = phone.slice(-10);
  costoLlamada.micro = 0; costoLlamada.real = true;
  const rec: any = { id: e.id, fuente: e.fuente, titulo: e.titulo, sucursal: e.sucursal, rep: REP, intentos: (previo.find((r) => r.id === e.id)?.intentos ?? 0) + 1, ...config };
  const t0 = Date.now(); let llamada: any; let err: string | null = null; let instruccion = ""; let topeEnCurso = false;
  try {
    const ctx = (await (await fetch(`${s.api}/internal/restaurantes/voz/llamada/contexto`, { method: "POST", headers: HDR_INT, body: JSON.stringify({ organizationId: ORG_ID, propertyId: PROP[e.sucursal], callerPhone: phone }) })).json()) as any;
    if (typeof ctx.instruccion !== "string") throw new Error("contexto sin instruccion: " + JSON.stringify(ctx).slice(0, 160));
    instruccion = ctx.instruccion;
    llamada = await correrLlamada(e, phone, instruccion, ctx.voiceId ?? "aura-2-estrella-es", `${e.id}-${REP}`);
  } catch (x) {
    if (x instanceof TopeExcedido) topeEnCurso = true;
    else err = redactar((x as Error).stack ?? (x as Error).message).slice(0, 700);
  }
  // El gasto de la llamada cuenta SIEMPRE (tambien si hubo excepcion o se corto por tope): vive en costoLlamada, no en el resultado.
  llmAcum += costoLlamada.micro / 1e6;
  if (topeEnCurso) { cortado = true; pendientes += 1; console.log("CORTE por tope en", e.id, "(sin registrar el escenario; se repite al continuar)"); break; }
  rec.llmUsd = costoLlamada.micro / 1e6;
  rec.durS = Math.round((Date.now() - t0) / 1000);
  if (err || !llamada) {
    // Una excepcion del arnes (red, base, bug) no es evidencia del agente: INVALIDA y reintentable, no FALLA.
    rec.excepcion = true; rec.invalida = true; rec.veredicto = "INVALIDA"; rec.causa = "arnes"; rec.motivo = "EXCEPCION: " + err;
    const i = results.findIndex((r) => r.id === e.id); if (i >= 0) results[i] = rec; else results.push(rec);
    guardar(); console.log("EXCEPCION", e.id, err?.slice(0, 200)); continue;
  }
  const orders = (await s.pool.query(`select total::float total, canal, status, items, property_id, customer_address from restaurantes.orders where customer_phone like $1`, [`%${phone10}`])).rows;
  const callbacks = (await s.pool.query(`select reason from restaurantes.callback_requests where customer_phone like $1`, [`%${phone10}`])).rows;
  const tr = llamada.transcripcion;
  const agenteTexto = tr.filter((x: any) => x.rol === "agente").map((x: any) => x.texto).join(" ");
  const inv: string[] = [];
  for (const o of orders) {
    let sum = 0;
    for (const it of o.items) { sum += it.price * it.quantity; const dbp = priceMap.get(`${o.property_id}:${it.id}`); if (!/^Extra Salsa/.test(it.name) && dbp !== undefined && motivoPrecioInvalido(it, dbp, o.items)) inv.push(`INV precio ${it.name} ${it.price}!=${dbp}`); if (dbp === undefined && !/^Extra Salsa/.test(it.name)) inv.push(`INV renglon ${it.name} fuera de menu`); }
    if (Math.abs(sum - o.total) > 0.01) inv.push(`INV total ${o.total}!=${sum}`);
    if (o.property_id !== PROP[e.sucursal]) inv.push("INV sucursal distinta");
  }
  const hard = [...inv, ...e.checks.map((c) => evaluar(c, { orders, callbacks, agenteTexto })).filter((x): x is string => x !== null)];
  if (llamada.resultado === undefined || llamada.resultado === null) hard.push("la llamada no tiene resultado (posible llamada colgada)");
  const caidas = llamada.v2log.filter((l: any) => /caida|vacia/.test(l.evento)).map((l: any) => `${l.evento}:${l.campos?.codigo ?? ""}`);
  const trTxt = llamada.registro.map((x: TurnoRegistro) => x.quien === "cliente" ? `CLIENTE [dijo]: ${x.dicho}${x.oido !== x.dicho ? `\n         [STT]: ${x.oido}` : ""}` : x.quien === "agente" ? `AGENTE: ${x.texto}${x.herramientas?.length ? `  <herramientas: ${x.herramientas.join(", ")}>` : ""}` : `SISTEMA: ${x.texto}`).join("\n").slice(0, 9000);
  const usr = `ESCENARIO ${e.id}: ${e.titulo}\nDEBE: ${e.debe}\nNO DEBE: ${e.noDebe}\nRESULTADO DE LA LLAMADA: ${llamada.resultado}\nTRANSCRIPCION:\n${trTxt}\nTOOLS: ${JSON.stringify(llamada.tools.map((t: any) => ({ n: t.nombre, r: JSON.stringify(t.resultado).slice(0, 180) }))).slice(0, 2800)}\nBD: pedidos=${JSON.stringify(orders.map((o: any) => ({ total: o.total, canal: o.canal, direccion: o.customer_address, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`) })))}; callbacks=${JSON.stringify(callbacks.map((c: any) => c.reason))}\nFALLAS DETERMINISTAS: ${hard.join(" ; ") || "ninguna"}${caidas.length ? `\nINFRA: ${caidas.join(",")}` : ""}`;
  let jr: any = { veredicto: "PARCIAL", motivo: "juez sin respuesta tras 3 intentos", causa: "juez", severidad: "ninguna" };
  let juezSinRespuesta = true;
  let topeEnJuez = false;
  for (let intento = 0; intento < 3; intento += 1) {
    try { verificarTope(); } catch { topeEnJuez = true; break; }
    try {
      const out = await chat([{ role: "system", content: JUEZ_SYS }, { role: "user", content: usr }], { max: 1500, json: true, model: JUEZ });
      const m = /\{[\s\S]*\}/.exec(out);
      const j = JSON.parse(m ? m[0] : out);
      if (typeof j.veredicto === "string") { jr = j; juezSinRespuesta = false; break; }
    } catch { /* reintenta */ }
  }
  if (topeEnJuez) { cortado = true; pendientes += 1; console.log("CORTE por tope antes del juez en", e.id); break; }
  const turnosAg = llamada.registro.filter((x: TurnoRegistro) => x.quien === "agente" && x.msTurno !== undefined);
  const palabras = turnosAg.map((x: TurnoRegistro) => (x.texto ?? "").split(/\s+/).filter(Boolean).length);
  Object.assign(rec, {
    resultado: llamada.resultado, hard, juez: jr.veredicto, motivo: jr.motivo, causa: hard.length || jr.veredicto !== "PASA" ? jr.causa : "ninguna", severidad: jr.severidad,
    // Una llamada con caida o respuesta vacia del LLM (infra) NO es evidencia del agente: queda INVALIDA, fuera de la tasa de acierto, y se reintenta.
    // Idem si el juez no respondio tras 3 intentos (falla de infraestructura, no del agente).
    invalida: caidas.length > 0 || juezSinRespuesta,
    veredicto: caidas.length > 0 || juezSinRespuesta ? "INVALIDA" : hard.length === 0 && jr.veredicto === "PASA" ? "PASA" : "FALLA", soloHard: hard.length === 0 ? "PASA" : "FALLA",
    infra: caidas, pedidos: orders.map((o: any) => ({ total: o.total, canal: o.canal, items: o.items.map((i: any) => `${i.quantity}x ${i.name}@${i.price}`), direccion: o.customer_address })), callbacks: callbacks.map((c: any) => c.reason),
    turnos: llamada.registro, tools: llamada.tools.map((t: any) => ({ n: t.nombre, r: JSON.stringify(t.resultado).slice(0, 220) })), toolLatMs: llamada.toolLatMs,
    msPrimeraFrase: turnosAg.map((x: TurnoRegistro) => x.msPrimeraFrase).filter((x: any) => typeof x === "number"), msTurno: turnosAg.map((x: TurnoRegistro) => x.msTurno), palabrasAgente: palabras,
    conHerramienta: turnosAg.map((x: TurnoRegistro) => (x.herramientas?.length ?? 0) > 0), llmUsd: llamada.costoMicro / 1e6, llmCostoReal: llamada.costoReal, instruccionChars: instruccion.length,
    v2llm: llamada.v2log.filter((l: any) => l.evento === "v2_llm").map((l: any) => l.campos).slice(0, 60),
  });
  const i = results.findIndex((r) => r.id === e.id); if (i >= 0) results[i] = rec; else results.push(rec);
  guardar();
  const p50 = pct(rec.msTurno as number[], 0.5);
  console.log(`${rec.veredicto} ${e.id} ${e.titulo} [juez ${jr.veredicto}/${jr.causa}] res=${llamada.resultado} ${rec.durS}s turno_p50=${p50}ms llm=$${rec.llmUsd.toFixed(3)} | ${String(jr.motivo ?? "").slice(0, 120)} ${hard.length ? "| HARD: " + hard.join("; ").slice(0, 200) : ""}${caidas.length ? " | INFRA " + caidas.join(",") : ""}`);
}
const uso1 = (await usoRealOpenRouter()) ?? uso0;
const ran = results.filter((r) => ESCENARIOS.some((e) => e.id === r.id));
const validas = ran.filter((r) => !r.invalida);
const incompleta = ran.length < esperados;
if (incompleta) console.log(`\nAVISO: corrida INCOMPLETA, ${ran.length}/${esperados} escenarios con resultado${cortado ? " (cortada por tope)" : ""}; la tasa NO es comparable con una corrida completa`);
console.log(`\nRESUMEN rep=${REP}${SIN_ZDR ? " [NO OFICIAL: sin ZDR]" : ""}: ${validas.filter((r) => r.veredicto === "PASA").length}/${validas.length} PASAN (validas; ${ran.length - validas.length} invalidas por infraestructura, aparte)${incompleta ? " | INCOMPLETA" : ""} | gasto de esta corrida (OpenRouter /key delta) $${(uso1 - uso0).toFixed(3)}${cortado ? ` | CORTADO por tope $${CORTE}; pendientes ${pendientes}` : ""}`);
appendFileSync(`${ARCHIVO}.gasto.jsonl`, JSON.stringify({ rep: REP, usoInicio: uso0, usoFin: uso1, deltaUsd: uso1 - uso0, cuentaPropiaUsd: llmAcum + gasto.usd, agenteUsd: llmAcum, clienteJuezUsd: gasto.usd, cortado, pendientes, esperados, conResultado: ran.length, validas: validas.length, incompleta, ...config, ts: new Date().toISOString() }) + "\n");
await s.stop();
process.exit(cortado ? 3 : 0);
