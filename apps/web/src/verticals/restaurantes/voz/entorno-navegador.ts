// Entorno REAL del navegador para la llamada de prueba: WebSocket, microfono (getUserMedia + AudioWorklet) y reproduccion (WebAudio).
// Es la unica capa que toca APIs del navegador; el protocolo y las politicas viven en adaptador-gemini-live.ts (con pruebas). No se
// puede probar en jsdom (no hay WebAudio): se comprueba en un navegador con credencial (docs/VOZ-PM.md, "Vista previa").
import type { CapturaMicrofono, EntornoVoz, ReproductorAudio, SocketPreview } from "./adaptador-gemini-live.ts";
import { nivelRms } from "./audio-pcm.ts";

const WORKLET = `class Captura extends AudioWorkletProcessor { process(entradas) { const c = entradas[0] && entradas[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("captura-pcm", Captura);`;
const MUESTRAS_POR_BLOQUE = 2048;

async function capturarMicrofono(onBloque: (m: Float32Array, tasaHz: number) => void): Promise<CapturaMicrofono> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no permite usar el micrófono.");
  let flujo: MediaStream;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new Error("No se pudo usar el micrófono. Revise el permiso del navegador e intente de nuevo.");
  }
  const contexto = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await contexto.audioWorklet.addModule(url);
  } catch {
    flujo.getTracks().forEach((t) => t.stop());
    void contexto.close();
    throw new Error("Este navegador no permite capturar el audio de la llamada de prueba.");
  } finally {
    URL.revokeObjectURL(url);
  }
  const fuente = contexto.createMediaStreamSource(flujo);
  const nodo = new AudioWorkletNode(contexto, "captura-pcm");
  let acumulado: number[] = [];
  nodo.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    for (const v of ev.data) acumulado.push(v);
    if (acumulado.length >= MUESTRAS_POR_BLOQUE) {
      onBloque(Float32Array.from(acumulado), contexto.sampleRate);
      acumulado = [];
    }
  };
  fuente.connect(nodo);
  return {
    detener() {
      fuente.disconnect();
      nodo.disconnect();
      flujo.getTracks().forEach((t) => t.stop());
      void contexto.close();
    },
  };
}

function crearReproductor(): ReproductorAudio {
  const contexto = new AudioContext();
  const analizador = contexto.createAnalyser();
  analizador.fftSize = 256;
  analizador.connect(contexto.destination);
  const fuentes = new Set<AudioBufferSourceNode>();
  let siguiente = 0;
  const bloque = new Float32Array(analizador.fftSize);
  return {
    encolar(muestras, tasaHz) {
      if (muestras.length === 0) return;
      const buffer = contexto.createBuffer(1, muestras.length, tasaHz);
      buffer.copyToChannel(Float32Array.from(muestras), 0);
      const fuente = contexto.createBufferSource();
      fuente.buffer = buffer;
      fuente.connect(analizador);
      siguiente = Math.max(siguiente, contexto.currentTime + 0.02);
      fuente.start(siguiente);
      siguiente += buffer.duration;
      fuentes.add(fuente);
      fuente.onended = () => fuentes.delete(fuente);
    },
    cortar() {
      for (const f of fuentes) {
        try {
          f.stop();
        } catch {
          /* ya termino */
        }
      }
      fuentes.clear();
      siguiente = 0;
    },
    nivel() {
      if (fuentes.size === 0) return 0;
      analizador.getFloatTimeDomainData(bloque);
      return nivelRms(bloque);
    },
    cerrar() {
      this.cortar();
      void contexto.close();
    },
  };
}

export const entornoNavegador: EntornoVoz = {
  abrirSocket: (url) => new WebSocket(url) as unknown as SocketPreview,
  capturarMicrofono,
  crearReproductor,
  esperar: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  repetir: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  ahora: () => Date.now(),
};
