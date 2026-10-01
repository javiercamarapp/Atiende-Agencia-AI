import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Edit, PanelRightClose, Pencil, Search, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../ConfirmDialog";
import { Skeleton } from "../ui/skeleton";
import { agruparConversaciones, ETIQUETA_GRUPO } from "./formato";
import type { ConversacionResumen, CopilotoTransporte } from "./tipos";

/** Tope de conversaciones que lista el servidor (el panel avisa cuando se llega). */
export const TOPE_HISTORIAL = 100;

const sinAcentos = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

type Estado = "cargando" | "error" | "listo";

/**
 * Panel de historial: geometria literal de atiende-restaurantes (flotante a la derecha, w-72, rounded-2xl) con la
 * entrada de Likida (480 ms), grupos por fecha, buscador, renombrar y borrar con confirmacion. En movil (< lg) ocupa
 * toda la pantalla (fixed inset-0). Esc cierra; el foco queda atrapado dentro y el shell lo devuelve al boton al cerrar.
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
  const botonNuevo = useRef<HTMLButtonElement>(null);
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
    botonNuevo.current?.focus();
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
      const f = Array.from(raiz.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, [href]"));
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
      setFallo("No se pudo renombrar el chat; intenta de nuevo.");
    }
  };

  const borrar = async (c: ConversacionResumen) => {
    if (!transporte.borrar) return;
    try {
      await transporte.borrar(c.id);
    } catch {
      setFallo("No se pudo borrar el chat; intenta de nuevo.");
      throw new Error("borrar");
    }
    setLista((l) => l.filter((x) => x.id !== c.id));
    setFallo(null);
    if (c.id === activaId) onActivaBorrada();
  };

  return (
    <div
      id={id}
      ref={raiz}
      role="dialog"
      aria-label="Historial de chats"
      onKeyDown={alTeclear}
      className={`${saliendo ? "copiloto-panel-sale" : "copiloto-panel-entra"} absolute right-3 inset-y-3 z-20 w-72 max-w-[85vw] bg-card border border-border rounded-2xl shadow-xl flex flex-col overflow-hidden max-lg:fixed max-lg:inset-0 max-lg:w-full max-lg:max-w-none max-lg:rounded-none max-lg:z-40`}
    >
      <div className="flex items-center gap-2 p-3">
        <button
          ref={botonNuevo}
          type="button"
          onClick={onNuevo}
          aria-label="Nuevo chat"
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-full border border-border/60 hover:bg-muted text-sm font-medium"
        >
          <Edit className="w-3.5 h-3.5" aria-hidden />
          Nuevo chat
        </button>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar historial"
          className="w-8 h-8 rounded-md border border-border/60 inline-flex items-center justify-center hover:bg-muted"
        >
          <PanelRightClose className="w-4 h-4" aria-hidden />
        </button>
      </div>
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-full bg-muted px-3 py-2">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar chats"
            aria-label="Buscar chats"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto pb-3">
        {fallo ? (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {fallo}
          </p>
        ) : null}
        {estado === "cargando" ? (
          <div className="px-3 space-y-2" role="status" aria-label="Cargando historial">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : estado === "error" ? (
          <div className="px-4 text-sm text-muted-foreground" role="alert">
            <p>No se pudo leer el historial ahora mismo — tus conversaciones siguen guardadas; reintenta en un momento.</p>
            <button type="button" onClick={reintentar} className="mt-2 text-xs underline underline-offset-2 hover:text-foreground">
              Reintentar
            </button>
          </div>
        ) : lista.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">Sin chats recientes.</p>
        ) : filtradas.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">Sin resultados.</p>
        ) : (
          grupos.map(({ grupo, items }) => (
            <section key={grupo} aria-label={ETIQUETA_GRUPO[grupo]}>
              <h2 className="px-4 pb-2 pt-1 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground font-normal">{ETIQUETA_GRUPO[grupo]}</h2>
              <ul className="px-2">
                {items.map((c) => (
                  <li key={c.id} className="group relative">
                    {renombrando === c.id ? (
                      <input
                        autoFocus
                        value={borrador}
                        maxLength={80}
                        aria-label="Nuevo nombre del chat"
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
                        className="w-full text-sm px-3 py-2 rounded-lg bg-muted outline-none"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onAbrir(c.id)}
                          aria-current={c.id === activaId ? "true" : undefined}
                          className={`w-full text-left text-sm pl-3 pr-16 py-2 rounded-lg hover:bg-muted truncate ${c.id === activaId ? "bg-muted font-medium" : ""}`}
                        >
                          {c.titulo}
                        </button>
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100">
                          {transporte.renombrar ? (
                            <button
                              type="button"
                              aria-label={`Renombrar ${c.titulo}`}
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
                              aria-label={`Borrar ${c.titulo}`}
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
                ))}
              </ul>
            </section>
          ))
        )}
        {estado === "listo" && lista.length >= TOPE_HISTORIAL ? (
          <p className="px-4 pt-2 text-xs text-muted-foreground">Las {TOPE_HISTORIAL} más recientes — las anteriores siguen guardadas.</p>
        ) : null}
      </div>

      <ConfirmDialog
        open={aBorrar !== null}
        onOpenChange={(o) => {
          if (!o) setABorrar(null);
        }}
        titulo="¿Borrar este chat?"
        descripcion="Se borra para siempre. Las cifras no cambian."
        tono="danger"
        confirmar="Borrar"
        onConfirm={async () => {
          if (aBorrar) await borrar(aBorrar);
        }}
      />
    </div>
  );
}
