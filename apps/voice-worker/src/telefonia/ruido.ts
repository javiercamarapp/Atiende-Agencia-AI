// Cancelacion de ruido de LiveKit (Krisp) sobre el audio del CLIENTE, antes del STT. Se aplica en el agente, no en el troncal SIP: la doc de LiveKit pide no
// encimar el NC del troncal (`krisp_enabled`) con el del agente.
//   (por omision `ninguno`: se enciende explicito tras medirlo con voz real)
//   krisp-telefonia  BVC telefonico (`TelephonyBackgroundVoiceCancellation`): quita cocina, musica y la conversacion de al lado; afinado para audio SIP de 8 kHz.
//   krisp            NC estandar (`NoiseCancellation`): solo ruido estacionario; para pedidos de grupo donde hablan varios legitimos.
//   ninguno          sin filtro.
// Requiere LiveKit Cloud (el modulo valida contra el servidor). VIVA (voice isolation) aun no existe en el paquete de Node: BVC telefonico es lo mas cercano.
// El paquete trae un binario nativo por plataforma: si no carga (maquina sin el binario), la llamada se atiende SIN filtro y queda el evento `ruido_no_disponible`.
import type { NoiseCancellationOptions } from "@livekit/rtc-node";
import type { ModoRuido } from "../config.ts";

type Log = (evento: string, campos?: Readonly<Record<string, string | number | boolean>>) => void;
type ModuloNc = { readonly TelephonyBackgroundVoiceCancellation: () => NoiseCancellationOptions; readonly NoiseCancellation: () => NoiseCancellationOptions };

/** Fabrica por pista (cada `AudioStream` necesita sus propias opciones), o null si el modo es `ninguno` o el modulo no esta. */
export async function cargarCancelacionRuido(modo: ModoRuido, log: Log, importar: () => Promise<ModuloNc> = () => import("@livekit/noise-cancellation-node") as Promise<ModuloNc>): Promise<(() => NoiseCancellationOptions) | null> {
  if (modo === "ninguno") return null;
  try {
    const m = await importar();
    const fabrica = modo === "krisp-telefonia" ? m.TelephonyBackgroundVoiceCancellation : m.NoiseCancellation;
    if (typeof fabrica !== "function") throw new Error("sin_fabrica");
    log("ruido_activo", { modo });
    return () => fabrica();
  } catch {
    log("ruido_no_disponible", { modo });
    return null;
  }
}
