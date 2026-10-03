// PL-31 -- Plantillas de WhatsApp: por evento (recordatorio de cita, lista de espera) el owner/admin registra el nombre que aprobo en Meta
// Business Manager, el idioma, el orden de las variables y su estado. Fuera de las 24 horas del ultimo mensaje del cliente, WhatsApp solo
// entrega una plantilla APROBADA; sin ella el aviso no sale por WhatsApp (se manda por correo si el cliente dejo uno). La aprobacion en Meta es un
// paso externo: aqui solo se registra. Contrato: lib/whatsapp-plantillas-client.ts. El servidor revalida rol y datos (403/400).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FileText } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, StatusBadge, useConfirm } from "@atiende/ui";
import {
  ESTADOS_PLANTILLA,
  ESTADO_PLANTILLA_ETIQUETA,
  eliminarPlantilla,
  fetchPlantillas,
  formDesdePlantilla,
  guardarPlantilla,
} from "../lib/whatsapp-plantillas-client.ts";
import type { EstadoPlantilla, EventoPlantillaWire, FormPlantilla, PlantillasWire } from "../lib/whatsapp-plantillas-client.ts";

const TONO: Readonly<Record<EstadoPlantilla, "neutral" | "info" | "success" | "danger">> = { borrador: "neutral", enviada: "info", aprobada: "success", rechazada: "danger" };

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export interface PlantillasWhatsappProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function PlantillasWhatsappSeccion({ apiBaseUrl, token, propertyId }: PlantillasWhatsappProps) {
  const { confirmar, dialogo } = useConfirm();
  const [datos, setDatos] = useState<PlantillasWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tono: "success" | "danger"; texto: string } | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [editando, setEditando] = useState<EventoPlantillaWire | null>(null);
  const [form, setForm] = useState<FormPlantilla | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const d = await fetchPlantillas(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        if (!Array.isArray(d?.eventos)) throw new Error("La respuesta de plantillas no tiene el formato esperado.");
        setDatos(d);
        setError(null);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudieron cargar las plantillas de WhatsApp."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  function abrir(evento: EventoPlantillaWire) {
    setEditando(evento);
    setForm(formDesdePlantilla(evento.plantilla));
    setErrorForm(null);
  }

  function cerrar() {
    if (guardando) return;
    setEditando(null);
    setForm(null);
    setErrorForm(null);
  }

  function cambiar<K extends keyof FormPlantilla>(campo: K, valor: FormPlantilla[K]) {
    setForm((f) => (f ? { ...f, [campo]: valor } : f));
    setErrorForm(null);
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!editando || !form) return;
    setGuardando(true);
    setErrorForm(null);
    try {
      await guardarPlantilla(fetch, apiBaseUrl, token, propertyId, editando.evento, form);
      setAviso({ tono: "success", texto: `Plantilla de «${editando.etiqueta}» guardada.` });
      setEditando(null);
      setForm(null);
      setRecarga((n) => n + 1);
    } catch (err) {
      setErrorForm(mensaje(err, "No se pudo guardar la plantilla."));
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(evento: EventoPlantillaWire) {
    const ok = await confirmar({
      titulo: "Quitar la plantilla",
      descripcion: `Se quita la plantilla de «${evento.etiqueta}». Fuera de las 24 horas del último mensaje del cliente ese aviso ya no saldrá por WhatsApp (saldrá por correo si el cliente dejó uno).`,
      tono: "danger",
      confirmar: "Quitar plantilla",
    });
    if (!ok) return;
    try {
      await eliminarPlantilla(fetch, apiBaseUrl, token, propertyId, evento.evento);
      setAviso({ tono: "success", texto: `Se quitó la plantilla de «${evento.etiqueta}».` });
      setRecarga((n) => n + 1);
    } catch (err) {
      setAviso({ tono: "danger", texto: mensaje(err, "No se pudo quitar la plantilla.") });
    }
  }

  const editable = Boolean(datos?.disponible);

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileText className="h-4 w-4" strokeWidth={1.75} />
          Plantillas de WhatsApp
        </CardTitle>
        <CardDescription>
          Fuera de las 24 horas del último mensaje del cliente, WhatsApp solo entrega plantillas aprobadas por Meta. Crea y aprueba cada plantilla en el Business Manager de Meta y registra aquí su nombre y el orden de sus variables
          ({"{{1}}"}, {"{{2}}"}…). Mientras no haya una plantilla aprobada, ese aviso no sale por WhatsApp: sale por correo si el cliente dejó uno.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        {aviso && <Callout tone={aviso.tono}>{aviso.texto}</Callout>}
        {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
        {!datos && !error && <EstadoCargando etiqueta="Cargando las plantillas…" />}
        {datos && !datos.disponible && (
          <Callout tone="warning" titulo="Edición todavía no disponible">
            Esta base aún no tiene el catálogo de plantillas (migración pendiente). Mientras tanto los avisos siguen saliendo como siempre.
          </Callout>
        )}
        {datos?.eventos.map((e) => (
          <section key={e.evento} aria-label={e.etiqueta} className="flex flex-col gap-2 rounded-card border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold">{e.etiqueta}</h3>
              {e.plantilla ? <StatusBadge tone={TONO[e.plantilla.estado]}>{ESTADO_PLANTILLA_ETIQUETA[e.plantilla.estado]}</StatusBadge> : <StatusBadge tone="neutral">Sin plantilla</StatusBadge>}
            </div>
            {e.plantilla ? (
              <p className="m-0 text-sm text-muted-foreground">
                <span className="font-mono text-foreground">{e.plantilla.nombre}</span> · {e.plantilla.idioma} · variables: {e.plantilla.variables.length > 0 ? e.plantilla.variables.join(", ") : "ninguna"}
              </p>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">Sin plantilla registrada: fuera de las 24 horas este aviso no sale por WhatsApp.</p>
            )}
            {editable && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => abrir(e)}>
                  {e.plantilla ? "Editar" : "Registrar plantilla"}
                </Button>
                {e.plantilla && (
                  <Button type="button" variant="danger-outline" size="sm" onClick={() => void quitar(e)}>
                    Quitar
                  </Button>
                )}
              </div>
            )}
          </section>
        ))}
      </CardContent>

      <FormDialog
        open={editando !== null}
        onOpenChange={(abierto) => {
          if (!abierto) cerrar();
        }}
        titulo={editando ? `Plantilla: ${editando.etiqueta}` : "Plantilla"}
        subtitulo="Registra la plantilla tal como la aprobó Meta."
        anchoClase="max-w-3xl"
        bloquearCierre={guardando}
        footer={
          <>
            {/* Cancelar NUNCA guarda: solo cierra. */}
            <Button type="button" variant="outline" disabled={guardando} onClick={cerrar}>
              Cancelar
            </Button>
            <Button type="submit" form="citas-plantilla-whatsapp" loading={guardando} disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar plantilla"}
            </Button>
          </>
        }
      >
        {editando && form && (
          <form id="citas-plantilla-whatsapp" onSubmit={(ev) => void guardar(ev)} className="flex flex-col gap-4">
            {errorForm && <Callout tone="danger">{errorForm}</Callout>}
            <FormField label="Nombre de la plantilla en Meta" hint="Minúsculas, dígitos y guion bajo, tal como aparece en el Business Manager.">
              <Input value={form.nombre} required onChange={(ev) => cambiar("nombre", ev.target.value)} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Idioma" hint="Por ejemplo es_MX.">
                <Input value={form.idioma} required onChange={(ev) => cambiar("idioma", ev.target.value)} />
              </FormField>
              <FormField label="Estado en Meta">
                <NativeSelect value={form.estado} onChange={(ev) => cambiar("estado", ev.target.value as EstadoPlantilla)}>
                  {ESTADOS_PLANTILLA.map((s) => (
                    <option key={s} value={s}>
                      {ESTADO_PLANTILLA_ETIQUETA[s]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <FormField label="Variables, en el orden de {{1}}, {{2}}…" hint={`Separadas por comas. Disponibles para este aviso: ${editando.variables.join(", ")}.`}>
              <Input value={form.variables} onChange={(ev) => cambiar("variables", ev.target.value)} />
            </FormField>
            <p className="m-0 text-xs text-muted-foreground">Solo una plantilla en estado «Aprobada» se usa para enviar. Marcarla como aprobada sin que Meta la haya aprobado hace que el envío fracase.</p>
          </form>
        )}
      </FormDialog>
      {dialogo}
    </Card>
  );
}
