// Cola de pedidos del encargado (panel movil del operador, PLAN-PANEL-OPERADOR §5.4-A): pedidos activos del turno por pestanas
// (Nuevos, En preparacion, Listos, En camino), semaforo de tiempo, UN boton grande por pedido (Aceptar -> Listo) y alerta sonora de
// pedido nuevo. Sondeo cada 15 s. Sin datos de ejemplo: lee `GET admin/operacion/cola`; si el servidor aun no lo implementa (501) o falla,
// lo dice con claridad y no pinta nada falso.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, Tabs, TabsList, TabsTrigger, notify, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesOperacion } from "@atiende/ui/i18n/restaurantes/operacion";
import type { ColaSalida, TarjetaPedido as TarjetaPedidoDato } from "@atiende/domain-restaurantes/operacion";
import { Hourglass, Inbox, Volume2, VolumeX, WifiOff } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { TarjetaPedido } from "../components/operacion/TarjetaPedido.tsx";
import { SILENCIO_MS, crearAlertaRepetida, vibrarAviso } from "../lib/alerta-pedido-nuevo.ts";
import { aceptarPedido, entregarEnMostrador, ErrorOperacion, fetchCola, marcarListo, nuevaLlave } from "../lib/operacion-client.ts";
import { PESTANAS_COLA, conteosPorPestana, minutosVivos, ordenarCola, pestanaDe } from "../lib/operacion-presentacion.ts";
import type { PestanaCola } from "../lib/operacion-presentacion.ts";
import { etiquetaActualizado, guardarSonido, leerSonido, reproducirAviso } from "../lib/sondeo-pedidos.ts";
import { aplicarTemaAutomatico } from "../lib/tema-nocturno.ts";
import { solicitarWakeLock } from "../lib/wake-lock.ts";
import type { ControlWakeLock, EstadoWakeLock } from "../lib/wake-lock.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";

const SONDEO_COLA_MS = 15_000;
type AccionCola = "aceptar" | "listo" | "entregar";

function almacenamiento(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const TEXTO_WAKE: Readonly<Record<EstadoWakeLock, Clave>> = {
  inactivo: "restaurantes.operacion.cola.wake.inactivo",
  activo: "restaurantes.operacion.cola.wake.activo",
  no_soportado: "restaurantes.operacion.cola.wake.no_soportado",
  denegado: "restaurantes.operacion.cola.wake.denegado",
};

export function OperacionColaPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const t = useT(restaurantesOperacion);
  const [cola, setCola] = useState<ColaSalida | null>(null);
  const [consultadoEnMs, setConsultadoEnMs] = useState<number>(() => Date.now());
  const [ultimaOk, setUltimaOk] = useState<number | null>(null);
  const [error, setError] = useState<ErrorOperacion | Error | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [pestana, setPestana] = useState<PestanaCola>("nuevos");
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set());
  const [reconocidos, setReconocidos] = useState<ReadonlySet<string>>(new Set());
  const [sonido, setSonido] = useState<boolean>(() => leerSonido(almacenamiento(), orgSlug, propertyId));
  const [wake, setWake] = useState<EstadoWakeLock>("inactivo");
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const [silenciadaHasta, setSilenciadaHasta] = useState(0);
  const llaves = useRef(new Map<string, string>());
  const wakeRef = useRef<ControlWakeLock | null>(null);
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);

  // Modo oscuro automatico (de noche o si el sistema esta en oscuro), restaurado al salir.
  useEffect(() => aplicarTemaAutomatico(), []);

  // Reloj local: los minutos avanzan entre consultas.
  useEffect(() => {
    const id = window.setInterval(() => setAhoraMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const cargar = useCallback(async () => {
    try {
      const r = await fetchCola(fetchImpl, apiBaseUrl, token, propertyId);
      setCola(r);
      setConsultadoEnMs(Date.now());
      setUltimaOk(Date.now());
      setAhoraMs(Date.now());
      setError(null);
      setSinConexion(false);
    } catch (e) {
      if (e instanceof TypeError) {
        // Fallo de red: se conserva lo ultimo visto y se avisa; sin nada previo que mostrar, la pantalla pide reintentar.
        setSinConexion(true);
        setError(new Error(t("restaurantes.operacion.sinConexionServidor")));
      } else setError(e instanceof Error ? e : new Error(t("restaurantes.operacion.cola.errorCarga")));
      throw e;
    }
  }, [apiBaseUrl, fetchImpl, propertyId, token]);

  const sondeo = useSondeoPedidos({ clave: `${orgSlug}:${propertyId}`, activo: true, consulta: cargar, baseMs: SONDEO_COLA_MS });
  const refrescar = sondeo.refrescar;
  // Primera carga inmediata (el sondeo solo programa la siguiente).
  useEffect(() => {
    void cargar().catch(() => undefined);
  }, [cargar]);

  const pedidos = cola?.pedidos ?? [];
  const pendientes = useMemo(() => pedidos.filter((p) => p.estado === "pending"), [pedidos]);
  const sinReconocer = useMemo(() => pendientes.filter((p) => !reconocidos.has(p.id)), [pendientes, reconocidos]);

  // Alerta: suena mientras haya pedidos nuevos sin reconocer (y el sonido este activado con un toque de la persona).
  const alerta = useMemo(() => crearAlertaRepetida({ reproducir: reproducirAviso, vibrar: vibrarAviso }), []);
  const debeSonar = sonido && sinReconocer.length > 0;
  useEffect(() => {
    if (debeSonar) alerta.iniciar();
    else alerta.detener();
    return () => alerta.detener();
  }, [alerta, debeSonar]);

  useEffect(() => () => void wakeRef.current?.liberar(), []);

  async function activarSonido() {
    setSonido(true);
    guardarSonido(almacenamiento(), orgSlug, propertyId, true);
    reproducirAviso(); // el toque es el gesto que el navegador exige para permitir audio
    wakeRef.current?.liberar().catch(() => undefined);
    wakeRef.current = await solicitarWakeLock(setWake);
  }
  function desactivarSonido() {
    setSonido(false);
    guardarSonido(almacenamiento(), orgSlug, propertyId, false);
    void wakeRef.current?.liberar();
    wakeRef.current = null;
  }

  const reconocer = useCallback((p: TarjetaPedidoDato) => setReconocidos((s) => new Set(s).add(p.id)), []);

  async function ejecutar(p: TarjetaPedidoDato, accion: AccionCola) {
    const clave = `${p.id}:${accion}`;
    if (ocupados.has(p.id)) return;
    setOcupados((s) => new Set(s).add(p.id));
    reconocer(p);
    const llave = llaves.current.get(clave) ?? nuevaLlave(); // se conserva si hay que reintentar: el servidor no duplica
    llaves.current.set(clave, llave);
    try {
      if (accion === "aceptar") await aceptarPedido(fetchImpl, apiBaseUrl, token, propertyId, p.id, llave);
      else if (accion === "listo") await marcarListo(fetchImpl, apiBaseUrl, token, propertyId, p.id, llave);
      else await entregarEnMostrador(fetchImpl, apiBaseUrl, token, propertyId, p.id, llave);
      llaves.current.delete(clave);
      notify.success(t(accion === "aceptar" ? "restaurantes.operacion.cola.exito.aceptar" : accion === "listo" ? "restaurantes.operacion.cola.exito.listo" : "restaurantes.operacion.cola.exito.entregar", { numero: String(p.numero) }));
    } catch (e) {
      if (e instanceof ErrorOperacion && e.esEstadoCambio) {
        llaves.current.delete(clave);
        notify.info(t("restaurantes.operacion.cola.yaCambio", { numero: String(p.numero) }));
      } else {
        if (e instanceof ErrorOperacion && e.status >= 400 && e.status < 500) llaves.current.delete(clave);
        notify.error(e instanceof ErrorOperacion ? e.message : t("restaurantes.operacion.errorSinRed"));
      }
    } finally {
      setOcupados((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
      refrescar();
    }
  }

  const base = `/restaurantes/${orgSlug}/operacion`;
  const conteos = useMemo(() => conteosPorPestana(pedidos), [pedidos]);
  const visibles = useMemo(
    () => ordenarCola(pedidos.filter((p) => pestanaDe(p) === pestana), consultadoEnMs, ahoraMs),
    [ahoraMs, consultadoEnMs, pedidos, pestana],
  );

  if (cola === null && error === null) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">{t("restaurantes.operacion.cola.titulo")}</h1>
        <EstadoCargando variante="tarjeta" etiqueta={t("restaurantes.operacion.cola.cargando")} />
      </PageContainer>
    );
  }
  if (cola === null && error !== null) {
    const noDisponible = error instanceof ErrorOperacion && error.esNoDisponible;
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">{t("restaurantes.operacion.cola.titulo")}</h1>
        {noDisponible ? (
          <EstadoVacio icon={Hourglass} titulo={t("restaurantes.operacion.cola.titulo")} mensaje={t("restaurantes.operacion.cola.noDisponible")} />
        ) : (
          <EstadoError mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />
        )}
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-3 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="sr-only">{t("restaurantes.operacion.cola.titulo")}</h1>
          <span className="ml-auto text-sm text-muted-foreground" aria-live="off">
            {etiquetaActualizado(ultimaOk, ahoraMs)}
          </span>
        </div>

        {sinConexion && (
          <div role="status" className="flex items-center gap-2 rounded-lg border-2 border-warning bg-warning-tint p-3 text-base text-warning">
            <WifiOff className="size-5 shrink-0" aria-hidden="true" />
            {t("restaurantes.operacion.sinConexionReintentando")}
          </div>
        )}
        {error && cola !== null && !sinConexion && <EstadoError compacto mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />}

        <div aria-live="polite" className="space-y-2">
          {sinReconocer.length > 0 && (
            <div role="alert" className="space-y-2 rounded-lg border-2 border-primary bg-card p-3">
              <p className="text-lg font-bold text-foreground">
                {sinReconocer.length === 1 ? t("restaurantes.operacion.cola.nuevoUno", { numero: String(sinReconocer[0]!.numero) }) : t("restaurantes.operacion.cola.nuevosVarios", { n: sinReconocer.length })}
              </p>
              {sonido && silenciadaHasta <= ahoraMs ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-14 w-full text-lg"
                  onClick={() => {
                    alerta.silenciar();
                    setSilenciadaHasta(Date.now() + SILENCIO_MS);
                  }}
                >
                  {t("restaurantes.operacion.cola.silenciar")}
                </Button>
              ) : null}
              {sonido && silenciadaHasta > ahoraMs && <p className="text-sm text-muted-foreground">{t("restaurantes.operacion.silenciado5")}</p>}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          {sonido ? (
            <Button type="button" variant="outline" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={desactivarSonido} iconLeft={<Volume2 className="size-5" aria-hidden="true" />}>
              {t("restaurantes.operacion.sonidoActivado")}
            </Button>
          ) : (
            <Button type="button" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={() => void activarSonido()} iconLeft={<VolumeX className="size-5" aria-hidden="true" />}>
              {t("restaurantes.operacion.cola.activarSonido")}
            </Button>
          )}
          {sonido && <p className="text-sm text-muted-foreground">{t(TEXTO_WAKE[wake])}</p>}
          <p className="text-sm text-muted-foreground">{t("restaurantes.operacion.avisoSonidoLimites")}</p>
        </div>

        <Tabs value={pestana} onValueChange={(v) => setPestana(v as PestanaCola)}>
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
            {PESTANAS_COLA.map((pes) => (
              <TabsTrigger key={pes.valor} value={pes.valor} className="h-12 text-base" data-testid={`pestana-${pes.valor}`}>
                {pes.etiqueta}
                <StatusBadge tone={pes.valor === "nuevos" && conteos.nuevos > 0 ? "danger" : "neutral"} dot={false} className="ml-1.5 text-sm" aria-label={t("restaurantes.operacion.cola.conteoAria", { n: conteos[pes.valor] })}>
                  {conteos[pes.valor]}
                </StatusBadge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {visibles.length === 0 ? (
          <EstadoVacio icon={Inbox} titulo={t("restaurantes.operacion.cola.vacioTitulo")} mensaje={t("restaurantes.operacion.cola.vacio", { pestana: String(PESTANAS_COLA.find((x) => x.valor === pestana)?.etiqueta) })} />
        ) : (
          <ul className="space-y-3" aria-label={t("restaurantes.operacion.cola.listaAria", { pestana: String(PESTANAS_COLA.find((x) => x.valor === pestana)?.etiqueta) })}>

            {visibles.map((p) => (
              <li key={p.id}>
                <TarjetaPedido
                  pedido={p}
                  minutos={minutosVivos(p, consultadoEnMs, ahoraMs)}
                  ocupado={ocupados.has(p.id)}
                  sinReconocer={p.estado === "pending" && !reconocidos.has(p.id)}
                  alAccion={(pedido, accion) => void ejecutar(pedido, accion)}
                  alReconocer={reconocer}
                  rutaViajes={`${base}/viajes`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageContainer>
  );
}
