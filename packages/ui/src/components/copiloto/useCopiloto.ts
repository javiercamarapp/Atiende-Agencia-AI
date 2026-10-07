// Maquina de estados del Copiloto, agnostica del transporte: inactivo -> enviando(fase, pasos) -> listo | error | cancelado.
// El cliente solo manda la pregunta y el conversacionId: el historial que ve el modelo lo reconstruye el servidor.
import { useCallback, useEffect, useRef, useState } from "react";
import { faseSegunTiempo, TICK_FASES_MS, TIMEOUT_TURNO_MS } from "./fases";
import {
  CopilotoErrorTransporte,
  type CopilotoDirecta,
  type CopilotoEvento,
  type CopilotoMensaje,
  type CopilotoRespuesta,
  type CopilotoStatus,
  type CopilotoTransporte,
} from "./tipos";

export interface PasoHerramienta {
  readonly herramienta: string;
  readonly fin: boolean;
}

export interface UseCopilotoOpciones {
  readonly transporte: CopilotoTransporte;
  readonly fases: ReadonlyArray<readonly [number, string]>;
  readonly conversacionInicial?: string;
  readonly onConversacionCambia?: (id?: string) => void;
}

export interface UseCopiloto {
  readonly mensajes: readonly CopilotoMensaje[];
  readonly enviando: boolean;
  readonly fase: string;
  readonly pasos: readonly PasoHerramienta[];
  readonly conversacionId: string | undefined;
  readonly abriendo: boolean;
  readonly errorAbrir: boolean;
  /** `directa` = el chip se resuelve sin modelo (el texto es solo la etiqueta del mensaje). `adjunto` = archivo que el servidor analiza (el texto es la etiqueta). */
  enviar(pregunta: string, directa?: CopilotoDirecta, adjunto?: File): void;
  detener(): void;
  nuevo(): void;
  abrir(id: string): void;
  regenerar(): void;
}

function esAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function useCopiloto({ transporte, fases, conversacionInicial, onConversacionCambia }: UseCopilotoOpciones): UseCopiloto {
  const [mensajes, setMensajes] = useState<readonly CopilotoMensaje[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [fase, setFase] = useState(() => faseSegunTiempo(fases, 0));
  const [pasos, setPasos] = useState<readonly PasoHerramienta[]>([]);
  const [conversacionId, setConversacionId] = useState<string | undefined>(undefined);
  const [abriendo, setAbriendo] = useState(false);
  const [errorAbrir, setErrorAbrir] = useState(false);

  const ocupado = useRef(false);
  const contador = useRef(0);
  const control = useRef<AbortController | null>(null);
  const abrirGen = useRef(0);
  // Sube cuando se descarta el turno en vuelo (nuevo chat / abrir otro): su resultado ya no se pinta.
  const turnoGen = useRef(0);
  const mensajesRef = useRef(mensajes);
  mensajesRef.current = mensajes;
  const conversacionRef = useRef<string | undefined>(undefined);
  conversacionRef.current = conversacionId;
  const fasesRef = useRef(fases);
  fasesRef.current = fases;
  const transporteRef = useRef(transporte);
  transporteRef.current = transporte;
  const cambiaRef = useRef(onConversacionCambia);
  cambiaRef.current = onConversacionCambia;

  const nuevoId = (prefijo: string) => `${prefijo}-${++contador.current}`;

  const fijarConversacion = useCallback((id: string | undefined) => {
    conversacionRef.current = id;
    setConversacionId(id);
    cambiaRef.current?.(id);
  }, []);

  // Reloj de fases: Date.now (no el tick) es la fuente de verdad; el intervalo solo repinta.
  useEffect(() => {
    if (!enviando) return;
    const inicio = Date.now();
    setFase(faseSegunTiempo(fasesRef.current, 0));
    const id = setInterval(() => setFase(faseSegunTiempo(fasesRef.current, Date.now() - inicio)), TICK_FASES_MS);
    return () => clearInterval(id);
  }, [enviando]);

  // Ultima consulta directa o adjunto enviado: "Regenerar" repite la MISMA consulta directa (o vuelve a analizar el MISMO archivo; nunca lo manda al modelo como texto).
  const directaRef = useRef<{ readonly texto: string; readonly directa?: CopilotoDirecta; readonly adjunto?: File } | undefined>(undefined);

  const turno = useCallback(
    async (pregunta: string, base: readonly CopilotoMensaje[], directa?: CopilotoDirecta, adjunto?: File) => {
      if (ocupado.current) return;
      ocupado.current = true;
      const ctl = new AbortController();
      control.current = ctl;
      const gen = turnoGen.current;
      let vencio = false;
      const timer = setTimeout(() => {
        vencio = true;
        ctl.abort();
      }, TIMEOUT_TURNO_MS);

      setMensajes([...base, { id: nuevoId("u"), role: "user", text: pregunta }]);
      setPasos([]);
      setEnviando(true);

      let respuesta: CopilotoRespuesta | undefined;
      let convNueva: string | undefined;
      let seqEvento: number | undefined;
      const alEvento = (e: CopilotoEvento) => {
        if (ctl.signal.aborted) return;
        if (e.t === "paso") {
          setPasos((prev) => {
            if (e.fase === "inicio") return [...prev, { herramienta: e.herramienta, fin: false }];
            const i = prev.findIndex((p) => p.herramienta === e.herramienta && !p.fin);
            if (i < 0) return [...prev, { herramienta: e.herramienta, fin: true }];
            return prev.map((p, j) => (j === i ? { ...p, fin: true } : p));
          });
        } else if (e.t === "fin") {
          respuesta = e.respuesta;
          convNueva = e.conversacionId;
          seqEvento = e.seq;
        } else {
          respuesta = {
            text: e.mensaje,
            status: e.status,
            ...(e.reintentarEnSeg !== undefined ? { reintentarEnSeg: e.reintentarEnSeg } : {}),
          };
        }
      };

      let final: CopilotoMensaje;
      try {
        const devuelta = await transporteRef.current.enviar({
          pregunta,
          ...(directa ? { directa } : {}),
          ...(adjunto ? { adjunto } : {}),
          ...(conversacionRef.current ? { conversacionId: conversacionRef.current } : {}),
          senal: ctl.signal,
          onEvento: alEvento,
        });
        if (ctl.signal.aborted && !vencio) throw new DOMException("cancelado", "AbortError");
        const r = respuesta ?? devuelta;
        final = {
          id: nuevoId("a"),
          role: "assistant",
          text: r.text,
          status: r.status,
          ...(r.blocks ? { blocks: r.blocks } : {}),
          ...(r.sources ? { sources: r.sources } : {}),
          ...((r.seq ?? seqEvento) !== undefined ? { seq: (r.seq ?? seqEvento) as number } : {}),
          ...(r.sugerencias ? { sugerencias: r.sugerencias } : {}),
          ...(r.reintentarEnSeg !== undefined ? { reintentarEnSeg: r.reintentarEnSeg } : {}),
          ...(r.limiteDiario !== undefined ? { limiteDiario: r.limiteDiario } : {}),
        };
        if (convNueva && convNueva !== conversacionRef.current) fijarConversacion(convNueva);
      } catch (e) {
        if (esAbort(e) && !vencio) {
          final = { id: nuevoId("a"), role: "assistant", text: "Cancelado.", cancelado: true };
        } else if (e instanceof CopilotoErrorTransporte) {
          final = {
            id: nuevoId("a"),
            role: "assistant",
            text: e.message,
            status: e.status,
            ...(e.reintentarEnSeg !== undefined ? { reintentarEnSeg: e.reintentarEnSeg } : {}),
          };
        } else {
          const status: CopilotoStatus = "unavailable";
          final = { id: nuevoId("a"), role: "assistant", text: "", status };
        }
      } finally {
        clearTimeout(timer);
        if (gen === turnoGen.current) {
          control.current = null;
          ocupado.current = false;
        }
      }
      if (gen !== turnoGen.current) return;
      setMensajes((prev) => [...prev, final]);
      setEnviando(false);
      setPasos([]);
    },
    [fijarConversacion],
  );

  const enviar = useCallback(
    (pregunta: string, directa?: CopilotoDirecta, adjunto?: File) => {
      const q = pregunta.trim();
      if (!q || ocupado.current) return;
      directaRef.current = directa || adjunto ? { texto: q, ...(directa ? { directa } : {}), ...(adjunto ? { adjunto } : {}) } : undefined;
      void turno(q, mensajesRef.current, directa, adjunto);
    },
    [turno],
  );

  const detener = useCallback(() => {
    control.current?.abort();
  }, []);

  const nuevo = useCallback(() => {
    control.current?.abort();
    turnoGen.current++;
    abrirGen.current++;
    ocupado.current = false;
    setMensajes([]);
    setEnviando(false);
    setPasos([]);
    setAbriendo(false);
    setErrorAbrir(false);
    fijarConversacion(undefined);
  }, [fijarConversacion]);

  const abrir = useCallback(
    (id: string) => {
      const t = transporteRef.current;
      if (!t.abrir) return;
      control.current?.abort();
      turnoGen.current++;
      ocupado.current = false;
      setEnviando(false);
      setPasos([]);
      const gen = ++abrirGen.current;
      const ctl = new AbortController();
      setAbriendo(true);
      setErrorAbrir(false);
      t.abrir(id, ctl.signal).then(
        (c) => {
          if (gen !== abrirGen.current) return;
          setMensajes(c.mensajes);
          setAbriendo(false);
          fijarConversacion(c.id);
        },
        () => {
          if (gen !== abrirGen.current) return;
          setAbriendo(false);
          setErrorAbrir(true);
        },
      );
    },
    [fijarConversacion],
  );

  const regenerar = useCallback(() => {
    if (ocupado.current) return;
    const lista = mensajesRef.current;
    let i = lista.length - 1;
    while (i >= 0 && lista[i]?.role !== "user") i--;
    const pregunta = lista[i]?.text;
    if (i < 0 || !pregunta) return;
    const previa = directaRef.current;
    const igual = previa && previa.texto === pregunta ? previa : undefined;
    void turno(pregunta, lista.slice(0, i), igual?.directa, igual?.adjunto);
  }, [turno]);

  // Conversacion inicial (?c=<id>) y limpieza al desmontar.
  useEffect(() => {
    if (conversacionInicial) abrir(conversacionInicial);
    return () => {
      abrirGen.current++;
      turnoGen.current++;
      control.current?.abort();
    };
    // Solo al montar: cambiar de conversacion despues es decision del shell.
  }, []);

  return { mensajes, enviando, fase, pasos, conversacionId, abriendo, errorAbrir, enviar, detener, nuevo, abrir, regenerar };
}
