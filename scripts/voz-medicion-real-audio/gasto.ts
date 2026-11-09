// Tope de gasto y de duracion de una corrida del arnes con audio REAL. El costo de Deepgram NO se lee de su API (la llave de la cuenta no tiene los scopes `usage:read`/`billing:read`,
// verificado con HTTP 403): se calcula con lo que de verdad se envio y se pidio (minutos de audio de STT x tarifa vigente de config-plataforma.ts, + add-on keyterm, + caracteres de TTS x tarifa Aura-2).
export interface TarifasDeepgram {
  readonly sttUsdPorMinuto: number;
  readonly keytermUsdPorMinuto: number;
  readonly ttsUsdPorMilCaracteres: number;
}

export interface TopesGasto {
  /** Tope de gasto de Deepgram de la corrida (USD). */
  readonly usd: number;
  /** Tope de audio de STT enviado en toda la corrida (segundos). */
  readonly audioS: number;
  /** Tope de audio de STT por llamada (segundos). */
  readonly llamadaS: number;
}

export class TopeExcedido extends Error {
  constructor(readonly motivo: "usd" | "audio" | "llamada", detalle: string) { super(`TOPE:${motivo} ${detalle}`); }
}

export class GastoDeepgram {
  sttS = 0; sttConKeytermsS = 0; ttsChars = 0; llamadaS = 0;
  constructor(private readonly t: TarifasDeepgram, readonly topes: TopesGasto) {}

  get usdStt(): number { return ((this.sttS - this.sttConKeytermsS) * this.t.sttUsdPorMinuto + this.sttConKeytermsS * (this.t.sttUsdPorMinuto + this.t.keytermUsdPorMinuto)) / 60; }
  get usdTts(): number { return (this.ttsChars * this.t.ttsUsdPorMilCaracteres) / 1000; }
  get usd(): number { return this.usdStt + this.usdTts; }

  nuevaLlamada(): void { this.llamadaS = 0; }
  /** Registra audio de STT enviado; lanza `TopeExcedido` si con esto se pasa de un tope (el audio ya enviado cuenta). */
  audioStt(segundos: number, conKeyterms: boolean): void {
    this.sttS += segundos; this.llamadaS += segundos;
    if (conKeyterms) this.sttConKeytermsS += segundos;
    this.verificar();
  }
  tts(caracteres: number): void { this.ttsChars += caracteres; this.verificar(); }

  verificar(): void {
    if (this.usd > this.topes.usd) throw new TopeExcedido("usd", `$${this.usd.toFixed(4)} > $${this.topes.usd}`);
    if (this.sttS > this.topes.audioS) throw new TopeExcedido("audio", `${this.sttS.toFixed(0)}s > ${this.topes.audioS}s`);
    if (this.llamadaS > this.topes.llamadaS) throw new TopeExcedido("llamada", `${this.llamadaS.toFixed(0)}s > ${this.topes.llamadaS}s por llamada`);
  }
  excedido(): boolean { try { this.verificar(); return false; } catch { return true; } }
  resumen() { return { sttS: Math.round(this.sttS * 10) / 10, ttsChars: this.ttsChars, usdStt: this.usdStt, usdTts: this.usdTts, usd: this.usd }; }
}
