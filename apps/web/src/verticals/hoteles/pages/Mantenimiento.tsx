// Mantenimiento — tickets correctivos (Fase 7, REQ-HK-011): crear/listar/cerrar
// tickets reales contra housekeeping.ts. Los turnos de camaristas/lavandería
// (REQ-HK-008, LFT) no están en esta página — ver housekeeping-client.ts.
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// botones/pills/tarjetas/inputs de estilos inline por Button/Tabs/Card/Badge/Input/
// Label reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún
// cambio de lógica: mismos props, mismo estado, mismas llamadas de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus, Wrench } from "lucide-react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { closeTicket, createTicket, fetchTickets, TICKET_SEVERITY_LABELS, TICKET_STATUS_LABELS } from "../lib/housekeeping-client.ts";
import type { MaintenanceTicketSeverity, MaintenanceTicketStatus, MaintenanceTicketSummary } from "../lib/housekeeping-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const FILTERS: ReadonlyArray<MaintenanceTicketStatus | "todos"> = ["todos", "abierto", "en_progreso", "cerrado", "cancelado"];
const SEVERITIES: readonly MaintenanceTicketSeverity[] = ["alta", "media", "baja"];

export function MantenimientoPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [filter, setFilter] = useState<MaintenanceTicketStatus | "todos">("abierto");
  const [tickets, setTickets] = useState<readonly MaintenanceTicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [severidad, setSeveridad] = useState<MaintenanceTicketSeverity>("media");
  const [roomId, setRoomId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setTickets(await fetchTickets(fetch, apiBaseUrl, token, propertyId, filter === "todos" ? undefined : filter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los tickets.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, filter]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!titulo.trim() || !descripcion.trim()) return setFormError("Título y descripción son requeridos.");
    setCreating(true);
    try {
      await createTicket(fetch, apiBaseUrl, token, propertyId, { titulo: titulo.trim(), descripcion: descripcion.trim(), severidad, roomId: roomId.trim() || undefined });
      setTitulo("");
      setDescripcion("");
      setRoomId("");
      setSeveridad("media");
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el ticket.");
    } finally {
      setCreating(false);
    }
  }

  async function handleClose(ticket: MaintenanceTicketSummary) {
    const costStr = window.prompt(`Costo real de cerrar "${ticket.titulo}" (MXN):`, String(ticket.costoEstimado));
    if (costStr === null) return;
    const actualCost = Number(costStr);
    if (!Number.isFinite(actualCost) || actualCost < 0) {
      setError("El costo real debe ser un número >= 0.");
      return;
    }
    const nota = window.prompt("Nota de resolución (opcional):") ?? undefined;
    setBusyId(ticket.id);
    setError(null);
    try {
      await closeTicket(fetch, apiBaseUrl, token, propertyId, ticket.id, actualCost, nota || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cerrar el ticket.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground">Mantenimiento</h1>
        <Button type="button" variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
          {!showForm && <Plus className="w-4 h-4" strokeWidth={1.75} />}
          {showForm ? "Cancelar" : "Nuevo ticket"}
        </Button>
      </header>

      {showForm && (
        <Card className="max-w-md">
          <CardContent className="p-4">
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <div>
                <Label htmlFor="mant-titulo">Título</Label>
                <Input id="mant-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} required className="mt-1" />
              </div>
              <div>
                <Label htmlFor="mant-descripcion">Descripción</Label>
                <textarea
                  id="mant-descripcion"
                  value={descripcion}
                  onChange={(e) => setDescripcion(e.target.value)}
                  required
                  className="mt-1 flex w-full min-h-[70px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label htmlFor="mant-severidad">Severidad</Label>
                  <select
                    id="mant-severidad"
                    value={severidad}
                    onChange={(e) => setSeveridad(e.target.value as MaintenanceTicketSeverity)}
                    className="mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {TICKET_SEVERITY_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <Label htmlFor="mant-room">Habitación (opcional)</Label>
                  <Input id="mant-room" value={roomId} onChange={(e) => setRoomId(e.target.value)} className="mt-1" />
                </div>
              </div>
              {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" disabled={creating}>
                {creating ? "Creando…" : "Crear ticket"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as MaintenanceTicketStatus | "todos")}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f}>
              {f === "todos" ? "Todos" : TICKET_STATUS_LABELS[f]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={filter} className="flex flex-col gap-4 mt-4">
          {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
          {!tickets && !error && <EstadoCargando etiqueta="Cargando tickets…" />}
          {tickets && tickets.length === 0 && <EstadoVacio mensaje="No hay tickets en este filtro." />}

          <div className="flex flex-col gap-3">
            {tickets?.map((t) => (
              <Card key={t.id}>
                <CardContent className="p-4">
                  <div className="flex justify-between gap-2 flex-wrap">
                    <div>
                      <p className="font-medium text-foreground flex items-center gap-1.5">
                        <Wrench className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
                        {t.titulo}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t.roomId ? `Habitación ${t.roomId}` : "Sin habitación"} · Origen: {t.origen} · Estimado: ${t.costoEstimado.toLocaleString("es-MX")}
                      </p>
                    </div>
                    <Badge variant={t.severidad === "alta" ? "destructive" : "secondary"} className="self-start">
                      {TICKET_SEVERITY_LABELS[t.severidad]} · {TICKET_STATUS_LABELS[t.estado]}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-foreground">{t.descripcion}</p>
                  {t.notaResolucion && <p className="mt-1.5 text-xs text-muted-foreground">Resolución: {t.notaResolucion}</p>}
                  {(t.estado === "abierto" || t.estado === "en_progreso") && (
                    <div className="mt-2.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleClose(t)} disabled={busyId === t.id}>
                        {busyId === t.id ? "…" : "Cerrar ticket"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
