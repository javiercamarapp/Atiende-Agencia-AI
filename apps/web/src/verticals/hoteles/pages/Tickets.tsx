// Tickets de huesped (H-05) -- bandeja con SLA, escalacion a gerente, bitacora y creacion desde
// resenas con queja. Consume apps/api/.../hoteles/tickets.ts. Los botones se muestran segun el rol de
// la sesion (cosmetico: el servidor es la unica barrera real, 403). Contra una base sin la migracion
// 034 la pantalla avisa y no rompe (sin 500).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useConfirm,
} from "@atiende/ui";
import {
  DEPARTAMENTO_LABELS,
  ESTADO_LABELS,
  ESTADO_SLA_LABELS,
  PRIORIDAD_LABELS,
  TICKET_DEPARTAMENTOS,
  TICKET_FROM_REVIEW_ROLES,
  TICKET_PRIORIDADES,
  TICKET_SLA_POLICY_ROLES,
  accionTicket,
  accionesDisponibles,
  crearTicket,
  crearTicketDesdeResena,
  fetchResenasPendientes,
  fetchSla,
  fetchTicketDetalle,
  fetchTickets,
  formatearVencimiento,
  guardarSla,
  reasignarTicket,
  TICKET_MANAGE_ROLES,
} from "../lib/tickets-client.ts";
import type { ResenaPendiente, SlaEfectiva, TicketAccion, TicketDepartamento, TicketEvento, TicketListado, TicketPrioridad, TicketResumen } from "../lib/tickets-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { SLA_ESTADO_TONES } from "../lib/status-tones.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ACCION_LABELS: Record<TicketAccion, string> = { iniciar: "Tomar", cerrar: "Cerrar", cancelar: "Cancelar", escalar: "Escalar a gerencia" };

export function TicketsPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [listado, setListado] = useState<TicketListado | null>(null);
  const [resenas, setResenas] = useState<readonly ResenaPendiente[] | null>(null);
  const [sla, setSla] = useState<readonly SlaEfectiva[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"activos" | "escalados" | "resenas" | "sla">("activos");
  const [detalle, setDetalle] = useState<{ ticket: TicketResumen; bitacora: readonly TicketEvento[] } | null>(null);
  const [nuevo, setNuevo] = useState({ mensaje: "", departamento: "", prioridad: "" });
  const [slaEdicion, setSlaEdicion] = useState<Record<string, string>>({});

  const gestiona = TICKET_MANAGE_ROLES.has(role);
  const puedeDesdeResena = TICKET_FROM_REVIEW_ROLES.has(role);
  const puedeEditarSla = TICKET_SLA_POLICY_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setListado(await fetchTickets(fetch, apiBaseUrl, token, propertyId, { activos: true }));
      if (puedeDesdeResena) setResenas((await fetchResenasPendientes(fetch, apiBaseUrl, token, propertyId).catch(() => ({ resenas: [] as readonly ResenaPendiente[] }))).resenas);
      setSla((await fetchSla(fetch, apiBaseUrl, token, propertyId).catch(() => ({ efectiva: [] as readonly SlaEfectiva[] }))).efectiva);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los tickets.");
    }
  }, [apiBaseUrl, token, propertyId, puedeDesdeResena]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage?: string) {
    setBusy(key);
    setError(null);
    setAviso(null);
    try {
      await fn();
      if (okMessage) setAviso(okMessage);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  async function handleAccion(t: TicketResumen, accion: TicketAccion) {
    if (accion === "cancelar") {
      const ok = await confirmar({
        titulo: "Cancelar este ticket",
        descripcion: `Se cancelará el ticket: ${t.mensaje}`,
        tono: "danger",
        confirmar: "Cancelar ticket",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    let nota = "";
    if (accion === "cerrar") {
      const texto = await pedirTexto({ titulo: "Cerrar el ticket", descripcion: t.mensaje, confirmar: "Cerrar ticket", campo: { etiqueta: "Nota de resolución", requerido: false, multilinea: true } });
      if (texto === null) return;
      nota = texto;
    }
    void run(t.id, () => accionTicket(fetch, apiBaseUrl, token, propertyId, t.id, accion, nota ? { nota } : {}));
  }

  async function handleCrear(e: FormEvent) {
    e.preventDefault();
    const mensaje = nuevo.mensaje.trim();
    if (!mensaje) return setError("Escribe la peticion o queja del huesped.");
    await run(
      "crear",
      async () => {
        await crearTicket(fetch, apiBaseUrl, token, propertyId, {
          mensaje,
          ...(nuevo.departamento ? { departamento: nuevo.departamento as TicketDepartamento } : {}),
          ...(nuevo.prioridad ? { prioridad: nuevo.prioridad as TicketPrioridad } : {}),
        });
        setNuevo({ mensaje: "", departamento: "", prioridad: "" });
      },
      "Ticket registrado.",
    );
  }

  async function verDetalle(t: TicketResumen) {
    setError(null);
    try {
      const d = await fetchTicketDetalle(fetch, apiBaseUrl, token, propertyId, t.id);
      setDetalle({ ticket: d, bitacora: d.bitacora });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la bitacora.");
    }
  }

  const activos = listado?.tickets ?? [];
  const escalados = activos.filter((t) => t.estado === "escalado");
  const vencidos = activos.filter((t) => t.estadoSla === "vencido").length;

  function tarjeta(t: TicketResumen) {
    const acciones = accionesDisponibles(t.estado, role, t.departamento);
    return (
      <Card key={t.id}>
        <CardContent className="p-4 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge tone={t.prioridad === "alta" ? "danger" : "neutral"}>{PRIORIDAD_LABELS[t.prioridad]}</StatusBadge>
              <StatusBadge tone="neutral" dot={false}>{DEPARTAMENTO_LABELS[t.departamento]}</StatusBadge>
              <StatusBadge tone="neutral" dot={false}>{ESTADO_LABELS[t.estado]}</StatusBadge>
              {t.habitacion && <span className="text-xs text-muted-foreground">Hab. {t.habitacion}</span>}
              {t.resenaId && <span className="text-xs text-muted-foreground">Desde reseña</span>}
            </div>
            <StatusBadge tone={statusTone(SLA_ESTADO_TONES, t.estadoSla)}>
              <Clock className="w-3 h-3 mr-1" strokeWidth={1.75} />
              {t.estadoSla === "cerrado" ? ESTADO_SLA_LABELS.cerrado : `${ESTADO_SLA_LABELS[t.estadoSla]} · ${formatearVencimiento(t.minutosParaVencer)}`}
            </StatusBadge>
          </div>
          <p className="text-sm text-foreground">{t.mensaje}</p>
          {t.estado === "escalado" && (
            <p className="text-xs text-foreground flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" strokeWidth={1.75} />
              Escalado a {t.escaladoARoles.map((r) => DEPARTAMENTO_LABELS[r as TicketDepartamento] ?? r).join(" y ")} por SLA vencido o a petición.
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-1">
            {acciones.map((a) => (
              <Button key={a} type="button" size="sm" variant={a === "iniciar" || a === "cerrar" ? "default" : "outline"} loading={busy === t.id} disabled={busy === t.id} onClick={() => void handleAccion(t, a)}>
                {ACCION_LABELS[a]}
              </Button>
            ))}
            {gestiona && t.estado !== "cerrado" && t.estado !== "cancelado" && (
              <NativeSelect
                aria-label={`Reasignar departamento del ticket ${t.id}`}
                size="sm"
                wrapperClassName="w-44"
                value={t.departamento}
                disabled={busy === t.id}
                onChange={(e) => void run(t.id, () => reasignarTicket(fetch, apiBaseUrl, token, propertyId, t.id, e.target.value as TicketDepartamento))}
              >
                {TICKET_DEPARTAMENTOS.map((d) => (
                  <option key={d} value={d}>
                    {DEPARTAMENTO_LABELS[d]}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => void verDetalle(t)}>
              Bitácora
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Tickets de huésped"
        descripcion="Peticiones y quejas de huéspedes con plazo de atención (SLA)."
        meta={listado?.disponible ? <span>{activos.length} activos · {vencidos} con SLA vencido · {escalados.length} escalados</span> : undefined}
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {!listado && !error && <EstadoCargando etiqueta="Cargando tickets…" />}

      {listado && !listado.disponible && (
        <Callout tone="info">Los tickets de huésped con SLA aún no están activos en esta base de datos: se activan cuando se aplique la actualización pendiente.</Callout>
      )}

      {listado?.disponible && (
        <>
          <Card>
            <CardContent className="p-4">
              <form className="grid gap-3 sm:grid-cols-[1fr_11rem_8rem_auto] items-end" onSubmit={(e) => void handleCrear(e)}>
                <FormField label="Petición o queja del huésped">
                  <Input value={nuevo.mensaje} maxLength={1000} onChange={(e) => setNuevo({ ...nuevo, mensaje: e.target.value })} placeholder="Ej. Habitación 204: el aire no enfría" />
                </FormField>
                <FormField label="Departamento">
                  <NativeSelect value={nuevo.departamento} onChange={(e) => setNuevo({ ...nuevo, departamento: e.target.value })}>
                    <option value="">Automático</option>
                    {TICKET_DEPARTAMENTOS.map((d) => (
                      <option key={d} value={d}>
                        {DEPARTAMENTO_LABELS[d]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Prioridad">
                  <NativeSelect value={nuevo.prioridad} onChange={(e) => setNuevo({ ...nuevo, prioridad: e.target.value })}>
                    <option value="">Automática</option>
                    {TICKET_PRIORIDADES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORIDAD_LABELS[p]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <Button type="submit" loading={busy === "crear"} disabled={busy === "crear"}>
                  Registrar ticket
                </Button>
              </form>
            </CardContent>
          </Card>

          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="activos">Activos</TabsTrigger>
              <TabsTrigger value="escalados">Escalados</TabsTrigger>
              {puedeDesdeResena && <TabsTrigger value="resenas">Reseñas con queja</TabsTrigger>}
              <TabsTrigger value="sla">SLA</TabsTrigger>
            </TabsList>

            <TabsContent value="activos" className="flex flex-col gap-3 mt-4">
              {activos.length === 0 && <EstadoVacio mensaje="No hay tickets activos. Las peticiones de los huéspedes aparecen aquí con su plazo de atención." />}
              {activos.map(tarjeta)}
            </TabsContent>

            <TabsContent value="escalados" className="flex flex-col gap-3 mt-4">
              {escalados.length === 0 && <EstadoVacio mensaje="Ningún ticket escalado: todo se atiende dentro de su plazo." />}
              {escalados.map(tarjeta)}
            </TabsContent>

            {puedeDesdeResena && (
              <TabsContent value="resenas" className="flex flex-col gap-3 mt-4">
                {resenas && resenas.length === 0 && <EstadoVacio mensaje="No hay reseñas negativas sin ticket." />}
                {(resenas ?? []).map((r) => (
                  <Card key={r.id}>
                    <CardContent className="p-4 flex flex-col gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge tone="danger">{r.sentimiento === "muy_negativo" ? "Muy negativa" : "Negativa"}</StatusBadge>
                        <span className="text-xs text-muted-foreground">
                          {r.fuente}
                          {r.calificacion != null ? ` · ${r.calificacion}/5` : ""}
                          {r.temas.length > 0 ? ` · ${r.temas.join(", ")}` : ""}
                        </span>
                      </div>
                      <p className="text-sm text-foreground">{r.texto}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy === r.id}
                          onClick={() => void run(r.id, () => crearTicketDesdeResena(fetch, apiBaseUrl, token, propertyId, r.id), "Ticket creado desde la reseña.")}
                        >
                          Crear ticket
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Se enviará a {DEPARTAMENTO_LABELS[r.sugerencia.departamento]} con prioridad {PRIORIDAD_LABELS[r.sugerencia.prioridad].toLowerCase()}.
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>
            )}

            <TabsContent value="sla" className="flex flex-col gap-3 mt-4">
              <p className="text-sm text-muted-foreground">
                Minutos para atender cada ticket según departamento y prioridad. Si no hay un valor propio se usa el predeterminado (alta 30, media 120, baja 480). Un cambio aplica a los tickets nuevos, nunca a los ya abiertos.
              </p>
              {(sla ?? []).length === 0 && <EstadoVacio mensaje="La política de SLA aún no está disponible." />}
              {TICKET_DEPARTAMENTOS.map((d) => {
                const filas = (sla ?? []).filter((s) => s.departamento === d);
                if (filas.length === 0) return null;
                return (
                  <Card key={d}>
                    <CardContent className="p-4 flex flex-col gap-2">
                      <p className="font-medium text-sm text-foreground">{DEPARTAMENTO_LABELS[d]}</p>
                      <div className="flex flex-wrap gap-3">
                        {filas.map((s) => {
                          const key = `${s.departamento}:${s.prioridad}`;
                          return (
                            <div key={key} className="flex items-end gap-2">
                              <FormField label={`${PRIORIDAD_LABELS[s.prioridad]}${s.configurada ? "" : " (predeterminado)"}`}>
                                <Input
                                  type="number"
                                  min={1}
                                  max={43200}
                                  className="w-28"
                                  value={slaEdicion[key] ?? String(s.minutos)}
                                  disabled={!puedeEditarSla}
                                  onChange={(e) => setSlaEdicion({ ...slaEdicion, [key]: e.target.value })}
                                />
                              </FormField>
                              {puedeEditarSla && slaEdicion[key] !== undefined && Number(slaEdicion[key]) !== s.minutos && (
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={busy === key}
                                  onClick={() =>
                                    void run(
                                      key,
                                      async () => {
                                        await guardarSla(fetch, apiBaseUrl, token, propertyId, { departamento: s.departamento, prioridad: s.prioridad, minutos: Number(slaEdicion[key]) });
                                        setSlaEdicion(({ [key]: _quitado, ...resto }) => resto);
                                      },
                                      "Política de SLA guardada.",
                                    )
                                  }
                                >
                                  Guardar
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </TabsContent>
          </Tabs>
        </>
      )}

      {detalle && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-sm text-foreground">Bitácora del ticket</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setDetalle(null)}>
                Cerrar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{detalle.ticket.mensaje}</p>
            <ol className="text-sm text-foreground flex flex-col gap-1">
              {detalle.bitacora.map((e) => (
                <li key={e.id}>
                  <span className="text-muted-foreground">{fechaHoraEsMx(e.creadoEn)}</span> · {e.tipo.replaceAll("_", " ")} · {e.sistema ? "Sistema" : "Personal del hotel"}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      {dialogo}
    </PageContainer>
  );
}
