import { Mic, MicOff, PlayCircle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
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
  /**
   * Si la llamada es una simulación (modo demo) se muestra una etiqueta visible: la
   * persona nunca debe confundirla con una llamada al agente real.
   */
  readonly etiquetaSimulacion?: string;
  /** Si no se puede iniciar (p. ej. el servicio no está disponible), motivo honesto que se muestra en vez del botón activo. */
  readonly motivoNoDisponible?: string;
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

/**
 * Layout de la vista previa de llamada (pantalla completa): orbe sobre el campo de
 * píxeles a la izquierda, transcripción y botón Iniciar/Terminar a la derecha.
 * Desacoplado del proveedor: solo consume un `VoiceSessionController`. Portado del
 * panel original, con el orbe reactivo en lugar del video fijo y sin framer-motion.
 */
export function VistaPreviaLlamada({ controller, nombreAgente, nombreSucursal, onCerrar, videoSrc, etiquetaSimulacion, motivoNoDisponible, pie }: VistaPreviaLlamadaProps) {
  const { estado, silenciado } = controller;
  const activa = sesionActiva(estado.modo);
  const conectando = estado.modo === "conectando";
  const bloqueada = Boolean(motivoNoDisponible) && !activa;

  const alternar = () => {
    if (conectando || bloqueada) return;
    void (activa ? controller.terminar() : controller.iniciar());
  };

  return (
    <div className="voz-aparece absolute inset-0 z-30 bg-background flex flex-col" data-modo={estado.modo}>
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
            {ETIQUETA_CHIP[estado.modo]}
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
            <OrbeAgente modo={estado.modo} volumenEntrada={estado.volumenEntrada} volumenSalida={estado.volumenSalida} videoSrc={videoSrc} />
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
}
