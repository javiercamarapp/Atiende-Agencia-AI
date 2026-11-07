// Respaldo por ETAPA dentro de la misma sesion: si el proveedor principal de STT o TTS (ElevenLabs) no abre o se cae a media llamada, la etapa pasa al
// respaldo (Deepgram Nova-3 / Aura-2) sin tirar la llamada ni bajar de escalon. Solo si tambien falla el respaldo la etapa avisa la caida (y la escalera decide).
//
//   STT: falla al abrir -> abre el respaldo. Caida despues de abrir -> abre el respaldo y sigue; el audio que llegue mientras abre se guarda (tope ~2 s) y se reenvia.
//   TTS: falla al abrir -> abre el respaldo. Una frase que falla ANTES de dar audio se repite con el respaldo y la sesion se queda en el respaldo; si ya habia
//        sonado parte de la frase, el error sube (no se repite media frase con otra voz) pero las frases siguientes van por el respaldo.
// Cada cambio deja el evento `v2_respaldo` (etapa y codigo corto, sin PII).
import type { EventosStt, OpcionesStt, OpcionesTts, ProveedorStt, ProveedorTts, PuertoSttVoz, PuertoTtsVoz, SesionStt, SesionTts } from "./puertos.ts";

export type AvisoRespaldo = (etapa: "stt" | "tts", momento: "apertura" | "caida", codigo: string) => void;

const codigoDe = (err: unknown): string => {
  const m = err instanceof Error ? err.message : "";
  return /^[a-z0-9_]{1,40}$/.test(m) ? m : "error";
};

/** Tope del audio guardado mientras abre el STT de respaldo: 2 s de PCM16 a 16 kHz. */
const BUFFER_RESPALDO_BYTES = 64_000;

class SttConRespaldo implements SesionStt {
  private actual: SesionStt | null = null;
  private enRespaldo = false;
  private abriendoRespaldo = false;
  private pendiente: Uint8Array[] = [];
  private bytesPendientes = 0;
  private cerrada = false;

  constructor(
    private readonly respaldo: PuertoSttVoz,
    private readonly opciones: OpcionesStt,
    private readonly eventos: EventosStt,
    private readonly avisar: AvisoRespaldo | undefined,
  ) {}

  /** Eventos para la sesion vigente: los de una sesion ya reemplazada se ignoran. */
  eventosPara(cual: "principal" | "respaldo"): EventosStt {
    const vigente = (): boolean => !this.cerrada && (cual === "respaldo") === this.enRespaldo;
    return {
      hablaIniciada: () => vigente() && this.eventos.hablaIniciada(),
      parcial: (t) => vigente() && this.eventos.parcial(t),
      turnoFinal: (t) => vigente() && this.eventos.turnoFinal(t),
      caido: (codigo) => {
        if (!vigente()) return;
        if (cual === "principal") void this.pasarARespaldo(codigo);
        else this.eventos.caido(codigo);
      },
    };
  }

  usar(sesion: SesionStt, respaldo: boolean): void {
    this.actual = sesion;
    this.enRespaldo = respaldo;
  }

  private async pasarARespaldo(codigo: string): Promise<void> {
    if (this.abriendoRespaldo || this.enRespaldo) return;
    this.abriendoRespaldo = true;
    const caida = this.actual;
    this.actual = null;
    this.enRespaldo = true;
    this.avisar?.("stt", "caida", codigo);
    void caida?.cerrar().catch(() => undefined);
    try {
      const s = await this.respaldo.abrir(this.opciones, this.eventosPara("respaldo"));
      if (this.cerrada) {
        await s.cerrar();
        return;
      }
      this.actual = s;
      for (const b of this.pendiente) s.enviarAudio(b);
    } catch {
      this.eventos.caido(codigo);
    } finally {
      this.pendiente = [];
      this.bytesPendientes = 0;
      this.abriendoRespaldo = false;
    }
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerrada) return;
    if (this.actual) {
      this.actual.enviarAudio(pcm16);
      return;
    }
    if (!this.abriendoRespaldo) return;
    this.pendiente.push(pcm16);
    this.bytesPendientes += pcm16.byteLength;
    while (this.bytesPendientes > BUFFER_RESPALDO_BYTES && this.pendiente.length > 0) this.bytesPendientes -= this.pendiente.shift()!.byteLength;
  }

  proveedor(): ProveedorStt {
    return this.actual?.proveedor?.() ?? (this.enRespaldo ? "deepgram" : "elevenlabs");
  }

  conKeyterms(): boolean {
    return this.actual?.conKeyterms?.() ?? (this.opciones.vocabulario?.length ?? 0) > 0;
  }

  async cerrar(): Promise<void> {
    this.cerrada = true;
    const s = this.actual;
    this.actual = null;
    await s?.cerrar();
  }
}

/** STT principal con respaldo automatico. */
export function sttConRespaldo(principal: PuertoSttVoz, respaldo: PuertoSttVoz, avisar?: AvisoRespaldo): PuertoSttVoz {
  return {
    async abrir(opciones, eventos) {
      const envoltura = new SttConRespaldo(respaldo, opciones, eventos, avisar);
      try {
        envoltura.usar(await principal.abrir(opciones, envoltura.eventosPara("principal")), false);
      } catch (err) {
        avisar?.("stt", "apertura", codigoDe(err));
        envoltura.usar(await respaldo.abrir(opciones, envoltura.eventosPara("respaldo")), true);
      }
      return envoltura;
    },
  };
}

class TtsConRespaldo implements SesionTts {
  private respaldoAbierto: SesionTts | null = null;

  constructor(
    private principal: SesionTts | null,
    private readonly respaldo: PuertoTtsVoz,
    private readonly opcionesRespaldo: OpcionesTts,
    private readonly avisar: AvisoRespaldo | undefined,
  ) {}

  private async sesionRespaldo(): Promise<SesionTts> {
    this.respaldoAbierto ??= await this.respaldo.abrir(this.opcionesRespaldo);
    return this.respaldoAbierto;
  }

  usarRespaldo(s: SesionTts): void {
    this.respaldoAbierto = s;
  }

  async *sintetizar(texto: string, senal: AbortSignal): AsyncIterable<Uint8Array> {
    const p = this.principal;
    if (p) {
      let dioAudio = false;
      try {
        for await (const pcm of p.sintetizar(texto, senal)) {
          dioAudio = true;
          yield pcm;
        }
        return;
      } catch (err) {
        if (senal.aborted) return;
        this.principal = null;
        void p.cerrar().catch(() => undefined);
        this.avisar?.("tts", "caida", codigoDe(err));
        if (dioAudio) throw err;
      }
    }
    const r = await this.sesionRespaldo();
    yield* r.sintetizar(texto, senal);
  }

  flushesDisponibles(): number {
    if (this.principal) return Number.POSITIVE_INFINITY;
    return this.respaldoAbierto?.flushesDisponibles?.() ?? Number.POSITIVE_INFINITY;
  }

  proveedor(): ProveedorTts {
    return this.principal ? (this.principal.proveedor?.() ?? "elevenlabs-tts") : (this.respaldoAbierto?.proveedor?.() ?? "deepgram-aura-2");
  }

  async cerrar(): Promise<void> {
    await Promise.allSettled([this.principal?.cerrar(), this.respaldoAbierto?.cerrar()]);
  }
}

/** TTS principal con respaldo automatico. `vozRespaldo` es la voz del respaldo (la del principal no le sirve: otro catalogo). */
export function ttsConRespaldo(principal: PuertoTtsVoz, respaldo: PuertoTtsVoz, vozRespaldo: string, avisar?: AvisoRespaldo): PuertoTtsVoz {
  return {
    async abrir(opciones) {
      const opcionesRespaldo: OpcionesTts = { ...opciones, voz: vozRespaldo };
      try {
        return new TtsConRespaldo(await principal.abrir(opciones), respaldo, opcionesRespaldo, avisar);
      } catch (err) {
        avisar?.("tts", "apertura", codigoDe(err));
        const env = new TtsConRespaldo(null, respaldo, opcionesRespaldo, avisar);
        env.usarRespaldo(await respaldo.abrir(opcionesRespaldo));
        return env;
      }
    },
  };
}
