// Contrato de UI del Copiloto "Chatea con tus datos" (ChatDatosShell). Duplica a proposito la forma de
// DataChatAnswer del motor (agent-core/src/data-chat/types.ts) para que packages/ui NO dependa de
// agent-core: el transporte de cada vertical traduce la respuesta del servidor a estos tipos.
// El shell no tiene datos propios: todo lo que muestra llega por el transporte.

export type CopilotoColumnaTipo = "text" | "integer" | "mxn" | "percent" | "decimal";
export type CopilotoCelda = string | number | null;

export interface CopilotoColumna {
  readonly key: string;
  readonly label: string;
  readonly kind: CopilotoColumnaTipo;
}

export interface CopilotoBloque {
  readonly tool: string;
  readonly title: string;
  readonly columns: readonly CopilotoColumna[];
  readonly rows: readonly Readonly<Record<string, CopilotoCelda>>[];
  /** Representacion que el CATALOGO eligio para este bloque (nunca el modelo). Si los datos no alcanzan para
   *  dibujarla, el bloque se muestra como tabla. `kpi`: 1 fila con 1-4 columnas numericas. */
  readonly chart?: { readonly kind: "bar" | "line" | "donut" | "kpi"; readonly x: string; readonly y: string };
  /** Mini serie por fila (`series[i]` es de `rows[i]`): se dibuja como sparkline en una columna extra. */
  readonly sparkline?: { readonly label: string; readonly series: readonly (readonly number[])[] };
  readonly truncated: boolean;
}

export interface CopilotoFuente {
  readonly tool: string;
  readonly source: string;
  readonly periodLabel?: string;
  readonly scopeLabel: string;
}

/** Estados del servidor mas dos de transporte: `apagado` (interruptor de plataforma) y `forbidden` (403 de rol). */
export type CopilotoStatus =
  | "ok"
  | "no_data"
  | "clarify"
  | "out_of_catalog"
  | "rate_limited"
  | "budget_exceeded"
  | "unavailable"
  | "invalid_input"
  | "apagado"
  | "forbidden";

export interface CopilotoRespuesta {
  readonly text: string;
  readonly status: CopilotoStatus;
  readonly blocks?: readonly CopilotoBloque[];
  readonly sources?: readonly CopilotoFuente[];
  /** Posicion del mensaje en la conversacion guardada (habilita PDF y fijar). */
  readonly seq?: number;
  /** `out_of_catalog`: preguntas que si se pueden consultar (se ofrecen como chips). */
  readonly sugerencias?: readonly string[];
  /** `rate_limited`: segundos de espera. */
  readonly reintentarEnSeg?: number;
  /** `rate_limited` por tope diario: cuantas preguntas permite el dia. */
  readonly limiteDiario?: number;
}

export type CopilotoEvento =
  | { readonly t: "paso"; readonly fase: "inicio" | "fin"; readonly herramienta: string }
  | { readonly t: "fin"; readonly respuesta: CopilotoRespuesta; readonly conversacionId?: string; readonly seq?: number }
  | { readonly t: "error"; readonly status: CopilotoStatus; readonly mensaje: string; readonly reintentarEnSeg?: number };

export interface ConversacionResumen {
  readonly id: string;
  readonly titulo: string;
  /** ISO 8601. */
  readonly actualizadaEn: string;
  readonly fijada?: boolean;
}

export interface CopilotoMensaje {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status?: CopilotoStatus;
  readonly blocks?: readonly CopilotoBloque[];
  readonly sources?: readonly CopilotoFuente[];
  readonly seq?: number;
  readonly sugerencias?: readonly string[];
  readonly reintentarEnSeg?: number;
  readonly limiteDiario?: number;
  /** El usuario detuvo el turno: no se guarda en el servidor. */
  readonly cancelado?: boolean;
}

export interface ConversacionCompleta {
  readonly id: string;
  readonly titulo: string;
  readonly mensajes: readonly CopilotoMensaje[];
}

export interface CopilotoTransporte {
  /** Envia una pregunta. Debe reportar `paso`/`fin`/`error` por `onEvento` (NDJSON) y/o devolver la respuesta final. */
  enviar(p: {
    pregunta: string;
    conversacionId?: string;
    senal: AbortSignal;
    onEvento: (e: CopilotoEvento) => void;
  }): Promise<CopilotoRespuesta>;
  /** Sin `listar`, el boton Historial no se muestra (no hay historial persistido que ofrecer). */
  listar?(senal: AbortSignal): Promise<readonly ConversacionResumen[]>;
  abrir?(id: string, senal: AbortSignal): Promise<ConversacionCompleta>;
  renombrar?(id: string, titulo: string): Promise<void>;
  borrar?(id: string): Promise<void>;
  /** URL de GET del servidor que descarga el PDF del mensaje. Sin ella, no se ofrece "Descargar PDF". */
  urlPdf?(conversacionId: string, seq: number): string;
  /** Fija el primer bloque del mensaje en el tablero. Sin ella, no se ofrece "Fijar". */
  fijar?(conversacionId: string, seq: number, bloque: number): Promise<void>;
}

/** Error que un transporte puede lanzar para que el shell muestre el aviso del `status` correcto. */
export class CopilotoErrorTransporte extends Error {
  readonly status: CopilotoStatus;
  readonly reintentarEnSeg?: number;
  constructor(status: CopilotoStatus, mensaje = status, reintentarEnSeg?: number) {
    super(mensaje);
    this.name = "CopilotoErrorTransporte";
    this.status = status;
    if (reintentarEnSeg !== undefined) this.reintentarEnSeg = reintentarEnSeg;
  }
}

export interface CopilotoTextos {
  readonly titulo: string;
  readonly subtitulo: string;
  readonly nota: string;
  readonly placeholder: string;
  /** Fases del "pensando" por tiempo transcurrido: [milisegundos, texto]. */
  readonly fases: ReadonlyArray<readonly [number, string]>;
  /** Ej. "Sucursal: Centro" / "Todas tus sucursales". */
  readonly contexto?: string;
}

export interface CopilotoCategoria {
  readonly titulo: string;
  readonly preguntas: readonly string[];
}

export interface ChatDatosShellProps {
  readonly transporte: CopilotoTransporte;
  readonly textos: CopilotoTextos;
  /** Chips en reposo (maximo 5). */
  readonly sugerencias: readonly string[];
  /** Tarjetas de la portada (3, como atiende-restaurantes). */
  readonly categorias: readonly CopilotoCategoria[];
  /** Nombre visible de cada herramienta del catalogo (para los pasos "en vivo"). */
  readonly etiquetasHerramienta: Readonly<Record<string, string>>;
  /** Herramienta -> ruta interna de la pantalla fuente (lista blanca: solo rutas que empiezan con "/"). */
  readonly rutasFuente?: Readonly<Record<string, string>>;
  readonly maxCaracteres: number;
  /** Vertical (p. ej. "restaurantes"): solo se usa para nombrar los archivos CSV descargados. */
  readonly vertical?: string;
  readonly uso?: { readonly pct: number; readonly etiqueta: string };
  readonly conversacionInicial?: string;
  readonly onConversacionCambia?: (id?: string) => void;
  /** Zona horaria IANA de la organizacion para agrupar el historial por dia. Por defecto, la del navegador. */
  readonly zonaHoraria?: string;
  /** Reloj inyectable (pruebas). */
  readonly ahora?: () => Date;
}
