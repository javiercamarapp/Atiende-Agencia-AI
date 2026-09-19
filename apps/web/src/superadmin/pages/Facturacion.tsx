// Back office de plataforma — FACTURACIÓN de la suscripción SaaS propia de
// Atiende (lo que Atiende le cobra a cada organización cliente). Backend
// real: GET/POST /superadmin/facturacion/* (apps/api/src/routes/
// superadmin-facturacion.ts), ya verificadas contra Postgres real (ver
// scripts/verify-superadmin-facturacion/). Mismo patrón de sesión/fetch/
// estados que GastoApi.tsx/Integraciones.tsx: fetch directo con Bearer, sin
// cliente separado, EstadoCargando/EstadoError/EstadoVacio de @atiende/ui,
// sin librerías de gráficas ni de fecha nuevas.
//
// MRR: el backend YA decide si es un número real (asientos contratados ×
// precio per-seat CONOCIDO, `@atiende/billing::SEAT_*`) o `null` ("no
// disponible sin precio configurado") -- este archivo NUNCA calcula ni
// inventa un número, solo formatea lo que la API ya resolvió.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Building2, Calendar, ChevronLeft, ChevronRight, Copy, ExternalLink, History, Link2, RefreshCw, ScaleIcon, TrendingDown, Webhook } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  formatMoney,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";

type EstadoBilling = "sin_suscripcion" | "activa" | "pago_pendiente" | "cancelada";
type FiltroEstado = EstadoBilling | "todos";

interface OrganizacionFacturacion {
  readonly organizationId: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly orgStatus: string;
  readonly createdAt: string;
  readonly billingStatus: EstadoBilling;
  readonly seats: number;
  readonly staffCount: number;
  readonly priceId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly ultimoEventoAplicadoAt: string | null;
  readonly precioConocido: boolean;
  readonly seatLabel: string | null;
  readonly precioPorSeatMxn: number | null;
  readonly seatsFacturablesSegunReal: number | null;
  readonly descuadreAsientos: number;
  readonly mrrMxn: number | null;
}

interface Resumen {
  readonly totalOrganizaciones: number;
  readonly conteoPorEstado: Record<string, number>;
  readonly morosos: number;
  readonly mrrMxn: number | null;
  readonly organizacionesActivasConPrecioDesconocido: number;
  readonly proximasRenovaciones: readonly OrganizacionFacturacion[];
  readonly webhooks: { readonly totalProcesados: number; readonly ultimoProcesadoAt: string | null };
}

interface EventoWebhook {
  readonly eventId: string;
  readonly processedAt: string;
}

// Bitácora completa de `POST /billing/webhook` (`core.billing_webhook_log`,
// `GET /superadmin/facturacion/webhooks-bitacora`) -- a diferencia del feed
// ligero de arriba (`EventoWebhook`), esta incluye TODO intento (con o sin
// éxito), organización resuelta, y es filtrable/paginada.
type ResultadoBitacora = "procesado" | "ignorado" | "rechazado" | "error";

interface FilaBitacora {
  readonly id: string;
  readonly providerEventId: string | null;
  readonly eventType: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly organizationSlug: string | null;
  readonly result: ResultadoBitacora;
  readonly reason: string;
  readonly createdAt: string;
}

interface PaginaBitacora {
  readonly disponible: boolean;
  readonly rows: readonly FilaBitacora[];
  readonly total: number;
}

const BITACORA_LIMIT = 20;

// Revisión de PR #153 (bloqueante 3): el filtro de organización manda el
// texto crudo del input al backend en CADA tecla -- mientras el usuario
// todavía está tecleando, un UUID incompleto llegaría hasta el parámetro
// `uuid` de la función SQL y Postgres lo rechazaría (22P02). La ruta ya
// valida esto y responde 400 en vez de 500, pero enviar la request de todas
// formas seguiría produciendo una ráfaga de errores mientras se teclea --
// aquí se filtra ANTES de mandar la request: solo se envía `organizationId`
// cuando el valor es un UUID completo.
const UUID_COMPLETO_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOMBRE_RESULTADO_BITACORA: Record<ResultadoBitacora, string> = {
  procesado: "Procesado",
  ignorado: "Ignorado",
  rechazado: "Rechazado",
  error: "Error",
};

const NOMBRE_MOTIVO_BITACORA: Record<string, string> = {
  aplicado: "Aplicado",
  duplicado: "Duplicado (reintento)",
  fuera_de_orden: "Fuera de orden (descartado)",
  evento_no_reconocido: "Tipo de evento no manejado",
  firma_invalida: "Firma inválida",
  json_invalido: "JSON inválido",
  tenant_id_ausente: "Sin tenant_id en la metadata",
  tenant_no_existe: "tenant_id no corresponde a ninguna organización",
  customer_no_coincide: "Customer no coincide (posible replay)",
  email_no_coincide: "Email no coincide (posible replay)",
  error_interno: "Error interno al procesar",
};

function badgeResultadoBitacora(result: ResultadoBitacora) {
  const variant = result === "procesado" ? "default" : result === "rechazado" || result === "error" ? "destructive" : "secondary";
  return <Badge variant={variant}>{NOMBRE_RESULTADO_BITACORA[result]}</Badge>;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

const NOMBRE_ESTADO: Record<EstadoBilling, string> = {
  sin_suscripcion: "Sin suscripción",
  activa: "Activa",
  pago_pendiente: "Moroso",
  cancelada: "Cancelada",
};

const FILTROS: readonly FiltroEstado[] = ["todos", "activa", "pago_pendiente", "sin_suscripcion", "cancelada"];

// Mismo estilo que `SELECT_CLASES` de `Prospectos.tsx` -- no hay componente
// `Select` en `@atiende/ui` todavía, así que los filtros nativos de esta
// pantalla siguen el mismo patrón que el resto del back office.
const SELECT_CLASES =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function mxn(monto: number | null): string {
  return monto === null ? "No disponible" : `$${formatMoney(monto, 2)} MXN`;
}

function fecha(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "numeric" });
}

function antiguedad(iso: string): string {
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (dias < 30) return `${dias} días`;
  if (dias < 365) return `${Math.floor(dias / 30)} meses`;
  return `${Math.floor(dias / 365)} años`;
}

function badgeEstado(estado: EstadoBilling) {
  const variant = estado === "activa" ? "default" : estado === "pago_pendiente" ? "destructive" : "secondary";
  return <Badge variant={variant}>{NOMBRE_ESTADO[estado]}</Badge>;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    const err = new Error(body?.message ?? "No se pudo completar la solicitud.") as Error & { code?: string; status?: number };
    err.code = body?.code;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

function PanelCheckout({ apiBaseUrl, token, org, onClose }: { readonly apiBaseUrl: string; readonly token: string; readonly org: OrganizacionFacturacion; readonly onClose: () => void }) {
  const [priceId, setPriceId] = useState(org.priceId ?? "");
  // Sugerencia inicial real (staff activo per-seat, o lo ya contratado como
  // último recurso) -- nunca por debajo de 1: un checkout de 0 asientos no es
  // válido (`POST /billing/checkout` exige un entero >= 1, ver `billing.ts`),
  // así que "0 seatsFacturablesSegunReal" (organización dentro de los seats
  // incluidos en el plan) sugiere el mínimo vendible, no cero.
  const sugerido = org.seatsFacturablesSegunReal ?? org.seats;
  const [seats, setSeats] = useState(String(sugerido > 0 ? sugerido : 1));
  const [generando, setGenerando] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stripeNoConfigurado, setStripeNoConfigurado] = useState(false);

  async function generar(e: FormEvent) {
    e.preventDefault();
    const seatsNum = Number(seats);
    if (!priceId.trim()) {
      setError("El price de Stripe es requerido.");
      return;
    }
    if (!Number.isInteger(seatsNum) || seatsNum < 1) {
      setError("Los asientos deben ser un entero positivo.");
      return;
    }
    setError(null);
    setStripeNoConfigurado(false);
    setUrl(null);
    setGenerando(true);
    try {
      const body = await fetchJson<{ url: string }>(apiBaseUrl, token, `/superadmin/facturacion/organizaciones/${org.organizationId}/checkout`, {
        method: "POST",
        body: JSON.stringify({ priceId: priceId.trim(), seats: seatsNum }),
      });
      setUrl(body.url);
    } catch (err) {
      const e2 = err as Error & { status?: number };
      if (e2.status === 503) setStripeNoConfigurado(true);
      else setError(e2.message);
    } finally {
      setGenerando(false);
    }
  }

  async function copiar() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles -- el input de abajo sigue mostrando la
      // URL completa, seleccionable a mano.
    }
  }

  return (
    <ModalFormularioLateral
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      titulo="Generar enlace de checkout"
      subtitulo={`${org.name} — suscripción SaaS de Atiende (${org.seatLabel ?? "asiento"})`}
      anchoClase="max-w-lg"
      footer={
        <Button type="button" variant="outline" className="rounded-full px-6" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Reutiliza la MISMA lógica de <code className="font-mono text-xs">POST /billing/checkout</code> -- nunca cobra, reembolsa ni cancela nada desde aquí, solo genera el enlace de pago para compartir con la organización.
        </p>

        {stripeNoConfigurado && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <AlertTriangle className="w-4 h-4" strokeWidth={1.75} />
              Stripe no está configurado en este entorno
            </p>
            <p className="text-muted-foreground">No hay credenciales de Stripe (STRIPE_SECRET_KEY) para generar el checkout todavía.</p>
            <a href="/superadmin/integraciones" className="inline-flex items-center gap-1 text-primary underline w-fit">
              Ir a Integraciones <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
            </a>
          </div>
        )}

        {!url ? (
          <form onSubmit={generar} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="checkout-price-id">Price de Stripe</Label>
              <Input id="checkout-price-id" value={priceId} onChange={(e) => setPriceId(e.target.value)} placeholder="price_..." required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="checkout-seats">Asientos ({org.seatLabel ?? "asiento"})</Label>
              <Input id="checkout-seats" type="number" min="1" value={seats} onChange={(e) => setSeats(e.target.value)} required />
              {org.seatsFacturablesSegunReal !== null && (
                <p className="text-xs text-muted-foreground">Sugerido según staff real: {org.seatsFacturablesSegunReal}</p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="rounded-full" disabled={generando}>
              {generando ? "Generando…" : "Generar enlace"}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="checkout-url">Enlace de checkout</Label>
            <div className="flex gap-2">
              <Input id="checkout-url" readOnly value={url} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => void copiar()}>
                <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />
                {copiado ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setUrl(null)}>
              Generar otro
            </Button>
          </div>
        )}
      </div>
    </ModalFormularioLateral>
  );
}

export function SuperAdminFacturacionPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [organizaciones, setOrganizaciones] = useState<readonly OrganizacionFacturacion[] | null>(null);
  const [eventos, setEventos] = useState<{ eventos: readonly EventoWebhook[]; total: number } | null>(null);
  const [filtro, setFiltro] = useState<FiltroEstado>("todos");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [detalle, setDetalle] = useState<OrganizacionFacturacion | null>(null);

  // Bitácora completa de webhooks — estado/carga separados del resto de la
  // pantalla a propósito: cambiar un filtro de la bitácora nunca debe volver
  // a pedir resumen/organizaciones/feed ligero (y viceversa).
  const [bitacora, setBitacora] = useState<PaginaBitacora | null>(null);
  const [bitacoraError, setBitacoraError] = useState<string | null>(null);
  const [bitacoraCargando, setBitacoraCargando] = useState(false);
  const [filtroResultado, setFiltroResultado] = useState<ResultadoBitacora | "todos">("todos");
  const [filtroOrganizationId, setFiltroOrganizationId] = useState("");
  const [bitacoraOffset, setBitacoraOffset] = useState(0);

  async function cargarBitacora() {
    setBitacoraError(null);
    setBitacoraCargando(true);
    try {
      const params = new URLSearchParams({ limit: String(BITACORA_LIMIT), offset: String(bitacoraOffset) });
      if (filtroResultado !== "todos") params.set("result", filtroResultado);
      const organizationIdCompleto = filtroOrganizationId.trim();
      if (organizationIdCompleto && UUID_COMPLETO_REGEX.test(organizationIdCompleto)) params.set("organizationId", organizationIdCompleto);
      const pagina = await fetchJson<PaginaBitacora>(apiBaseUrl, token, `/superadmin/facturacion/webhooks-bitacora?${params.toString()}`);
      setBitacora(pagina);
    } catch {
      setBitacoraError("No se pudo cargar la bitácora de webhooks.");
    } finally {
      setBitacoraCargando(false);
    }
  }

  useEffect(() => {
    void cargarBitacora();
  }, [apiBaseUrl, token, filtroResultado, filtroOrganizationId, bitacoraOffset]);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const [r, orgs, ev] = await Promise.all([
        fetchJson<Resumen>(apiBaseUrl, token, "/superadmin/facturacion/resumen"),
        fetchJson<{ organizaciones: OrganizacionFacturacion[] }>(apiBaseUrl, token, "/superadmin/facturacion/organizaciones"),
        fetchJson<{ eventos: EventoWebhook[]; total: number }>(apiBaseUrl, token, "/superadmin/facturacion/webhooks-recientes?limit=10"),
      ]);
      setResumen(r);
      setOrganizaciones(orgs.organizaciones);
      setEventos(ev);
    } catch {
      setError("No se pudo cargar la facturación.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  const organizacionesFiltradas = useMemo(() => {
    if (!organizaciones) return null;
    return filtro === "todos" ? organizaciones : organizaciones.filter((o) => o.billingStatus === filtro);
  }, [organizaciones, filtro]);

  if (error && !resumen) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!resumen || !organizacionesFiltradas || !eventos) return <EstadoCargando etiqueta="Cargando facturación…" />;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Facturación</h1>
          <p className="text-sm text-muted-foreground mt-1">Suscripción SaaS que Atiende le cobra a cada organización cliente — estado real, asientos, y descuadres contra el staff activo.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void cargar()} disabled={cargando}>
          <RefreshCw className={cargando ? "animate-spin" : undefined} />
          {cargando ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Organizaciones" value={String(resumen.totalOrganizaciones)} icon={Building2} />
        <StatCard label="MRR (asientos contratados × precio conocido)" value={mxn(resumen.mrrMxn)} icon={TrendingDown} />
        <StatCard label="Morosos (pago pendiente)" value={String(resumen.morosos)} icon={AlertTriangle} />
        <StatCard label="Eventos de webhook procesados" value={String(resumen.webhooks.totalProcesados)} icon={Webhook} />
      </div>

      {resumen.organizacionesActivasConPrecioDesconocido > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <ScaleIcon className="w-3.5 h-3.5" strokeWidth={1.75} />
          {resumen.organizacionesActivasConPrecioDesconocido} organización(es) activa(s) tienen un vertical sin precio per-seat configurado en el código — su MRR queda fuera del total de arriba (no se inventa).
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
            Próximas renovaciones
          </CardTitle>
        </CardHeader>
        <CardContent>
          {resumen.proximasRenovaciones.length === 0 ? (
            <EstadoVacio mensaje="Ninguna organización activa tiene una fecha de fin de periodo registrada todavía." />
          ) : (
            <div className="flex flex-col gap-2">
              {resumen.proximasRenovaciones.map((o) => (
                <div key={o.organizationId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">{o.name}</span>
                  <span className="text-muted-foreground">{fecha(o.currentPeriodEnd)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
            Últimos eventos de webhook (feed de plataforma)
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Feed ligero (`core.billing_webhook_event`, solo id y hora de cada evento ya aplicado con éxito) — úsalo para confirmar "¿sigue vivo el webhook?". Para diagnosticar un cobro que no se reflejó,
            incluidos los webhooks rechazados, usa la bitácora completa de abajo.
          </p>
        </CardHeader>
        <CardContent>
          {eventos.eventos.length === 0 ? (
            <EstadoVacio mensaje="Ningún evento de webhook se ha procesado todavía en este ambiente." />
          ) : (
            <div className="flex flex-col gap-1.5">
              {eventos.eventos.map((e) => (
                <div key={e.eventId} className="flex items-center justify-between gap-3 text-sm">
                  <code className="font-mono text-xs text-muted-foreground">{e.eventId}</code>
                  <span className="text-muted-foreground">{new Date(e.processedAt).toLocaleString("es-MX")}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <CardTitle className="flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
            Bitácora completa de webhooks
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Cada intento de <code className="font-mono">POST /billing/webhook</code>, con o sin éxito — procesados, ignorados, y RECHAZADOS (firma inválida, evento desconocido, organización no resuelta, error al
            procesar), sin datos de tarjeta ni payload crudo.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filtroResultado}
              onChange={(e) => {
                setFiltroResultado(e.target.value as ResultadoBitacora | "todos");
                setBitacoraOffset(0);
              }}
              className={SELECT_CLASES}
              aria-label="Filtrar por resultado"
            >
              <option value="todos">Todos los resultados</option>
              {(Object.keys(NOMBRE_RESULTADO_BITACORA) as ResultadoBitacora[]).map((r) => (
                <option key={r} value={r}>
                  {NOMBRE_RESULTADO_BITACORA[r]}
                </option>
              ))}
            </select>
            <Input
              value={filtroOrganizationId}
              onChange={(e) => {
                setFiltroOrganizationId(e.target.value);
                setBitacoraOffset(0);
              }}
              placeholder="Filtrar por id de organización…"
              className="h-8 w-64 text-xs"
              aria-label="Filtrar por id de organización"
            />
          </div>
        </CardHeader>
        <CardContent>
          {/* Revisión de PR #153 (bloqueante 3): antes, un error nuevo
             (`bitacoraError`) solo se mostraba si NUNCA se había cargado
             ninguna página (`!bitacora`) -- una vez que había datos previos,
             un error posterior quedaba silencioso y la tabla seguía
             mostrando la página VIEJA sin filtrar, dato engañoso en una
             pantalla de diagnóstico de cobros. Ahora, si YA hay datos
             previos, el error se muestra como aviso ARRIBA de esos datos en
             vez de desaparecer. */}
          {bitacoraError && bitacora && (
            <p role="alert" className="text-[13px] text-destructive mb-3">
              {bitacoraError}
            </p>
          )}
          {bitacoraError && !bitacora ? (
            <EstadoError mensaje={bitacoraError} onReintentar={() => void cargarBitacora()} />
          ) : bitacoraCargando && !bitacora ? (
            <EstadoCargando etiqueta="Cargando bitácora…" />
          ) : !bitacora ? null : !bitacora.disponible ? (
            <EstadoVacio mensaje="La bitácora completa no está disponible todavía en este ambiente (la migración 0018_billing_webhook_registro.sql no se ha aplicado a esta base real)." />
          ) : bitacora.rows.length === 0 ? (
            <EstadoVacio mensaje="Ningún webhook coincide con este filtro todavía." />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cuándo</TableHead>
                      <TableHead>Resultado</TableHead>
                      <TableHead>Motivo</TableHead>
                      <TableHead>Tipo de evento</TableHead>
                      <TableHead>Organización</TableHead>
                      <TableHead>Id de evento</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bitacora.rows.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{new Date(f.createdAt).toLocaleString("es-MX")}</TableCell>
                        <TableCell>{badgeResultadoBitacora(f.result)}</TableCell>
                        <TableCell>{NOMBRE_MOTIVO_BITACORA[f.reason] ?? f.reason}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{f.eventType ?? "—"}</TableCell>
                        <TableCell>{f.organizationName ? `${f.organizationName} (${f.organizationSlug})` : <span className="text-muted-foreground">Sin resolver</span>}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{f.providerEventId ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {bitacoraOffset + 1}–{Math.min(bitacoraOffset + BITACORA_LIMIT, bitacora.total)} de {bitacora.total}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={bitacoraOffset === 0 || bitacoraCargando} onClick={() => setBitacoraOffset(Math.max(0, bitacoraOffset - BITACORA_LIMIT))}>
                    <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
                    Anterior
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={bitacoraOffset + BITACORA_LIMIT >= bitacora.total || bitacoraCargando}
                    onClick={() => setBitacoraOffset(bitacoraOffset + BITACORA_LIMIT)}
                  >
                    Siguiente
                    <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <CardTitle>Organizaciones</CardTitle>
          <div className="overflow-x-auto">
            <Tabs value={filtro} onValueChange={(v) => setFiltro(v as FiltroEstado)}>
              <TabsList>
                {FILTROS.map((f) => (
                  <TabsTrigger key={f} value={f}>
                    {f === "todos" ? "Todos" : NOMBRE_ESTADO[f]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {organizacionesFiltradas.length === 0 ? (
            <EstadoVacio mensaje="Ninguna organización coincide con este filtro." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Asientos (contratados / staff real)</TableHead>
                    <TableHead>MRR</TableHead>
                    <TableHead>Fin de periodo</TableHead>
                    <TableHead>Antigüedad</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizacionesFiltradas.map((org) => (
                    <TableRow key={org.organizationId}>
                      <TableCell>
                        <span className="font-medium text-foreground">{org.name}</span>
                        <span className="block text-xs text-muted-foreground">{org.slug}</span>
                      </TableCell>
                      <TableCell>{NOMBRE_VERTICAL[org.vertical] ?? org.vertical}</TableCell>
                      <TableCell>{badgeEstado(org.billingStatus)}</TableCell>
                      <TableCell>
                        {org.seats} / {org.staffCount}
                        {org.descuadreAsientos !== 0 && (
                          <Badge variant="destructive" className="ml-2">
                            {org.descuadreAsientos > 0 ? `+${org.descuadreAsientos}` : org.descuadreAsientos} descuadre
                          </Badge>
                        )}
                        {!org.precioConocido && <span className="block text-xs text-muted-foreground">Sin precio per-seat configurado</span>}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">{mxn(org.mrrMxn)}</TableCell>
                      <TableCell className="text-muted-foreground">{fecha(org.currentPeriodEnd)}</TableCell>
                      <TableCell className="text-muted-foreground">{antiguedad(org.createdAt)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setDetalle(org)}>
                          <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                          Checkout
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {detalle && <PanelCheckout apiBaseUrl={apiBaseUrl} token={token} org={detalle} onClose={() => setDetalle(null)} />}

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}
