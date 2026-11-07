// «Atención de pedidos» (F4b; migraciones 170 a 172): lo que la sucursal hacia a mano. Tres listas del turno (por aceptar, en preparación, en camino) y UNA accion por
// tarjeta: Aceptar con tiempo prometido editable (el cliente recibe el aviso), Rechazar con motivo de lista cerrada, Salida con repartidor y Entregado con la hora
// real. Arriba, los ratios de operacion (tiempo real vs prometido, aceptacion, encuesta) y, para dueno/admin, el encendido de la encuesta y de los recordatorios.
// Sin datos de ejemplo: todo sale de `GET admin/orders` y `admin/ciclo/*`; sin la actualizacion de base de datos lo dice con claridad.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, PageContainer, Selector, StatusBadge, Switch, Tabs, TabsList, TabsTrigger, formatMoney, notify } from "@atiende/ui";
import { ClipboardCheck } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";
import {
  ETIQUETA_MOTIVO_RECHAZO,
  MOTIVOS_RECHAZO,
  TIEMPO_PROMETIDO_MAX,
  TIEMPO_PROMETIDO_MIN,
  TIEMPO_PROMETIDO_POR_OMISION,
  aceptarConTiempo,
  fetchConfigEncuesta,
  fetchConfigRecordatorios,
  fetchRatios,
  guardarConfigEncuesta,
  guardarConfigRecordatorios,
  rechazarConMotivo,
  registrarEntregaReal,
  registrarSalidaConChofer,
} from "../lib/ciclo-client.ts";
import type { ConfigEncuesta, ConfigRecordatorios, MotivoRechazo, RespuestaRatios } from "../lib/ciclo-client.ts";
import { ErrorOperacion, nuevaLlave } from "../lib/operacion-client.ts";
import { fetchOrders } from "../lib/orders-client.ts";
import type { OrderSummary } from "../lib/orders-client.ts";
import { fetchRepartidores } from "../lib/staff-client.ts";
import type { RepartidorMember } from "../lib/staff-client.ts";

type Pestana = "pending" | "preparando" | "en_camino";
const ETIQUETA_PESTANA: Readonly<Record<Pestana, string>> = { pending: "Por aceptar", preparando: "En preparación", en_camino: "En camino" };
const OPCIONES_RECHAZO = MOTIVOS_RECHAZO.map((m) => ({ valor: m, etiqueta: ETIQUETA_MOTIVO_RECHAZO[m] }));
const MENSAJE_NO_DISPONIBLE = "Esta función requiere actualizar la base de datos (migraciones 170 a 172). Mientras tanto usa la pestaña de Pedidos.";

const pct = (n: number | null): string => (n === null ? "—" : `${n}%`);
const min = (n: number | null): string => (n === null ? "—" : `${n} min`);

function mensajeDeError(e: unknown): string {
  if (e instanceof ErrorOperacion) return e.status === 503 ? MENSAJE_NO_DISPONIBLE : e.message;
  return e instanceof Error ? e.message : "No se pudo completar la acción.";
}

export function OperacionCicloPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);
  const esDuenoOAdmin = role === "owner" || role === "admin";
  const [pestana, setPestana] = useState<Pestana>("pending");
  const [pedidos, setPedidos] = useState<readonly OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratios, setRatios] = useState<RespuestaRatios | null>(null);
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aceptando, setAceptando] = useState<OrderSummary | null>(null);
  const [rechazando, setRechazando] = useState<OrderSummary | null>(null);
  const [saliendo, setSaliendo] = useState<OrderSummary | null>(null);
  const [entregando, setEntregando] = useState<OrderSummary | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [encuesta, setEncuesta] = useState<ConfigEncuesta | null>(null);
  const [recordatorios, setRecordatorios] = useState<ConfigRecordatorios | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetchOrders(fetchImpl, apiBaseUrl, token, propertyId, { status: pestana, limit: 50 });
      setPedidos(r.orders);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar los pedidos.");
    }
  }, [apiBaseUrl, fetchImpl, pestana, propertyId, token]);

  useEffect(() => {
    setPedidos(null);
    void cargar();
  }, [cargar]);

  useEffect(() => {
    void fetchRatios(fetchImpl, apiBaseUrl, token, propertyId).then(setRatios).catch(() => setRatios(null));
    void fetchRepartidores(fetchImpl, apiBaseUrl, token, propertyId).then(setRepartidores).catch(() => setRepartidores([]));
    if (esDuenoOAdmin) {
      void fetchConfigEncuesta(fetchImpl, apiBaseUrl, token, propertyId).then(setEncuesta).catch(() => setEncuesta(null));
      void fetchConfigRecordatorios(fetchImpl, apiBaseUrl, token, propertyId).then(setRecordatorios).catch(() => setRecordatorios(null));
    }
  }, [apiBaseUrl, esDuenoOAdmin, fetchImpl, propertyId, token]);

  async function ejecutar(orderId: string, accion: () => Promise<void>, exito: string): Promise<boolean> {
    if (ocupado !== null) return false;
    setOcupado(orderId);
    setErrorDialogo(null);
    try {
      await accion();
      notify.success(exito);
      await cargar();
      void fetchRatios(fetchImpl, apiBaseUrl, token, propertyId).then(setRatios).catch(() => undefined);
      return true;
    } catch (e) {
      if (e instanceof ErrorOperacion && e.status === 409) {
        notify.info("El pedido ya cambió de estado. Se actualizó la lista.");
        await cargar();
        return true;
      }
      setErrorDialogo(mensajeDeError(e));
      return false;
    } finally {
      setOcupado(null);
    }
  }

  const noDisponible = error !== null && error.includes("503");
  const lista = pedidos ?? [];

  return (
    <PageContainer padding="none">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-3 pb-6">
        <h1 className="sr-only">Atención de pedidos</h1>

        {ratios?.disponible && ratios.ratios ? (
          <Card data-testid="ratios-operacion">
            <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
              <Dato titulo="Aceptados" valor={pct(ratios.ratios.tasaAceptacionPct)} />
              <Dato titulo="Cumple su promesa" valor={pct(ratios.ratios.cumplimientoPromesaPct)} />
              <Dato titulo="Desvío vs prometido" valor={ratios.ratios.desvioMinProm === null ? "—" : `${ratios.ratios.desvioMinProm > 0 ? "+" : ""}${ratios.ratios.desvioMinProm} min`} />
              <Dato titulo="Encuesta (promedio)" valor={ratios.ratios.encuesta.promedio === null ? "—" : `${ratios.ratios.encuesta.promedio} / 5`} />
              <Dato titulo="Tarda en aceptar" valor={ratios.ratios.aceptacionSegProm === null ? "—" : `${ratios.ratios.aceptacionSegProm} s`} />
              <Dato titulo="Aceptado a salida" valor={min(ratios.ratios.salidaMinProm)} />
              <Dato titulo="Responden la encuesta" valor={pct(ratios.ratios.encuesta.tasaRespuestaPct)} />
              <Dato titulo="Encuestas bajas" valor={pct(ratios.ratios.encuesta.pctBajas)} />
            </CardContent>
          </Card>
        ) : null}

        <Tabs value={pestana} onValueChange={(v) => setPestana(v as Pestana)}>
          <TabsList className="grid h-auto w-full grid-cols-3 gap-1">
            {(Object.keys(ETIQUETA_PESTANA) as Pestana[]).map((p) => (
              <TabsTrigger key={p} value={p} className="h-12 text-base" data-testid={`pestana-${p}`}>
                {ETIQUETA_PESTANA[p]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {pedidos === null && error === null ? (
          <EstadoCargando />
        ) : error !== null && pedidos === null ? (
          noDisponible ? <EstadoVacio icon={ClipboardCheck} titulo="Atención de pedidos" mensaje={MENSAJE_NO_DISPONIBLE} /> : <EstadoError mensaje={error} onReintentar={() => void cargar()} />
        ) : lista.length === 0 ? (
          <EstadoVacio icon={ClipboardCheck} titulo="Nada en esta lista" mensaje="No hay pedidos en este estado por ahora." />
        ) : (
          <ul className="space-y-3" aria-label={ETIQUETA_PESTANA[pestana]}>
            {lista.map((p) => (
              <li key={p.id}>
                <Card data-testid={`tarjeta-ciclo-${p.id}`}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-lg font-bold text-foreground">Pedido {p.orderNumber != null ? `#${p.orderNumber}` : ""}</h3>
                        <p className="truncate text-sm text-muted-foreground">
                          {p.customerName} · {p.canal === "recoger" ? "Para recoger" : "A domicilio"}
                        </p>
                      </div>
                      <StatusBadge tone="neutral" dot={false} className="text-base">
                        {formatMoney(p.total)}
                      </StatusBadge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {pestana === "pending" ? (
                        <>
                          <Button type="button" className="h-12 flex-1" disabled={ocupado !== null} onClick={() => { setErrorDialogo(null); setAceptando(p); }}>
                            Aceptar
                          </Button>
                          <Button type="button" variant="outline" className="h-12 flex-1" disabled={ocupado !== null} onClick={() => { setErrorDialogo(null); setRechazando(p); }}>
                            Rechazar
                          </Button>
                        </>
                      ) : null}
                      {pestana === "preparando" && p.canal !== "recoger" ? (
                        <Button type="button" className="h-12 flex-1" disabled={ocupado !== null} onClick={() => { setErrorDialogo(null); setSaliendo(p); }}>
                          Salió con repartidor
                        </Button>
                      ) : null}
                      {pestana === "en_camino" ? (
                        <Button type="button" className="h-12 flex-1" disabled={ocupado !== null} onClick={() => { setErrorDialogo(null); setEntregando(p); }}>
                          Marcar entregado
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {esDuenoOAdmin && (encuesta?.disponible || recordatorios?.disponible) ? (
          <Card data-testid="config-ciclo">
            <CardContent className="space-y-4 p-4">
              <h2 className="text-lg font-bold text-foreground">Automatizaciones de la sucursal</h2>
              {encuesta?.disponible ? (
                <div className="flex items-start gap-3">
                  <Switch
                    id="encuesta-habilitada"
                    checked={encuesta.habilitada}
                    aria-label="Encuesta de satisfacción después de entregar"
                    onCheckedChange={(v) => {
                      void guardarConfigEncuesta(fetchImpl, apiBaseUrl, token, propertyId, v)
                        .then(() => {
                          setEncuesta({ ...encuesta, habilitada: v });
                          notify.success(v ? "Encuesta encendida." : "Encuesta apagada.");
                        })
                        .catch((e) => notify.error(mensajeDeError(e)));
                    }}
                  />
                  <label htmlFor="encuesta-habilitada" className="text-sm text-foreground">
                    Encuesta de 1 a 5 por WhatsApp, 2 horas después de entregar (una sola vez por pedido; solo si el cliente escribió en las últimas 24 h o hay plantilla aprobada). El cliente puede responder BAJA.
                  </label>
                </div>
              ) : null}
              {recordatorios?.disponible ? (
                <div className="flex items-start gap-3">
                  <Switch
                    id="recordatorios-habilitados"
                    checked={recordatorios.habilitado}
                    aria-label="Recordatorios de pedidos sin aceptar"
                    onCheckedChange={(v) => {
                      const { disponible: _d, ...config } = recordatorios;
                      void guardarConfigRecordatorios(fetchImpl, apiBaseUrl, token, propertyId, { ...config, habilitado: v })
                        .then(() => {
                          setRecordatorios({ ...recordatorios, habilitado: v });
                          notify.success(v ? "Recordatorios encendidos." : "Recordatorios apagados.");
                        })
                        .catch((e) => notify.error(mensajeDeError(e)));
                    }}
                  />
                  <label htmlFor="recordatorios-habilitados" className="text-sm text-foreground">
                    Recordar al gerente cada {recordatorios.repetirMin} min un pedido sin aceptar (el primero a los {recordatorios.primeroMin} min, hasta {recordatorios.maximo} veces).
                  </label>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <DialogoTiempo
        pedido={aceptando}
        error={errorDialogo}
        enCurso={ocupado !== null}
        onCerrar={() => setAceptando(null)}
        onConfirmar={(minutos) => {
          if (!aceptando) return;
          void ejecutar(aceptando.id, async () => void (await aceptarConTiempo(fetchImpl, apiBaseUrl, token, propertyId, aceptando.id, minutos, nuevaLlave())), "Pedido aceptado. Se avisó al cliente con el tiempo prometido.").then((ok) => ok && setAceptando(null));
        }}
      />
      <MotivoDialogo<MotivoRechazo>
        open={rechazando !== null}
        onOpenChange={(o) => !o && setRechazando(null)}
        titulo={rechazando ? `Rechazar el pedido${rechazando.orderNumber != null ? ` #${rechazando.orderNumber}` : ""}` : "Rechazar el pedido"}
        subtitulo="El cliente recibe un aviso con una disculpa y el motivo. La nota es interna y no se le envía."
        textoConfirmar="Rechazar pedido"
        tonoPeligro
        opciones={OPCIONES_RECHAZO}
        notaMax={240}
        error={errorDialogo}
        enCurso={ocupado !== null}
        onConfirmar={(motivo, nota) => {
          if (!rechazando) return;
          void ejecutar(rechazando.id, async () => void (await rechazarConMotivo(fetchImpl, apiBaseUrl, token, propertyId, rechazando.id, motivo, nota, nuevaLlave())), "Pedido rechazado. Se avisó al cliente.").then((ok) => ok && setRechazando(null));
        }}
      />
      <DialogoSalida
        pedido={saliendo}
        repartidores={repartidores}
        error={errorDialogo}
        enCurso={ocupado !== null}
        onCerrar={() => setSaliendo(null)}
        onConfirmar={(repartidorId, eta) => {
          if (!saliendo) return;
          void ejecutar(saliendo.id, async () => void (await registrarSalidaConChofer(fetchImpl, apiBaseUrl, token, propertyId, saliendo.id, repartidorId, eta, nuevaLlave())), "Salida registrada. Se avisó al cliente que va en camino.").then((ok) => ok && setSaliendo(null));
        }}
      />
      <DialogoEntrega
        pedido={entregando}
        error={errorDialogo}
        enCurso={ocupado !== null}
        onCerrar={() => setEntregando(null)}
        onConfirmar={(haceMin) => {
          if (!entregando) return;
          const cuando = haceMin > 0 ? new Date(Date.now() - haceMin * 60_000).toISOString() : null;
          void ejecutar(entregando.id, async () => void (await registrarEntregaReal(fetchImpl, apiBaseUrl, token, propertyId, entregando.id, cuando, nuevaLlave())), "Entrega registrada con su hora real.").then((ok) => ok && setEntregando(null));
        }}
      />
    </PageContainer>
  );
}

function Dato({ titulo, valor }: { readonly titulo: string; readonly valor: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{titulo}</p>
      <p className="text-lg font-bold text-foreground">{valor}</p>
    </div>
  );
}

function DialogoTiempo({ pedido, error, enCurso, onCerrar, onConfirmar }: { readonly pedido: OrderSummary | null; readonly error: string | null; readonly enCurso: boolean; readonly onCerrar: () => void; readonly onConfirmar: (minutos: number) => void }) {
  const omision = pedido?.canal === "recoger" ? TIEMPO_PROMETIDO_POR_OMISION.recoger : TIEMPO_PROMETIDO_POR_OMISION.domicilio;
  const [texto, setTexto] = useState(String(omision));
  useEffect(() => {
    if (pedido) setTexto(String(omision));
  }, [pedido, omision]);
  const minutos = Number(texto);
  const valido = Number.isInteger(minutos) && minutos >= TIEMPO_PROMETIDO_MIN && minutos <= TIEMPO_PROMETIDO_MAX;
  return (
    <FormDialog
      open={pedido !== null}
      onOpenChange={(o) => !o && onCerrar()}
      titulo={pedido ? `Aceptar el pedido${pedido.orderNumber != null ? ` #${pedido.orderNumber}` : ""}` : "Aceptar el pedido"}
      subtitulo="El cliente recibe un aviso con este tiempo prometido."
      anchoClase="max-w-2xl"
      bloquearCierre={enCurso}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCerrar} disabled={enCurso}>
            Volver
          </Button>
          <Button type="button" loading={enCurso} disabled={enCurso || !valido} onClick={() => onConfirmar(minutos)}>
            Aceptar pedido
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <FormField label="Tiempo prometido (minutos)" required hint={`Entre ${TIEMPO_PROMETIDO_MIN} y ${TIEMPO_PROMETIDO_MAX}. Cuenta desde que aceptas.`}>
          <Input type="number" inputMode="numeric" min={TIEMPO_PROMETIDO_MIN} max={TIEMPO_PROMETIDO_MAX} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </FormField>
      </div>
    </FormDialog>
  );
}

function DialogoSalida({ pedido, repartidores, error, enCurso, onCerrar, onConfirmar }: { readonly pedido: OrderSummary | null; readonly repartidores: readonly RepartidorMember[]; readonly error: string | null; readonly enCurso: boolean; readonly onCerrar: () => void; readonly onConfirmar: (repartidorId: string, etaMin: number) => void }) {
  const [repartidorId, setRepartidorId] = useState("");
  const [eta, setEta] = useState("30");
  useEffect(() => {
    if (pedido) {
      setRepartidorId(pedido.assignedRepartidorId ?? "");
      setEta("30");
    }
  }, [pedido]);
  const etaMin = Number(eta);
  const valido = repartidorId !== "" && Number.isInteger(etaMin) && etaMin >= 5 && etaMin <= 240;
  return (
    <FormDialog
      open={pedido !== null}
      onOpenChange={(o) => !o && onCerrar()}
      titulo={pedido ? `Salida del pedido${pedido.orderNumber != null ? ` #${pedido.orderNumber}` : ""}` : "Salida del pedido"}
      subtitulo="Asigna al repartidor y registra la hora real de salida. El cliente recibe el aviso de que va en camino."
      anchoClase="max-w-2xl"
      bloquearCierre={enCurso}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCerrar} disabled={enCurso}>
            Volver
          </Button>
          <Button type="button" loading={enCurso} disabled={enCurso || !valido} onClick={() => onConfirmar(repartidorId, etaMin)}>
            Registrar salida
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <FormField label="Repartidor" required>
          <Selector value={repartidorId} placeholder="Elige un repartidor…" onValueChange={(v) => setRepartidorId(v)}>
            {repartidores.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </Selector>
        </FormField>
        <FormField label="Entrega estimada (minutos)" required hint="Entre 5 y 240.">
          <Input type="number" inputMode="numeric" min={5} max={240} value={eta} onChange={(e) => setEta(e.target.value)} />
        </FormField>
      </div>
    </FormDialog>
  );
}

function DialogoEntrega({ pedido, error, enCurso, onCerrar, onConfirmar }: { readonly pedido: OrderSummary | null; readonly error: string | null; readonly enCurso: boolean; readonly onCerrar: () => void; readonly onConfirmar: (haceMin: number) => void }) {
  const [hace, setHace] = useState("0");
  useEffect(() => {
    if (pedido) setHace("0");
  }, [pedido]);
  const haceMin = Number(hace);
  const valido = Number.isInteger(haceMin) && haceMin >= 0 && haceMin <= 720;
  return (
    <FormDialog
      open={pedido !== null}
      onOpenChange={(o) => !o && onCerrar()}
      titulo={pedido ? `Entrega del pedido${pedido.orderNumber != null ? ` #${pedido.orderNumber}` : ""}` : "Entrega del pedido"}
      subtitulo="Se guarda la hora real de entrega para medir el tiempo real contra el prometido."
      anchoClase="max-w-2xl"
      bloquearCierre={enCurso}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCerrar} disabled={enCurso}>
            Volver
          </Button>
          <Button type="button" loading={enCurso} disabled={enCurso || !valido} onClick={() => onConfirmar(haceMin)}>
            Marcar entregado
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <FormField label="¿Hace cuántos minutos se entregó?" hint="0 = ahora. Máximo 720 (12 horas).">
          <Input type="number" inputMode="numeric" min={0} max={720} value={hace} onChange={(e) => setHace(e.target.value)} />
        </FormField>
      </div>
    </FormDialog>
  );
}
