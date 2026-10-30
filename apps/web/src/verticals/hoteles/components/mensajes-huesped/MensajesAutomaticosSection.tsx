// H-P3-03 -- Mensajeria > "Mensajes automaticos": el huesped se entera de todo el viaje (pre-reserva, reserva, pre-llegada, post-estancia, lista de
// espera) sin que nadie escriba a mano. Cada control llama a un endpoint real (apps/api/.../hoteles/mensajes-huesped.ts, owner/gm): activar o apagar
// un evento, las horas de pre-llegada, el enlace de resena y la plantilla HSM del catalogo de la organizacion. Estados honestos: sin migracion 046
// "no disponible aun"; sin credencial de Meta "requiere credencial de WhatsApp; se enviara por correo". Sin datos inventados.
import { useCallback, useEffect, useState } from "react";
import { BellRing, RefreshCw } from "lucide-react";
import { Button, Callout, Card, CardContent, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, StatusBadge, Switch, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  eliminarPlantillaEvento,
  estadoDeEnvio,
  fetchHistorialMensajes,
  fetchMensajesHuesped,
  guardarConfigEvento,
  guardarPlantillaEvento,
  parsearVariables,
} from "../../lib/mensajes-huesped-client.ts";
import type { EnvioHistorial, EstadoPlantilla, EventoConfig, HistorialMensajes, MensajesHuespedEstado } from "../../lib/mensajes-huesped-client.ts";

const ETIQUETA_ESTADO_PLANTILLA: Readonly<Record<EstadoPlantilla, string>> = { borrador: "Borrador", enviada: "Enviada a Meta", aprobada: "Aprobada", rechazada: "Rechazada" };
const TONO_ESTADO_PLANTILLA: Readonly<Record<EstadoPlantilla, "neutral" | "info" | "success" | "danger">> = { borrador: "neutral", enviada: "info", aprobada: "success", rechazada: "danger" };
const ETIQUETA_CANAL = { whatsapp: "WhatsApp", email: "Correo" } as const;

function mensaje(err: unknown, respaldo: string): string {
  return err instanceof Error ? err.message : respaldo;
}

function fechaHora(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function MensajesAutomaticosSection({ apiBaseUrl, token, propertyId }: Props) {
  const [estado, setEstado] = useState<MensajesHuespedEstado | null>(null);
  const [historial, setHistorial] = useState<HistorialMensajes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [configurando, setConfigurando] = useState<EventoConfig | null>(null);
  const [horas, setHoras] = useState("");
  const [resena, setResena] = useState("");
  const [plantillando, setPlantillando] = useState<EventoConfig | null>(null);
  const [pNombre, setPNombre] = useState("");
  const [pIdioma, setPIdioma] = useState("es_MX");
  const [pEstado, setPEstado] = useState<EstadoPlantilla>("borrador");
  const [pVariables, setPVariables] = useState("");
  const { confirmar, dialogo } = useConfirm();

  const cargar = useCallback(async () => {
    setError(null);
    try {
      // En SECUENCIA no hace falta (son rutas distintas, cada una su propia transaccion), pero el historial depende de que haya estado.
      const [e, h] = await Promise.all([fetchMensajesHuesped(fetch, apiBaseUrl, token, propertyId), fetchHistorialMensajes(fetch, apiBaseUrl, token, propertyId)]);
      setEstado(e);
      setHistorial(h);
    } catch (err) {
      setError(mensaje(err, "No se pudieron cargar los mensajes automáticos."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function correr(clave: string, fn: () => Promise<void>) {
    setOcupado(clave);
    try {
      await fn();
    } catch (err) {
      notify.error(mensaje(err, "No se pudo completar la acción."));
    } finally {
      setOcupado(null);
    }
  }

  function abrirConfig(e: EventoConfig) {
    setHoras(e.horasAntes === null ? "" : String(e.horasAntes));
    setResena(e.resenaUrl ?? "");
    setConfigurando(e);
  }

  function abrirPlantilla(e: EventoConfig) {
    setPNombre(e.plantilla?.nombre ?? "");
    setPIdioma(e.plantilla?.idioma ?? "es_MX");
    setPEstado(e.plantilla?.estado ?? "borrador");
    setPVariables((e.plantilla?.variables ?? e.variables.slice(0, 3)).join(", "));
    setPlantillando(e);
  }

  async function quitarPlantilla(e: EventoConfig) {
    const ok = await confirmar({ titulo: "Quitar la plantilla", descripcion: `«${e.etiqueta}» volverá a salir por correo hasta que registres otra plantilla aprobada.`, tono: "danger", confirmar: "Quitar plantilla", cancelar: "Volver" });
    if (!ok) return;
    await correr("plantilla-quitar", async () => {
      await eliminarPlantillaEvento(fetch, apiBaseUrl, token, propertyId, e.evento);
      notify.success("Plantilla quitada.");
      await cargar();
    });
  }

  if (error && !estado) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void cargar()} />;
  if (!estado) return <EstadoCargando etiqueta="Cargando mensajes automáticos…" />;

  const puede = estado.puedeConfigurar;

  const columnas: DataTableColumna<EventoConfig>[] = [
    {
      id: "evento",
      encabezado: "Evento",
      principal: true,
      celda: (e) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground">{e.etiqueta}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {e.transaccional ? "Responde a algo que el huésped hizo: sale en cuanto hay canal." : "Proactivo: respeta la ventana de envío del hotel."}
            {e.evento === "pre_llegada" && ` ${e.horasAntes ?? estado.horasAntesPorOmision} h antes del check-in.`}
            {e.evento === "post_estancia" && ` El día del check-out, a las ${estado.horaPostEstancia}:00 locales.`}
          </p>
        </div>
      ),
    },
    {
      id: "activo",
      encabezado: "Activo",
      celda: (e) => (
        <Switch
          aria-label={`${e.etiqueta}: activo`}
          checked={e.activo}
          disabled={!puede || ocupado === `activo:${e.evento}`}
          onCheckedChange={(v) =>
            void correr(`activo:${e.evento}`, async () => {
              await guardarConfigEvento(fetch, apiBaseUrl, token, propertyId, e.evento, { activo: v, horasAntes: e.horasAntes, resenaUrl: e.resenaUrl });
              notify.success(v ? "Mensaje activado." : "Mensaje apagado.");
              await cargar();
            })
          }
        />
      ),
    },
    {
      id: "plantilla",
      encabezado: "Plantilla de WhatsApp",
      celda: (e) =>
        e.plantilla ? (
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge tone={TONO_ESTADO_PLANTILLA[e.plantilla.estado]}>{ETIQUETA_ESTADO_PLANTILLA[e.plantilla.estado]}</StatusBadge>
            <span className="text-xs text-muted-foreground">{e.plantilla.nombre}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Sin plantilla: sale por correo</span>
        ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (e) =>
        puede ? (
          <div className="flex items-center gap-2 flex-wrap">
            {(e.evento === "pre_llegada" || e.evento === "post_estancia") && (
              <Button type="button" size="sm" variant="outline" onClick={() => abrirConfig(e)}>
                {e.evento === "pre_llegada" ? "Horas de pre-llegada" : "Enlace de reseña"}
              </Button>
            )}
            {estado.catalogoDisponible && (
              <Button type="button" size="sm" variant="outline" onClick={() => abrirPlantilla(e)}>
                {e.plantilla ? "Cambiar plantilla" : "Elegir plantilla"}
              </Button>
            )}
            {estado.catalogoDisponible && e.plantilla && (
              <Button type="button" size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void quitarPlantilla(e)}>
                Quitar plantilla
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  const columnasHistorial: DataTableColumna<EnvioHistorial>[] = [
    {
      id: "evento",
      encabezado: "Mensaje",
      principal: true,
      celda: (h) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground">{h.etiqueta}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{fechaHora(h.creadoEn)}</p>
        </div>
      ),
    },
    { id: "canal", encabezado: "Canal", celda: (h) => <span className="text-sm text-foreground">{h.canal ? ETIQUETA_CANAL[h.canal] : "—"}</span> },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (h) => {
        const s = estadoDeEnvio(h);
        return (
          <div className="flex flex-col gap-0.5">
            <StatusBadge tone={s.tono}>{s.texto}</StatusBadge>
            {h.motivoTexto && <span className="text-xs text-muted-foreground">{h.motivoTexto}</span>}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <BellRing className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
              Mensajes automáticos
            </p>
            <StatusBadge tone={estado.whatsapp.listo ? "success" : "warning"}>{estado.whatsapp.listo ? "WhatsApp y correo" : "Solo correo"}</StatusBadge>
          </div>
          <p className="text-xs text-muted-foreground">
            El huésped se entera de su pre-reserva, su reserva, su llegada y su salida sin que nadie escriba a mano. Cada mensaje sale por WhatsApp con la plantilla aprobada de tu
            organización (o como texto libre dentro de las 24 h de su último mensaje); si no se puede, por correo; si tampoco hay correo, queda «no enviado» con su motivo en el historial.
          </p>
          {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void cargar()} />}
          {!estado.disponible && <Callout tone="info">No disponible aún: los mensajes automáticos requieren aplicar la migración 046 de hoteles en esta base de datos.</Callout>}
          {estado.disponible && estado.whatsapp.aviso && <Callout tone="warning">{estado.whatsapp.aviso}</Callout>}
          {estado.disponible && !estado.catalogoDisponible && <Callout tone="info">El catálogo de plantillas de WhatsApp aún no está disponible en esta base de datos: todo sale por correo.</Callout>}
          {estado.disponible && !puede && <Callout tone="info">Solo el dueño o la gerencia pueden cambiar estos mensajes.</Callout>}
          {estado.disponible && (
            <DataTable etiqueta="Mensajes automáticos por evento" columnas={columnas} filas={estado.eventos} obtenerId={(e) => e.evento} paginacion={false} vacio={{ mensaje: "No hay eventos configurables." }} />
          )}
        </CardContent>
      </Card>

      {estado.disponible && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-foreground">Historial de envíos</p>
              <Button type="button" size="sm" variant="outline" iconLeft={<RefreshCw className="size-3.5" strokeWidth={1.75} />} onClick={() => void cargar()}>
                Actualizar
              </Button>
            </div>
            {historial && !historial.disponible && <Callout tone="info">No disponible aún: el historial requiere la migración 046 de hoteles.</Callout>}
            {historial?.disponible && (
              <DataTable etiqueta="Historial de mensajes al huésped" columnas={columnasHistorial} filas={historial.envios} obtenerId={(h) => h.id} paginacion={{ tamano: 10 }} vacio={{ mensaje: "Todavía no se ha enviado ningún mensaje automático." }} />
            )}
          </CardContent>
        </Card>
      )}

      <FormDialog
        open={configurando !== null}
        onOpenChange={(v) => {
          if (!v && ocupado === null) setConfigurando(null);
        }}
        titulo={configurando?.evento === "pre_llegada" ? "Horas de pre-llegada" : "Enlace de reseña"}
        subtitulo={configurando?.evento === "pre_llegada" ? `Cuántas horas antes del check-in sale el mensaje (de ${estado.horasAntesMin} a ${estado.horasAntesMax}; por omisión ${estado.horasAntesPorOmision}).` : "Se agrega al agradecimiento del día del check-out. Debe ser un enlace https."}
        onGuardar={() => {
          const e = configurando;
          if (!e) return;
          void correr("config", async () => {
            const entrada =
              e.evento === "pre_llegada"
                ? { activo: e.activo, horasAntes: horas.trim() === "" ? null : Number(horas), resenaUrl: null }
                : { activo: e.activo, horasAntes: null, resenaUrl: resena.trim() === "" ? null : resena.trim() };
            await guardarConfigEvento(fetch, apiBaseUrl, token, propertyId, e.evento, entrada);
            notify.success("Configuración guardada.");
            setConfigurando(null);
            await cargar();
          });
        }}
        guardando={ocupado === "config"}
        textoBotonGuardar="Guardar"
        guardarDeshabilitado={
          configurando?.evento === "pre_llegada"
            ? horas.trim() !== "" && !(Number.isInteger(Number(horas)) && Number(horas) >= estado.horasAntesMin && Number(horas) <= estado.horasAntesMax)
            : resena.trim() !== "" && !/^https:\/\/\S+$/u.test(resena.trim())
        }
        bloquearCierre={ocupado === "config"}
      >
        {configurando?.evento === "pre_llegada" ? (
          <FormField label="Horas antes del check-in" hint={`De ${estado.horasAntesMin} a ${estado.horasAntesMax}. Vacío = ${estado.horasAntesPorOmision} h.`}>
            <Input id="mh-horas" inputMode="numeric" value={horas} maxLength={3} onChange={(e) => setHoras(e.target.value.replace(/\D/gu, ""))} />
          </FormField>
        ) : (
          <FormField label="Enlace de reseña (https)" hint="Vacío = el agradecimiento sale sin enlace.">
            <Input id="mh-resena" value={resena} maxLength={500} placeholder="https://" onChange={(e) => setResena(e.target.value)} />
          </FormField>
        )}
      </FormDialog>

      <FormDialog
        open={plantillando !== null}
        onOpenChange={(v) => {
          if (!v && ocupado === null) setPlantillando(null);
        }}
        titulo={plantillando ? `Plantilla de WhatsApp: ${plantillando.etiqueta}` : "Plantilla de WhatsApp"}
        subtitulo="Registra aquí el nombre de la plantilla que ya aprobó Meta en tu Business Manager y el orden de sus variables {{1}}, {{2}}... Solo una plantilla aprobada se usa para enviar."
        anchoClase="max-w-2xl"
        onGuardar={() => {
          const e = plantillando;
          if (!e) return;
          void correr("plantilla", async () => {
            await guardarPlantillaEvento(fetch, apiBaseUrl, token, propertyId, e.evento, { nombre: pNombre.trim(), idioma: pIdioma.trim(), variables: parsearVariables(pVariables), estado: pEstado });
            notify.success("Plantilla guardada.");
            setPlantillando(null);
            await cargar();
          });
        }}
        guardando={ocupado === "plantilla"}
        textoBotonGuardar="Guardar plantilla"
        guardarDeshabilitado={!/^[a-z0-9_]{1,512}$/u.test(pNombre.trim()) || !/^[a-z]{2,3}(_[A-Z]{2})?$/u.test(pIdioma.trim())}
        bloquearCierre={ocupado === "plantilla"}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Nombre en Meta" hint="Minúsculas, dígitos y guion bajo" required>
            <Input id="mh-p-nombre" value={pNombre} maxLength={512} onChange={(e) => setPNombre(e.target.value)} />
          </FormField>
          <FormField label="Idioma" hint="Por ejemplo es_MX" required>
            <Input id="mh-p-idioma" value={pIdioma} maxLength={10} onChange={(e) => setPIdioma(e.target.value)} />
          </FormField>
          <FormField label="Estado en Meta">
            <NativeSelect id="mh-p-estado" value={pEstado} onChange={(e) => setPEstado(e.target.value as EstadoPlantilla)}>
              {estado.estadosPlantilla.map((s) => (
                <option key={s} value={s}>
                  {ETIQUETA_ESTADO_PLANTILLA[s]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Variables, en orden" hint={plantillando ? `Disponibles: ${plantillando.variables.join(", ")}` : undefined}>
            <Input id="mh-p-variables" value={pVariables} onChange={(e) => setPVariables(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>
      {dialogo}
    </>
  );
}
