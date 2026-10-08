// Mantenimiento — tickets correctivos (Fase 7, REQ-HK-011): crear/listar/cerrar
// tickets reales contra housekeeping.ts. Los turnos de camaristas/lavandería
// (REQ-HK-008, LFT) no están en esta página — ver housekeeping-client.ts.
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// botones/pills/tarjetas/inputs de estilos inline por Button/Tabs/Card/Badge/Input/
// Label reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún
// cambio de lógica: mismos props, mismo estado, mismas llamadas de red.
import { useEffect, useState } from "react";
import { Plus, Wrench } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  notify,
  useConfirm,
} from "@atiende/ui";
import { dineroMx } from "../lib/dinero.ts";
import { closeTicket, createTicket, fetchTickets, TICKET_SEVERITY_LABELS, TICKET_STATUS_LABELS } from "../lib/housekeeping-client.ts";
import type { MaintenanceTicketSeverity, MaintenanceTicketStatus, MaintenanceTicketSummary } from "../lib/housekeeping-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const FILTERS: ReadonlyArray<MaintenanceTicketStatus | "todos"> = ["todos", "abierto", "en_progreso", "cerrado", "cancelado"];
const SEVERITIES: readonly MaintenanceTicketSeverity[] = ["alta", "media", "baja"];

export function MantenimientoPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const { pedirTexto, dialogo } = useConfirm();
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

  async function handleCreate() {
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
      notify.success("Ticket creado.");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el ticket.");
    } finally {
      setCreating(false);
    }
  }

  async function handleClose(ticket: MaintenanceTicketSummary) {
    const costStr = await pedirTexto({
      titulo: `Cerrar el ticket "${ticket.titulo}"`,
      confirmar: "Continuar",
      campo: {
        etiqueta: "Costo real (MXN)",
        valorInicial: String(ticket.costoEstimado),
        validar: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "El costo real debe ser un número >= 0."),
      },
    });
    if (costStr === null) return;
    const actualCost = Number(costStr);
    const nota = await pedirTexto({ titulo: `Cerrar el ticket "${ticket.titulo}"`, confirmar: "Cerrar ticket", campo: { etiqueta: "Nota de resolución (opcional)", requerido: false, multilinea: true } });
    if (nota === null) return;
    setBusyId(ticket.id);
    setError(null);
    try {
      await closeTicket(fetch, apiBaseUrl, token, propertyId, ticket.id, actualCost, nota || undefined);
      notify.success("Ticket cerrado.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cerrar el ticket.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Mantenimiento"
        descripcion="Tickets correctivos de la propiedad: crea, sigue y cierra con costo real."
        acciones={
          <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setShowForm(true)}>
            Nuevo ticket
          </Button>
        }
      />

      <FormDialog
        open={showForm}
        onOpenChange={(o) => {
          setShowForm(o);
          if (!o) setFormError(null);
        }}
        titulo="Nuevo ticket"
        subtitulo="Reporta un desperfecto para que mantenimiento lo atienda."
        onGuardar={() => void handleCreate()}
        guardando={creating}
        textoBotonGuardar="Crear ticket"
        anchoClase="max-w-xl"
      >
        <div className="grid gap-4">
          <FormField label="Título" required>
            <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          </FormField>
          <FormField label="Descripción" required>
            <Textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Severidad">
              <NativeSelect value={severidad} onChange={(e) => setSeveridad(e.target.value as MaintenanceTicketSeverity)}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_SEVERITY_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Habitación (opcional)">
              <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </FormField>
          </div>
          {formError && <Callout tone="danger">{formError}</Callout>}
        </div>
      </FormDialog>

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
                        {t.roomId ? `Habitación ${t.roomId}` : "Sin habitación"} · Origen: {t.origen} · {t.costoEstimado > 0 ? `Estimado: ${dineroMx(t.costoEstimado)}` : "Sin estimar"}
                      </p>
                    </div>
                    <StatusBadge tone={t.severidad === "alta" ? "danger" : "neutral"} className="self-start">
                      {TICKET_SEVERITY_LABELS[t.severidad]} · {TICKET_STATUS_LABELS[t.estado]}
                    </StatusBadge>
                  </div>
                  <p className="mt-2 text-sm text-foreground">{t.descripcion}</p>
                  {t.notaResolucion && <p className="mt-1.5 text-xs text-muted-foreground">Resolución: {t.notaResolucion}</p>}
                  {(t.estado === "abierto" || t.estado === "en_progreso") && (
                    <div className="mt-2.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleClose(t)} loading={busyId === t.id} disabled={busyId === t.id}>
                        Cerrar ticket
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      {dialogo}
    </PageContainer>
  );
}
