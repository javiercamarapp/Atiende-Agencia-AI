// Aviso de privacidad, consentimientos y ventana de bloqueo (H-02). UNI-C gestion: la publicacion del aviso pasa a FormDialog,
// los consentimientos a DataTable y el motivo de revocacion a useConfirm (Cancelar/Escape no revocan). Mismas llamadas.
import { useEffect, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, StatusBadge, Textarea, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchAvisos, fetchConfiguracion, fetchConsentimientos, publishAviso, revokeConsentimiento, saveVentanaBloqueo } from "../../lib/privacidad-client.ts";
import type { AvisoSummary, ConfiguracionPrivacidad, ConsentimientoSummary, Lista } from "../../lib/privacidad-client.ts";
import { ETIQUETA_REVISION_LEGAL, plantillaBaseAviso } from "../../lib/aviso-plantilla-base.ts";
import { NoDisponible, errorMessage, validarNota10 } from "./comun.tsx";
import type { PrivacidadSectionProps } from "./comun.tsx";

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export function AvisoSection({ apiBaseUrl, token, propertyId, isAdmin }: PrivacidadSectionProps) {
  const [avisos, setAvisos] = useState<Lista<AvisoSummary> | null>(null);
  const [consents, setConsents] = useState<Lista<ConsentimientoSummary> | null>(null);
  const [config, setConfig] = useState<ConfiguracionPrivacidad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publicando, setPublicando] = useState(false);
  const [version, setVersion] = useState("");
  const [texto, setTexto] = useState("");
  const [obligatorias, setObligatorias] = useState("");
  const [opcionales, setOpcionales] = useState("");
  const [url, setUrl] = useState("");
  const [dias, setDias] = useState("");
  const [saving, setSaving] = useState(false);
  const [plantillaBaseUsada, setPlantillaBaseUsada] = useState(false);
  const [savingVentana, setSavingVentana] = useState(false);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      const [a, c, cfg] = await Promise.all([
        fetchAvisos(fetch, apiBaseUrl, token, propertyId),
        fetchConsentimientos(fetch, apiBaseUrl, token, propertyId),
        isAdmin ? fetchConfiguracion(fetch, apiBaseUrl, token, propertyId) : Promise.resolve(null),
      ]);
      setAvisos(a);
      setConsents(c);
      setConfig(cfg);
      if (cfg) setDias(String(cfg.ventanaBloqueoDias));
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar el aviso de privacidad."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, isAdmin]);

  /** "Usar plantilla base": SOLO llena el formulario (nada se publica); el hotel la revisa, la ajusta y la publica con el boton de siempre. */
  function usarPlantillaBase() {
    const base = plantillaBaseAviso();
    setTexto(base.textoSimplificado);
    setObligatorias(base.finalidadesObligatorias.join("\n"));
    setOpcionales(base.finalidadesOpcionales.join("\n"));
    setPlantillaBaseUsada(true);
  }

  async function handlePublish() {
    setSaving(true);
    try {
      await publishAviso(fetch, apiBaseUrl, token, propertyId, {
        version,
        textoSimplificado: texto,
        finalidadesObligatorias: lines(obligatorias),
        finalidadesOpcionales: lines(opcionales),
        urlIntegral: url.trim() || undefined,
      });
      notify.success("Aviso publicado como versión vigente.");
      setVersion("");
      setTexto("");
      setObligatorias("");
      setOpcionales("");
      setUrl("");
      setPlantillaBaseUsada(false);
      setPublicando(false);
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo publicar el aviso."));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(c: ConsentimientoSummary) {
    const motivo = await pedirTexto({
      titulo: "Revocar el consentimiento",
      descripcion: "Revocación pedida por el titular. El motivo queda en la bitácora.",
      tono: "danger",
      confirmar: "Revocar",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (mínimo 10 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
    });
    if (motivo === null) return;
    try {
      await revokeConsentimiento(fetch, apiBaseUrl, token, propertyId, c.id, motivo);
      notify.success("Consentimiento revocado.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo revocar el consentimiento."));
    }
  }

  async function handleWindow() {
    setSavingVentana(true);
    try {
      await saveVentanaBloqueo(fetch, apiBaseUrl, token, propertyId, Number(dias));
      notify.success("Ventana de bloqueo actualizada.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo guardar la ventana de bloqueo."));
    } finally {
      setSavingVentana(false);
    }
  }

  const vigente = avisos?.items.find((a) => a.vigente) ?? null;

  const columnas: DataTableColumna<ConsentimientoSummary>[] = [
    {
      id: "consentimiento",
      encabezado: "Consentimiento",
      principal: true,
      celda: (c) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground">
            Aviso {c.versionAviso} · {c.canal} · {c.metodo}
            {c.datosSensibles ? " · datos sensibles (expreso y por escrito)" : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Huésped {c.huespedId} · {c.consentidoEn} · obligatorias: {c.finalidadesObligatorias.join("; ")}
            {c.finalidadesOpcionales.length > 0 ? ` · opcionales: ${c.finalidadesOpcionales.join("; ")}` : ""}
          </p>
          {c.revocadoEn && <p className="mt-0.5 text-xs text-muted-foreground">Revocado: {c.motivoRevocacion}</p>}
        </div>
      ),
    },
    { id: "estado", encabezado: "Estado", celda: (c) => <StatusBadge tone={c.revocadoEn ? "neutral" : "success"}>{c.revocadoEn ? "Revocado" : "Vigente"}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (c) =>
        !c.revocadoEn ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void handleRevoke(c)}>
            Revocar consentimiento
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!avisos && !error && <EstadoCargando etiqueta="Cargando aviso de privacidad…" />}
      {avisos && !avisos.disponible && <NoDisponible />}
      {avisos?.disponible && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-medium text-foreground">Aviso vigente</h2>
              {isAdmin && (
                <Button type="button" size="sm" iconLeft={<Plus className="size-3.5" strokeWidth={1.75} />} onClick={() => {
                    setPlantillaBaseUsada(false);
                    setPublicando(true);
                  }}>
                  Publicar versión nueva
                </Button>
              )}
            </div>
            {vigente ? (
              <div data-testid="aviso-vigente" className="text-xs text-muted-foreground flex flex-col gap-1">
                <p>
                  Versión <strong className="text-foreground">{vigente.version}</strong> · publicado {vigente.publicadoEn}
                </p>
                <p>{vigente.textoSimplificado}</p>
                <p>Obligatorias: {vigente.finalidadesObligatorias.join("; ")}</p>
                <p>Opcionales: {vigente.finalidadesOpcionales.length > 0 ? vigente.finalidadesOpcionales.join("; ") : "ninguna"}</p>
                {vigente.urlIntegral && <p>Aviso integral: {vigente.urlIntegral}</p>}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Todavía no hay un aviso publicado: sin versión vigente no se puede registrar el consentimiento ligado a la captura.</p>
            )}
          </CardContent>
        </Card>
      )}
      {isAdmin && config?.disponible && (
        <Card>
          <CardContent className="p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleWindow();
              }}
              className="flex items-end gap-3 flex-wrap"
              aria-label="Ventana de bloqueo"
            >
              <FormField label="Ventana de bloqueo antes de purgar (días, 3 a 30)">
                <Input id="ventana-dias" type="number" min={3} max={30} step={1} value={dias} onChange={(e) => setDias(e.target.value)} className="w-32" />
              </FormField>
              <Button type="submit" variant="outline" loading={savingVentana}>
                Guardar
              </Button>
              <p className="text-xs text-muted-foreground">
                {config.esDefault ? "Valor por defecto (7 días)." : `Cambiado por ${config.actualizadoPor ?? "—"} el ${config.actualizadoEn ?? "—"}.`} Durante la ventana la identidad no tiene acceso operativo.
              </p>
            </form>
          </CardContent>
        </Card>
      )}
      {consents?.disponible && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">Consentimientos registrados</h2>
          <DataTable etiqueta="Consentimientos" columnas={columnas} filas={consents.items} obtenerId={(c) => c.id} vacio={{ mensaje: "Todavía no hay consentimientos registrados." }} />
        </div>
      )}

      <FormDialog
        open={publicando}
        onOpenChange={(v) => {
          if (!v && !saving) setPublicando(false);
        }}
        titulo="Publicar versión nueva del aviso"
        subtitulo="La versión nueva queda como vigente; las capturas posteriores ligan el consentimiento a ella."
        anchoClase="max-w-3xl"
        onGuardar={() => void handlePublish()}
        guardando={saving}
        textoBotonGuardar="Publicar versión nueva"
        guardarDeshabilitado={version.trim() === "" || texto.trim().length < 20 || lines(obligatorias).length === 0}
        bloquearCierre={saving}
      >
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Button type="button" size="sm" variant="outline" iconLeft={<FileText className="size-3.5" strokeWidth={1.75} />} onClick={usarPlantillaBase}>
            Usar plantilla base
          </Button>
          <StatusBadge tone="warning">{ETIQUETA_REVISION_LEGAL}</StatusBadge>
          <p className="text-xs text-muted-foreground">Declara encargados y transferencias (OpenRouter, Meta/WhatsApp, Google/LiveKit, PAC, Stripe y Resend). No se publica sola.</p>
        </div>
        {plantillaBaseUsada && <Callout tone="warning">La plantilla base es un punto de partida: {ETIQUETA_REVISION_LEGAL.toLowerCase()}. Revísala con tu asesor y ajústala antes de publicar.</Callout>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Versión nueva" required>
            <Input id="aviso-version" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={40} />
          </FormField>
          <FormField label="Enlace al aviso integral (https)">
            <Input id="aviso-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </FormField>
          <FormField label="Aviso simplificado (se muestra en el punto de captura)" required className="sm:col-span-2">
            <Textarea id="aviso-texto" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} minLength={20} maxLength={2000} />
          </FormField>
          <FormField label="Finalidades obligatorias (una por línea)" required>
            <Textarea id="aviso-obligatorias" rows={3} value={obligatorias} onChange={(e) => setObligatorias(e.target.value)} />
          </FormField>
          <FormField label="Finalidades opcionales (una por línea; casilla distinta y sin marcar)">
            <Textarea id="aviso-opcionales" rows={3} value={opcionales} onChange={(e) => setOpcionales(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>
      {dialogo}
    </div>
  );
}
