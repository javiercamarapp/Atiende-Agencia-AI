// «Agregados por validar» (panel movil del operador, migracion 097): el cliente ya tiene un pedido enviado a la sucursal y pide agregar algo por WhatsApp o llamada.
// El agente NUNCA lo confirma: crea la solicitud y aqui la sucursal la acepta o la rechaza con motivo. Pendientes con la mas antigua arriba, cronometro con color
// (plazo de 10 min), banner persistente + sonido de dos tonos cada 60 s mientras haya pendientes, titulo de la pestana parpadeante. Sondeo cada 15 s.
// Sin datos de ejemplo: lee `GET admin/agregados`; sin la actualizacion de base de datos lo dice con claridad y no pinta nada falso.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, Tabs, TabsList, TabsTrigger, notify, useConfirm } from "@atiende/ui";
import type { ListaAgregados, RechazarAgregadoEntrada, ResolverAgregadoSalida, TarjetaAgregado as TarjetaAgregadoDato } from "@atiende/domain-restaurantes/operacion";
import { Hourglass, ListChecks, Volume2, VolumeX, WifiOff } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";
import { TarjetaAgregado } from "../components/operacion/TarjetaAgregado.tsx";
import { aceptarAgregado, fetchAgregados, marcarAgregadoVisto, rechazarAgregado } from "../lib/agregados-client.ts";
import type { EstadoLista } from "../lib/agregados-client.ts";
import { MENSAJE_AGREGADOS_NO_DISPONIBLES, OPCIONES_RECHAZO, ordenarAgregados, segundosVivos, textoPendientes, tituloConPendientes } from "../lib/agregados-presentacion.ts";
import { AVISO_SONIDO_LIMITES, SILENCIO_MS, crearAlertaRepetida, vibrarAviso } from "../lib/alerta-pedido-nuevo.ts";
import { ErrorOperacion, nuevaLlave } from "../lib/operacion-client.ts";
import { etiquetaActualizado, guardarSonido, leerSonido, reproducirAviso } from "../lib/sondeo-pedidos.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";

const SONDEO_MS = 15_000;
/** El sonido se repite cada 60 s mientras siga pendiente (el banner visual no se puede silenciar). */
export const REPETICION_SONIDO_MS = 60_000;

function almacenamiento(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function OperacionAgregadosPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const [lista, setLista] = useState<ListaAgregados | null>(null);
  const [consultadoEnMs, setConsultadoEnMs] = useState<number>(() => Date.now());
  const [ultimaOk, setUltimaOk] = useState<number | null>(null);
  const [error, setError] = useState<ErrorOperacion | Error | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [pestana, setPestana] = useState<EstadoLista>("pendientes");
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set());
  const [sonido, setSonido] = useState<boolean>(() => leerSonido(almacenamiento(), orgSlug, propertyId));
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const [silenciadaHasta, setSilenciadaHasta] = useState(0);
  const [rechazando, setRechazando] = useState<TarjetaAgregadoDato | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [parpadeo, setParpadeo] = useState(false);
  const llaves = useRef(new Map<string, string>());
  const vistos = useRef(new Set<string>());
  /** Candado SINCRONO contra el doble toque (el estado `ocupados` se actualiza despues del render). */
  const enCurso = useRef(new Set<string>());
  const { confirmar, dialogo } = useConfirm();
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);

  // Reloj local: el cronometro avanza cada segundo entre consultas.
  useEffect(() => {
    const id = window.setInterval(() => setAhoraMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const cargar = useCallback(async () => {
    try {
      const r = await fetchAgregados(fetchImpl, apiBaseUrl, token, propertyId, pestana);
      setLista(r);
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
      } else setError(e instanceof Error ? e : new Error("No se pudieron cargar los agregados."));
      throw e;
    }
  }, [apiBaseUrl, fetchImpl, pestana, propertyId, token]);

  const sondeo = useSondeoPedidos({ clave: `agregados-pagina:${orgSlug}:${propertyId}:${pestana}`, activo: true, consulta: cargar, baseMs: SONDEO_MS });
  const refrescar = sondeo.refrescar;
  useEffect(() => {
    void cargar().catch(() => undefined);
  }, [cargar]);

  const tarjetas = useMemo(() => ordenarAgregados(lista?.agregados ?? []), [lista]);
  const pendientes = useMemo(() => tarjetas.filter((t) => t.estado === "pendiente"), [tarjetas]);

  // Primera vez que una persona la ve (idempotente en el servidor; un fallo aqui nunca estorba la decision).
  useEffect(() => {
    for (const t of pendientes) {
      if (t.vistoEn !== null || vistos.current.has(t.id)) continue;
      vistos.current.add(t.id);
      void marcarAgregadoVisto(fetchImpl, apiBaseUrl, token, propertyId, t.id, nuevaLlave()).catch(() => undefined);
    }
  }, [apiBaseUrl, fetchImpl, pendientes, propertyId, token]);

  // Sonido de dos tonos: de inmediato al llegar y cada 60 s mientras siga pendiente (solo si la persona lo activo con un toque).
  const alerta = useMemo(() => crearAlertaRepetida({ reproducir: reproducirAviso, vibrar: vibrarAviso, intervaloMs: REPETICION_SONIDO_MS }), []);
  const debeSonar = sonido && pendientes.length > 0;
  useEffect(() => {
    if (debeSonar) alerta.iniciar();
    else alerta.detener();
    return () => alerta.detener();
  }, [alerta, debeSonar]);

  // Titulo de la pestana parpadeante «(N) Agregado por validar» mientras haya pendientes.
  const tituloBase = useRef<string>(typeof document === "undefined" ? "" : document.title);
  useEffect(() => {
    if (pendientes.length === 0) {
      setParpadeo(false);
      return;
    }
    const id = window.setInterval(() => setParpadeo((p) => !p), 1500);
    return () => window.clearInterval(id);
  }, [pendientes.length]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = tituloConPendientes(tituloBase.current, pendientes.length, parpadeo);
    return () => {
      document.title = tituloBase.current;
    };
  }, [parpadeo, pendientes.length]);

  function activarSonido() {
    setSonido(true);
    guardarSonido(almacenamiento(), orgSlug, propertyId, true);
    reproducirAviso(); // el toque es el gesto que el navegador exige para permitir audio
  }
  function desactivarSonido() {
    setSonido(false);
    guardarSonido(almacenamiento(), orgSlug, propertyId, false);
  }

  function avisarResultado(r: ResolverAgregadoSalida, accion: "aceptar" | "rechazar") {
    if (r.resultado === "ya_resuelto") notify.info(`Ya lo resolvió ${r.agregado.resueltoPor ?? "otra persona"}. Se actualizó la lista.`);
    else if (r.resultado === "no_aplicable") notify.warning("El pedido ya no admitía agregados (ya salió o se cerró). Se avisó al cliente que puede pedir aparte.");
    else if (accion === "aceptar") notify.success("Agregado aceptado. Se avisó al cliente.");
    else notify.success("Agregado rechazado. Se creó una tarea para devolver la llamada.");
  }

  async function ejecutar(t: TarjetaAgregadoDato, accion: "aceptar" | "rechazar", entrada?: RechazarAgregadoEntrada): Promise<boolean> {
    if (enCurso.current.has(t.id)) return false;
    enCurso.current.add(t.id);
    const clave = `${t.id}:${accion}`;
    const llave = llaves.current.get(clave) ?? nuevaLlave(); // se conserva si hay que reintentar: el servidor no duplica
    llaves.current.set(clave, llave);
    setOcupados((s) => new Set(s).add(t.id));
    setErrorDialogo(null);
    try {
      const r = accion === "aceptar" ? await aceptarAgregado(fetchImpl, apiBaseUrl, token, propertyId, t.id, llave) : await rechazarAgregado(fetchImpl, apiBaseUrl, token, propertyId, t.id, entrada!, llave);
      llaves.current.delete(clave);
      avisarResultado(r, accion);
      return true;
    } catch (e) {
      const mensaje = e instanceof ErrorOperacion ? e.message : "No hay conexión. La acción no se aplicó; vuelve a intentarlo.";
      if (e instanceof ErrorOperacion && e.status >= 400 && e.status < 500) llaves.current.delete(clave);
      notify.error(mensaje);
      setErrorDialogo(mensaje);
      return false;
    } finally {
      enCurso.current.delete(t.id);
      setOcupados((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
      refrescar();
    }
  }

  async function alAceptar(t: TarjetaAgregadoDato) {
    if (t.pedido.yaEnCocina) {
      const ok = await confirmar({
        titulo: "El pedido ya está en preparación",
        descripcion: "¿Confirmas que sí alcanza a agregarse? Si aceptas, el cliente recibe la confirmación con el nuevo total.",
        confirmar: "Sí, aceptar agregado",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    await ejecutar(t, "aceptar");
  }

  if (lista === null && error === null) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Agregados por validar</h1>
        <EstadoCargando variante="tarjeta" etiqueta="Cargando los agregados por validar…" />
      </PageContainer>
    );
  }
  if (lista === null && error !== null) {
    const noDisponible = error instanceof ErrorOperacion && (error.esNoDisponible || error.status === 503);
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Agregados por validar</h1>
        {noDisponible ? (
          <EstadoVacio icon={Hourglass} titulo="Agregados por validar" mensaje={MENSAJE_AGREGADOS_NO_DISPONIBLES} />
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
          <h1 className="sr-only">Agregados por validar</h1>
          <span className="ml-auto text-sm text-muted-foreground" aria-live="off">
            {etiquetaActualizado(ultimaOk, ahoraMs)}
          </span>
        </div>

        {sinConexion && (
          <div role="status" className="flex items-center gap-2 rounded-lg border-2 border-warning bg-warning-tint p-3 text-base text-warning">
            <WifiOff className="size-5 shrink-0" aria-hidden="true" />
            Sin conexión — reintentando. Lo que ves puede estar desactualizado.
          </div>
        )}
        {error && lista !== null && !sinConexion && <EstadoError compacto mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />}

        {lista !== null && !lista.disponible ? (
          <EstadoVacio icon={Hourglass} titulo="Agregados por validar" mensaje={MENSAJE_AGREGADOS_NO_DISPONIBLES} />
        ) : (
          <>
            {pendientes.length > 0 && (
              <div role="alert" data-testid="banner-agregados" className="space-y-2 rounded-lg border-2 border-primary bg-card p-3">
                <p className="text-lg font-bold text-foreground">{textoPendientes(pendientes.length)}</p>
                <p className="text-sm text-muted-foreground">El agente no confirma nada por su cuenta: acepta o rechaza para que el cliente reciba respuesta.</p>
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
                    Silenciar el sonido 5 minutos
                  </Button>
                ) : null}
                {sonido && silenciadaHasta > ahoraMs && <p className="text-sm text-muted-foreground">Sonido en silencio por 5 minutos. El aviso en pantalla sigue.</p>}
              </div>
            )}

            <div className="space-y-2 rounded-lg border border-border bg-card p-3">
              {sonido ? (
                <Button type="button" variant="outline" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={desactivarSonido} iconLeft={<Volume2 className="size-5" aria-hidden="true" />}>
                  Sonido activado · Desactivar
                </Button>
              ) : (
                <Button type="button" className="h-auto min-h-14 w-full whitespace-normal py-2 text-lg" onClick={activarSonido} iconLeft={<VolumeX className="size-5" aria-hidden="true" />}>
                  Activar sonido de agregados
                </Button>
              )}
              <p className="text-sm text-muted-foreground">{AVISO_SONIDO_LIMITES}</p>
            </div>

            <Tabs value={pestana} onValueChange={(v) => setPestana(v as EstadoLista)}>
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1">
                <TabsTrigger value="pendientes" className="h-12 text-base" data-testid="pestana-pendientes">
                  Por validar
                  <StatusBadge tone={pendientes.length > 0 ? "danger" : "neutral"} dot={false} className="ml-1.5 text-sm" aria-label={`${pendientes.length} por validar`}>
                    {lista?.pendientes ?? pendientes.length}
                  </StatusBadge>
                </TabsTrigger>
                <TabsTrigger value="recientes" className="h-12 text-base" data-testid="pestana-recientes">
                  Recientes
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tarjetas.length === 0 ? (
              <EstadoVacio icon={ListChecks} titulo={pestana === "pendientes" ? "Nada por validar" : "Sin movimientos recientes"} mensaje={pestana === "pendientes" ? "No hay agregados esperando respuesta de la sucursal." : "No hay agregados de las últimas 24 horas."} />
            ) : (
              <ul className="space-y-3" aria-label={pestana === "pendientes" ? "Agregados por validar" : "Agregados recientes"}>
                {tarjetas.map((t) => (
                  <li key={t.id}>
                    <TarjetaAgregado
                      tarjeta={t}
                      segundos={segundosVivos(t, consultadoEnMs, ahoraMs)}
                      ocupado={ocupados.has(t.id)}
                      alAceptar={(x) => void alAceptar(x)}
                      alRechazar={(x) => {
                        setErrorDialogo(null);
                        setRechazando(x);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <MotivoDialogo
        open={rechazando !== null}
        onOpenChange={(o) => !o && setRechazando(null)}
        titulo={rechazando ? `Rechazar el agregado${rechazando.pedido.numero !== null ? ` al pedido #${rechazando.pedido.numero}` : ""}` : "Rechazar el agregado"}
        subtitulo="Se avisa al cliente con una disculpa y se crea una tarea para devolverle la llamada."
        textoConfirmar="Rechazar agregado"
        tonoPeligro
        opciones={OPCIONES_RECHAZO}
        notaObligatoriaCon="otro"
        error={errorDialogo}
        enCurso={rechazando !== null && ocupados.has(rechazando.id)}
        onConfirmar={(motivo, nota) => {
          if (!rechazando) return;
          void ejecutar(rechazando, "rechazar", { motivo, ...(nota ? { nota } : {}) }).then((ok) => ok && setRechazando(null));
        }}
      />
      {dialogo}
    </PageContainer>
  );
}
