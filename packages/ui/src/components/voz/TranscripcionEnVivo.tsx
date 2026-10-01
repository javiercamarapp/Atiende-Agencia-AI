import { useRef } from "react";
import type { ReactNode } from "react";
import { AtiendeMark } from "../AtiendeLogo.js";
import { TextoEscribiendose } from "./TextoEscribiendose.js";
import type { LineaTranscripcion } from "./tipos.js";

export interface TranscripcionEnVivoProps {
  readonly lineas: readonly LineaTranscripcion[];
  /** Contenido cuando todavía no hay líneas (estado vacío de la llamada). */
  readonly vacio?: ReactNode;
}

/**
 * Burbujas de transcripción. Agente a la izquierda con su marca, usuario a la
 * derecha. Una línea `parcial` se muestra tal como llega, con cursor parpadeante;
 * la última línea del agente que llegó completa de una vez (sin pasar por parcial)
 * se "teclea" como en el panel original. Una línea que ya se vio parcial nunca se
 * vuelve a teclear al cerrarse (evita repetir lo que el usuario acaba de leer).
 */
export function TranscripcionEnVivo({ lineas, vacio }: TranscripcionEnVivoProps) {
  // ids que alguna vez fueron parciales: al volverse definitivas no se re-tipean.
  const vistasParciales = useRef<Set<string>>(new Set());
  for (const l of lineas) if (l.parcial) vistasParciales.current.add(l.id);

  if (lineas.length === 0) return <>{vacio ?? null}</>;

  return (
    <div className="space-y-5" role="log" aria-live="polite" aria-label="Transcripción de la llamada">
      {lineas.map((l, i) => {
        const propio = l.rol === "usuario";
        const esUltima = i === lineas.length - 1;
        const teclear = esUltima && !propio && !l.parcial && !vistasParciales.current.has(l.id);
        return (
          <div key={l.id} data-rol={l.rol} data-parcial={l.parcial ? "true" : "false"} className={`voz-burbuja flex items-start gap-2.5 ${propio ? "justify-end" : ""}`}>
            {!propio && <AtiendeMark className="w-5 h-5 shrink-0 mt-0.5" />}
            <p className={`text-[14px] leading-relaxed max-w-[85%] text-foreground ${propio ? "text-right" : ""} ${l.parcial ? "opacity-80" : ""}`}>
              {teclear ? <TextoEscribiendose texto={l.texto} /> : l.texto}
              {l.parcial ? <span className="voz-cursor ml-0.5" aria-hidden>▍</span> : null}
            </p>
          </div>
        );
      })}
    </div>
  );
}
