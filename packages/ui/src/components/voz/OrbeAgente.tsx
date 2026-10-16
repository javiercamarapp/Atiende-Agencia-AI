import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { suavizarConAtaque } from "./medidor-volumen.js";
import type { ModoOrb } from "./tipos.js";

/** Etiquetas accesibles por estado (el orbe es una imagen con rol, no un botón). */
export const ETIQUETA_MODO_ORB: Readonly<Record<ModoOrb, string>> = {
  reposo: "en reposo",
  conectando: "conectando",
  escuchando: "escuchando",
  pensando: "pensando",
  hablando: "hablando",
  error: "con un error",
};

/**
 * Qué nivel de audio mueve al orbe en cada estado: el del usuario mientras el
 * agente escucha, el del agente mientras habla, y nada en los demás (reposo,
 * conectando, pensando y error tienen animación propia, no reactiva).
 */
export function volumenObjetivo(modo: ModoOrb, volumenEntrada: number, volumenSalida: number): number {
  if (modo === "escuchando") return volumenEntrada;
  if (modo === "hablando") return volumenSalida;
  return 0;
}

export interface OrbeAgenteProps {
  readonly modo: ModoOrb;
  /** Nivel del micrófono, 0..1. */
  readonly volumenEntrada?: number;
  /** Nivel del audio del agente, 0..1. */
  readonly volumenSalida?: number;
  /** Diámetro en px (el original usaba 224 = w-56). */
  readonly size?: number;
  /** Colores del degradado [principal, secundario]. Por defecto #1d4ed8 y #0ea5e9. */
  readonly colores?: readonly [string, string];
  /**
   * Video del orbe original (boomerang de 4 s generado con Higgsfield). Se muestra
   * como cargador en reposo/conectando; si no se pasa, el orbe es solo CSS.
   */
  readonly videoSrc?: string;
  /**
   * El video se ve en TODOS los estados (como el orbe del original, que nunca lo cambia por una animación CSS); el halo, las ondas y el anillo
   * siguen reaccionando al audio y al estado alrededor y encima de él. Sin esta bandera el video solo se ve en reposo/conectando.
   */
  readonly videoSiempre?: boolean;
  readonly className?: string;
}

/**
 * Orbe del agente de voz. Presentación pura: no sabe de proveedores, solo de
 * `modo` y de dos niveles 0..1. El nivel se suaviza (media móvil con ataque
 * rápido) y se escribe en la variable CSS `--vol` desde un requestAnimationFrame,
 * sin pasar por el estado de React (evita re-renderizar 60 veces por segundo).
 * `data-volumen` refleja el mismo valor para pruebas y depuración.
 */
export function OrbeAgente({ modo, volumenEntrada = 0, volumenSalida = 0, size = 224, colores, videoSrc, videoSiempre = false, className }: OrbeAgenteProps) {
  const raizRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Los niveles viajan por ref: el bucle de rAF lee siempre el último sin reiniciarse.
  const objetivoRef = useRef(0);
  objetivoRef.current = volumenObjetivo(modo, volumenEntrada, volumenSalida);

  useEffect(() => {
    const raiz = raizRef.current;
    if (!raiz) return undefined;
    let nivel = 0;
    let raf = 0;
    let vivo = true;
    const pintar = () => {
      if (!vivo) return;
      nivel = suavizarConAtaque(nivel, objetivoRef.current);
      // Debajo de 0.005 se considera silencio: evita escrituras de DOM infinitas al decaer.
      if (nivel < 0.005 && objetivoRef.current === 0) nivel = 0;
      const texto = nivel.toFixed(3);
      if (raiz.dataset.volumen !== texto) {
        raiz.style.setProperty("--vol", texto);
        raiz.dataset.volumen = texto;
      }
      raf = requestAnimationFrame(pintar);
    };
    raf = requestAnimationFrame(pintar);
    return () => {
      vivo = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const videoVisible = Boolean(videoSrc) && (videoSiempre || modo === "reposo" || modo === "conectando");

  // Boomerang del video original: adelante hasta el final, luego hacia atrás hasta
  // el inicio, repite; se maneja currentTime a mano vía rAF para que nunca haya un
  // salto brusco (el video de 4 s no cierra en loop perfecto). Solo corre mientras
  // el video está visible.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoVisible) return undefined;
    let direccion = 1;
    let raf = 0;
    const paso = 1 / 30;
    const tick = () => {
      if (video.duration && !Number.isNaN(video.duration)) {
        let t = video.currentTime + direccion * paso;
        if (t >= video.duration) {
          direccion = -1;
          t = video.duration;
        } else if (t <= 0) {
          direccion = 1;
          t = 0;
        }
        video.currentTime = t;
      }
      raf = requestAnimationFrame(tick);
    };
    try {
      video.pause();
    } catch {
      // entornos sin reproducción de medios (pruebas): el boomerang es solo decoración
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoVisible]);

  return (
    <div
      ref={raizRef}
      role="img"
      aria-label={`Agente de voz ${ETIQUETA_MODO_ORB[modo]}`}
      data-modo={modo}
      data-video={videoVisible ? "visible" : "oculto"}
      data-volumen="0.000"
      className={`voz-orbe${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        ...(colores ? ({ "--orbe-c1": colores[0], "--orbe-c2": colores[1] } as CSSProperties) : null),
      }}
    >
      <div className="voz-orbe__halo" aria-hidden />
      <div className="voz-orbe__nucleo" aria-hidden>
        <div className="voz-orbe__onda voz-orbe__onda--a" />
        <div className="voz-orbe__onda voz-orbe__onda--b" />
        {videoSrc ? <video ref={videoRef} className="voz-orbe__video" src={videoSrc} autoPlay muted playsInline tabIndex={-1} /> : null}
      </div>
      <div className="voz-orbe__anillo" aria-hidden />
    </div>
  );
}
