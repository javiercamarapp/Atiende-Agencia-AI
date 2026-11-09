// Fase 8 — panel mínimo, real (no maqueta) del rol "repartidor": acotado a SUS
// pedidos asignados, nunca gestión (ver domain-restaurantes/src/roles.ts::
// REPARTIDOR_ROLES). Deliberadamente SIN el shell de nav de RestaurantesShell.tsx:
// ese sidebar apunta a Productos/Sucursales/Historial/Clientes, todas rutas
// MANAGER_ROLES que un repartidor real nunca puede abrir (le devolverían 403) — este
// componente resuelve su propia sesión/property, mismo patrón de useEffect que
// RestaurantesShell, pero sin ese nav.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card` por entrega, `StatusBadge` para el estado, `Button`
// para Mapa/Llamar/avanzar/reportar — y el `window.prompt` del navegador que pedía la
// nota de incidencia pasa a `useConfirm().pedirTexto` del sistema de diseño (UNI-C):
// cancelar o Escape = no-op, el campo es obligatorio (la nota vacía ya no se puede enviar)
// y una nota con texto = la misma llamada a `updateAssignedOrderStatus(..., "problema", nota.trim())`.
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
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  PageContainer,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatMoney,
  localeActivo,
  statusTone,
  useConfirm,
  useT,
  useTemaGlobal,
} from "@atiende/ui";
import { restaurantesChofer } from "@atiende/ui/i18n/restaurantes/chofer";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { AlertTriangle, MapPin, Map as MapIcon, Phone } from "lucide-react";
import { clearSession, readPersistedSession } from "../../../lib/auth-client.ts";
import { servidorProgresoGuia } from "../../../lib/guia-progreso.ts";
import { GuiaDiferida } from "../../../components/GuiaDiferida.tsx";
import { etiquetaRol } from "../../../lib/roles.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { fetchBranches } from "../dashboard-client.ts";
import { fetchAssignedOrders, isSessionExpiredEventForRepartidor, nuevaLlaveIdempotencia, pedirTelefonoCliente, REPARTIDOR_NEXT_STATUS, updateAssignedOrderStatus } from "../lib/repartidor-client.ts";
import { enlaceTelefono } from "../lib/chofer-entregas.ts";
import type { RepartidorOrder, RepartidorOrderStatus } from "../lib/repartidor-client.ts";
import { destinoEsPin, urlDestinoMapa } from "../lib/destino-mapa.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { HistorialDiaTab, MiPerfilTab } from "../components/RepartidorPestanas.tsx";
import { almacenDelNavegador, purgarColas } from "../lib/cola-entrega-offline.ts";
import { identidadDeSesion } from "../lib/identidad-sesion.ts";
import { PanelChofer } from "../components/chofer/PanelChofer.tsx";
import { SESSION_EXPIRED_EVENT } from "../../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../../lib/authed-fetch.ts";

/** Estado del pedido -> clave compartida de restaurantes (`restaurantes.estado.*`: Recibido, Preparando, En camino...). */
const STATUS_CLAVE = {
  pending: "restaurantes.estado.pending",
  preparando: "restaurantes.estado.preparando",
  en_camino: "restaurantes.estado.en_camino",
  entregado: "restaurantes.estado.entregado",
  completado: "restaurantes.estado.completado",
  cancelado: "restaurantes.estado.cancelado",
  problema: "restaurantes.estado.problema",
} as const satisfies Record<RepartidorOrderStatus, string>;

/** Boton para avanzar el pedido; solo los estados con siguiente paso tienen etiqueta. */
const NEXT_STATUS_CLAVE: Partial<Record<RepartidorOrderStatus, "restaurantes.chofer.legado.siguiente.preparando" | "restaurantes.chofer.legado.siguiente.en_camino">> = {
  preparando: "restaurantes.chofer.legado.siguiente.preparando",
  en_camino: "restaurantes.chofer.legado.siguiente.en_camino",
};

/** Vista de las entregas del repartidor (exportada para probarla sin sesión/router; la ruta usa `RepartidorPedidosPage`). */
export function RepartidorPedidosView({ apiBaseUrl, token, propertyId }: { apiBaseUrl: string; token: string; propertyId: string }) {
  const [orders, setOrders] = useState<readonly RepartidorOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  const t = useT(restaurantesComun, restaurantesChofer);
  // La nota de incidencia se pide con `pedirTexto` (`useConfirm`, con `AlertDialog`); el diálogo lo monta `dialogo`.
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      setOrders(await fetchAssignedOrders(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.chofer.legado.errorCarga"));
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
      setError(err instanceof Error ? err.message : t("restaurantes.chofer.legado.errorActualizar"));
    } finally {
      setChangingId(null);
    }
  }

  // «Llamar»: el listado trae el telefono enmascarado; el numero real se pide aqui (auditado, con tope por pedido) y se marca sin pintarlo.
  async function handleLlamar(order: RepartidorOrder) {
    setChangingId(order.id);
    setError(null);
    try {
      const { telefono } = await pedirTelefonoCliente(fetch, apiBaseUrl, token, propertyId, order.id, nuevaLlaveIdempotencia());
      const enlace = enlaceTelefono(telefono);
      if (enlace) window.location.href = enlace;
      else setError(t("restaurantes.chofer.numeroInvalido"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.chofer.errorNumero"));
    } finally {
      setChangingId(null);
    }
  }

  async function handleReportarIncidencia(order: RepartidorOrder) {
    const nota = await pedirTexto({
      titulo: t("restaurantes.chofer.legado.reportarIncidencia"),
      descripcion: t("restaurantes.chofer.legado.incidenciaDescripcion"),
      tono: "danger",
      confirmar: t("restaurantes.chofer.legado.reportarIncidencia"),
      cancelar: t("restaurantes.volver"),
      campo: { etiqueta: t("restaurantes.chofer.legado.notaAdmin"), placeholder: t("restaurantes.chofer.legado.notaEjemplo"), multilinea: true, maxLength: 2000 },
    });
    if (nota === null) return; // Volver, Escape o cerrar: no se llama al API
    setChangingId(order.id);
    setError(null);
    try {
      await updateAssignedOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, "problema", nota.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.chofer.legado.errorIncidencia"));
    } finally {
      setChangingId(null);
    }
  }

  const activos = orders?.filter((o) => o.status === "preparando" || o.status === "en_camino") ?? [];
  const resto = orders?.filter((o) => o.status !== "preparando" && o.status !== "en_camino") ?? [];

  return (
    <main id="contenido-principal" tabIndex={-1} className="min-h-screen bg-background focus:outline-none">
      <PageContainer padding="default" className="mx-auto max-w-2xl gap-4">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">{t("restaurantes.chofer.titulo")}</h1>

      {/* R-15: tres pestanas. "Mis pedidos" es la vista de siempre; las otras dos cargan solo al abrirse (Radix monta su contenido al activarlas). */}
      <Tabs defaultValue="pedidos" className="flex flex-col gap-3">
      <TabsList>
        <TabsTrigger value="pedidos">{t("restaurantes.chofer.tab.pedidos")}</TabsTrigger>
        <TabsTrigger value="historial">{t("restaurantes.chofer.tab.historial")}</TabsTrigger>
        <TabsTrigger value="perfil">{t("restaurantes.chofer.tab.perfil")}</TabsTrigger>
      </TabsList>

      <TabsContent value="pedidos" className="mt-0 flex flex-col gap-4">
      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {!orders && !error && <EstadoCargando etiqueta={t("restaurantes.chofer.cargandoEntregas")} />}
      {orders && orders.length === 0 && <EstadoVacio mensaje={t("restaurantes.chofer.legado.sinPedidos")} />}

      {[...activos, ...resto].map((o) => {
        const nextClave = NEXT_STATUS_CLAVE[o.status];
        const nextLabel = nextClave ? t(nextClave) : "";
        return (
          <Card key={o.id}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {o.customerName} · ${formatMoney(o.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {o.customerPhone} · {new Date(o.createdAt).toLocaleString(localeActivo())}
                  </p>
                </div>
                <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)} className="self-start">
                  {t(STATUS_CLAVE[o.status])}
                </StatusBadge>
              </div>

              {o.customerAddress && (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  {o.customerAddress}
                </p>
              )}
              <p className="mt-1.5 text-sm text-foreground">{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>
              {o.incidentNote && (
                <p className="mt-1.5 flex items-start gap-1.5 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  {o.incidentNote}
                </p>
              )}

              <div className="mt-2.5 flex flex-wrap gap-2">
                {urlDestinoMapa(o.notes, o.customerAddress) && (
                  <Button asChild variant="outline">
                    <a href={urlDestinoMapa(o.notes, o.customerAddress) ?? undefined} target="_blank" rel="noreferrer">
                      <MapIcon />
                      {destinoEsPin(o.notes) ? t("restaurantes.chofer.legado.mapaPin") : t("restaurantes.chofer.legado.mapa")}
                    </a>
                  </Button>
                )}
                {o.status !== "entregado" && o.status !== "cancelado" && (
                  <Button type="button" variant="outline" onClick={() => void handleLlamar(o)} disabled={changingId === o.id}>
                    <Phone />
                    {t("restaurantes.chofer.llamar")}
                  </Button>
                )}
                {nextLabel && (
                  <Button type="button" onClick={() => void handleAvanzar(o)} loading={changingId === o.id}>
                    {nextLabel}
                  </Button>
                )}
                {(o.status === "pending" || o.status === "preparando" || o.status === "en_camino") && (
                  <Button
                    type="button"
                    variant="danger-outline"
                    onClick={() => void handleReportarIncidencia(o)}
                    disabled={changingId === o.id}
                  >
                    <AlertTriangle />
                    {t("restaurantes.chofer.legado.reportarIncidencia")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      </TabsContent>

      <TabsContent value="historial" className="mt-0">
        <HistorialDiaTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
      </TabsContent>
      <TabsContent value="perfil" className="mt-0">
        <MiPerfilTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
      </TabsContent>
      </Tabs>

      {dialogo}
      </PageContainer>
    </main>
  );
}

export function RepartidorPedidosPage() {
  // Esta ruta vive fuera de todo shell (el que aplica el tema): se aplica aqui, con la bandera de diseno apagada o no (BUG-E2E-REST-004).
  useTemaGlobal();
  const navigate = useNavigate();
  const t = useT(restaurantesChofer);
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
      purgarColas(almacenDelNavegador(), null); // sesion vencida: nada pendiente de esta persona queda en el celular
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
          setError(t("restaurantes.chofer.legado.sinSucursal"));
          return;
        }
        // Igual que RestaurantesShell.tsx: usa la primera sucursal hasta que haya un
        // selector visual real. Para repartidor esto solo ancla la resolución de
        // organización/rol (ver requirePropertyMembership) -- la lista de pedidos NO
        // se filtra por esta sucursal, es SIEMPRE "lo que tengo asignado" (ver
        // repartidor-orders.ts).
        setPropertyId(branches[0]!.propertyId);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : t("restaurantes.chofer.legado.errorSucursales"));
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
      <PageContainer as="main" padding="default" className="mx-auto max-w-2xl gap-6 min-h-screen bg-background">
        <EstadoError mensaje={error} />
      </PageContainer>
    );
  }

  if (!propertyId) {
    return (
      <PageContainer as="main" padding="default" className="mx-auto max-w-2xl gap-6 min-h-screen bg-background">
        <EstadoCargando etiqueta={t("restaurantes.chofer.cargando")} />
      </PageContainer>
    );
  }

  // Panel nuevo del chofer (PLAN-PANEL-OPERADOR, paquete C1); cae a la vista anterior si el servidor aun no tiene sus rutas (501).
  // ds3 «Guía»: el repartidor no tiene sidebar ni cabecera; su recorrido (una pantalla) se ofrece con la invitación del primer ingreso.
  return (
    <>
      <PanelChofer
        apiBaseUrl={apiBaseUrl}
        token={session.token}
        propertyId={propertyId}
        identidad={identidadDeSesion(session)}
        legado={<RepartidorPedidosView apiBaseUrl={apiBaseUrl} token={session.token} propertyId={propertyId} />}
      />
      <GuiaRepartidor apiBaseUrl={apiBaseUrl} token={session.token} email={session.email} orgSlug={orgSlug} />
    </>
  );
}

/** ds3 «Guía» del repartidor (su panel no tiene sidebar): una sola pantalla; contenido y componente se cargan solo con la bandera ds3. */
function GuiaRepartidor({ apiBaseUrl, token, email, orgSlug }: { apiBaseUrl: string; token: string; email: string; orgSlug: string }) {
  const t = useT(restaurantesComun, restaurantesChofer);
  const titulo = t("restaurantes.repartidor");
  const pantalla = t("restaurantes.chofer.titulo");
  // Mismo menu que menuRepartidor de guia-restaurantes.ts (no se importa: el contenido de la guia se descarga solo con ds3).
  const sections = useMemo(() => [{ title: titulo, items: [{ to: `/restaurantes/${orgSlug}/repartidor`, label: pantalla }] }], [orgSlug, titulo, pantalla]);
  const servidor = useMemo(() => servidorProgresoGuia(fetch, apiBaseUrl, token, "restaurantes.repartidor", orgSlug), [apiBaseUrl, token, orgSlug]);
  return (
    <GuiaDiferida
      sections={sections}
      base={`/restaurantes/${orgSlug}`}
      pista="restaurantes.repartidor"
      persona={email}
      organizacion={orgSlug}
      organizacionNombre={orgSlug}
      rolEtiqueta={etiquetaRol("repartidor")}
      cargar={() => import("../guia-restaurantes.ts").then((m) => ({ contenido: m.GUIA_REPARTIDOR }))}
      servidor={servidor}
    />
  );
}
