// Telefonia REAL: LiveKit Cloud (o autoalojado) con SIP. Twilio entrega la llamada al inbound trunk de LiveKit y la regla de despacho crea UNA
// sala por llamada (prefijo `VOICE_ROOM_PREFIX`, por defecto `llamada-`). Este adaptador consulta las salas con ese prefijo, entra a cada una
// que aun no atendio con un token de servidor (identidad `agente-...`), se suscribe a la pista de audio del participante SIP y publica la pista
// del agente. El DNIS y el origen salen de los atributos del participante SIP (`sip.trunkPhoneNumber`, `sip.phoneNumber`), nunca del modelo.
//
// ESTADO DE VERIFICACION (honesto): compila contra el SDK oficial (@livekit/rtc-node, livekit-server-sdk) y su logica pura (`infoDeParticipanteSip`)
// esta probada, pero NO se ha probado contra un servidor LiveKit real (no hay cuenta ni numero en este entorno). Los nombres de atributos SIP
// y de los encabezados de desvio siguen la documentacion publica de LiveKit SIP y se confirman en la primera llamada real (docs/VOZ-PM.md).
import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, ParticipantKind, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import type { RemoteParticipant, Track } from "@livekit/rtc-node";
import { remuestrearPcm16 } from "../audio/remuestreo.ts";
import { infoDeParticipanteSip } from "./sip-atributos.ts";
import type { InfoParticipanteSip } from "./sip-atributos.ts";
import type { LlamadaTelefonica, TelefoniaPort } from "./puerto.ts";

export const HZ_ENTRADA_LIVEKIT = 16_000;
export const HZ_SALIDA_LIVEKIT = 24_000;
const FRAME_MS = 20;
const ESPERA_SIP_MS = 15_000;

export interface OpcionesLiveKit {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly prefijoSala?: string;
  readonly intervaloMs?: number;
  readonly log?: (evento: string, campos?: Readonly<Record<string, string | number | boolean>>) => void;
}

class LlamadaLiveKit implements LlamadaTelefonica {
  private cbAudio: ((pcm: Int16Array, hz: number) => void) | null = null;
  private cbDtmf: ((d: string) => void) | null = null;
  private cbColgar: (() => void) | null = null;
  private colgo = false;
  private generacion = 0;

  constructor(
    readonly id: string,
    private readonly info: InfoParticipanteSip,
    private readonly sala: Room,
    private readonly fuente: AudioSource,
    private readonly cerrarSala: () => Promise<void>,
  ) {}

  get dnis(): string | null {
    return this.info.dnis;
  }
  get sipFrom(): string | null {
    return this.info.sipFrom;
  }
  get desviadaDesde(): string | null {
    return this.info.desviadaDesde;
  }

  alAudio(cb: (pcm: Int16Array, hz: number) => void): void {
    this.cbAudio = cb;
  }
  alDtmf(cb: (digito: string) => void): void {
    this.cbDtmf = cb;
  }
  alColgar(cb: () => void): void {
    this.cbColgar = cb;
    if (this.colgo) cb();
  }

  entregarAudio(pcm: Int16Array): void {
    this.cbAudio?.(pcm, HZ_ENTRADA_LIVEKIT);
  }
  entregarDtmf(d: string): void {
    this.cbDtmf?.(d);
  }
  terminar(): void {
    if (this.colgo) return;
    this.colgo = true;
    this.generacion += 1;
    this.cbColgar?.();
  }

  async reproducir(pcm: Int16Array, hz: number): Promise<void> {
    if (this.colgo) return;
    const mia = ++this.generacion;
    const muestras = hz === HZ_SALIDA_LIVEKIT ? pcm : remuestrearPcm16(pcm, hz, HZ_SALIDA_LIVEKIT);
    const porFrame = (HZ_SALIDA_LIVEKIT * FRAME_MS) / 1000;
    for (let i = 0; i < muestras.length; i += porFrame) {
      if (this.colgo || this.generacion !== mia) return;
      const trozo = muestras.slice(i, i + porFrame);
      await this.fuente.captureFrame(new AudioFrame(trozo, HZ_SALIDA_LIVEKIT, 1, trozo.length));
    }
    if (this.generacion === mia && !this.colgo) await this.fuente.waitForPlayout();
  }

  detenerReproduccion(): void {
    this.generacion += 1;
    this.fuente.clearQueue();
  }

  async colgar(): Promise<void> {
    this.terminar();
    await this.cerrarSala();
  }
}

export class LiveKitTelefonia implements TelefoniaPort {
  private readonly servicio: RoomServiceClient;
  private readonly prefijo: string;
  private readonly atendidas = new Set<string>();
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private alLlegar: ((l: LlamadaTelefonica) => void) | null = null;
  private consultando = false;
  private ultimoLatido: number | null = null;
  private activas = new Set<Room>();

  constructor(private readonly o: OpcionesLiveKit) {
    this.servicio = new RoomServiceClient(o.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), o.apiKey, o.apiSecret);
    this.prefijo = o.prefijoSala ?? "llamada-";
  }

  async escuchar(alLlegar: (llamada: LlamadaTelefonica) => void): Promise<void> {
    this.alLlegar = alLlegar;
    await this.consultar();
    this.temporizador = setInterval(() => void this.consultar(), this.o.intervaloMs ?? 1000);
  }

  /** Ultimo sondeo exitoso de salas: si deja de avanzar, LiveKit no responde o el sondeo murio y el worker no esta atendiendo (aunque el proceso viva). */
  latidoMs(): number | null {
    return this.ultimoLatido;
  }

  async detener(): Promise<void> {
    this.alLlegar = null;
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await Promise.all([...this.activas].map((r) => r.disconnect().catch(() => undefined)));
  }

  private async consultar(): Promise<void> {
    if (this.consultando || !this.alLlegar) return;
    this.consultando = true;
    try {
      const salas = await this.servicio.listRooms();
      this.ultimoLatido = Date.now();
      for (const sala of salas) {
        if (!sala.name.startsWith(this.prefijo) || this.atendidas.has(sala.name)) continue;
        this.atendidas.add(sala.name);
        void this.unirse(sala.name).catch(() => {
          this.o.log?.("sala_no_atendida", { codigo: "unirse_fallo" });
        });
      }
      // Las salas que ya no existen salen del conjunto (un mismo nombre no se reutiliza, pero el conjunto no crece sin tope).
      const vivas = new Set(salas.map((s) => s.name));
      for (const n of this.atendidas) if (!vivas.has(n)) this.atendidas.delete(n);
    } catch {
      this.o.log?.("listar_salas_fallo", { codigo: "livekit_no_responde" });
    } finally {
      this.consultando = false;
    }
  }

  private async unirse(nombreSala: string): Promise<void> {
    const token = new AccessToken(this.o.apiKey, this.o.apiSecret, { identity: `agente-${randomUUID().slice(0, 8)}`, ttl: "2h" });
    token.addGrant({ roomJoin: true, room: nombreSala, canPublish: true, canSubscribe: true });
    const sala = new Room();
    await sala.connect(this.o.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    this.activas.add(sala);
    sala.on(RoomEvent.Disconnected, () => this.activas.delete(sala));

    const sip = await esperarParticipanteSip(sala);
    if (!sip) {
      this.o.log?.("sala_sin_participante_sip", { codigo: "timeout" });
      await sala.disconnect();
      return;
    }
    // Solo los NOMBRES de los atributos SIP (nunca los valores: traen telefonos): permiten confirmar en la primera llamada real que LiveKit entrega `sip.phoneNumber`,
    // `sip.trunkPhoneNumber` y `sip.h.diversion` / `sip.h.history-info` (docs/VOZ-ACTIVACION.md, paso del INVITE).
    this.o.log?.("sip_atributos", { claves: Object.keys(sip.attributes).filter((k) => k.startsWith("sip.")).sort().join(",").slice(0, 400) });
    const fuente = new AudioSource(HZ_SALIDA_LIVEKIT, 1);
    const pista = LocalAudioTrack.createAudioTrack("agente", fuente);
    await sala.localParticipant?.publishTrack(pista, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

    const cerrar = async (): Promise<void> => {
      await sala.disconnect().catch(() => undefined);
      // Borrar la sala termina la llamada SIP del lado de LiveKit.
      await this.servicio.deleteRoom(nombreSala).catch(() => undefined);
    };
    const llamada = new LlamadaLiveKit(nombreSala, infoDeParticipanteSip(sip.attributes), sala, fuente, cerrar);

    sala.on(RoomEvent.DtmfReceived, (_codigo, digito) => llamada.entregarDtmf(digito));
    sala.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity === sip.identity) llamada.terminar();
    });
    sala.on(RoomEvent.Disconnected, () => llamada.terminar());

    const suscribir = (track: Track): void => {
      const flujo = new AudioStream(track, { sampleRate: HZ_ENTRADA_LIVEKIT, numChannels: 1 });
      void (async () => {
        try {
          for await (const frame of flujo) llamada.entregarAudio(frame.data);
        } catch {
          /* la pista se cerro: el colgado lo avisan los eventos de la sala */
        }
      })();
    };
    for (const pub of sip.trackPublications.values()) {
      if (pub.kind === TrackKind.KIND_AUDIO && pub.track) suscribir(pub.track);
    }
    sala.on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
      if (p.identity === sip.identity && track.kind === TrackKind.KIND_AUDIO) suscribir(track);
    });

    this.alLlegar?.(llamada);
  }
}

function esperarParticipanteSip(sala: Room): Promise<RemoteParticipant | null> {
  const buscar = (): RemoteParticipant | undefined => [...sala.remoteParticipants.values()].find((p) => p.kind === ParticipantKind.SIP);
  const ya = buscar();
  if (ya) return Promise.resolve(ya);
  return new Promise((resolve) => {
    const limite = setTimeout(() => resolve(null), ESPERA_SIP_MS);
    sala.on(RoomEvent.ParticipantConnected, (p) => {
      if (p.kind !== ParticipantKind.SIP) return;
      clearTimeout(limite);
      resolve(p);
    });
  });
}
