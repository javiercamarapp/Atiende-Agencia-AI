// Incidentes / vulneraciones (H-02). UNI-C gestion: el reporte pasa a FormDialog, la lista a DataTable y las notas que pedian
// `window.prompt` a useConfirm en cadena (Cancelar/Escape en cualquier paso NO registra nada). Mismas llamadas.
// El recordatorio del art. 19 sigue siendo solo informativo: el sistema NO envia ninguna notificacion.
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Callout, Checkbox, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, StatusBadge, Textarea, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { INCIDENTE_ESTADO_LABELS, INCIDENTE_TIPO_LABELS, actIncidente, etiquetaHoras, fetchIncidentes, reportIncidente } from "../../lib/privacidad-client.ts";
import type { IncidenteSeveridad, IncidenteSummary, IncidenteTipo, Lista } from "../../lib/privacidad-client.ts";
import { NoDisponible, errorMessage, validarNota10 } from "./comun.tsx";
import type { PrivacidadSectionProps } from "./comun.tsx";

export function IncidentesSection({ apiBaseUrl, token, propertyId, isAdmin }: PrivacidadSectionProps) {
  const [data, setData] = useState<Lista<IncidenteSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportando, setReportando] = useState(false);
  const [tipo, setTipo] = useState<IncidenteTipo>("acceso_no_autorizado");
  const [severidad, setSeveridad] = useState<IncidenteSeveridad>("media");
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [riesgo, setRiesgo] = useState(false);
  const [saving, setSaving] = useState(false);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    if (!isAdmin) return; // solo owner/gm leen; front-of-house reporta
    setError(null);
    try {
      setData(await fetchIncidentes(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar los incidentes."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, isAdmin]);

  async function handleReport() {
    setSaving(true);
    try {
      await reportIncidente(fetch, apiBaseUrl, token, propertyId, { tipo, severidad, titulo, descripcion, riesgoSignificativo: riesgo });
      notify.success("Incidente registrado. Avisa a owner/gm.");
      setTitulo("");
      setDescripcion("");
      setRiesgo(false);
      setReportando(false);
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo registrar el incidente."));
    } finally {
      setSaving(false);
    }
  }

  async function act(i: IncidenteSummary, accion: "contener" | "registrar_notificacion" | "cerrar") {
    try {
      if (accion === "contener") {
        const nota = await pedirTexto({
          titulo: "Marcar el incidente como contenido",
          confirmar: "Marcar contenido",
          cancelar: "Cancelar",
          campo: { etiqueta: "Cómo se contuvo (opcional)", requerido: false, multilinea: true, maxLength: 300 },
        });
        if (nota === null) return;
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, nota: nota || undefined });
      } else if (accion === "registrar_notificacion") {
        const canal = await pedirTexto({
          titulo: "Registrar la notificación al titular",
          descripcion: "El sistema no envía nada: solo se registra la notificación que ya hiciste.",
          confirmar: "Continuar",
          cancelar: "Cancelar",
          campo: { etiqueta: "Canal por el que SE NOTIFICÓ al titular", maxLength: 80 },
        });
        if (canal === null) return;
        const constancia = await pedirTexto({
          titulo: "Constancia de la notificación",
          confirmar: "Registrar notificación",
          cancelar: "Cancelar",
          campo: { etiqueta: "Constancia o referencia de la notificación", maxLength: 200 },
        });
        if (constancia === null) return;
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, canal, constancia });
      } else {
        const nota = await pedirTexto({
          titulo: "Cerrar el incidente",
          confirmar: "Continuar",
          cancelar: "Cancelar",
          campo: { etiqueta: "Nota de cierre (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
        });
        if (nota === null) return;
        let motivoNoNotificar: string | undefined;
        if (i.riesgoSignificativo && !i.notificacion) {
          const m = await pedirTexto({
            titulo: "Motivo de no notificar",
            descripcion: "Hay riesgo significativo y no se registró la notificación al titular.",
            tono: "danger",
            confirmar: "Cerrar incidente",
            cancelar: "Cancelar",
            campo: { etiqueta: "Motivo de no notificar (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
          });
          if (m === null) return;
          motivoNoNotificar = m;
        }
        await actIncidente(fetch, apiBaseUrl, token, propertyId, i.id, { accion, nota, motivoNoNotificar });
      }
      notify.success("Incidente actualizado.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo actualizar el incidente."));
    }
  }

  const columnas: DataTableColumna<IncidenteSummary>[] = [
    {
      id: "incidente",
      encabezado: "Incidente",
      principal: true,
      celda: (i) => (
        <div className="min-w-0 flex flex-col gap-1">
          <p className="font-medium text-foreground">
            {i.folio} · {i.titulo}
          </p>
          <p className="text-xs text-muted-foreground">
            {INCIDENTE_TIPO_LABELS[i.tipo]} · severidad {i.severidad} · detectado {i.detectadoEn}
            {i.afectados !== null ? ` · ${i.afectados} afectado(s)` : ""}
          </p>
          <p className="text-xs text-muted-foreground">{i.descripcion}</p>
          {i.recordatorio.requerido && (
            <Callout tone="danger" data-testid="recordatorio-notificar" className="p-2 text-xs">
              {i.recordatorio.mensaje} ({etiquetaHoras(i.recordatorio.horasDesdeDeteccion)})
            </Callout>
          )}
          {i.notificacion && (
            <p className="text-xs text-muted-foreground">
              Titular notificado el {i.notificacion.en} por {i.notificacion.canal} (constancia: {i.notificacion.constancia}).
            </p>
          )}
          {i.motivoNoNotificar && <p className="text-xs text-muted-foreground">No se notificó: {i.motivoNoNotificar}</p>}
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", celda: (i) => <StatusBadge tone={i.estado === "cerrada" ? "neutral" : "warning"}>{INCIDENTE_ESTADO_LABELS[i.estado]}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (i) =>
        i.estado !== "cerrada" ? (
          <div className="flex gap-2 flex-wrap">
            {i.estado === "detectada" && (
              <Button type="button" size="sm" variant="outline" onClick={() => void act(i, "contener")}>
                Marcar contenido
              </Button>
            )}
            {!i.notificacion && (
              <Button type="button" size="sm" variant="outline" onClick={() => void act(i, "registrar_notificacion")}>
                Registrar notificación al titular
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => void act(i, "cerrar")}>
              Cerrar incidente
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Registro de vulneraciones de datos. Si afectan de forma significativa derechos patrimoniales o morales, la ley pide notificar al titular de inmediato (art. 19): el sistema solo lo recuerda y lleva el registro; NO envía ninguna notificación.
      </p>
      <div className="flex justify-end">
        <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setReportando(true)}>
          Reportar incidente
        </Button>
      </div>
      {!isAdmin && <p className="text-xs text-muted-foreground">Solo owner/gm ven y gestionan los incidentes reportados.</p>}
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {isAdmin && !data && !error && <EstadoCargando etiqueta="Cargando incidentes…" />}
      {data && !data.disponible && <NoDisponible />}
      {data?.disponible && <DataTable etiqueta="Incidentes" columnas={columnas} filas={data.items} obtenerId={(i) => i.id} vacio={{ mensaje: "No hay incidentes registrados." }} />}

      <FormDialog
        open={reportando}
        onOpenChange={(v) => {
          if (!v && !saving) setReportando(false);
        }}
        titulo="Reportar incidente"
        subtitulo="Avisa también a owner/gm: el sistema no envía notificaciones."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleReport()}
        guardando={saving}
        textoBotonGuardar="Reportar incidente"
        guardarDeshabilitado={titulo.trim().length < 3 || descripcion.trim().length < 10}
        bloquearCierre={saving}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tipo">
            <NativeSelect id="inc-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as IncidenteTipo)}>
              {(Object.keys(INCIDENTE_TIPO_LABELS) as IncidenteTipo[]).map((t) => (
                <option key={t} value={t}>
                  {INCIDENTE_TIPO_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Severidad">
            <NativeSelect id="inc-severidad" value={severidad} onChange={(e) => setSeveridad(e.target.value as IncidenteSeveridad)}>
              <option value="baja">Baja</option>
              <option value="media">Media</option>
              <option value="alta">Alta</option>
            </NativeSelect>
          </FormField>
          <FormField label="Título" required className="sm:col-span-2">
            <Input id="inc-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} minLength={3} maxLength={120} />
          </FormField>
          <FormField label="Qué pasó (10 a 1000 caracteres)" required className="sm:col-span-2">
            <Textarea id="inc-descripcion" rows={3} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} minLength={10} maxLength={1000} />
          </FormField>
          <Checkbox
            wrapperClassName="sm:col-span-2"
            label="Puede afectar de forma significativa derechos patrimoniales o morales del titular (lo decide el hotel con su abogado)"
            checked={riesgo}
            onChange={(e) => setRiesgo(e.target.checked)}
          />
        </div>
      </FormDialog>
      {dialogo}
    </div>
  );
}
