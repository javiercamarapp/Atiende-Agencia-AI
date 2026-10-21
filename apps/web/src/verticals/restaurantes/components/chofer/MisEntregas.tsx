// «Mis entregas» del chofer (PLAN-PANEL-OPERADOR §2.3 y §5.4 E): SOLO sus pedidos en camino (max 30), tarjeta grande, sondeo cada 15 s, «Entregado»
// con confirmacion y «Deshacer» 60 s, «No pude entregar» con motivo cerrado, «Llamar» auditado (el telefono nunca se pinta) y retiro de lo
// entregado a los 2 min. Sin senal, «Entregado» se guarda en el celular y se reenvia con la MISMA llave de idempotencia al volver la red.
// Si el servidor aun no tiene la ruta (501, backend A1 sin desplegar) avisa con `onNoDisponible` y el panel cae a la vista anterior.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EstadoCargando, EstadoError, EstadoVacio, notify } from "@atiende/ui";
import type { EntregaChofer, ProblemaEntrada } from "@atiende/domain-restaurantes/operacion";
import { PackageOpen, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@atiende/ui";
import { SessionExpiredError, RepartidorClientError, deshacerEntregaChofer, entregarPedidoChofer, esErrorDeRed, esFuncionNoDisponible, fetchEntregasChofer, nuevaLlaveIdempotencia, pedirTelefonoCliente, reportarProblemaChofer } from "../../lib/repartidor-client.ts";
import { almacenDelNavegador, encolarEntrega, leerPendientes, quitarPendiente } from "../../lib/cola-entrega-offline.ts";
import type { AlmacenLocal } from "../../lib/cola-entrega-offline.ts";
import { enlaceTelefono, registrarCerrados, visiblesEnPantalla } from "../../lib/chofer-entregas.ts";
import { etiquetaActualizado } from "../../lib/sondeo-pedidos.ts";
import { useSondeoPedidos } from "../../lib/use-sondeo-pedidos.ts";
import { ConfirmarEntrega } from "./ConfirmarEntrega.tsx";
import { ReportarProblema } from "./ReportarProblema.tsx";
import { TarjetaEntrega } from "./TarjetaEntrega.tsx";
import type { AccionEnCurso } from "./TarjetaEntrega.tsx";

export const SONDEO_CHOFER_MS = 15_000;

export interface MisEntregasProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl?: typeof fetch;
  /** Almacen de la cola sin senal; `undefined` = el del navegador, `null` = sin almacenamiento. */
  readonly almacen?: AlmacenLocal | null;
  /** Abre el marcador del telefono; por omision navega al enlace `tel:`. */
  readonly abrirTelefono?: (enlace: string) => void;
  /** El servidor aun no tiene las rutas del panel: el contenedor muestra la vista anterior. */
  readonly onNoDisponible?: () => void;
}

type Carga = { fase: "cargando" } | { fase: "error"; mensaje: string } | { fase: "listo" };

function mensajeDe(err: unknown, porOmision: string): string {
  return err instanceof Error && err.message ? err.message : porOmision;
}

export function MisEntregas({ apiBaseUrl, token, propertyId, fetchImpl, almacen: almacenProp, onNoDisponible, abrirTelefono = (enlace) => void (window.location.href = enlace) }: MisEntregasProps) {
  const http = useMemo<typeof fetch>(() => fetchImpl ?? ((...args) => fetch(...args)), [fetchImpl]);
  const almacen = almacenProp === undefined ? almacenDelNavegador() : almacenProp;
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [servidor, setServidor] = useState<readonly EntregaChofer[]>([]);
  /** Lo que el chofer acaba de cerrar aqui (entregado/problema): se conserva 2 min aunque el servidor ya no lo mande como activo. */
  const [recientes, setRecientes] = useState<ReadonlyMap<string, EntregaChofer>>(new Map());
  const [enCurso, setEnCurso] = useState<ReadonlyMap<string, AccionEnCurso>>(new Map());
  const [pendientes, setPendientes] = useState<readonly string[]>([]);
  const [ahora, setAhora] = useState(() => Date.now());
  const [paraEntregar, setParaEntregar] = useState<EntregaChofer | null>(null);
  const [paraProblema, setParaProblema] = useState<EntregaChofer | null>(null);
  const cerradosRef = useRef<Map<string, number>>(new Map());
  const noDisponibleAvisado = useRef(false);
  const refrescarRef = useRef<() => void>(() => undefined);

  const marcarEnCurso = useCallback((id: string, accion: AccionEnCurso | null) => {
    setEnCurso((previo) => {
      const siguiente = new Map(previo);
      if (accion) siguiente.set(id, accion);
      else siguiente.delete(id);
      return siguiente;
    });
  }, []);

  const recordarCerrada = useCallback((e: EntregaChofer) => {
    cerradosRef.current.set(e.id, Date.now());
    setRecientes((previo) => new Map(previo).set(e.id, e));
  }, []);

  const olvidarCerrada = useCallback((id: string) => {
    cerradosRef.current.delete(id);
    setRecientes((previo) => {
      const siguiente = new Map(previo);
      siguiente.delete(id);
      return siguiente;
    });
  }, []);

  /** Reenvia las entregas guardadas por falta de senal, cada una con su llave original. Se detiene en el primer corte de red. */
  const enviarPendientes = useCallback(async () => {
    for (const p of leerPendientes(almacen, propertyId, Date.now())) {
      try {
        await entregarPedidoChofer(http, apiBaseUrl, token, propertyId, p.orderId, { cobradoMonto: p.cobradoMonto }, p.llave);
        quitarPendiente(almacen, propertyId, p.orderId, Date.now());
        notify.success("Se envió una entrega que estaba guardada en tu celular.");
      } catch (err) {
        if (esErrorDeRed(err)) break;
        quitarPendiente(almacen, propertyId, p.orderId, Date.now());
        notify.warning(mensajeDe(err, "Una entrega guardada ya no se pudo enviar. Avisa al encargado."));
      }
    }
    setPendientes(leerPendientes(almacen, propertyId, Date.now()).map((p) => p.orderId));
  }, [almacen, http, apiBaseUrl, token, propertyId]);

  const consultar = useCallback(async () => {
    try {
      await enviarPendientes();
      const r = await fetchEntregasChofer(http, apiBaseUrl, token, propertyId);
      setServidor(r.entregas);
      setCarga({ fase: "listo" });
    } catch (err) {
      if (esFuncionNoDisponible(err)) {
        if (!noDisponibleAvisado.current) {
          noDisponibleAvisado.current = true;
          onNoDisponible?.();
        }
        return;
      }
      if (err instanceof SessionExpiredError) return; // la pagina escucha el evento y redirige al login
      // Con datos ya en pantalla se conservan (banner «Sin conexion»); sin ellos, error con «Reintentar».
      setCarga((previo) => (previo.fase === "listo" ? previo : { fase: "error", mensaje: mensajeDe(err, "No se pudieron cargar tus entregas.") }));
      throw err; // cuenta como fallo para el backoff del sondeo
    }
  }, [enviarPendientes, http, apiBaseUrl, token, propertyId, onNoDisponible]);

  const sondeo = useSondeoPedidos({ clave: propertyId, activo: true, consulta: consultar, baseMs: SONDEO_CHOFER_MS });
  refrescarRef.current = sondeo.refrescar;

  useEffect(() => {
    setPendientes(leerPendientes(almacen, propertyId, Date.now()).map((p) => p.orderId));
    void consultar().catch(() => undefined); // primera carga inmediata (el sondeo arranca esperando 15 s)
    // Solo al montar o al cambiar de sucursal/sesion: `consultar` cambia de identidad en cada render y no debe relanzar la carga.
  }, [propertyId, token, apiBaseUrl]);

  useEffect(() => {
    const alVolverLaRed = () => void consultar().catch(() => undefined);
    window.addEventListener("online", alVolverLaRed);
    return () => window.removeEventListener("online", alVolverLaRed);
  }, [consultar]);

  // Mezcla: lo que el chofer cerro aqui manda sobre un sondeo atrasado; despues se retira lo cerrado hace mas de 2 min.
  const lista = useMemo(() => {
    const ids = new Set(servidor.map((e) => e.id));
    const base = servidor.map((e) => recientes.get(e.id) ?? e);
    for (const [id, e] of recientes) if (!ids.has(id)) base.push(e);
    const conPendientes = base.map((e) => (pendientes.includes(e.id) ? { ...e, estado: "entregado" as const, puedeDeshacerHasta: null } : e));
    cerradosRef.current = registrarCerrados(cerradosRef.current, conPendientes.filter((e) => !pendientes.includes(e.id)), ahora);
    const visibles = visiblesEnPantalla(conPendientes, cerradosRef.current, ahora);
    return [...visibles.filter((e) => e.estado === "en_camino"), ...visibles.filter((e) => e.estado !== "en_camino")];
  }, [servidor, recientes, pendientes, ahora]);

  const hayCerradas = lista.some((e) => e.estado !== "en_camino");
  useEffect(() => {
    const id = window.setInterval(() => setAhora(Date.now()), hayCerradas ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [hayCerradas]);

  async function confirmarEntrega(e: EntregaChofer, cobradoMonto: number | null) {
    const llave = nuevaLlaveIdempotencia();
    marcarEnCurso(e.id, "entregar");
    try {
      const r = await entregarPedidoChofer(http, apiBaseUrl, token, propertyId, e.id, { cobradoMonto }, llave);
      recordarCerrada({ ...e, estado: "entregado", puedeDeshacerHasta: r.puedeDeshacerHasta });
      notify.success(`Pedido #${e.numero} entregado.`);
    } catch (err) {
      if (esErrorDeRed(err)) {
        encolarEntrega(almacen, propertyId, { orderId: e.id, llave, cobradoMonto, en: Date.now() });
        setPendientes(leerPendientes(almacen, propertyId, Date.now()).map((p) => p.orderId));
        notify.warning("Sin conexión: la entrega quedó guardada en tu celular y se enviará sola cuando vuelva la señal.");
      } else {
        notify.error(mensajeDe(err, "No se pudo marcar la entrega."));
        refrescarRef.current();
      }
    } finally {
      marcarEnCurso(e.id, null);
      setParaEntregar(null);
    }
  }

  async function confirmarProblema(e: EntregaChofer, entrada: ProblemaEntrada) {
    marcarEnCurso(e.id, "problema");
    try {
      await reportarProblemaChofer(http, apiBaseUrl, token, propertyId, e.id, entrada, nuevaLlaveIdempotencia());
      recordarCerrada({ ...e, estado: "problema" });
      notify.success(`Se avisó al encargado del pedido #${e.numero}.`);
      setParaProblema(null);
    } catch (err) {
      notify.error(esErrorDeRed(err) ? "Sin conexión: no se pudo avisar al encargado. Intenta de nuevo cuando vuelva la señal." : mensajeDe(err, "No se pudo reportar el problema."));
    } finally {
      marcarEnCurso(e.id, null);
    }
  }

  async function deshacer(e: EntregaChofer) {
    marcarEnCurso(e.id, "deshacer");
    try {
      await deshacerEntregaChofer(http, apiBaseUrl, token, propertyId, e.id, nuevaLlaveIdempotencia());
      olvidarCerrada(e.id);
      setServidor((previo) => (previo.some((x) => x.id === e.id) ? previo.map((x) => (x.id === e.id ? { ...e, estado: "en_camino", puedeDeshacerHasta: null } : x)) : [...previo, { ...e, estado: "en_camino", puedeDeshacerHasta: null }]));
      notify.success(`La entrega del pedido #${e.numero} se deshizo.`);
      refrescarRef.current();
    } catch (err) {
      if (err instanceof RepartidorClientError && err.code === "fuera_de_ventana") {
        olvidarCerrada(e.id);
        notify.warning("Ya pasó el tiempo para deshacer. Avisa al encargado.");
      } else {
        notify.error(esErrorDeRed(err) ? "Sin conexión: no se pudo deshacer. Intenta de nuevo." : mensajeDe(err, "No se pudo deshacer la entrega."));
      }
    } finally {
      marcarEnCurso(e.id, null);
    }
  }

  async function llamar(e: EntregaChofer) {
    marcarEnCurso(e.id, "llamar");
    try {
      const { telefono } = await pedirTelefonoCliente(http, apiBaseUrl, token, propertyId, e.id, nuevaLlaveIdempotencia());
      const enlace = enlaceTelefono(telefono);
      if (enlace) abrirTelefono(enlace);
      else notify.error("El número del cliente no es válido. Avisa al encargado.");
    } catch (err) {
      notify.error(esErrorDeRed(err) ? "Sin conexión: no se pudo obtener el número." : mensajeDe(err, "No se pudo obtener el número del cliente."));
    } finally {
      marcarEnCurso(e.id, null);
    }
  }

  const activas = lista.filter((e) => e.estado === "en_camino").length;
  const sinConexion = carga.fase === "listo" && sondeo.fallosSeguidos > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-sm text-muted-foreground" aria-live="polite">
          {activas === 1 ? "1 entrega en camino" : `${activas} entregas en camino`} · {etiquetaActualizado(sondeo.ultimaActualizacion, ahora)}
        </p>
        <Button type="button" variant="outline" size="sm" className="h-11" loading={sondeo.consultando} onClick={() => sondeo.refrescar()} aria-label="Actualizar mis entregas">
          <RefreshCw />
          Actualizar
        </Button>
      </div>

      {sinConexion && (
        <p role="status" className="m-0 flex items-center gap-2 rounded-lg bg-warning-tint px-3 py-2 text-sm text-warning">
          <WifiOff className="size-4 shrink-0" aria-hidden="true" />
          Sin conexión — reintentando. Lo que ves puede no estar al día.
        </p>
      )}
      {pendientes.length > 0 && (
        <p role="status" className="m-0 rounded-lg bg-warning-tint px-3 py-2 text-sm text-warning">
          {pendientes.length === 1 ? "Una entrega está guardada en tu celular" : `${pendientes.length} entregas están guardadas en tu celular`} y se enviará sola al volver la señal.
        </p>
      )}

      {carga.fase === "cargando" && <EstadoCargando etiqueta="Cargando tus entregas…" />}
      {carga.fase === "error" && <EstadoError mensaje={carga.mensaje} onReintentar={() => sondeo.refrescar()} />}
      {carga.fase === "listo" && lista.length === 0 && (
        <EstadoVacio icon={PackageOpen} titulo="Sin entregas en camino" mensaje="Cuando el encargado marque «Salió» con tu nombre, tus pedidos aparecen aquí." />
      )}

      {lista.map((e) => (
        <TarjetaEntrega
          key={e.id}
          entrega={e}
          ahoraMs={ahora}
          enCurso={enCurso.get(e.id) ?? null}
          pendienteDeEnvio={pendientes.includes(e.id)}
          onEntregar={setParaEntregar}
          onProblema={setParaProblema}
          onLlamar={(x) => void llamar(x)}
          onDeshacer={(x) => void deshacer(x)}
        />
      ))}

      <ConfirmarEntrega entrega={paraEntregar} onCerrar={() => setParaEntregar(null)} onConfirmar={confirmarEntrega} />
      <ReportarProblema entrega={paraProblema} onCerrar={() => setParaProblema(null)} onConfirmar={confirmarProblema} />
    </div>
  );
}
