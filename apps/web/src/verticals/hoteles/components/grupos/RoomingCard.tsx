// Detalle de un bloqueo de grupo: pickup, rooming list y alta de huespedes (UNI-C gestion: extraido de Grupos.tsx).
// Cero logica de red propia: la pagina pasa los handlers que ya tenia. El alta de huesped pasa a FormDialog.
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, DataTable, FormDialog, FormField, Input, NativeSelect, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { ESTADO_HUESPED_LABELS, describirLiberacion } from "../../lib/grupos-client.ts";
import type { BloqueoDetalle, EstadoHuesped, HuespedGrupo } from "../../lib/grupos-client.ts";

type Tono = "warning" | "success" | "danger" | "neutral" | "info";
const tonoHuesped = (e: EstadoHuesped): Tono => (e === "confirmada" ? "success" : e === "pendiente" ? "warning" : "neutral");

export interface NuevoHuesped {
  readonly tipoHabitacionId: string;
  readonly huesped: string;
  readonly llegada: string;
  readonly salida: string;
}

export interface RoomingCardProps {
  readonly detalle: BloqueoDetalle;
  readonly hoy: string;
  readonly puedeGestionar: boolean;
  readonly puedeRooming: boolean;
  /** Clave del elemento en curso (id del bloqueo, del huesped o "huesped"). */
  readonly busy: string | null;
  readonly nombreTipo: (id: string) => string;
  readonly onLiberar: () => void;
  readonly onCancelarBloqueo: () => void;
  readonly onCerrar: () => void;
  readonly onConfirmarHuesped: (huespedId: string) => void;
  readonly onCancelarHuesped: (huespedId: string) => void;
  /** Agrega el huesped; debe lanzar si falla (el dialogo muestra el mensaje y sigue abierto). */
  readonly onAgregarHuesped: (input: NuevoHuesped) => Promise<void>;
}

export function RoomingCard({ detalle, hoy, puedeGestionar, puedeRooming, busy, nombreTipo, onLiberar, onCancelarBloqueo, onCerrar, onConfirmarHuesped, onCancelarHuesped, onAgregarHuesped }: RoomingCardProps) {
  const [abierto, setAbierto] = useState(false);
  const [huesped, setHuesped] = useState({ tipoHabitacionId: "", nombre: "", llegada: "", salida: "" });
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleAgregar() {
    if (!huesped.tipoHabitacionId || huesped.nombre.trim().length < 2 || !huesped.llegada || !huesped.salida) {
      setError("Completa el tipo de habitación, el nombre y las fechas del huésped.");
      return;
    }
    setError(null);
    setEnviando(true);
    try {
      await onAgregarHuesped({ tipoHabitacionId: huesped.tipoHabitacionId, huesped: huesped.nombre.trim(), llegada: huesped.llegada, salida: huesped.salida });
      setHuesped({ ...huesped, nombre: "" });
      setAbierto(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar al huésped.");
    } finally {
      setEnviando(false);
    }
  }

  const columnasHuesped: DataTableColumna<HuespedGrupo>[] = [
    { id: "huesped", encabezado: "Huésped", principal: true, valorOrden: (h) => h.huesped, celda: (h) => <span className="font-medium">{h.huesped}</span> },
    { id: "tipo", encabezado: "Habitación", celda: (h) => nombreTipo(h.tipoHabitacionId) },
    { id: "fechas", encabezado: "Estancia", valorOrden: (h) => h.llegada, celda: (h) => `${h.llegada} → ${h.salida}` },
    { id: "estado", encabezado: "Estado", valorOrden: (h) => h.estado, celda: (h) => <StatusBadge tone={tonoHuesped(h.estado)}>{ESTADO_HUESPED_LABELS[h.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (h) =>
        puedeRooming && h.estado !== "cancelada" ? (
          <div className="flex flex-wrap gap-2">
            {h.estado === "pendiente" && detalle.estado === "activo" && (
              <Button type="button" size="sm" disabled={busy === h.id} onClick={() => onConfirmarHuesped(h.id)}>
                Confirmar pickup
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" disabled={busy === h.id} onClick={() => onCancelarHuesped(h.id)}>
              Cancelar
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-medium text-foreground">Rooming list — {detalle.nombreGrupo}</h2>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral" dot={false}>{describirLiberacion(detalle, hoy)}</StatusBadge>
            {puedeGestionar && detalle.estado === "activo" && (
              <>
                <Button type="button" size="sm" variant="outline" disabled={busy === detalle.id} onClick={onLiberar}>
                  Liberar no confirmados
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy === detalle.id} onClick={onCancelarBloqueo}>
                  Cancelar bloqueo
                </Button>
              </>
            )}
            {puedeRooming && detalle.estado === "activo" && (
              <Button
                type="button"
                size="sm"
                iconLeft={<Plus className="size-3.5" strokeWidth={1.75} />}
                onClick={() => {
                  setError(null);
                  setAbierto(true);
                }}
              >
                Agregar huésped
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={onCerrar}>
              Cerrar
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Pickup: {detalle.pickup.cuartosNocheConfirmados} de {detalle.pickup.cuartosNocheBloqueados} cuartos-noche confirmados ({detalle.pickup.porcentaje} %) ·{" "}
          {detalle.pickup.cuartosNochePendientes} sin confirmar · {detalle.pickup.cuartosNocheLiberados} liberados.
        </p>
        <DataTable etiqueta="Huéspedes del grupo" columnas={columnasHuesped} filas={detalle.rooming} obtenerId={(h) => h.id} vacio={{ mensaje: "Aún no hay huéspedes en la rooming list." }} />
      </CardContent>

      <FormDialog
        open={abierto}
        onOpenChange={(v) => {
          if (!v && !enviando) setAbierto(false);
        }}
        titulo="Agregar huésped"
        subtitulo={`Rooming list de ${detalle.nombreGrupo}.`}
        anchoClase="max-w-3xl"
        onGuardar={() => void handleAgregar()}
        guardando={enviando}
        textoBotonGuardar="Agregar huésped"
        bloquearCierre={enviando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {error && <Callout tone="danger" className="sm:col-span-2">{error}</Callout>}
          <FormField label="Habitación" required>
            <NativeSelect value={huesped.tipoHabitacionId} onChange={(e) => setHuesped({ ...huesped, tipoHabitacionId: e.target.value })}>
              <option value="">Elige…</option>
              {[...new Set(detalle.noches.map((n) => n.tipoHabitacionId))].map((id) => (
                <option key={id} value={id}>
                  {nombreTipo(id)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Nombre del huésped" required>
            <Input value={huesped.nombre} maxLength={120} onChange={(e) => setHuesped({ ...huesped, nombre: e.target.value })} />
          </FormField>
          <FormField label="Llegada" required>
            <Input type="date" value={huesped.llegada} min={detalle.llegada} max={detalle.salida} onChange={(e) => setHuesped({ ...huesped, llegada: e.target.value })} />
          </FormField>
          <FormField label="Salida" required>
            <Input type="date" value={huesped.salida} min={detalle.llegada} max={detalle.salida} onChange={(e) => setHuesped({ ...huesped, salida: e.target.value })} />
          </FormField>
        </div>
      </FormDialog>
    </Card>
  );
}
