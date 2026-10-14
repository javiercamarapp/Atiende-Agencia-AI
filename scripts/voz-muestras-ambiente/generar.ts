// Genera las MUESTRAS DE AUDIO del ambiente de restaurante y el tecleo para que una persona las escuche (el desarrollo no puede oir):
//   npx vite-node scripts/voz-muestras-ambiente/generar.ts -- [--out <carpeta>] [--segundos 18] [--semilla 1] [--sin-voz]
// Por cada preset (cocina-taqueria, sala-tranquila, calle-ocupada) escribe 4 WAV de ~18 s: (1) ambiente solo, (2) ambiente + tecleo, (3) ambiente + tecleo sobre una voz de
// ejemplo, (4) lo mismo que (3) como lo oye el cliente por TELEFONO (8 kHz, 300-3400 Hz, mu-law). La voz de ejemplo es la del sistema de macOS en español de Mexico
// (`say -v Paulina`): SIN cuentas ni llaves; no es la voz de Gemini y suena a sintetizador. Sin `say` se usa una voz sintetica de prueba (zumbido): solo sirve para oir
// el mezclado. Los WAV y el README van FUERA del repo (por omision en ~/atiende-loop/pm/audio-ambiente/) y NO se commitean.
// Usa el MISMO mezclador de la llamada (`MezcladorSalida`); no llama a ninguna API.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HZ_MUESTRA, PERFILES_AMBIENTE, PRESETS_AMBIENTE, PRESET_RESTAURANTE_HUMANO, aTelefono, escribirWav16, leerWav16, medirMuestra, remuestrearLineal, renderizarMuestra } from "../../packages/voice-core/src/index.ts";
import type { MetricasMuestra, PresetAmbiente } from "../../packages/voice-core/src/index.ts";

const FRASES = [
  "Buenas tardes, Los Taquitos de PM, ¿qué le preparo?",
  "Con gusto. Déjeme anotarlo, un momento.",
  "Listo, son cuatro tacos al pastor y una horchata, ciento veinte pesos. ¿Algo más?",
];

function arg(nombre: string, porOmision: string): string {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : porOmision;
}

/** Voz de ejemplo con `say` (macOS) a 24 kHz mono; null si no esta disponible. */
function sintetizarFrases(): Int16Array[] | null {
  const tmp = mkdtempSync(join(tmpdir(), "voz-muestras-"));
  try {
    return FRASES.map((texto, i) => {
      const archivo = join(tmp, `f${i}.wav`);
      execFileSync("say", ["-v", "Paulina", "-o", archivo, "--file-format=WAVE", "--data-format=LEI16@24000", texto], { stdio: "ignore" });
      const { pcm, hz } = leerWav16(new Uint8Array(readFileSync(archivo)));
      const normal = hz === HZ_MUESTRA ? pcm : remuestrearLineal(pcm, hz, HZ_MUESTRA);
      // Nivel de voz de agente: pico alrededor de -6 dBFS (como el audio de Gemini Live), para que la relacion con el ambiente sea la real.
      let p = 0;
      for (const v of normal) p = Math.max(p, Math.abs(v));
      const g = p > 0 ? (0.5 * 32767) / p : 1;
      return Int16Array.from(normal, (v) => Math.round(v * g));
    });
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const out = arg("out", join(homedir(), "atiende-loop", "pm", "audio-ambiente"));
const segundos = Number(arg("segundos", "18"));
const semilla = Number(arg("semilla", "1"));
const conVoz = !process.argv.includes("--sin-voz");
mkdirSync(out, { recursive: true });

const frases = conVoz ? sintetizarFrases() : null;
const filas: { archivo: string; descripcion: string; m: MetricasMuestra }[] = [];

for (const preset of PRESETS_AMBIENTE as readonly PresetAmbiente[]) {
  const defs = [
    { tipo: "ambiente" as const, sufijo: "1-ambiente", d: "Ambiente solo" },
    { tipo: "ambiente-tecleo" as const, sufijo: "2-ambiente-tecleo", d: "Ambiente + tecleo (3 esperas de herramienta; la 3.ª la corta el cliente al hablar)" },
    { tipo: "voz-ambiente-tecleo" as const, sufijo: "3-voz-ambiente-tecleo", d: frases ? "Voz de ejemplo (macOS Paulina) + ambiente + tecleo" : "Voz sintetica de prueba + ambiente + tecleo" },
  ];
  for (const def of defs) {
    const r = renderizarMuestra({ preset, tipo: def.tipo, segundos, semilla, ...(frases && def.tipo === "voz-ambiente-tecleo" ? { frases } : {}) });
    const archivo = `${preset}-${def.sufijo}.wav`;
    writeFileSync(join(out, archivo), escribirWav16(r.pcm, r.hz));
    filas.push({ archivo, descripcion: def.d, m: medirMuestra(r) });
    if (def.tipo === "voz-ambiente-tecleo") {
      const tel = `${preset}-4-telefono.wav`;
      writeFileSync(join(out, tel), escribirWav16(aTelefono(r.pcm), 8000));
      filas.push({ archivo: tel, descripcion: "Lo anterior como lo oye el cliente por telefono (8 kHz, 300-3400 Hz, mu-law)", m: medirMuestra({ ...r, pcm: r.pcm }) });
    }
  }
}

// Para ajustar de oido el volumen: la misma escena (cocina-taqueria, voz + ambiente + tecleo) por TELEFONO con el ambiente al 5, 8, 12 y 16 %.
for (const volumenFondo of [5, 8, 12, 16]) {
  const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "voz-ambiente-tecleo", segundos, semilla, volumenFondo, ...(frases ? { frases } : {}) });
  const archivo = `comparar-volumen-${String(volumenFondo).padStart(2, "0")}-telefono.wav`;
  writeFileSync(join(out, archivo), escribirWav16(aTelefono(r.pcm), 8000));
  filas.push({ archivo, descripcion: `cocina-taqueria por telefono con el ambiente al ${volumenFondo} %`, m: medirMuestra(r) });
}

const f = (n: number | null, d = 1): string => (n === null ? "—" : Number.isFinite(n) ? n.toFixed(d) : "-inf");
const p = PRESET_RESTAURANTE_HUMANO;
const readme = `# Muestras de audio: ambiente de restaurante y tecleo

Generadas el ${new Date().toISOString().slice(0, 10)} con \`scripts/voz-muestras-ambiente/generar.ts\` (semilla ${semilla}, ${segundos} s). **No están en el repo.**
Todo el sonido es SINTETIZADO por código (sin archivos con licencia). Quien las generó NO pudo escucharlas: lo que sigue son medidas objetivas, no una opinión de oído.

## Qué escuchar

Cada preset tiene 4 archivos (y hay 3 de comparación de volumen):

1. \`<preset>-1-ambiente.wav\`: solo el ambiente.
2. \`<preset>-2-ambiente-tecleo.wav\`: ambiente + tecleo. Tres esperas de herramienta: 3.0-4.2 s (rápida), 8.0-11.0 s (larga, varias ráfagas con pausas) y 14.5-17.5 s; el cliente habla a los 16.2 s y el tecleo se corta aunque la herramienta siga.
3. \`<preset>-3-voz-ambiente-tecleo.wav\`: lo mismo sobre una voz de ejemplo (${frases ? "voz del sistema de macOS «Paulina», español de México: NO es la voz de Gemini y suena a sintetizador" : "no había `say`: es una voz sintética de prueba, un zumbido; sirve solo para oír el mezclado"}). Línea de tiempo: 0.8 s saludo · 4.8-7.0 s habla el cliente (el ambiente baja) · 8.4 s «déjeme anotarlo» con la herramienta en vuelo (el tecleo espera a que la voz calle) · 12.6 s resultado · 16-19 s segunda herramienta que el cliente corta al hablar a los 17.4 s.
4. \`<preset>-4-telefono.wav\`: el punto 3 como llega por teléfono (8 kHz, 300-3400 Hz, mu-law). **Esta es la que más se parece a lo que oirá el cliente real.**

Presets: ${PRESETS_AMBIENTE.map((id) => `**${id}** (${PERFILES_AMBIENTE[id].descripcion})`).join("; ")}.

5. \`comparar-volumen-05|08|12|16-telefono.wav\`: la misma escena de cocina-taqueria por teléfono con el ambiente al 5, 8, 12 y 16 %, para elegir el volumen de oído (el del preset es ${PRESET_RESTAURANTE_HUMANO.fondo.volumen} %, un punto de partida por cálculo).

## Parámetros

- Volumen del ambiente: ${p.fondo.volumen} % de plena escala (pico máximo; el del preset «restaurante-humano»). Volumen del tecleo: ${p.tecleo.volumen} %.
- Ducking: el ambiente baja 7 dB (ataque 25 ms, liberación 350 ms) mientras habla el agente o el cliente.
- Tecleo: ráfagas de 0.9-2.5 s con pausas de 0.35-1.1 s, mínimo 500 ms, fade-in 40 ms / fade-out 120 ms, corte por barge-in en ~25 ms, silenciado mientras habla el agente, tope 8 s por espera y 30 s por llamada, «pip» de POS al terminar bien.
- Mezclador: el mismo \`MezcladorSalida\` que usa el worker de la llamada (24 kHz, PCM16).

## Medidas objetivas

| Archivo | RMS dBFS | LUFS aprox. | Pico dBFS | Recortadas | Ventanas de 1 s repetidas | Voz sobre ambiente (dB) |
|---|---|---|---|---|---|---|
${filas.map((x) => `| ${x.archivo} | ${f(x.m.rmsDbfs)} | ${f(x.m.lufsAprox)} | ${f(x.m.picoDbfs)} | ${x.m.muestrasRecortadas} | ${x.m.ventanasRepetidas} | ${f(x.m.vozSobreAmbienteDb)} |`).join("\n")}

(LUFS aproximado: ponderación K sin compuerta. «Voz sobre ambiente» = RMS de la voz contra el RMS de todo lo demás durante las frases; los archivos 4 se miden antes de pasar a teléfono.)

## Cómo cambiar algo

Volumen, preset y tecleo se eligen en el panel: Ajustes del agente → «Preset restaurante humano» y «Sonido de fondo de restaurante». Para regenerar con otra semilla o duración: \`npx vite-node scripts/voz-muestras-ambiente/generar.ts -- --semilla 2 --segundos 20\`.
`;
writeFileSync(join(out, "README.md"), readme);
console.log(`Listo: ${filas.length} archivos en ${out}`);
