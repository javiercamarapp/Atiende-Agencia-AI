import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Edit, PanelRightClose, Pencil, Search, Trash2, X } from "lucide-react";
import { AtiendeWordmark } from "../AtiendeLogo";
import { ConfirmDialog } from "../ConfirmDialog";
import { HOJA_UMBRAL_CIERRE_PX } from "../ui/drawer";
import { Skeleton } from "../ui/skeleton";
import { RegionCargando } from "../CargandoDelegado";
import { agruparConversaciones, partirUltimoMes, type GrupoHistorial } from "./formato";
import { useIdiomaCopiloto, type ClaveCopiloto } from "./idioma";
import type { ConversacionResumen, CopilotoTransporte } from "./tipos";

/** Tope de conversaciones que lista el servidor (el panel avisa cuando se llega). */
export const TOPE_HISTORIAL = 100;

const sinAcentos = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

type Estado = "cargando" | "error" | "listo";

const CLAVE_GRUPO: Readonly<Record<GrupoHistorial, ClaveCopiloto>> = {
  fijadas: "grupoFijadas",
  hoy: "grupoHoy",
  ayer: "grupoAyer",
  semana: "grupoSemana",
  anteriores: "grupoAnteriores",
};

/** Visible para el teclado: ni `hidden` ni `display:none` (las piezas `ds3-no`/`ds3-solo` se apagan por CSS segun la bandera). */
function enfocable(el: HTMLElement, raiz: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== raiz; n = n.parentElement) {
    if (n.hidden) return false;
    if (typeof getComputedStyle === "function" && getComputedStyle(n).display === "none") return false;
  }
  return true;
}

/**
 * Panel de historial: geometria literal de atiende-restaurantes (flotante a la derecha, w-72, rounded-2xl) con la
 * entrada de Likida (480 ms), grupos por fecha, buscador, renombrar y borrar con confirmacion. En movil (< lg) ocupa
 * toda la pantalla (fixed inset-0). Esc cierra; el foco queda atrapado dentro y el shell lo devuelve al boton al cerrar.
 *
 * Bajo la bandera ds3 (solo CSS, `ds3/copiloto.css`) toma la anatomia del `Drawer` sm de @atiende/ui: 420 px flotando a 8 px del
 * borde, velo, cabecera «Historial» + cuantos chats hay, «Chat nuevo» junto al buscador, grupos Hoy/Ayer/7/30 dias/Anteriores,
 * filas de 40 px con renombrar/borrar al pasar el cursor, pie con la nota de privacidad y el logo de Atiende; en < 820 px, hoja
 * inferior con agarradera. Las piezas nuevas van con `hidden` + `ds3-solo` y las que se reemplazan con `ds3-no`: sin la bandera
 * nada cambia. (El panel no se monta con el `Drawer` de Radix porque eso cambiaria la produccion sin bandera; al retirar la
 * bandera se sustituye por `<Drawer tamano="sm">`.)
 */
export function CopilotoHistorial({
  id,
  transporte,
  activaId,
  saliendo,
  zonaHoraria,
  ahora,
  onNuevo,
  onAbrir,
  onCerrar,
  onActivaBorrada,
  onTotal,
}: {
  id: string;
  transporte: CopilotoTransporte;
  activaId: string | undefined;
  saliendo: boolean;
  zonaHoraria: string | undefined;
  ahora: () => Date;
  onNuevo: () => void;
  onAbrir: (id: string) => void;
  onCerrar: () => void;
  onActivaBorrada: () => void;
  /** Cuantas conversaciones hay (para el contador del boton Historial). */
  onTotal?: (n: number) => void;
}) {
  const [estado, setEstado] = useState<Estado>("cargando");
  const [lista, setLista] = useState<readonly ConversacionResumen[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState("");
  const [aBorrar, setABorrar] = useState<ConversacionResumen | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const raiz = useRef<HTMLDivElement>(null);
  const { t } = useIdiomaCopiloto();
  const arrastre = useRef<{ y: number; id: number } | null>(null);
  const botonNuevo = useRef<HTMLButtonElement>(null);
  const botonNuevoDs3 = useRef<HTMLButtonElement>(null);
  const cancelaRenombre = useRef(false);

  const cargar = useCallback(
    (senal: AbortSignal) => {
      if (!transporte.listar) return;
      setEstado("cargando");
      transporte.listar(senal).then(
        (l) => {
          if (senal.aborted) return;
          setLista(l);
          setEstado("listo");
          onTotal?.(l.length);
        },
        () => {
          if (senal.aborted) return;
          setEstado("error");
        },
      );
    },
    [transporte, onTotal],
  );

  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    ctl.current = c;
    cargar(c.signal);
    return () => c.abort();
  }, [cargar]);

  useEffect(() => {
    // Foco inicial en «Nuevo chat»; si esta apagado por la hoja ds3 (no toma el foco), en «Chat nuevo».
    botonNuevo.current?.focus();
    if (typeof document !== "undefined" && document.activeElement !== botonNuevo.current) botonNuevoDs3.current?.focus();
  }, []);

  const reintentar = () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    cargar(c.signal);
  };

  const filtradas = useMemo(() => {
    const q = sinAcentos(busqueda.trim());
    return q ? lista.filter((c) => sinAcentos(c.titulo).includes(q)) : lista;
  }, [lista, busqueda]);
  const grupos = useMemo(() => agruparConversaciones(filtradas, ahora(), zonaHoraria), [filtradas, ahora, zonaHoraria]);

  const alTeclear = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !aBorrar && renombrando === null) {
      e.stopPropagation();
      onCerrar();
      return;
    }
    if (e.key === "Tab" && raiz.current) {
      const r = raiz.current;
      const f = Array.from(r.querySelectorAll<HTMLElement>("button:not([disabled]), input, [href]")).filter((x) => enfocable(x, r));
      const primero = f[0];
      const ultimo = f[f.length - 1];
      if (!primero || !ultimo) return;
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    }
  };

  const confirmarRenombre = async (c: ConversacionResumen) => {
    const titulo = borrador.trim().slice(0, 80);
    setRenombrando(null);
    if (!titulo || titulo === c.titulo || !transporte.renombrar) return;
    try {
      await transporte.renombrar(c.id, titulo);
      setLista((l) => l.map((x) => (x.id === c.id ? { ...x, titulo } : x)));
      setFallo(null);
    } catch {
      setFallo(t("errorRenombrar"));
    }
  };

  const borrar = async (c: ConversacionResumen) => {
    if (!transporte.borrar) return;
    try {
      await transporte.borrar(c.id);
    } catch {
      setFallo(t("errorBorrar"));
      throw new Error("borrar");
    }
    setLista((l) => l.filter((x) => x.id !== c.id));
    setFallo(null);
    if (c.id === activaId) onActivaBorrada();
  };

  const subtitulo = lista.length === 0 ? t("subtituloVacio") : lista.length === 1 ? t("subtituloUno") : t("subtituloVarios", { n: lista.length });

  const fila = (c: ConversacionResumen) => (
    <li key={c.id} className="ds3-copiloto-hist-fila group relative">
      {renombrando === c.id ? (
        <input
          autoFocus
          value={borrador}
          maxLength={80}
          aria-label={t("nuevoNombre")}
          onChange={(e) => setBorrador(e.target.value)}
          onBlur={() => {
            if (cancelaRenombre.current) {
              cancelaRenombre.current = false;
              return;
            }
            void confirmarRenombre(c);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void confirmarRenombre(c);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              cancelaRenombre.current = true;
              setRenombrando(null);
            }
          }}
          className="ds3-copiloto-hist-renombre w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => onAbrir(c.id)}
            aria-current={c.id === activaId ? "true" : undefined}
            title={c.titulo}
            className={`ds3-copiloto-hist-titulo w-full text-left text-sm pl-3 pr-16 py-2 rounded-lg hover:bg-muted truncate ${c.id === activaId ? "bg-muted font-medium" : ""}`}
          >
            {c.titulo}
          </button>
          <span className="ds3-copiloto-hist-acciones absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100">
            {transporte.renombrar ? (
              <button
                type="button"
                aria-label={t("renombrar", { t: c.titulo })}
                onClick={() => {
                  setBorrador(c.titulo);
                  setRenombrando(c.id);
                }}
                className="p-1.5 rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <Pencil className="w-3.5 h-3.5" aria-hidden />
              </button>
            ) : null}
            {transporte.borrar ? (
              <button
                type="button"
                aria-label={t("borrar", { t: c.titulo })}
                onClick={() => setABorrar(c)}
                className="p-1.5 rounded-md text-muted-foreground hover:bg-background hover:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
              </button>
            ) : null}
          </span>
        </>
      )}
    </li>
  );
  const claseGrupo = "ds3-copiloto-hist-grupo px-4 pb-2 pt-1 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground font-normal";

  return (
    <>
    {/* Velo del Drawer ds3 (clic fuera cierra). Sin la bandera no existe para nadie. */}
    <div hidden aria-hidden="true" className="ds3-solo ds3-copiloto-velo" data-saliendo={saliendo || undefined} onClick={onCerrar} />
    <div
      id={id}
      ref={raiz}
      role="dialog"
      aria-modal="true"
      aria-label={t("historialAria")}
      onKeyDown={alTeclear}
      data-saliendo={saliendo || undefined}
      className={`ds3-copiloto-hist ${saliendo ? "copiloto-panel-sale" : "copiloto-panel-entra"} absolute right-3 inset-y-3 z-20 w-72 max-w-[85vw] bg-card border border-border rounded-2xl shadow-xl flex flex-col overflow-hidden max-lg:fixed max-lg:inset-0 max-lg:w-full max-lg:max-w-none max-lg:rounded-none max-lg:z-40`}
    >
      {/* ds3, < 820 px: agarradera de la hoja inferior (arrastrar mas de 80 px hacia abajo cierra; Esc y la X tambien). */}
      <div
        hidden
        aria-hidden="true"
        data-testid="copiloto-hist-agarre"
        className="ds3-solo ds3-copiloto-hist-agarre"
        onPointerDown={(e) => {
          arrastre.current = { y: e.clientY, id: e.pointerId };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const a = arrastre.current;
          if (a?.id === e.pointerId) raiz.current?.style.setProperty("transform", `translateY(${Math.max(0, e.clientY - a.y)}px)`);
        }}
        onPointerUp={(e) => {
          const a = arrastre.current;
          arrastre.current = null;
          raiz.current?.style.removeProperty("transform");
          if (a && e.clientY - a.y > HOJA_UMBRAL_CIERRE_PX) onCerrar();
        }}
        onPointerCancel={() => {
          arrastre.current = null;
          raiz.current?.style.removeProperty("transform");
        }}
      >
        <span />
      </div>
      <header hidden className="ds3-solo ds3-copiloto-hist-cabecera">
        <div className="min-w-0 flex-1">
          <p className="ds3-copiloto-hist-nombre">{t("historial")}</p>
          <p className="ds3-copiloto-hist-sub" aria-live="polite">
            {estado === "listo" ? subtitulo : "\u00a0"}
          </p>
        </div>
      </header>
      <div className="ds3-copiloto-hist-arriba">
        <div className="ds3-copiloto-hist-fila-nuevo flex items-center gap-2 p-3">
          <button
            ref={botonNuevo}
            type="button"
            onClick={onNuevo}
            aria-label={t("nuevoChat")}
            className="ds3-no flex-1 flex items-center gap-2 px-3 py-2 rounded-full border border-border/60 hover:bg-muted text-sm font-medium"
          >
            <Edit className="w-3.5 h-3.5" aria-hidden />
            {t("nuevoChat")}
          </button>
          <button
            type="button"
            onClick={onCerrar}
            aria-label={t("cerrarHistorial")}
            className="ds3-no w-8 h-8 rounded-md border border-border/60 inline-flex items-center justify-center hover:bg-muted"
          >
            <PanelRightClose className="w-4 h-4" aria-hidden />
          </button>
          {/* Cerrar del Drawer ds3: va aqui en el DOM (justo despues de «Chat nuevo», como el cerrar de siempre) y la hoja lo coloca
              en la esquina de la cabecera; asi el orden del teclado es el mismo con y sin bandera. */}
          {/* «Chat nuevo» de ds3: su nombre accesible ES su texto visible (WCAG 2.5.3); el de siempre se apaga con `ds3-no`. */}
          <button ref={botonNuevoDs3} hidden type="button" onClick={onNuevo} className="ds3-solo ds3-copiloto-hist-nuevo">
            <Edit className="w-3.5 h-3.5" aria-hidden />
            {t("chatNuevo")}
          </button>
          <button hidden type="button" onClick={onCerrar} aria-label={t("cerrarHistorial")} className="ds3-solo ds3-copiloto-hist-cerrar">
            <X className="w-3.5 h-3.5" aria-hidden />
          </button>
        </div>
        <div className="ds3-copiloto-hist-buscar px-3 pb-2">
          <label className="flex items-center gap-2 rounded-full bg-muted px-3 py-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder={t("buscar")}
              aria-label={t("buscar")}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
      </div>

      <div className="ds3-copiloto-hist-cuerpo flex-1 overflow-y-auto pb-3">
        {fallo ? (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {fallo}
          </p>
        ) : null}
        {estado === "cargando" ? (
          <RegionCargando etiqueta={t("cargandoHistorial")} className="px-3 space-y-2" claseDs3="min-h-24">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </RegionCargando>
        ) : estado === "error" ? (
          <div className="px-4 text-sm text-muted-foreground" role="alert">
            <p>{t("errorHistorial")}</p>
            <button type="button" onClick={reintentar} className="mt-2 text-xs underline underline-offset-2 hover:text-foreground">
              {t("reintentar")}
            </button>
          </div>
        ) : lista.length === 0 ? (
          <p className="ds3-copiloto-hist-ayuda px-4 text-sm text-muted-foreground" role="status">
            <span className="ds3-no">{t("sinChats")}</span>
            <span hidden className="ds3-solo ds3-copiloto-en-linea">
              {t("sinChatsDs3")}
            </span>
          </p>
        ) : filtradas.length === 0 ? (
          <p className="ds3-copiloto-hist-ayuda px-4 text-sm text-muted-foreground" role="status">
            {t("sinResultados")}
          </p>
        ) : (
          grupos.map(({ grupo, items }) => {
            if (grupo !== "anteriores") {
              return (
                <section key={grupo} aria-label={t(CLAVE_GRUPO[grupo])}>
                  <h2 className={claseGrupo}>{t(CLAVE_GRUPO[grupo])}</h2>
                  <ul className="ds3-copiloto-hist-filas px-2">{items.map(fila)}</ul>
                </section>
              );
            }
            // «Anteriores» del diseno actual = «Últimos 30 días» + «Anteriores» de ds3. Sin la bandera se ve un solo encabezado
            // seguido de todas (en el mismo orden); con ella, los dos grupos de la referencia.
            const { mes, resto } = partirUltimoMes(items, ahora(), zonaHoraria);
            if (mes.length === 0) {
              return (
                <section key={grupo} aria-label={t("grupoAnteriores")}>
                  <h2 className={claseGrupo}>{t("grupoAnteriores")}</h2>
                  <ul className="ds3-copiloto-hist-filas px-2">{items.map(fila)}</ul>
                </section>
              );
            }
            return (
              <section key={grupo}>
                <h2 className={claseGrupo}>
                  <span className="ds3-no">{t("grupoAnteriores")}</span>
                  <span hidden className="ds3-solo ds3-copiloto-en-linea">
                    {t("grupoMes")}
                  </span>
                </h2>
                <ul className="ds3-copiloto-hist-filas px-2">{mes.map(fila)}</ul>
                {resto.length > 0 ? (
                  <>
                    <h2 hidden className={`ds3-solo ${claseGrupo}`}>
                      {t("grupoAnteriores")}
                    </h2>
                    <ul className="ds3-copiloto-hist-filas px-2">{resto.map(fila)}</ul>
                  </>
                ) : null}
              </section>
            );
          })
        )}
        {estado === "listo" && lista.length >= TOPE_HISTORIAL ? (
          <p className="px-4 pt-2 text-xs text-muted-foreground">{t("topeHistorial", { n: TOPE_HISTORIAL })}</p>
        ) : null}
      </div>

      <footer hidden className="ds3-solo ds3-copiloto-hist-pie">
        <p>{t("pieHistorial")}</p>
      </footer>
      <div hidden aria-hidden="true" data-testid="copiloto-hist-marca" className="ds3-solo ds3-copiloto-hist-marca">
        <span className="ds3-copiloto-hist-marca-logo">
          <AtiendeWordmark variante="ds3" tamano="sidebar" respetarMinimos={false} />
        </span>
      </div>

      <ConfirmDialog
        open={aBorrar !== null}
        onOpenChange={(o) => {
          if (!o) setABorrar(null);
        }}
        titulo={t("borrarTitulo")}
        descripcion={t("borrarDescripcion")}
        tono="danger"
        confirmar={t("borrarConfirmar")}
        onConfirm={async () => {
          if (aBorrar) await borrar(aBorrar);
        }}
      />
    </div>
    </>
  );
}
