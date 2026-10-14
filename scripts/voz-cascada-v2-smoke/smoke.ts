// Prueba REAL y corta de la cascada v2 (Deepgram STT + LLM por OpenRouter + Deepgram Aura-2 TTS), con tope de gasto. MANUAL: NO corre en CI ni en `test:unit`
// (necesita llaves reales y gasta dinero). Nadie la ejecuto todavia: no habia llave de Deepgram al escribirla; su primera corrida es la que confirma los protocolos.
//
// Uso:
//   DEEPGRAM_API_KEY=... OPENROUTER_API_KEY=... [VOZ_SMOKE_MAX_USD=0.05] npx tsx scripts/voz-cascada-v2-smoke/smoke.ts
//   (`node --experimental-strip-types` NO sirve aqui: los modulos importados usan parameter properties, que Node no puede quitar solo.)
//
// Que hace (gasto estimado < US$0.01):
//   1. TTS: sintetiza una frase corta con Aura-2 (voz mexicana) y mide el tiempo al primer audio.
//   2. STT: manda ese mismo audio (remuestreado a 16 kHz) a Deepgram Nova-3 `es-419` y compara la transcripcion con la frase.
//   3. LLM: dos turnos seguidos al cerebro por OpenRouter (Sonnet 5.5, esfuerzo bajo) con el MISMO system prompt largo: mide el tiempo al primer trozo y
//      comprueba que el segundo turno LEE de la cache del system prompt (`tokensCache > 0`).
//   4. Cascada completa: un turno de texto -> LLM en streaming -> TTS por frase, y muestra que el primer audio sale antes de que el LLM termine.
// Imprime SOLO metricas y la transcripcion de frases sinteticas propias (nunca llaves ni datos de clientes). Se detiene si el gasto estimado pasa del tope.
import { VOZ_PLATAFORMA, costoDeepgramAura2MicroUsd, costoDeepgramMicroUsd, crearProveedorCascadaV2, crearSttDeepgram, crearTtsDeepgram } from "../../packages/voice-core/src/index.ts";
import type { ManejadoresSesion } from "../../packages/voice-core/src/index.ts";
import { crearPuertoLlmVozV2 } from "../../apps/voice-worker/src/llm-openrouter.ts";
import { remuestrearPcm16 } from "../../apps/voice-worker/src/audio/remuestreo.ts";

const FRASE = "Hola, buenas tardes. Quisiera pedir dos tacos de cochinita y una horchata.";
// ~3 000 tokens: por ENCIMA del minimo cacheable de Sonnet 5.5 y Haiku 5.5 (512 tokens), para que el paso 3 pueda ver la lectura de cache.
const PROMPT_LARGO = `Eres el agente de voz de una taqueria en Merida. Hablas siempre en espanol de Mexico, tratas al cliente de usted y respondes en una o dos frases cortas. ${"El menu incluye tacos de cochinita, panuchos, salbutes, horchata y agua de jamaica, todo preparado al momento. ".repeat(160)}`;

const gasto = { microUsd: 0 };
const topeMicroUsd = Math.round(Number(process.env.VOZ_SMOKE_MAX_USD ?? "0.05") * 1_000_000);
/** Revisa ANTES de gastar: si el paso previsto (`estimado`) haria pasar el tope, se detiene sin gastarlo. */
const permitir = (estimado: number, paso: string): void => {
  if (gasto.microUsd + estimado > topeMicroUsd) throw new Error(`El paso "${paso}" pasaria el tope de gasto (US$${(topeMicroUsd / 1_000_000).toFixed(2)}): se detiene antes de gastar.`);
};
const sumar = (n: number, que: string): void => {
  gasto.microUsd += n;
  console.log(`  gasto estimado acumulado: US$${(gasto.microUsd / 1_000_000).toFixed(4)} (${que})`);
};
const ms = (desde: number): number => Math.round(performance.now() - desde);

async function main(): Promise<void> {
  const deepgram = process.env.DEEPGRAM_API_KEY?.trim();
  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (!deepgram || !openrouter) {
    console.error("Faltan DEEPGRAM_API_KEY y/o OPENROUTER_API_KEY en el entorno.");
    process.exit(2);
  }
  const c = VOZ_PLATAFORMA.cascadaV2;
  const tts = await crearTtsDeepgram({ apiKey: deepgram, config: c.deepgramAura2 }).abrir({ voz: c.deepgramAura2.voz, hzSalida: c.deepgramAura2.hzSalida });
  const stt = crearSttDeepgram({ apiKey: deepgram, config: c.deepgram });

  console.log("1) TTS Aura-2");
  permitir(costoDeepgramAura2MicroUsd(FRASE.length, VOZ_PLATAFORMA), "TTS");
  const t0 = performance.now();
  const trozos: Uint8Array[] = [];
  let primero: number | null = null;
  for await (const pcm of tts.sintetizar(FRASE, new AbortController().signal)) {
    primero ??= ms(t0);
    trozos.push(pcm);
  }
  const audio24 = new Uint8Array(trozos.reduce((n, t) => n + t.byteLength, 0));
  let desplazamiento = 0;
  for (const t of trozos) {
    audio24.set(t, desplazamiento);
    desplazamiento += t.byteLength;
  }
  console.log(`  primer audio: ${primero} ms; ${(audio24.byteLength / 2 / c.deepgramAura2.hzSalida).toFixed(2)} s de audio a ${c.deepgramAura2.hzSalida} Hz`);
  sumar(costoDeepgramAura2MicroUsd(FRASE.length, VOZ_PLATAFORMA), "TTS");

  console.log("2) STT Nova-3 es-419");
  permitir(costoDeepgramMicroUsd(10, VOZ_PLATAFORMA, true), "STT");
  const muestras24 = new Int16Array(audio24.buffer, audio24.byteOffset, Math.floor(audio24.byteLength / 2));
  const muestras16 = remuestrearPcm16(muestras24, c.deepgramAura2.hzSalida, c.deepgram.hzEntrada);
  const audio16 = new Uint8Array(muestras16.buffer, muestras16.byteOffset, muestras16.byteLength);
  let sesionStt: { cerrar(): Promise<void> } | null = null;
  const transcripcion = await new Promise<string>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error("STT: sin turno final en 15 s")), 15_000);
    void stt
      .abrir(
        { hzEntrada: c.deepgram.hzEntrada, vocabulario: ["cochinita", "panuchos", "salbutes", "horchata"] },
        {
          hablaIniciada: () => undefined,
          parcial: () => undefined,
          turnoFinal: (t) => {
            clearTimeout(limite);
            resolve(t);
          },
          caido: (codigo) => reject(new Error(`STT caido: ${codigo}`)),
        },
      )
      .then(async (s) => {
        sesionStt = s;
        // Audio a velocidad real en trozos de 20 ms, y 1.5 s de silencio al final para que el endpointing cierre el turno.
        const trozo = (c.deepgram.hzEntrada * 2 * 20) / 1000;
        for (let i = 0; i < audio16.byteLength; i += trozo) {
          s.enviarAudio(audio16.subarray(i, i + trozo));
          await new Promise((r) => setTimeout(r, 20));
        }
        for (let i = 0; i < 75; i++) {
          s.enviarAudio(new Uint8Array(trozo));
          await new Promise((r) => setTimeout(r, 20));
        }
      })
      .catch(reject);
  });
  // La sesion de STT se cierra SIEMPRE: si no, sigue con KeepAlive, factura por segundo y deja el proceso colgado.
  await (sesionStt as { cerrar(): Promise<void> } | null)?.cerrar();
  console.log(`  transcripcion: "${transcripcion}"`);
  sumar(costoDeepgramMicroUsd(audio16.byteLength / 2 / c.deepgram.hzEntrada + 1.5, VOZ_PLATAFORMA), "STT");

  console.log("3) LLM en streaming + cache del system prompt");
  const llm = crearPuertoLlmVozV2(openrouter);
  for (const n of [1, 2]) {
    permitir(30_000, `LLM turno ${n}`);
    const t1 = performance.now();
    let ttft: number | null = null;
    const r = await llm.completar({
      system: PROMPT_LARGO,
      mensajes: [{ role: "user", content: "Quiero un pedido de dos tacos, por favor." }],
      herramientas: [],
      onTextDelta: () => {
        ttft ??= ms(t1);
      },
    });
    console.log(`  turno ${n}: modelo ${r.modelo}; primer trozo ${ttft} ms; total ${ms(t1)} ms; tokens in/out/cache ${r.tokensEntrada}/${r.tokensSalida}/${r.tokensCache ?? 0}; costo US$${(r.costoMicroUsd / 1_000_000).toFixed(5)} (${r.costoReal ? "real" : "estimado"})`);
    sumar(r.costoMicroUsd, "LLM");
    if (n === 2 && !(r.tokensCache && r.tokensCache > 0)) console.log("  ATENCION: el segundo turno NO leyo de la cache del system prompt.");
  }

  console.log("4) Cascada completa (turno de texto)");
  permitir(60_000, "cascada completa");
  let t2 = performance.now();
  const marcas: { primerAudio: number | null; finLlm: number | null } = { primerAudio: null, finLlm: null };
  const eventos: ManejadoresSesion = {
    agenteDijo: () => undefined,
    agenteTermino: () => console.log(`  turno completo en ${ms(t2)} ms`),
    interrumpido: () => undefined,
    ejecutarTool: async () => ({}),
    audioAgente: () => {
      marcas.primerAudio ??= ms(t2);
    },
    caido: (razon) => console.log(`  CAIDA: ${razon}`),
    costo: (micro, _real, comp) => {
      sumar(micro, comp?.proveedor ?? "cascada");
      if (comp?.proveedor.startsWith("openrouter:")) marcas.finLlm = ms(t2);
    },
  };
  const prov = crearProveedorCascadaV2({ deepgramApiKey: deepgram, llm });
  const sesion = await prov.abrirSesion({ instruccion: PROMPT_LARGO, voiceId: c.deepgramAura2.voz, herramientas: [] }, eventos);
  t2 = performance.now();
  sesion.enviarTexto("Cuentame que tacos tienen, por favor.");
  await prov.inactivo();
  const { primerAudio, finLlm } = marcas;
  console.log(`  primer audio ${primerAudio} ms; el LLM termino a los ${finLlm} ms ${primerAudio !== null && finLlm !== null && primerAudio < finLlm ? "(el audio salio ANTES de que el LLM terminara)" : "(revisar: el audio no salio antes)"}`);
  await sesion.cerrar();
  await tts.cerrar();
  console.log(`Listo. Gasto estimado total: US$${(gasto.microUsd / 1_000_000).toFixed(4)}`);
}

main().catch((err: unknown) => {
  console.error(`Fallo: ${err instanceof Error ? err.message : "error"}`);
  process.exit(1);
});
