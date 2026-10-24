// Cola de pedidos del encargado (panel movil del operador, PLAN-PANEL-OPERADOR §5.4-A): pedidos activos del turno por pestanas
// (Nuevos, En preparacion, Listos, En camino), semaforo de tiempo, UN boton grande por pedido (Aceptar -> Listo) y alerta sonora de
// pedido nuevo. Sondeo cada 15 s. Sin datos de ejemplo: lee `GET admin/operacion/cola`; si el servidor aun no lo implementa (501) o falla,
// lo dice con claridad y no pinta nada falso.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, Tabs, TabsList, TabsTrigger, notify } from "@atiende/ui";
import type { ColaSalida, TarjetaPedido as TarjetaPedidoDato } from "@atiende/domain-restaurantes/operacion";
import { Hourglass, Inbox, Volume2, VolumeX, WifiOff } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { TarjetaPedido } from "../components/operacion/TarjetaPedido.tsx";
import { AVISO_SONIDO_LIMITES, SILENCIO_MS, crearAlertaRepetida, vibrarAviso } from "../lib/alerta-pedido-nuevo.ts";
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

const TEXTO_WAKE: Readonly<Record<EstadoWakeLock, string>> = {
  inactivo: "La pantalla puede apagarse.",
  activo: "La pantalla se mantiene encendida.",
  no_soportado: "Este navegador no puede mantener la pantalla encendida: desactiva el bloqueo automático.",
  denegado: "El navegador no permitió mantener la pantalla encendida: desactiva el bloqueo automático.",
};

export function OperacionColaPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
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
        setError(new Error("Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo."));
      } else setError(e instanceof Error ? e : new Error("No se pudo cargar la cola."));
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
      notify.success(`Pedido #${p.numero}: ${accion === "aceptar" ? "aceptado" : accion === "listo" ? "listo" : "entregado"}.`);
    } catch (e) {
      if (e instanceof ErrorOperacion && e.esEstadoCambio) {
        llaves.current.delete(clave);
        notify.info(`El pedido #${p.numero} ya cambió de estado; se actualizó la cola.`);
      } else {
        if (e instanceof ErrorOperacion && e.status >= 400 && e.status < 500) llaves.current.delete(clave);
        notify.error(e instanceof ErrorOperacion ? e.message : "No hay conexión. La acción no se aplicó; vuelve a tocar el botón.");
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
        <h1 className="sr-only">Cola de pedidos</h1>
        <EstadoCargando variante="tarjeta" etiqueta="Cargando la cola de pedidos…" />
      </PageContainer>
    );
  }
  if (cola === null && error !== null) {
    const noDisponible = error instanceof ErrorOperacion && error.esNoDisponible;
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Cola de pedidos</h1>
        {noDisponible ? (
          <EstadoVacio icon={Hourglass} titulo="Cola de pedidos" mensaje="No disponible aún: esta pantalla se activa cuando el servidor del panel del operador esté listo." />
        ) : (
          <EstadoError mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />
        )}
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none">
      <div className="mx-auto w-full min-w-0 max-w-2xl space-y-3 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-foreground">Cola de pedidos</h1>
          <span className="text-sm text-muted-foreground" aria-live="off">
            {etiquetaActualizado(ultimaOk, ahoraMs)}
          </span>
        </div>

        {sinConexion && (
          <div role="status" className="flex items-center gap-2 rounded-lg border-2 border-warning bg-warning-tint p-3 text-base text-warning">
            <WifiOff className="size-5 shrink-0" aria-hidden="true" />
            Sin conexión — reintentando. Lo que ves puede estar desactualizado.
          </div>
        )}
        {error && cola !== null && !sinConexion && <EstadoError compacto mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />}

        <div aria-live="polite" className="space-y-2">
          {sinReconocer.length > 0 && (
            <div role="alert" className="space-y-2 rounded-lg border-2 border-primary bg-card p-3">
              <p className="text-lg font-bold text-foreground">
                {sinReconocer.length === 1 ? `Pedido nuevo #${sinReconocer[0]!.numero}` : `${sinReconocer.length} pedidos nuevos sin atender`}
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
                  Silenciar 5 minutos
                </Button>
              ) : null}
              {sonido && silenciadaHasta > ahoraMs && <p className="text-sm text-muted-foreground">Sonido en silencio por 5 minutos.</p>}
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          {sonido ? (
            <Button type="button" variant="outline" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={desactivarSonido} iconLeft={<Volume2 className="size-5" aria-hidden="true" />}>
              Sonido activado · Desactivar
            </Button>
          ) : (
            <Button type="button" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={() => void activarSonido()} iconLeft={<VolumeX className="size-5" aria-hidden="true" />}>
              Activar sonido y mantener pantalla encendida
            </Button>
          )}
          {sonido && <p className="text-sm text-muted-foreground">{TEXTO_WAKE[wake]}</p>}
          <p className="text-sm text-muted-foreground">{AVISO_SONIDO_LIMITES}</p>
        </div>

        <Tabs value={pestana} onValueChange={(v) => setPestana(v as PestanaCola)}>
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
            {PESTANAS_COLA.map((t) => (
              <TabsTrigger key={t.valor} value={t.valor} className="h-12 text-base" data-testid={`pestana-${t.valor}`}>
                {t.etiqueta}
                <StatusBadge tone={t.valor === "nuevos" && conteos.nuevos > 0 ? "danger" : "neutral"} dot={false} className="ml-1.5 text-sm" aria-label={`${conteos[t.valor]} pedidos`}>
                  {conteos[t.valor]}
                </StatusBadge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {visibles.length === 0 ? (
          <EstadoVacio icon={Inbox} titulo="Sin pedidos aquí" mensaje={`No hay pedidos en «${PESTANAS_COLA.find((t) => t.valor === pestana)?.etiqueta}» por ahora.`} />
        ) : (
          <ul className="space-y-3" aria-label={`Pedidos: ${PESTANAS_COLA.find((t) => t.valor === pestana)?.etiqueta}`}>
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
