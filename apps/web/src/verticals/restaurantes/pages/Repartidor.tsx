// Fase 8 — panel mínimo, real (no maqueta) del rol "repartidor": acotado a SUS
// pedidos asignados, nunca gestión (ver domain-restaurantes/src/roles.ts::
// REPARTIDOR_ROLES). Deliberadamente SIN el shell de nav de RestaurantesShell.tsx:
// ese sidebar apunta a Productos/Sucursales/Historial/Clientes, todas rutas
// MANAGER_ROLES que un repartidor real nunca puede abrir (le devolverían 403) — este
// componente resuelve su propia sesión/property, mismo patrón de useEffect que
// RestaurantesShell, pero sin ese nav.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card` por entrega, `Badge` para el estado, `Button`
// para Mapa/Llamar/avanzar/reportar — y el `window.prompt` del navegador que pedía la
// nota de incidencia pasa a un `Dialog` real del sistema de diseño (mismas tres ramas
// de siempre: cancelar = no-op, nota vacía = el mismo mensaje de error, nota con texto
// = la misma llamada a `updateAssignedOrderStatus(..., "problema", nota.trim())`).
//
// Ronda 13 — hallazgo de auditoría (severidad ALTA, "único consumidor autenticado de
// apps/web que no escucha SESSION_EXPIRED_EVENT"): al estar FUERA de
// RestaurantesShell (por lo de arriba: un repartidor nunca debe ver ese nav de
// gestión), este componente nunca heredó el listener que sí tiene RestaurantesShell
// (ver su comentario ~línea 92) para cuando `withAuthRefresh` (repartidor-client.ts,
// usado por fetchAssignedOrders/updateAssignedOrderStatus) agota su refresh y dispara
// `SESSION_EXPIRED_EVENT`. Sin ese listener, `SessionExpiredError.message` se pintaba
// como cualquier otro error de carga (`setError(err.message)` en `load()`/
// `handleAvanzar()`/`handleReportarIncidencia()` de `RepartidorPedidosView`, sin
// tocar) y el repartidor se quedaba viendo "Tu sesión expiró..." sin botón ni
// redirección — el mismo síntoma que el hallazgo original, aunque la ronda 12 ya
// había corregido el refresh en sí. El fix es el MISMO patrón que RestaurantesShell:
// escuchar el evento en `RepartidorPedidosPage` (el componente de nivel de ruta, con
// acceso a `useNavigate`), filtrar por vertical con `isSessionExpiredEventForRepartidor`
// (repartidor-client.ts) y, si aplica, `clearSession` + `navigate("/restaurantes/
// login", { replace: true })` — igual que el `useEffect` de "sin sesión" que ya tenía
// esta página unas líneas abajo.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Label,
} from "@atiende/ui";
import { AlertTriangle, MapPin, Map as MapIcon, Phone } from "lucide-react";
import { clearSession, readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { fetchBranches } from "../dashboard-client.ts";
import { fetchAssignedOrders, isSessionExpiredEventForRepartidor, REPARTIDOR_NEXT_STATUS, updateAssignedOrderStatus } from "../lib/repartidor-client.ts";
import type { RepartidorOrder, RepartidorOrderStatus } from "../lib/repartidor-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../../lib/authed-fetch.ts";

const STATUS_LABELS: Record<RepartidorOrderStatus, string> = {
  pending: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Incidencia",
};

const NEXT_STATUS_LABEL: Record<RepartidorOrderStatus, string> = {
  pending: "",
  preparando: "Marcar en camino",
  en_camino: "Marcar entregado",
  entregado: "",
  completado: "",
  cancelado: "",
  problema: "",
};

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function RepartidorPedidosView({ apiBaseUrl, token, propertyId }: { apiBaseUrl: string; token: string; propertyId: string }) {
  const [orders, setOrders] = useState<readonly RepartidorOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  // Pedido cuyo reporte de incidencia está abierto (antes: el `window.prompt` del
  // navegador) y el texto que el repartidor lleva escrito.
  const [incidenciaOrder, setIncidenciaOrder] = useState<RepartidorOrder | null>(null);
  const [incidenciaNota, setIncidenciaNota] = useState("");

  async function load() {
    setError(null);
    try {
      setOrders(await fetchAssignedOrders(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar tus pedidos.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleAvanzar(order: RepartidorOrder) {
    const next = REPARTIDOR_NEXT_STATUS[order.status];
    if (!next) return;
    setChangingId(order.id);
    setError(null);
    try {
      await updateAssignedOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el pedido.");
    } finally {
      setChangingId(null);
    }
  }

  function abrirIncidencia(order: RepartidorOrder) {
    setIncidenciaNota("");
    setIncidenciaOrder(order);
  }

  function cerrarIncidencia() {
    setIncidenciaOrder(null);
    setIncidenciaNota("");
  }

  async function handleReportarIncidencia() {
    const order = incidenciaOrder;
    if (!order) return; // equivalente a haber cancelado el prompt de antes
    const nota = incidenciaNota;
    cerrarIncidencia();
    if (!nota.trim()) {
      setError("Escribe qué pasó antes de reportar la incidencia.");
      return;
    }
    setChangingId(order.id);
    setError(null);
    try {
      await updateAssignedOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, "problema", nota.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reportar la incidencia.");
    } finally {
      setChangingId(null);
    }
  }

  const activos = orders?.filter((o) => o.status === "preparando" || o.status === "en_camino") ?? [];
  const resto = orders?.filter((o) => o.status !== "preparando" && o.status !== "en_camino") ?? [];

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Mis entregas</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {!orders && !error && <EstadoCargando etiqueta="Cargando tus entregas…" />}
      {orders && orders.length === 0 && <EstadoVacio mensaje="No tienes ningún pedido asignado por ahora." />}

      {[...activos, ...resto].map((o) => {
        const nextLabel = NEXT_STATUS_LABEL[o.status];
        return (
          <Card key={o.id}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {o.customerName} · {formatMoney(o.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {o.customerPhone} · {new Date(o.createdAt).toLocaleString("es-MX")}
                  </p>
                </div>
                <Badge variant={o.status === "problema" ? "destructive" : "secondary"} className="self-start">
                  {STATUS_LABELS[o.status]}
                </Badge>
              </div>

              {o.customerAddress && (
                <p className="mt-2 flex items-start gap-1.5 text-[13px] text-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  {o.customerAddress}
                </p>
              )}
              <p className="mt-1.5 text-[13px] text-foreground">{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>
              {o.incidentNote && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  {o.incidentNote}
                </p>
              )}

              <div className="mt-2.5 flex flex-wrap gap-2">
                {o.customerAddress && (
                  <Button asChild variant="outline" size="sm" className="h-9 text-xs">
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.customerAddress)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapIcon />
                      Mapa
                    </a>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm" className="h-9 text-xs">
                  <a href={`tel:${o.customerPhone}`}>
                    <Phone />
                    Llamar
                  </a>
                </Button>
                {nextLabel && (
                  <Button type="button" size="sm" className="h-9 text-xs" onClick={() => void handleAvanzar(o)} disabled={changingId === o.id}>
                    {changingId === o.id ? "…" : nextLabel}
                  </Button>
                )}
                {(o.status === "pending" || o.status === "preparando" || o.status === "en_camino") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 border-destructive/40 text-xs text-destructive hover:border-destructive"
                    onClick={() => abrirIncidencia(o)}
                    disabled={changingId === o.id}
                  >
                    <AlertTriangle />
                    Reportar incidencia
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={incidenciaOrder !== null} onOpenChange={(abierto) => !abierto && cerrarIncidencia()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reportar incidencia</DialogTitle>
            <DialogDescription>¿Qué pasó? (se guarda y administración lo ve de inmediato)</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repartidor-incidencia-nota" className="text-xs text-muted-foreground">
              Nota para administración
            </Label>
            <textarea
              id="repartidor-incidencia-nota"
              value={incidenciaNota}
              onChange={(e) => setIncidenciaNota(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="Ej. El cliente no abrió y no contesta el teléfono."
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cerrarIncidencia}>
              Volver
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleReportarIncidencia()}>
              Reportar incidencia
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}

export function RepartidorPedidosPage() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8787";

  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [propertyId, setPropertyId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = readPersistedSession(window.localStorage);
    setSession(s);
    if (!s) navigate("/restaurantes/login", { replace: true });
  }, [navigate]);

  // Ver comentario de cabecera de este archivo — mismo criterio exacto que el
  // `useEffect` de RestaurantesShell.tsx que escucha `SESSION_EXPIRED_EVENT`.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (!isSessionExpiredEventForRepartidor(detail)) return;
      clearSession(window.localStorage);
      setSession(null);
      navigate("/restaurantes/login", { replace: true });
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [navigate]);

  useEffect(() => {
    if (!session || !orgSlug) return;
    let cancelado = false;
    (async () => {
      try {
        const branches = await fetchBranches(fetch, apiBaseUrl, session.token, orgSlug);
        if (cancelado) return;
        if (branches.length === 0) {
          setError("Este negocio todavía no tiene ninguna sucursal configurada.");
          return;
        }
        // Igual que RestaurantesShell.tsx: usa la primera sucursal hasta que haya un
        // selector visual real. Para repartidor esto solo ancla la resolución de
        // organización/rol (ver requirePropertyMembership) -- la lista de pedidos NO
        // se filtra por esta sucursal, es SIEMPRE "lo que tengo asignado" (ver
        // repartidor-orders.ts).
        setPropertyId(branches[0]!.propertyId);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, orgSlug, apiBaseUrl]);

  if (!orgSlug) return null;
  if (session === undefined || (session && propertyId === undefined)) return null;
  if (!session) return null; // ya redirigió a login

  if (error) {
    return (
      <main className="min-h-screen bg-background p-6">
        <EstadoError mensaje={error} />
      </main>
    );
  }

  if (!propertyId) {
    return (
      <main className="min-h-screen bg-background p-6">
        <EstadoCargando etiqueta="Cargando…" />
      </main>
    );
  }

  return <RepartidorPedidosView apiBaseUrl={apiBaseUrl} token={session.token} propertyId={propertyId} />;
}
