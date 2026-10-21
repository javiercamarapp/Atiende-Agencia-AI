// Viajes del encargado (panel movil del operador, PLAN-PANEL-OPERADOR §5.4-C): pedidos por salir, seleccion de lote (hasta 6), chofer y UN boton
// «Salió» con confirmacion que llama a `POST admin/orders/dispatch` (despacho atomico en el servidor: nunca dos PATCH). Lista de «en camino»
// con tiempo transcurrido y rojo + alerta a los 90 min. Sin datos de ejemplo: lee `GET admin/operacion/viajes`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, PageContainer, Selector, StatusBadge, formatMoney, notify } from "@atiende/ui";
import type { TarjetaPedido, ViajesSalida } from "@atiende/domain-restaurantes/operacion";
import { AlertTriangle, Hourglass, MessageSquareOff, Square, SquareCheckBig, WifiOff } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { SemaforoMinutos } from "../components/operacion/SemaforoMinutos.tsx";
import { despacharPedidos, ErrorOperacion, fetchViajes, nuevaLlave } from "../lib/operacion-client.ts";
import { minutosVivos } from "../lib/operacion-presentacion.ts";
import { etiquetaActualizado } from "../lib/sondeo-pedidos.ts";
import { EN_CAMINO_ROJO_MIN, semaforoPedido } from "../lib/semaforo.ts";
import { aplicarTemaAutomatico } from "../lib/tema-nocturno.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";
import { ETA_POR_OMISION_MIN, MAX_LOTE, alternarSeleccion, choferInicial, depurarSeleccion, etiquetaChofer, textoBotonSalio } from "../lib/viajes.ts";

const SONDEO_VIAJES_MS = 15_000;

export function OperacionViajesPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [datos, setDatos] = useState<ViajesSalida | null>(null);
  const [consultadoEnMs, setConsultadoEnMs] = useState<number>(() => Date.now());
  const [ultimaOk, setUltimaOk] = useState<number | null>(null);
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const [error, setError] = useState<ErrorOperacion | Error | null>(null);
  const [sinConexion, setSinConexion] = useState(false);
  const [seleccion, setSeleccion] = useState<readonly string[]>([]);
  const [choferId, setChoferId] = useState<string>("");
  const [eta, setEta] = useState<string>(String(ETA_POR_OMISION_MIN));
  const [confirmando, setConfirmando] = useState(false);
  const [fueraDeTurno, setFueraDeTurno] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [topeAvisado, setTopeAvisado] = useState(false);
  const intento = useRef<{ clave: string; llave: string } | null>(null);
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);

  useEffect(() => aplicarTemaAutomatico(), []);
  useEffect(() => {
    const id = window.setInterval(() => setAhoraMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const cargar = useCallback(async () => {
    try {
      const r = await fetchViajes(fetchImpl, apiBaseUrl, token, propertyId);
      setDatos(r);
      setConsultadoEnMs(Date.now());
      setUltimaOk(Date.now());
      setAhoraMs(Date.now());
      setError(null);
      setSinConexion(false);
      setSeleccion((s) => depurarSeleccion(s, r.porSalir.map((p) => p.id)));
      setChoferId((actual) => (actual && r.repartidores.some((c) => c.id === actual) ? actual : (choferInicial(r.repartidores) ?? "")));
    } catch (e) {
      if (e instanceof TypeError) {
        setSinConexion(true);
        setError(new Error("Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo."));
      } else setError(e instanceof Error ? e : new Error("No se pudo cargar Viajes."));
      throw e;
    }
  }, [apiBaseUrl, fetchImpl, propertyId, token]);

  const sondeo = useSondeoPedidos({ clave: `viajes:${propertyId}`, activo: true, consulta: cargar, baseMs: SONDEO_VIAJES_MS });
  const refrescar = sondeo.refrescar;
  useEffect(() => {
    void cargar().catch(() => undefined);
  }, [cargar]);

  const porSalir = datos?.porSalir ?? [];
  const chofer = datos?.repartidores.find((c) => c.id === choferId) ?? null;
  const etaNum = Number(eta);
  const etaValida = Number.isInteger(etaNum) && etaNum >= 5 && etaNum <= 240;
  const elegidos = porSalir.filter((p) => seleccion.includes(p.id));
  const puedeSalir = elegidos.length > 0 && chofer !== null && etaValida && !enviando;

  async function despachar(forzar: boolean) {
    if (!chofer || elegidos.length === 0) return;
    const ids = elegidos.map((p) => p.id);
    const clave = JSON.stringify({ ids: [...ids].sort(), chofer: chofer.id, etaNum, forzar });
    if (intento.current?.clave !== clave) intento.current = { clave, llave: nuevaLlave() }; // misma llave solo si es el mismo intento
    setEnviando(true);
    try {
      const r = await despacharPedidos(fetchImpl, apiBaseUrl, token, propertyId, { pedidos: ids, repartidorId: chofer.id, desdeEstado: "preparando", etaMin: etaNum, ...(forzar ? { forzar: true } : {}) }, intento.current.llave);
      intento.current = null;
      setSeleccion([]);
      const sinAviso = r.resultados.filter((x) => x.aviso.startsWith("omitido")).length;
      notify.success(`${r.resultados.length === 1 ? "1 pedido salió" : `${r.resultados.length} pedidos salieron`} con ${chofer.nombre}.`);
      if (sinAviso > 0) notify.warning(`${sinAviso === 1 ? "1 cliente quedó" : `${sinAviso} clientes quedaron`} sin aviso por WhatsApp: avísales por llamada.`);
    } catch (e) {
      if (e instanceof ErrorOperacion && e.code === "repartidor_no_disponible" && !forzar) {
        setFueraDeTurno(chofer.nombre);
      } else if (e instanceof ErrorOperacion && e.esEstadoCambio) {
        intento.current = null;
        notify.info("Alguno de los pedidos ya cambió de estado; se actualizó la lista. Revisa y vuelve a elegir.");
      } else {
        if (e instanceof ErrorOperacion && e.status >= 400 && e.status < 500) intento.current = null;
        notify.error(e instanceof ErrorOperacion ? e.message : "No hay conexión. Nada salió; vuelve a tocar Salió.");
      }
    } finally {
      setEnviando(false);
      refrescar();
    }
  }

  if (datos === null && error === null) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Viajes</h1>
        <EstadoCargando variante="tarjeta" etiqueta="Cargando Viajes…" />
      </PageContainer>
    );
  }
  if (datos === null && error !== null) {
    const noDisponible = error instanceof ErrorOperacion && error.esNoDisponible;
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Viajes</h1>
        {noDisponible ? (
          <EstadoVacio icon={Hourglass} titulo="Viajes" mensaje="No disponible aún: el despacho de pedidos a choferes se activa cuando el servidor del panel del operador esté listo." />
        ) : (
          <EstadoError mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />
        )}
      </PageContainer>
    );
  }

  const enCamino = datos?.enCamino ?? [];
  const nombreChofer = (id: string | null) => datos?.repartidores.find((c) => c.id === id)?.nombre ?? "Chofer sin nombre";
  const minutos = (p: TarjetaPedido) => minutosVivos(p, consultadoEnMs, ahoraMs);
  const largos = enCamino.filter((p) => minutos(p) >= EN_CAMINO_ROJO_MIN);

  return (
    <PageContainer padding="none">
      <div className="mx-auto w-full max-w-2xl space-y-4 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-foreground">Viajes</h1>
          <span className="text-sm text-muted-foreground">{etiquetaActualizado(ultimaOk, ahoraMs)}</span>
        </div>
        {sinConexion && (
          <div role="status" className="flex items-center gap-2 rounded-lg border-2 border-warning bg-warning-tint p-3 text-base text-warning">
            <WifiOff className="size-5 shrink-0" aria-hidden="true" />
            Sin conexión — reintentando. Lo que ves puede estar desactualizado.
          </div>
        )}
        {error && datos !== null && !sinConexion && <EstadoError compacto mensaje={error.message} onReintentar={() => void cargar().catch(() => undefined)} />}

        <section aria-label="Por salir" className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Por salir ({porSalir.length})</h2>
          {porSalir.length === 0 ? (
            <EstadoVacio icon={Hourglass} titulo="Nada por salir" mensaje="No hay pedidos a domicilio esperando chofer." />
          ) : (
            <ul className="space-y-2" aria-label="Pedidos por salir">
              {porSalir.map((p) => {
                const marcado = seleccion.includes(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={marcado}
                      data-testid={`viaje-pedido-${p.numero}`}
                      className={`flex min-h-14 w-full items-center gap-3 rounded-lg border-2 bg-card p-3 text-left ${marcado ? "border-primary" : "border-border"}`}
                      onClick={() => {
                        const nueva = alternarSeleccion(seleccion, p.id);
                        setTopeAvisado(nueva === seleccion && !marcado);
                        setSeleccion(nueva);
                      }}
                    >
                      {marcado ? <SquareCheckBig className="size-7 shrink-0" aria-hidden="true" /> : <Square className="size-7 shrink-0" aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-lg font-bold text-foreground">
                          #{p.numero} · {p.clienteNombre}
                        </span>
                        <span className="block truncate text-base text-muted-foreground">{p.resumenItems}</span>
                        <span className="mt-1 flex flex-wrap gap-2">
                          <StatusBadge tone="neutral" dot={false} className="text-sm">
                            {p.listoAt ? "Listo" : "En preparación"}
                          </StatusBadge>
                          {p.sinAviso && (
                            <StatusBadge tone="warning" dot={false} className="text-sm">
                              <MessageSquareOff className="size-4" aria-hidden="true" />
                              Sin aviso al cliente
                            </StatusBadge>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-lg font-bold text-foreground">{formatMoney(p.total)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {topeAvisado && <p role="status" className="text-sm text-muted-foreground">Un viaje lleva máximo {MAX_LOTE} pedidos. Quita uno para agregar otro.</p>}

          {porSalir.length > 0 && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-3">
              <FormField label="Chofer" required>
                <Selector value={choferId} onChange={(e) => setChoferId(e.target.value)} className="h-12 text-base">
                  <option value="">Elige un chofer</option>
                  {(datos?.repartidores ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {etiquetaChofer(c)}
                    </option>
                  ))}
                </Selector>
              </FormField>
              <FormField label="Tiempo estimado de entrega (min)" error={etaValida ? undefined : "Escribe entre 5 y 240 minutos."}>
                <Input type="number" inputMode="numeric" min={5} max={240} className="h-12 text-lg" value={eta} onChange={(e) => setEta(e.target.value)} />
              </FormField>
              <Button type="button" className="h-14 w-full text-lg" disabled={!puedeSalir} loading={enviando} onClick={() => setConfirmando(true)}>
                {textoBotonSalio(elegidos.length)}
              </Button>
              {!puedeSalir && !enviando && (
                <p className="text-sm text-muted-foreground">{elegidos.length === 0 ? "Marca los pedidos que salen en este viaje." : chofer === null ? "Elige el chofer." : "Revisa el tiempo estimado."}</p>
              )}
            </div>
          )}
        </section>

        <section aria-label="En camino" className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">En camino ({enCamino.length})</h2>
          {largos.length > 0 && (
            <div role="alert" className="flex items-center gap-2 rounded-lg border-2 border-destructive bg-destructive-tint p-3 text-base text-destructive">
              <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
              {largos.length === 1 ? `El pedido #${largos[0]!.numero} lleva` : `${largos.length} pedidos llevan`} más de {EN_CAMINO_ROJO_MIN} minutos en camino. Llama al chofer.
            </div>
          )}
          {enCamino.length === 0 ? (
            <EstadoVacio icon={Hourglass} titulo="Nadie en camino" mensaje="No hay pedidos en reparto ahora." />
          ) : (
            <ul className="space-y-2" aria-label="Pedidos en camino">
              {enCamino.map((p) => {
                const m = minutos(p);
                return (
                  <li key={p.id} data-testid={`en-camino-${p.numero}`} data-semaforo={semaforoPedido("en_camino", p.canal, m)} className="space-y-1 rounded-lg border border-border bg-card p-3">
                    <p className="text-lg font-bold text-foreground">
                      #{p.numero} · {p.clienteNombre}
                    </p>
                    <p className="text-base text-muted-foreground">
                      Chofer: {nombreChofer(p.repartidorId)} · {formatMoney(p.total)}
                    </p>
                    <SemaforoMinutos semaforo={semaforoPedido("en_camino", p.canal, m)} minutos={m} prefijo="En camino" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {(datos?.recientes.length ?? 0) > 0 && (
          <section aria-label="Entregados recientes" className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Entregados recientes</h2>
            <ul className="space-y-1" aria-label="Pedidos entregados recientemente">
              {datos!.recientes.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 text-base text-muted-foreground">
                  <span>
                    #{p.numero} · {p.clienteNombre}
                  </span>
                  <span>{formatMoney(p.total)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        titulo={`¿Salieron ${elegidos.length === 1 ? "el pedido" : "los pedidos"} con ${chofer?.nombre ?? "el chofer"}?`}
        descripcion={`${elegidos.map((p) => `#${p.numero}`).join(", ")} · entrega estimada en ${etaNum} min. Se avisa al cliente que su pedido va en camino.`}
        confirmar="Sí, salió"
        cancelar="Volver"
        onConfirm={async () => {
          setConfirmando(false);
          await despachar(false);
        }}
      />
      <ConfirmDialog
        open={fueraDeTurno !== null}
        onOpenChange={(abierto) => !abierto && setFueraDeTurno(null)}
        titulo="Chofer fuera de turno"
        descripcion={`${fueraDeTurno ?? "El chofer"} está marcado fuera de turno. ¿Despachar de todos modos?`}
        confirmar="Sí, despachar"
        cancelar="Elegir otro chofer"
        onConfirm={async () => {
          setFueraDeTurno(null);
          await despachar(true);
        }}
      />
    </PageContainer>
  );
}
