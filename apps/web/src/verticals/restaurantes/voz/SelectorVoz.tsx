// Selector de voz: lista con búsqueda, avatar animado y botón de muestra, sobre el
// catálogo ESTÁTICO de voces predefinidas de Gemini Live. Sin clonación, sin "Mis
// voces", sin diseño de voz y sin filtros de género/acento (el proveedor no los
// publica). El avatar y su animación vienen del panel original; el giro ahora es
// CSS (.voz-avatar-gira) en vez de framer-motion.
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, PlayCircle, Search, XCircle } from "lucide-react";
import { CATALOGO_VOCES, filtrarVoces, urlMuestraVoz } from "../lib/voz-catalogo.ts";
import type { VozCatalogo } from "../lib/voz-catalogo.ts";

/** Subconjunto de HTMLAudioElement que usa el selector (facilita probar sin reproducir audio real). */
export interface MuestraAudio {
  play(): Promise<void> | void;
  pause(): void;
  onended: ((ev: Event) => void) | null;
  onerror: ((ev: Event | string) => void) | null;
}

export interface SelectorVozProps {
  readonly vozId: string | null;
  readonly onElegir: (id: string) => void;
  /** Base para resolver las muestras (`import.meta.env.BASE_URL`). */
  readonly baseUrl: string;
  readonly crearAudio?: (url: string) => MuestraAudio;
}

function audioPorDefecto(url: string): MuestraAudio {
  return new Audio(url);
}

export function SelectorVoz({ vozId, onElegir, baseUrl, crearAudio = audioPorDefecto }: SelectorVozProps) {
  const [busqueda, setBusqueda] = useState("");
  const [voceandoId, setVoceandoId] = useState<string | null>(null);
  const [errorMuestra, setErrorMuestra] = useState<string | null>(null);
  const audioRef = useRef<MuestraAudio | null>(null);

  const filtradas = filtrarVoces(CATALOGO_VOCES, busqueda);

  function detener() {
    const a = audioRef.current;
    audioRef.current = null;
    if (a) {
      a.onended = null;
      a.onerror = null;
      try {
        a.pause();
      } catch {
        // nada que detener
      }
    }
    setVoceandoId(null);
  }

  // Cierra la muestra si el selector se desmonta (cambio de pestaña).
  useEffect(
    () => () => {
      const a = audioRef.current;
      audioRef.current = null;
      if (a) {
        a.onended = null;
        a.onerror = null;
        try {
          a.pause();
        } catch {
          // nada que detener
        }
      }
    },
    [],
  );

  function alternarMuestra(voz: VozCatalogo) {
    if (voceandoId === voz.id) {
      detener();
      return;
    }
    detener();
    setErrorMuestra(null);
    const audio = crearAudio(urlMuestraVoz(baseUrl, voz.id));
    const falla = () => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setVoceandoId(null);
      setErrorMuestra(`La muestra de ${voz.nombre} todavía no está disponible.`);
    };
    audioRef.current = audio;
    audio.onended = () => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setVoceandoId(null);
    };
    audio.onerror = falla;
    setVoceandoId(voz.id);
    try {
      const r = audio.play();
      if (r && typeof r.catch === "function") void r.catch(falla);
    } catch {
      falla();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[13px] font-medium text-foreground">
          Voz — {filtradas.length}/{CATALOGO_VOCES.length} voces
        </p>
      </div>
      <p className="text-[11.5px] text-muted-foreground mb-2">
        Son las voces predefinidas de Gemini Live. No hay clonación ni diseño de voz, y las voces no vienen etiquetadas por acento: el acento se pide en el comportamiento del agente y conviene validarlo con una llamada de prueba.
      </p>
      <div className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-2.5 mb-2">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por nombre o tono…"
          aria-label="Buscar voz"
          className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      {errorMuestra ? (
        <p role="status" className="mb-2 text-[12px] text-muted-foreground">
          {errorMuestra}
        </p>
      ) : null}
      <ul className="rounded-xl border border-border divide-y divide-border max-h-72 overflow-auto" aria-label="Voces disponibles">
        {filtradas.map((v) => {
          const elegida = vozId === v.id;
          const sonando = voceandoId === v.id;
          return (
            <li key={v.id} data-voz={v.id} aria-selected={elegida} className={`flex items-center gap-2.5 px-3 py-2 transition-colors ${elegida ? "bg-primary/10" : "hover:bg-muted"}`}>
              <button
                type="button"
                onClick={() => alternarMuestra(v)}
                aria-label={sonando ? `Detener la muestra de ${v.nombre}` : `Escuchar una muestra de ${v.nombre}`}
                className="relative w-8 h-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center"
                style={{ background: `conic-gradient(from ${(v.id.charCodeAt(0) * 37) % 360}deg, #1d4ed8, #38bdf8, #1d4ed8)` }}
              >
                <span
                  aria-hidden
                  data-girando={sonando ? "true" : "false"}
                  className={`absolute inset-0 ${sonando ? "voz-avatar-gira" : ""}`}
                  style={{ background: `conic-gradient(from ${(v.id.charCodeAt(1) * 53) % 360}deg, transparent, #ffffff30, transparent)` }}
                />
                <span className="relative z-10 text-white">{sonando ? <XCircle className="w-3.5 h-3.5" /> : <PlayCircle className="w-3.5 h-3.5" />}</span>
              </button>
              <button type="button" onClick={() => onElegir(v.id)} className="min-w-0 flex-1 text-left" aria-label={`Elegir la voz ${v.nombre}`}>
                <span className="block text-[13px] text-foreground truncate">{v.nombre}</span>
                <span className="block text-[10.5px] text-muted-foreground truncate">{v.tono}</span>
              </button>
              {elegida ? <CheckCircle2 className="w-4 h-4 text-primary shrink-0" aria-label="Voz elegida" /> : null}
            </li>
          );
        })}
        {filtradas.length === 0 ? <li className="text-[12px] text-muted-foreground p-3">Sin resultados para esa búsqueda.</li> : null}
      </ul>
    </div>
  );
}
