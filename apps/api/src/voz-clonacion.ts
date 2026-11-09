// Clonacion instantanea de voz (ElevenLabs IVC) para la voz TELEFONICA de una sucursal de restaurantes.
//
// Puerto + adaptador HTTP sin SDK. La llave (`ELEVENLABS_API_KEY`) vive solo en el servidor: el navegador sube las muestras a
// NUESTRA API (`POST /v1/restaurantes/:propertyId/admin/voz/clonar`) y nunca habla con ElevenLabs. Sin llave, `deps.clonadorVoz`
// queda ausente y la ruta responde 503 honesto ("no disponible aun"). La voz clonada queda en la cuenta de ElevenLabs de la
// plataforma, la MISMA que usa el worker de voz para el TTS de la llamada.

/** Una muestra de audio tal como llega del formulario (ya acotada en tamano y tipo por la ruta). */
export interface MuestraVoz {
  readonly nombre: string;
  readonly tipo: string;
  readonly bytes: Uint8Array;
}

export interface ClonarVozEntrada {
  /** Nombre visible de la voz en la cuenta del proveedor (ya saneado por la ruta). */
  readonly nombre: string;
  readonly muestras: readonly MuestraVoz[];
  /** Pide al proveedor quitar el ruido de fondo de las muestras. */
  readonly quitarRuido: boolean;
  /** Etiquetas no sensibles para ubicar la voz en la cuenta (organizacion y sucursal; nunca PII). */
  readonly etiquetas: Readonly<Record<string, string>>;
}

export interface ClonadorVoz {
  /** Crea la voz y devuelve su id (20 alfanumericos). Lanza `ClonacionVozError` si el proveedor la rechaza o falla. */
  clonar(entrada: ClonarVozEntrada): Promise<{ readonly voiceId: string }>;
  /** Borra una voz creada por `clonar` (mejor esfuerzo: compensacion cuando no se pudo guardar en la base). */
  borrar(voiceId: string): Promise<void>;
}

/** Fallo del proveedor. `rechazo` = el proveedor no acepto las muestras (4xx); el resto es indisponibilidad (5xx, red, respuesta rara). */
export class ClonacionVozError extends Error {
  constructor(
    readonly tipo: "rechazo" | "proveedor",
    readonly estado: number | null,
  ) {
    super(tipo === "rechazo" ? "El proveedor de voz rechazo las muestras." : "El proveedor de voz no respondio.");
    this.name = "ClonacionVozError";
  }
}

export const VOZ_ELEVENLABS_ID_RE = /^[A-Za-z0-9]{20}$/;
const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const TIEMPO_MAX_MS = 45_000;

export interface ElevenLabsClonadorOpciones {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly tiempoMaxMs?: number;
}

export class ElevenLabsClonadorVoz implements ClonadorVoz {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly tiempoMaxMs: number;

  constructor(private readonly opciones: ElevenLabsClonadorOpciones) {
    this.fetchImpl = opciones.fetchImpl ?? fetch;
    this.baseUrl = (opciones.baseUrl ?? ELEVENLABS_API).replace(/\/+$/, "");
    this.tiempoMaxMs = opciones.tiempoMaxMs ?? TIEMPO_MAX_MS;
  }

  async clonar(entrada: ClonarVozEntrada): Promise<{ readonly voiceId: string }> {
    const form = new FormData();
    form.append("name", entrada.nombre);
    form.append("remove_background_noise", entrada.quitarRuido ? "true" : "false");
    form.append("labels", JSON.stringify(entrada.etiquetas));
    for (const m of entrada.muestras) {
      // Copia a un ArrayBuffer propio: `Blob` no acepta vistas sobre SharedArrayBuffer en los tipos de TS.
      const copia = new Uint8Array(m.bytes.byteLength);
      copia.set(m.bytes);
      form.append("files", new Blob([copia.buffer], { type: m.tipo }), m.nombre);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/voices/add`, { method: "POST", headers: { "xi-api-key": this.opciones.apiKey }, body: form, signal: AbortSignal.timeout(this.tiempoMaxMs) });
    } catch {
      throw new ClonacionVozError("proveedor", null);
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) throw new ClonacionVozError("rechazo", res.status);
    if (!res.ok) throw new ClonacionVozError("proveedor", res.status);
    let cuerpo: unknown;
    try {
      cuerpo = await res.json();
    } catch {
      throw new ClonacionVozError("proveedor", res.status);
    }
    const voiceId = (cuerpo as { voice_id?: unknown } | null)?.voice_id;
    // Solo un id con el formato de ElevenLabs viaja a la base (el CHECK de la migracion 103 exige lo mismo).
    if (typeof voiceId !== "string" || !VOZ_ELEVENLABS_ID_RE.test(voiceId)) throw new ClonacionVozError("proveedor", res.status);
    return { voiceId };
  }

  async borrar(voiceId: string): Promise<void> {
    if (!VOZ_ELEVENLABS_ID_RE.test(voiceId)) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/voices/${voiceId}`, { method: "DELETE", headers: { "xi-api-key": this.opciones.apiKey }, signal: AbortSignal.timeout(this.tiempoMaxMs) });
    } catch {
      // Mejor esfuerzo: una voz huerfana en la cuenta no afecta a ninguna sucursal (ninguna la tiene guardada).
    }
  }
}

/** Produccion: el clonador solo existe con la llave configurada; sin ella la ruta responde 503 honesto. */
export function clonadorVozDesdeEnv(apiKey: string | null | undefined): ClonadorVoz | undefined {
  return apiKey ? new ElevenLabsClonadorVoz({ apiKey }) : undefined;
}
