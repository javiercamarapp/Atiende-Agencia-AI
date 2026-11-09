// AudioWorklet de la llamada de prueba de voz (apps/web/src/lib/voz/entorno-navegador.ts): reenvia cada bloque del
// microfono al hilo principal. Archivo estatico del mismo origen para que la CSP (script-src 'self') lo permita sin blob:.
class Captura extends AudioWorkletProcessor {
  process(entradas) {
    const c = entradas[0] && entradas[0][0];
    if (c) this.port.postMessage(c.slice(0));
    return true;
  }
}
registerProcessor("captura-pcm", Captura);
