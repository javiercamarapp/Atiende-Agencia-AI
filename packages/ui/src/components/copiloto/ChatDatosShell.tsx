// Copiloto "Pregúntale a tus datos": shell unico para las verticales. Estilo literal de atiende-restaurantes (portada,
// burbujas, compositor rounded-3xl, chips, panel de historial) con el comportamiento de Likida (fases por tiempo,
// pasos de herramienta, historial persistido, detener). Es presentacional: no hardcodea datos ni habla con la red;
// todo entra por el `transporte` inyectado, que cada vertical conecta a su API (nunca a un mock en produccion).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { History } from "lucide-react";
import { CampoPixeles } from "../voz/CampoPixeles";
import { CopilotoCategorias } from "./CopilotoCategorias";
import { CopilotoCompositor } from "./CopilotoCompositor";
import { CopilotoHistorial, TOPE_HISTORIAL } from "./CopilotoHistorial";
import { CopilotoMensajeVista } from "./CopilotoMensaje";
import { CopilotoPensando } from "./CopilotoPensando";
import { CopilotoPortada } from "./CopilotoPortada";
import { CopilotoTemas } from "./CopilotoTemas";
import { useIdiomaCopiloto } from "./idioma";
import type { ChatDatosShellProps, CopilotoDirecta } from "./tipos";
import { useCopiloto } from "./useCopiloto";

const DURACION_PANEL_MS = 480;

function movimientoReducido(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function ChatDatosShell({
  variante = "pagina",
  acciones,
  transporte,
  textos,
  sugerencias,
  categorias,
  directas,
  etiquetasHerramienta,
  rutasFuente,
  maxCaracteres,
  vertical,
  uso,
  conversacionInicial,
  onConversacionCambia,
  zonaHoraria,
  preguntaInicial,
  ahora = () => new Date(),
}: ChatDatosShellProps) {
  const copiloto = useCopiloto({
    transporte,
    fases: textos.fases,
    ...(conversacionInicial ? { conversacionInicial } : {}),
    ...(onConversacionCambia ? { onConversacionCambia } : {}),
  });
  const { mensajes, enviando, fase, pasos, conversacionId, abriendo, errorAbrir } = copiloto;

  const { t } = useIdiomaCopiloto();
  const [texto, setTexto] = useState("");
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const [categoriasVisibles, setCategoriasVisibles] = useState(false);
  const [total, setTotal] = useState(0);
  const botonHistorial = useRef<HTMLButtonElement>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(temporizador.current), []);

  const raiz = useRef<HTMLDivElement>(null);
  const cuerpo = useRef<HTMLDivElement>(null);
  // Con el historial abierto (dialogo modal: aria-modal + foco atrapado) el fondo queda `inert`: el hilo y el compositor, y todo lo
  // que esta fuera del chat (menu, encabezado, portales ya montados). El boton «Historial» sigue vivo para cerrarlo. Se restaura al cerrar.
  useEffect(() => {
    if (!historialAbierto || typeof document === "undefined") return;
    const marcados: Element[] = [];
    const marcar = (el: Element) => {
      if (el.hasAttribute("inert") || el instanceof HTMLScriptElement || el instanceof HTMLStyleElement) return;
      el.setAttribute("inert", "");
      marcados.push(el);
    };
    if (cuerpo.current) marcar(cuerpo.current);
    for (let n: HTMLElement | null = raiz.current; n && n !== document.body; n = n.parentElement) {
      const padre = n.parentElement;
      if (!padre) break;
      for (const hermano of Array.from(padre.children)) if (hermano !== n) marcar(hermano);
    }
    return () => {
      for (const el of marcados) el.removeAttribute("inert");
    };
  }, [historialAbierto]);

  const idHistorial = useId();
  const idCategorias = useId();
  const idEntrada = useId();
  const puedeHistorial = Boolean(transporte.listar);
  const panel = variante === "panel";
  const hayConversacion = mensajes.length > 0 || abriendo || errorAbrir;

  const abrirHistorial = () => {
    clearTimeout(temporizador.current);
    setSaliendo(false);
    setHistorialAbierto(true);
  };
  const cerrarHistorial = useCallback(() => {
    clearTimeout(temporizador.current);
    botonHistorial.current?.focus();
    // En ds3 el boton esta oculto (visibility) mientras el panel esta abierto: el foco se devuelve otra vez cuando reaparece.
    setTimeout(() => botonHistorial.current?.focus(), 0);
    if (movimientoReducido()) {
      setHistorialAbierto(false);
      setSaliendo(false);
      return;
    }
    setSaliendo(true);
    temporizador.current = setTimeout(() => {
      setHistorialAbierto(false);
      setSaliendo(false);
    }, DURACION_PANEL_MS);
  }, []);

  const [avisoAdjunto, setAvisoAdjunto] = useState<string | null>(null);
  const adjuntar = (archivo: File) => {
    const cfg = transporte.adjuntos;
    if (!cfg || enviando) return;
    const ext = archivo.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    const permitidas = cfg.accept.split(",").map((x) => x.trim().toLowerCase());
    if (!permitidas.includes(ext)) return setAvisoAdjunto(t("adjuntoTipos", { ext: permitidas.join(", ") }));
    if (archivo.size === 0) return setAvisoAdjunto(t("adjuntoVacio"));
    if (archivo.size > cfg.maxBytes) return setAvisoAdjunto(t("adjuntoGrande", { mb: Math.round(cfg.maxBytes / (1024 * 1024)) }));
    setAvisoAdjunto(null);
    setCategoriasVisibles(false);
    copiloto.enviar(t("adjunte", { nombre: archivo.name.slice(0, 80) }), undefined, archivo);
  };

  const preguntar = (pregunta: string, directa?: CopilotoDirecta) => {
    const q = pregunta.trim().slice(0, maxCaracteres);
    if (!q || enviando) return;
    setTexto("");
    setCategoriasVisibles(false);
    copiloto.enviar(q, directa);
  };
  // Chips, tarjetas y sugerencias alternas: si el servidor puede resolverlos sin modelo (consulta directa), van por esa ruta.
  const preguntarChip = (pregunta: string) => preguntar(pregunta, directas?.[pregunta.trim()]);

  // Pregunta que llega desde otra pantalla (p. ej. el Resumen general): se envia UNA vez al montar, como si se escribiera, y solo en un
  // chat nuevo (abrir una conversacion guardada nunca le agrega un turno). Pasa por el mismo `preguntar` (tope de caracteres y directas).
  const preguntaInicialEnviada = useRef(false);
  useEffect(() => {
    if (preguntaInicialEnviada.current || !preguntaInicial || conversacionInicial) return;
    preguntaInicialEnviada.current = true;
    preguntarChip(preguntaInicial);
    // Solo al montar: la pregunta inicial no se reenvia si el padre vuelve a pintar.
  }, []);

  const hilo = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hilo.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "end" });
  }, [mensajes.length, enviando]);

  const ultimaAsistente = (() => {
    for (let i = mensajes.length - 1; i >= 0; i--) if (mensajes[i]?.role === "assistant") return mensajes[i]?.id;
    return undefined;
  })();

  const contador = total >= TOPE_HISTORIAL ? `${TOPE_HISTORIAL}+` : total > 0 ? String(total) : null;

  return (
    <div
      className={panel ? "copiloto relative h-full min-h-0 overflow-y-auto overflow-x-hidden px-3 pt-3" : "copiloto relative min-h-[calc(100dvh-8rem)] overflow-hidden px-4 pt-4"}
      ref={raiz}
      data-testid="copiloto-shell"
      data-ds3-copiloto=""
      data-variante={variante}
    >
      <CampoPixeles color="hsl(var(--copiloto-acento))" />

      {puedeHistorial ? (
        <div data-ds3="hist-fila-boton" className="relative flex justify-end mb-6">
          <button
            ref={botonHistorial}
            type="button"
            onClick={historialAbierto && !saliendo ? cerrarHistorial : abrirHistorial}
            aria-label={t("historialAria")}
            aria-expanded={historialAbierto && !saliendo}
            aria-controls={idHistorial}
            data-ds3="hist-btn"
            className="relative flex items-center gap-1.5 text-xs border border-border rounded-full pl-3 pr-2.5 py-1.5 bg-card text-muted-foreground hover:bg-muted transition-colors"
          >
            <History className="w-3.5 h-3.5" aria-hidden />
            {t("historial")}
            {contador ? <span data-ds3="hist-contador" className="font-mono text-2xs bg-muted rounded-full px-1.5 py-0.5 text-foreground">{contador}</span> : null}
          </button>
        </div>
      ) : null}

      <div
        ref={cuerpo}
        data-hay-conversacion={hayConversacion || undefined}
        data-ds3="cuerpo"
        className={`relative flex flex-col items-center ${panel ? "px-1 pb-4" : "px-4 pb-8"} ${
          hayConversacion ? (panel ? "min-h-[calc(100%-3rem)] justify-end" : "min-h-[calc(100dvh-8rem)] justify-end") : panel ? "pt-6" : "pt-16 md:pt-24"
        }`}
      >
        {!hayConversacion ? <CopilotoPortada textos={textos} compacta={panel} /> : null}

        {hayConversacion ? (
          <div ref={hilo} data-ds3-hilo="" role="log" aria-live="polite" aria-label={t("conversacionAria")} className={`w-full ${panel ? "max-w-full" : "max-w-2xl"} space-y-5 mb-6`}>
            {abriendo ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("abriendo")}
              </p>
            ) : null}
            {errorAbrir ? (
              <p className="text-xs text-destructive" role="alert">
                {t("errorAbrir")}
              </p>
            ) : null}
            {mensajes.map((m) => (
              <CopilotoMensajeVista
                key={m.id}
                mensaje={m}
                esUltima={m.id === ultimaAsistente && !enviando}
                conversacionId={conversacionId}
                transporte={transporte}
                rutasFuente={rutasFuente}
                sugerenciasAlternas={sugerencias.slice(0, 3)}
                ocupado={enviando}
                onRegenerar={copiloto.regenerar}
                onPreguntar={preguntarChip}
                vertical={vertical}
                etiquetasHerramienta={etiquetasHerramienta}
                {...(acciones ? { acciones } : {})}
              />
            ))}
            {enviando ? <CopilotoPensando fase={fase} pasos={pasos} etiquetas={etiquetasHerramienta} /> : null}
          </div>
        ) : null}

        {!hayConversacion && categoriasVisibles ? <CopilotoCategorias id={idCategorias} categorias={categorias} onElegir={preguntarChip} compacta={panel} /> : null}

        <div data-ds3="dock" className={`w-full flex justify-center sticky ${panel ? "bottom-0" : "bottom-[calc(63px+var(--safe-area-bottom))] md:bottom-0"}`}>
          <CopilotoCompositor
            valor={texto}
            onCambia={setTexto}
            onEnviar={() => preguntar(texto)}
            onDetener={copiloto.detener}
            onConsulta={() => setCategoriasVisibles((v) => !v)}
            enviando={enviando}
            placeholder={textos.placeholder}
            maxCaracteres={maxCaracteres}
            categoriasId={idCategorias}
            categoriasVisibles={categoriasVisibles}
            inputId={idEntrada}
            adjuntos={transporte.adjuntos}
            onAdjuntar={transporte.adjuntos ? adjuntar : undefined}
            avisoAdjunto={avisoAdjunto}
          />
        </div>

        {!hayConversacion ? (
          <>
            <CopilotoTemas categorias={categorias} onElegir={preguntarChip} ocupado={enviando} />
            {sugerencias.length > 0 ? (
              <div data-ds3={categorias.some((c) => c.preguntas.length > 0) ? "chips-con-temas" : "chips"} className="flex flex-wrap gap-1.5 justify-center mt-4 max-w-xl">
                {sugerencias.slice(0, 5).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => preguntarChip(s)}
                    className="text-xs rounded-full px-3 py-1 bg-copiloto/10 text-copiloto border border-copiloto/20 hover:bg-copiloto/20 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            <p data-ds3="pie" className="text-xs text-muted-foreground text-center mt-8 max-w-lg">{textos.nota}</p>
          </>
        ) : null}

        {uso ? (
          <div data-ds3="uso" className="mt-4 w-full max-w-xs text-xs text-muted-foreground">
            <div className="flex justify-between mb-1">
              <span>{uso.etiqueta}</span>
              <span className="font-mono tabular-nums">{Math.round(uso.pct)}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={uso.etiqueta}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, Math.max(0, uso.pct)))}
              className="h-1 rounded-full bg-muted overflow-hidden"
            >
              <div className="h-full bg-copiloto" style={{ width: `${Math.min(100, Math.max(0, uso.pct))}%` }} />
            </div>
          </div>
        ) : null}
      </div>

      {historialAbierto ? (
        <CopilotoHistorial
          id={idHistorial}
          transporte={transporte}
          activaId={conversacionId}
          saliendo={saliendo}
          zonaHoraria={zonaHoraria}
          ahora={ahora}
          onTotal={setTotal}
          onCerrar={cerrarHistorial}
          onNuevo={() => {
            copiloto.nuevo();
            setTexto("");
            cerrarHistorial();
          }}
          onAbrir={(id) => {
            copiloto.abrir(id);
            cerrarHistorial();
          }}
          onActivaBorrada={() => {
            copiloto.nuevo();
          }}
        />
      ) : null}
    </div>
  );
}
