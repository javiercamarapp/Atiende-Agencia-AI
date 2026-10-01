// Pagina de notificaciones de las 7 consolas (6 verticales + superadmin), identica a la de Likida
// (`dashboard/notificaciones/lista.tsx` + `admin/notificaciones/lista.tsx`): la barra superior del shell
// lleva el icono + nombre de la pagina (`useTituloBarra`), el cuerpo es un renglon de texto de apoyo con
// «Marcar todas», una tarjeta `p-4` por aviso (badge de severidad, texto, «Resolver» a la pantalla donde se
// resuelve y «Marcar leído») y los estados vacio/cargando/error de verdad. Lo leido se OCULTA de la lista por
// omision y se cuenta abajo (como el «N avisos descartados» de Likida); «Todas» lo muestra atenuado.
//
// A diferencia de Likida (leidas en localStorage porque sus alertas son un calculo en vivo), aqui cada aviso
// es una fila real de `core.notification` y leerlo es estado por usuario en el servidor
// (`core.notification_read`): sobrevive a otro navegador/dispositivo y no apaga el aviso de otro usuario.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bell, CheckCheck, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Button, Card, EstadoCargando, EstadoError, StatusBadge, cn, useTituloBarra } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { NOTIFICACIONES_CAMBIO_EVENTO, anunciarCambioNotificaciones } from "../lib/useNotifications.ts";
import type { CambioNotificaciones } from "../lib/useNotifications.ts";
import { CATEGORIAS_ROTULO, SEVERIDAD_ROTULO, formatoRelativo, rotuloCategoria } from "../lib/notificaciones-presentacion.ts";
import { NotificacionesError, listarNotificaciones, marcarLeida, marcarTodasLeidas } from "../lib/notificaciones-client.ts";
import type { NotificacionFila, NotificacionSeveridad } from "../lib/notificaciones-client.ts";

export const NOTIFICACIONES_POR_PAGINA = 30;

const TONO: Readonly<Record<NotificacionSeveridad, StatusTone>> = { info: "neutral", atencion: "warning", critica: "danger" };
const ICONO = { info: Info, atencion: TriangleAlert, critica: CircleAlert } as const;
const COLOR_ICONO: Readonly<Record<NotificacionSeveridad, string>> = { info: "text-muted-foreground", atencion: "text-warning", critica: "text-destructive" };

type Vista = "sin-leer" | "todas";
type Fase = "cargando" | "error" | "listo";

export interface NotificacionesPaginaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
}

export function NotificacionesPagina({ apiBaseUrl, token }: NotificacionesPaginaProps) {
  useTituloBarra("Notificaciones", Bell);
  const [vista, setVista] = useState<Vista>("sin-leer");
  const [categoria, setCategoria] = useState<string | null>(null);
  const [fase, setFase] = useState<Fase>("cargando");
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [filas, setFilas] = useState<readonly NotificacionFila[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Cada carga lleva un numero: una respuesta vieja (otro filtro) nunca pisa a la nueva.
  const cargaRef = useRef(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const unreadRef = useRef(0);
  unreadRef.current = unreadCount;

  const cargar = useCallback(
    async (silenciosa: boolean) => {
      const mia = ++cargaRef.current;
      if (!silenciosa) {
        setFase("cargando");
        setErrorCarga(null);
      }
      try {
        const r = await listarNotificaciones(fetch, apiBaseUrl, tokenRef.current, { soloNoLeidas: vista === "sin-leer", categoria, limit: NOTIFICACIONES_POR_PAGINA });
        if (mia !== cargaRef.current) return;
        setFilas(r.notificaciones);
        setHayMas(r.notificaciones.length === NOTIFICACIONES_POR_PAGINA);
        setUnreadCount(r.unreadCount);
        setFase("listo");
        // La campana debe coincidir con lo que la pagina acaba de leer del servidor.
        anunciarCambioNotificaciones({ unreadCount: r.unreadCount, origen: "pagina" });
      } catch (err) {
        if (mia !== cargaRef.current) return;
        if (silenciosa) return;
        setErrorCarga(err instanceof NotificacionesError ? err.message : "No se pudieron cargar las notificaciones.");
        setFase("error");
      }
    },
    [apiBaseUrl, vista, categoria],
  );

  useEffect(() => {
    if (token === "") return;
    void cargar(false);
  }, [cargar, token]);

  // Llego algo nuevo (lo detecto el sondeo de la campana): se recarga la lista sin parpadeo.
  useEffect(() => {
    const alCambiar = (e: Event) => {
      const d = (e as CustomEvent<CambioNotificaciones>).detail;
      if (d?.origen === "sondeo" && typeof d.unreadCount === "number" && d.unreadCount > unreadRef.current) void cargar(true);
    };
    window.addEventListener(NOTIFICACIONES_CAMBIO_EVENTO, alCambiar);
    return () => window.removeEventListener(NOTIFICACIONES_CAMBIO_EVENTO, alCambiar);
  }, [cargar]);

  async function cargarMas() {
    const ultima = filas[filas.length - 1];
    if (!ultima || cargandoMas) return;
    setCargandoMas(true);
    setErrorAccion(null);
    try {
      const r = await listarNotificaciones(fetch, apiBaseUrl, tokenRef.current, { soloNoLeidas: vista === "sin-leer", categoria, before: ultima.createdAt, limit: NOTIFICACIONES_POR_PAGINA });
      setFilas((cur) => [...cur, ...r.notificaciones.filter((n) => !cur.some((c) => c.id === n.id))]);
      setHayMas(r.notificaciones.length === NOTIFICACIONES_POR_PAGINA);
    } catch (err) {
      setErrorAccion(err instanceof NotificacionesError ? err.message : "No se pudieron cargar más notificaciones.");
    } finally {
      setCargandoMas(false);
    }
  }

  async function leer(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (!fila || fila.readAt !== null) return;
    setErrorAccion(null);
    const respaldo = { filas, unreadCount };
    // Optimista: el punto de la campana y la fila cambian al instante; si el servidor falla se revierte.
    const marca = new Date().toISOString();
    setFilas((cur) => (vista === "sin-leer" ? cur.filter((f) => f.id !== id) : cur.map((f) => (f.id === id ? { ...f, readAt: marca } : f))));
    const esperado = Math.max(0, unreadCount - 1);
    setUnreadCount(esperado);
    anunciarCambioNotificaciones({ unreadCount: esperado, origen: "pagina" });
    try {
      const real = await marcarLeida(fetch, apiBaseUrl, tokenRef.current, id);
      setUnreadCount(real);
      anunciarCambioNotificaciones({ unreadCount: real, origen: "pagina" });
    } catch (err) {
      setFilas(respaldo.filas);
      setUnreadCount(respaldo.unreadCount);
      anunciarCambioNotificaciones({ unreadCount: respaldo.unreadCount, origen: "pagina" });
      setErrorAccion(err instanceof NotificacionesError ? err.message : "No se pudo marcar como leída.");
    }
  }

  async function leerTodas() {
    if (ocupado) return;
    setOcupado(true);
    setErrorAccion(null);
    try {
      await marcarTodasLeidas(fetch, apiBaseUrl, tokenRef.current);
      anunciarCambioNotificaciones({ unreadCount: 0, origen: "pagina" });
      await cargar(false);
    } catch (err) {
      setErrorAccion(err instanceof NotificacionesError ? err.message : "No se pudieron marcar como leídas.");
    } finally {
      setOcupado(false);
    }
  }

  const sinLeerEnLista = filas.filter((f) => f.readAt === null).length;
  const leidasOcultas = vista === "sin-leer" ? 0 : filas.length - sinLeerEnLista;

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-eyebrow text-faint">
          Lo que hoy necesita a una persona. Cada renglón lleva a la pantalla donde se resuelve; todos salen de un evento real de tu operación, ninguno de un contador de adorno.
        </p>
        {unreadCount > 0 && (
          <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={() => void leerTodas()} disabled={ocupado}>
            <CheckCheck className="size-[13px]" strokeWidth={1.75} />
            Marcar todas
          </Button>
        )}
      </div>

      <div role="group" aria-label="Filtros de notificaciones" className="flex flex-wrap items-center gap-1.5">
        <FiltroPildora activo={vista === "sin-leer"} onClick={() => setVista("sin-leer")}>
          Sin leer
        </FiltroPildora>
        <FiltroPildora activo={vista === "todas"} onClick={() => setVista("todas")}>
          Todas
        </FiltroPildora>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <FiltroPildora activo={categoria === null} onClick={() => setCategoria(null)}>
          Todas las categorías
        </FiltroPildora>
        {Object.entries(CATEGORIAS_ROTULO).map(([clave, rotulo]) => (
          <FiltroPildora key={clave} activo={categoria === clave} onClick={() => setCategoria(clave)}>
            {rotulo}
          </FiltroPildora>
        ))}
      </div>

      {errorAccion && (
        <p role="alert" className="text-eyebrow text-destructive">
          {errorAccion}
        </p>
      )}

      {fase === "cargando" && <EstadoCargando variante="tarjeta" etiqueta="Cargando notificaciones…" />}
      {fase === "error" && <EstadoError titulo="No se pudieron cargar las notificaciones" mensaje={errorCarga ?? undefined} onReintentar={() => void cargar(false)} compacto />}

      {fase === "listo" && filas.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-ui font-medium">{vista === "sin-leer" && categoria === null ? "Sin novedades." : "Sin resultados."}</p>
          <p className="mt-1 text-eyebrow text-muted-foreground">
            {vista === "sin-leer" && categoria === null
              ? "Nada de tu operación pide a una persona en este momento."
              : "No hay notificaciones con este filtro. Cambia a «Todas» para ver también las ya leídas."}
          </p>
        </Card>
      )}

      {fase === "listo" &&
        filas.map((n) => <TarjetaNotificacion key={n.id} fila={n} onLeer={() => void leer(n.id)} />)}

      {fase === "listo" && hayMas && (
        <div className="flex justify-center pt-1">
          <Button type="button" variant="outline" size="xs" onClick={() => void cargarMas()} disabled={cargandoMas}>
            {cargandoMas ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      )}

      {fase === "listo" && vista === "sin-leer" && filas.length > 0 && (
        <p className="pt-1 text-eyebrow text-faint">Lo leído se oculta de esta lista; «Todas» lo muestra.</p>
      )}
      {fase === "listo" && leidasOcultas > 0 && (
        <p className="pt-1 text-eyebrow text-faint">
          {leidasOcultas} {leidasOcultas === 1 ? "aviso ya leído" : "avisos ya leídos"} en esta lista.
        </p>
      )}
    </div>
  );
}

function FiltroPildora({ activo, onClick, children }: { activo: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors",
        activo ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-canvas",
      )}
    >
      {children}
    </button>
  );
}

function TarjetaNotificacion({ fila, onLeer }: { fila: NotificacionFila; onLeer: () => void }) {
  const Icono = ICONO[fila.severidad];
  const sinLeer = fila.readAt === null;
  const categoria = rotuloCategoria(fila.categoria);
  return (
    <Card className="p-4" data-testid="notificacion" data-sin-leer={sinLeer ? "true" : "false"} data-severidad={fila.severidad}>
      <div className="flex items-start gap-3">
        <Icono aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", COLOR_ICONO[fila.severidad])} strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={TONO[fila.severidad]} dot={false} className="text-eyebrow">
              {SEVERIDAD_ROTULO[fila.severidad]}
            </StatusBadge>
            {categoria && <span className="text-eyebrow text-faint">{categoria}</span>}
            <span className="text-eyebrow text-faint">· {formatoRelativo(fila.createdAt)}</span>
          </div>
          <p className={cn("mt-1.5 text-ui", sinLeer ? "font-medium text-foreground" : "text-muted-foreground")}>{fila.titulo}</p>
          {fila.cuerpo && <p className="mt-1 text-xs text-muted-foreground">{fila.cuerpo}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {fila.enlace && (
              <Button asChild variant="outline" size="xs">
                {/* Ir a donde se resuelve cuenta como atenderlo: la marca de leida viaja con el clic. */}
                <Link to={fila.enlace} onClick={onLeer}>
                  Resolver
                  <ArrowRight className="size-[13px]" strokeWidth={1.75} />
                </Link>
              </Button>
            )}
            {sinLeer && (
              <button type="button" onClick={onLeer} className="text-xs text-muted-foreground transition-colors hover:underline">
                Marcar leído
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
