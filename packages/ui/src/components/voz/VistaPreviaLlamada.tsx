import { Mic, MicOff, PlayCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as TecladoReact, ReactNode } from "react";
import { CampoPixeles } from "./CampoPixeles.js";
import { OrbeAgente } from "./OrbeAgente.js";
import { TranscripcionEnVivo } from "./TranscripcionEnVivo.js";
import { sesionActiva } from "./tipos.js";
import type { ModoOrb, VoiceSessionController } from "./tipos.js";

export interface VistaPreviaLlamadaProps {
  readonly controller: VoiceSessionController;
  readonly nombreAgente: string;
  readonly nombreSucursal: string;
  readonly onCerrar: () => void;
  /** Video del orbe original (cargador en reposo/conectando). */
  readonly videoSrc?: string;
  /** Mantiene el video del orbe en todos los estados de la llamada (el original nunca lo reemplaza por una animación CSS). */
  readonly videoSiempre?: boolean;
  /** Reemplaza el texto del chip de estado por modo (p. ej. «● Llamada en curso» en lugar de «● Escuchando»); el modo real sigue en `data-modo` y en el orbe. */
  readonly etiquetasChip?: Partial<Readonly<Record<ModoOrb, string>>>;
  /**
   * Si la llamada es una simulación (modo demo) se muestra una etiqueta visible: la
   * persona nunca debe confundirla con una llamada al agente real.
   */
  readonly etiquetaSimulacion?: string;
  /** Si no se puede iniciar (p. ej. el servicio no está disponible), motivo honesto que se muestra en vez del botón activo. */
  readonly motivoNoDisponible?: string;
  /**
   * Marco de contenido de escritorio (barra superior + pagina; `useMarcoShell`): si se pasa y la pantalla es de escritorio, la vista previa se monta ahi
   * y cubre TAMBIEN la barra superior, como el original (absolute inset-0 sobre todo el contenido). En movil (sin esa barra) queda en su sitio.
   */
  readonly portalEn?: HTMLElement | null;
  /** Contenido extra bajo el botón (avisos). */
  readonly pie?: ReactNode;
}

const ETIQUETA_CHIP: Readonly<Record<ModoOrb, string>> = {
  reposo: "Vista previa",
  conectando: "Conectando…",
  escuchando: "● Escuchando",
  pensando: "● Pensando",
  hablando: "● Hablando",
  error: "Error",
};

const CONSULTA_ESCRITORIO = "(min-width: 768px)";

/** `true`/`false` según el ancho de la ventana (reacciona al cambio de tamaño); `null` si el entorno no tiene matchMedia (pruebas). */
function useEscritorio(): boolean | null {
  return useSyncExternalStore(
    (aviso) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const mq = window.matchMedia(CONSULTA_ESCRITORIO);
      mq.addEventListener("change", aviso);
      return () => mq.removeEventListener("change", aviso);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(CONSULTA_ESCRITORIO).matches : null),
    () => null,
  );
}

const ENFOCABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Layout de la vista previa de llamada (pantalla completa): orbe sobre el campo de
 * píxeles a la izquierda, transcripción y botón Iniciar/Terminar a la derecha.
 * Desacoplado del proveedor: solo consume un `VoiceSessionController`. Portado del
 * panel original, con el orbe reactivo en lugar del video fijo y sin framer-motion.
 */
export function VistaPreviaLlamada({ controller, nombreAgente, nombreSucursal, onCerrar, videoSrc, videoSiempre, etiquetasChip, portalEn, etiquetaSimulacion, motivoNoDisponible, pie }: VistaPreviaLlamadaProps) {
  const { estado, silenciado } = controller;
  const activa = sesionActiva(estado.modo);
  const conectando = estado.modo === "conectando";
  const bloqueada = Boolean(motivoNoDisponible) && !activa;
  const panel = useRef<HTMLDivElement>(null);
  const escritorio = useEscritorio();
  // Móvil: pantalla completa fija sobre TODO (cabecera y barra inferior incluidas), montada en <body>. Escritorio con marco del shell: cubre barra y página.
  const enBody = escritorio === false;
  // Se comporta como un dialogo: el foco entra al panel al abrirse, Tab no sale de el, Escape lo cierra (igual que "‹ Atrás") y al cerrarse
  // el foco vuelve al control que lo abrio (QA-restaurantes-R1-botones-09).
  const alCerrar = useRef(onCerrar);
  alCerrar.current = onCerrar;
  useEffect(() => {
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        alCerrar.current();
      }
    };
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("keydown", alTeclear);
      previo?.focus?.();
    };
  }, []);
  const atraparTab = (e: TecladoReact<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(ENFOCABLES));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const primero = items[0]!;
    const ultimo = items[items.length - 1]!;
    const dentro = panel.current.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === primero || document.activeElement === panel.current || !dentro)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && (document.activeElement === ultimo || !dentro)) {
      e.preventDefault();
      primero.focus();
    }
  };

  const alternar = () => {
    if (conectando || bloqueada) return;
    void (activa ? controller.terminar() : controller.iniciar());
  };

  const contenido = (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={`Vista previa de llamada: ${nombreAgente}`}
      tabIndex={-1}
      onKeyDown={atraparTab}
      className={`voz-aparece ${enBody ? "fixed inset-0 z-50" : "absolute inset-0 z-30"} bg-background flex flex-col outline-none`}
      data-modo={estado.modo}
    >
      <header className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-3 min-w-0">
          <button type="button" onClick={onCerrar} className="text-[13px] text-muted-foreground hover:text-foreground transition-colors shrink-0">
            ‹ Atrás
          </button>
          <span className="text-border shrink-0">|</span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground truncate">{nombreAgente}</p>
            <p className="text-[10.5px] text-muted-foreground truncate">{nombreSucursal}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {etiquetaSimulacion ? (
            <span className="font-mono text-[10px] uppercase tracking-wide rounded-full px-2.5 py-1 border border-amber-500/40 text-amber-600 bg-amber-500/10">{etiquetaSimulacion}</span>
          ) : null}
          <span
            data-testid="chip-estado"
            className={`font-mono text-[10px] uppercase tracking-wide rounded-full px-2.5 py-1 border ${
              estado.modo === "error" ? "text-destructive border-destructive/30 bg-destructive/10" : activa ? "text-primary border-primary/30 bg-primary/10" : "text-muted-foreground border-border"
            }`}
          >
            {etiquetasChip?.[estado.modo] ?? ETIQUETA_CHIP[estado.modo]}
          </span>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        <div className="md:flex-[3] relative flex items-center justify-center overflow-hidden min-h-[260px] md:min-h-0">
          <CampoPixeles />
          <button
            type="button"
            onClick={alternar}
            disabled={bloqueada}
            title={activa ? "Terminar llamada" : "Iniciar llamada"}
            aria-label={activa ? "Terminar llamada" : "Iniciar llamada de prueba"}
            className="relative rounded-full transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
          >
            <OrbeAgente modo={estado.modo} volumenEntrada={estado.volumenEntrada} volumenSalida={estado.volumenSalida} videoSrc={videoSrc} videoSiempre={videoSiempre} />
          </button>
        </div>

        <div className="md:flex-[2] md:border-l border-t md:border-t-0 border-border flex flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-auto px-5 py-6">
            <TranscripcionEnVivo
              lineas={estado.transcripcion}
              vacio={
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center mb-3">
                    <Mic className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
                  </div>
                  <p className="text-[13px] font-medium text-foreground mb-1">{activa ? "Llamada iniciada" : "Aún no hay una llamada activa"}</p>
                  <p className="text-[11.5px] text-muted-foreground max-w-[220px] leading-snug">
                    {activa ? "Esperando el primer mensaje…" : "Toca el orbe o el botón de abajo para iniciar una llamada de prueba."}
                  </p>
                </div>
              }
            />
          </div>

          {estado.error ? (
            <div role="alert" className="mx-4 mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {estado.error.mensaje}
              {estado.error.recuperable ? <span className="block text-[11px] opacity-80 mt-0.5">Puedes volver a intentarlo.</span> : null}
            </div>
          ) : null}
          {bloqueada ? (
            <p role="status" className="mx-4 mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
              {motivoNoDisponible}
            </p>
          ) : null}
          {pie}

          <div className="p-4 border-t border-border flex items-center gap-2">
            {activa ? (
              <button
                type="button"
                onClick={() => controller.silenciar(!silenciado)}
                aria-pressed={silenciado}
                aria-label={silenciado ? "Activar micrófono" : "Silenciar micrófono"}
                title={silenciado ? "Activar micrófono" : "Silenciar micrófono"}
                className="h-10 w-10 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-muted transition-colors"
              >
                {silenciado ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            ) : null}
            <button
              type="button"
              onClick={alternar}
              disabled={conectando || bloqueada}
              className={`flex-1 flex items-center justify-center gap-2 h-10 rounded-full text-[13px] font-medium transition-colors disabled:opacity-50 ${
                activa ? "bg-destructive text-destructive-foreground hover:opacity-90" : "bg-primary text-primary-foreground hover:opacity-90"
              }`}
            >
              {activa ? <XCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
              {conectando ? "Conectando…" : activa ? "Terminar llamada" : estado.modo === "error" ? "Reintentar llamada" : "Iniciar llamada de prueba"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  if (enBody) return createPortal(contenido, document.body);
  return escritorio && portalEn ? createPortal(contenido, portalEn) : contenido;
}
