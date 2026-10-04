// Captura manual de datos de Revenue: evento local y tarifa de competidor (UNI-C gestion: extraida de Revenue.tsx).
// Cada alta vive en un FormDialog con FormField; errores dentro del dialogo. Mismas llamadas: createLocalEvent / createCompetitorRate.
import { useState } from "react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, FormDialog, FormField, Input, NativeSelect, notify } from "@atiende/ui";
import { createCompetitorRate, createLocalEvent } from "../../lib/revenue-client.ts";

const EVENTO_VACIO = { nombre: "", fechaInicio: "", fechaFin: "", impacto: "alza_demanda" as "alza_demanda" | "baja_demanda", magnitudPct: "20" };
const COMPETIDOR_VACIO = { competidor: "", fecha: "", tarifa: "" };

export interface CapturaDatosSectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function CapturaDatosSection({ apiBaseUrl, token, propertyId }: CapturaDatosSectionProps) {
  const [abierto, setAbierto] = useState<"evento" | "competidor" | null>(null);
  const [localEventForm, setLocalEventForm] = useState(EVENTO_VACIO);
  const [competitorForm, setCompetitorForm] = useState(COMPETIDOR_VACIO);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  function abrir(cual: "evento" | "competidor") {
    setCaptureError(null);
    setAbierto(cual);
  }

  async function enviar(fn: () => Promise<void>, exito: string) {
    setEnviando(true);
    try {
      await fn();
      notify.success(exito);
      setAbierto(null);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setEnviando(false);
    }
  }

  async function handleCreateLocalEvent() {
    setCaptureError(null);
    if (!localEventForm.nombre || !localEventForm.fechaInicio || !localEventForm.fechaFin) {
      setCaptureError("Nombre, fecha de inicio y fecha de fin son obligatorios.");
      return;
    }
    const magnitudPct = Number(localEventForm.magnitudPct);
    if (!Number.isFinite(magnitudPct) || magnitudPct <= 0) {
      setCaptureError("La magnitud debe ser un número positivo.");
      return;
    }
    await enviar(async () => {
      await createLocalEvent(fetch, apiBaseUrl, token, propertyId, { ...localEventForm, magnitudPct });
      setLocalEventForm(EVENTO_VACIO);
    }, "Evento local registrado.");
  }

  async function handleCreateCompetitorRate() {
    setCaptureError(null);
    if (!competitorForm.competidor || !competitorForm.fecha) {
      setCaptureError("Competidor y fecha son obligatorios.");
      return;
    }
    const tarifa = Number(competitorForm.tarifa);
    if (!Number.isFinite(tarifa) || tarifa <= 0) {
      setCaptureError("La tarifa debe ser un número positivo.");
      return;
    }
    await enviar(async () => {
      await createCompetitorRate(fetch, apiBaseUrl, token, propertyId, { competidor: competitorForm.competidor, fecha: competitorForm.fecha, tarifa });
      setCompetitorForm(COMPETIDOR_VACIO);
    }, "Tarifa de competidor capturada.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Captura de datos (evento local / tarifa de competidor)</CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2 items-start">
          <h3 className="text-sm font-medium">Evento local (feria, concierto, congreso…)</h3>
          <p className="text-xs text-muted-foreground">Solo el staff de esta property lo sabe -- nunca se inventa ni se scrapea.</p>
          <Button type="button" size="sm" onClick={() => abrir("evento")}>
            Registrar evento
          </Button>
        </div>
        <div className="flex flex-col gap-2 items-start">
          <h3 className="text-sm font-medium">Tarifa de competidor (captura manual)</h3>
          <p className="text-xs text-muted-foreground">Nunca un scraper -- ver knownGaps del motor para la extensión futura con un proveedor de rate-shopping.</p>
          <Button type="button" size="sm" onClick={() => abrir("competidor")}>
            Capturar tarifa
          </Button>
        </div>
      </CardContent>

      <FormDialog
        open={abierto === "evento"}
        onOpenChange={(v) => {
          if (!v && !enviando) setAbierto(null);
        }}
        titulo="Registrar evento local"
        subtitulo="Feria, concierto, congreso… Solo el staff de esta property lo sabe."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleCreateLocalEvent()}
        guardando={enviando}
        textoBotonGuardar="Registrar evento"
        bloquearCierre={enviando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {captureError && <Callout tone="danger" className="sm:col-span-2">{captureError}</Callout>}
          <FormField label="Nombre del evento" required className="sm:col-span-2">
            <Input placeholder="Nombre del evento" value={localEventForm.nombre} onChange={(e) => setLocalEventForm({ ...localEventForm, nombre: e.target.value })} />
          </FormField>
          <FormField label="Inicio" required>
            <Input type="date" value={localEventForm.fechaInicio} onChange={(e) => setLocalEventForm({ ...localEventForm, fechaInicio: e.target.value })} />
          </FormField>
          <FormField label="Fin" required>
            <Input type="date" value={localEventForm.fechaFin} onChange={(e) => setLocalEventForm({ ...localEventForm, fechaFin: e.target.value })} />
          </FormField>
          <FormField label="Impacto">
            <NativeSelect value={localEventForm.impacto} onChange={(e) => setLocalEventForm({ ...localEventForm, impacto: e.target.value as "alza_demanda" | "baja_demanda" })}>
              <option value="alza_demanda">Sube la demanda</option>
              <option value="baja_demanda">Baja la demanda</option>
            </NativeSelect>
          </FormField>
          <FormField label="Magnitud (%)">
            <Input type="number" placeholder="Magnitud %" value={localEventForm.magnitudPct} onChange={(e) => setLocalEventForm({ ...localEventForm, magnitudPct: e.target.value })} />
          </FormField>
        </div>
      </FormDialog>

      <FormDialog
        open={abierto === "competidor"}
        onOpenChange={(v) => {
          if (!v && !enviando) setAbierto(null);
        }}
        titulo="Capturar tarifa de competidor"
        subtitulo="Captura manual: nunca un scraper."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleCreateCompetitorRate()}
        guardando={enviando}
        textoBotonGuardar="Capturar tarifa"
        bloquearCierre={enviando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {captureError && <Callout tone="danger" className="sm:col-span-2">{captureError}</Callout>}
          <FormField label="Competidor" required className="sm:col-span-2">
            <Input placeholder="Nombre del competidor" value={competitorForm.competidor} onChange={(e) => setCompetitorForm({ ...competitorForm, competidor: e.target.value })} />
          </FormField>
          <FormField label="Fecha" required>
            <Input type="date" value={competitorForm.fecha} onChange={(e) => setCompetitorForm({ ...competitorForm, fecha: e.target.value })} />
          </FormField>
          <FormField label="Tarifa (MXN)" required>
            <Input type="number" placeholder="Tarifa (MXN)" value={competitorForm.tarifa} onChange={(e) => setCompetitorForm({ ...competitorForm, tarifa: e.target.value })} />
          </FormField>
        </div>
      </FormDialog>
    </Card>
  );
}
