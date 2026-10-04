// ARCO con plazos (H-02/H-30). UNI-C gestion: el registro de una solicitud y el enlace "Mis datos" pasan a FormDialog, la lista
// a DataTable y las notas que pedian `window.prompt` a useConfirm (Cancelar/Escape nunca avanzan la solicitud). Mismas llamadas.
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Callout, Checkbox, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, StatusBadge, notify, statusTone, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ARCO_CANALES_STAFF,
  ARCO_CANAL_LABELS,
  ARCO_DERECHO_LABELS,
  ARCO_ESTADO_LABELS,
  PLAZO_ESTADO_LABELS,
  advanceArco,
  extendArco,
  fetchArco,
  issueEnlaceMisDatos,
  openArco,
  textoPlazo,
} from "../../lib/privacidad-client.ts";
import type { ArcoCanalStaff, ArcoDerecho, ArcoSummary, Lista } from "../../lib/privacidad-client.ts";
import { buscarHuespedes } from "../../lib/huespedes-client.ts";
import type { GuestOption } from "../../lib/huespedes-client.ts";
import { ARCO_PLAZO_TONES } from "../../lib/status-tones.ts";
import { fechaHoraEsMx } from "../../../../lib/formato-fecha.ts";
import { NoDisponible, errorMessage, validarNota10 } from "./comun.tsx";
import type { PrivacidadSectionProps } from "./comun.tsx";

export function ArcoSection({ apiBaseUrl, token, propertyId, isAdmin }: PrivacidadSectionProps) {
  const [data, setData] = useState<(Lista<ArcoSummary> & { hoy: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registrando, setRegistrando] = useState(false);
  const [derecho, setDerecho] = useState<ArcoDerecho>("acceso");
  const [solicitante, setSolicitante] = useState("");
  const [canal, setCanal] = useState<ArcoCanalStaff>("mostrador");
  const [contacto, setContacto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [saving, setSaving] = useState(false);
  const [enlaceDe, setEnlaceDe] = useState<ArcoSummary | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      setData(await fetchArco(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudieron cargar las solicitudes ARCO."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleOpen() {
    setSaving(true);
    try {
      await openArco(fetch, apiBaseUrl, token, propertyId, { derecho, solicitante, canal, contacto: contacto.trim() || undefined, descripcion: descripcion.trim() || undefined });
      notify.success("Solicitud ARCO registrada; el plazo de respuesta ya corre.");
      setSolicitante("");
      setContacto("");
      setDescripcion("");
      setRegistrando(false);
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo registrar la solicitud."));
    } finally {
      setSaving(false);
    }
  }

  async function handleAdvance(a: ArcoSummary, estado: "en_revision" | "procedente" | "improcedente" | "ejecutada") {
    const nota = await pedirTexto({
      titulo: `Pasar la solicitud a «${ARCO_ESTADO_LABELS[estado]}»`,
      descripcion: `${a.folio}. La nota queda en la bitácora.`,
      tono: estado === "improcedente" ? "danger" : "default",
      confirmar: ARCO_ESTADO_LABELS[estado],
      cancelar: "Cancelar",
      campo: { etiqueta: "Nota (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
    });
    if (nota === null) return;
    try {
      await advanceArco(fetch, apiBaseUrl, token, propertyId, a.id, estado, nota);
      notify.success(`Solicitud ${ARCO_ESTADO_LABELS[estado].toLowerCase()}.`);
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo actualizar la solicitud."));
    }
  }

  async function handleExtend(a: ArcoSummary) {
    const motivo = await pedirTexto({
      titulo: "Prórroga de la solicitud",
      descripcion: `+${a.prorrogaDisponible.dias} días; solo se puede usar una vez.`,
      confirmar: "Registrar prórroga",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo documentado", multilinea: true, minLength: 10, maxLength: 300, validar: validarNota10 },
    });
    if (motivo === null) return;
    try {
      await extendArco(fetch, apiBaseUrl, token, propertyId, a.id, motivo);
      notify.success("Prórroga registrada.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo registrar la prórroga."));
    }
  }

  const columnas: DataTableColumna<ArcoSummary>[] = [
    {
      id: "solicitud",
      encabezado: "Solicitud",
      principal: true,
      celda: (a) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {a.folio} · {ARCO_DERECHO_LABELS[a.derecho]} · {a.solicitante}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="plazo-arco">
            {textoPlazo(a.plazo)} · recibida {a.recibidaEn} por {ARCO_CANAL_LABELS[a.canal]}
          </p>
          {a.descripcion && <p className="mt-0.5 text-xs text-muted-foreground">{a.descripcion}</p>}
          {a.notaDecision && <p className="mt-0.5 text-xs text-muted-foreground">Última nota: {a.notaDecision}</p>}
          {a.prorroga && <p className="mt-0.5 text-xs text-muted-foreground">Prórroga de {a.prorroga.fase}: {a.prorroga.motivo}</p>}
        </div>
      ),
    },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (a) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge tone="neutral" dot={false}>{ARCO_ESTADO_LABELS[a.estado]}</StatusBadge>
          <StatusBadge tone={statusTone(ARCO_PLAZO_TONES, a.plazo.estado)}>{PLAZO_ESTADO_LABELS[a.plazo.estado]}</StatusBadge>
        </div>
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (a) => (
        <div className="flex gap-2 flex-wrap">
          {a.estado === "recibida" && (
            <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "en_revision")}>
              Pasar a revisión
            </Button>
          )}
          {(a.estado === "recibida" || a.estado === "en_revision") && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "procedente")}>
                Procedente
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleAdvance(a, "improcedente")}>
                Improcedente
              </Button>
            </>
          )}
          {a.estado === "procedente" && (
            <Button type="button" size="sm" onClick={() => void handleAdvance(a, "ejecutada")}>
              Marcar ejecutada
            </Button>
          )}
          {isAdmin && a.derecho === "acceso" && (a.estado === "procedente" || a.estado === "ejecutada") && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEnlaceDe(a)}>
              Enlace «Mis datos»
            </Button>
          )}
          {a.prorrogaDisponible.disponible && (
            <Button type="button" size="sm" variant="outline" onClick={() => void handleExtend(a)}>
              Prórroga (+{a.prorrogaDisponible.dias} d)
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Plazos (días naturales; un abogado debe confirmar el cómputo): 20 días para responder y 15 para ejecutar; una prórroga por igual plazo, una sola vez y con motivo. Una cancelación procedente bloquea la identidad ligada; la supresión pasa por la ventana de bloqueo y no ocurre si hay retención legal.
      </p>
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando solicitudes ARCO…" />}
      {data && !data.disponible && <NoDisponible />}
      {data?.disponible && (
        <>
          <div className="flex justify-end">
            <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setRegistrando(true)}>
              Registrar solicitud
            </Button>
          </div>
          <DataTable etiqueta="Solicitudes ARCO" columnas={columnas} filas={data.items} obtenerId={(a) => a.id} vacio={{ mensaje: "No hay solicitudes ARCO registradas." }} />
        </>
      )}

      <FormDialog
        open={registrando}
        onOpenChange={(v) => {
          if (!v && !saving) setRegistrando(false);
        }}
        titulo="Registrar solicitud ARCO"
        subtitulo="El plazo de respuesta corre desde el registro."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleOpen()}
        guardando={saving}
        textoBotonGuardar="Registrar solicitud"
        guardarDeshabilitado={solicitante.trim().length < 2}
        bloquearCierre={saving}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Derecho">
            <NativeSelect id="arco-derecho" value={derecho} onChange={(e) => setDerecho(e.target.value as ArcoDerecho)}>
              {(Object.keys(ARCO_DERECHO_LABELS) as ArcoDerecho[]).map((d) => (
                <option key={d} value={d}>
                  {ARCO_DERECHO_LABELS[d]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Canal de recepción">
            <NativeSelect id="arco-canal" value={canal} onChange={(e) => setCanal(e.target.value as ArcoCanalStaff)}>
              {ARCO_CANALES_STAFF.map((c) => (
                <option key={c} value={c}>
                  {ARCO_CANAL_LABELS[c]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Titular que solicita" required>
            <Input id="arco-solicitante" value={solicitante} onChange={(e) => setSolicitante(e.target.value)} minLength={2} />
          </FormField>
          <FormField label="Contacto (opcional)">
            <Input id="arco-contacto" value={contacto} onChange={(e) => setContacto(e.target.value)} />
          </FormField>
          <FormField label="Descripción (opcional)" className="sm:col-span-2">
            <Input id="arco-descripcion" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>

      {enlaceDe && <EnlaceMisDatosDialog apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} arco={enlaceDe} onClose={() => setEnlaceDe(null)} />}
      {dialogo}
    </div>
  );
}

/** H-30 -- emite el enlace "Mis datos" (derecho de acceso) de una solicitud procedente: el titular lo abre sin sesion. */
function EnlaceMisDatosDialog({ apiBaseUrl, token, propertyId, arco, onClose }: { apiBaseUrl: string; token: string; propertyId: string; arco: ArcoSummary; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [huespedes, setHuespedes] = useState<readonly GuestOption[]>([]);
  const [huespedId, setHuespedId] = useState(arco.huespedId ?? "");
  const [enviarCorreo, setEnviarCorreo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<Awaited<ReturnType<typeof issueEnlaceMisDatos>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tieneCorreo = Boolean(arco.contacto && arco.contacto.includes("@"));

  useEffect(() => {
    if (arco.huespedId) return;
    let cancelado = false;
    const t = setTimeout(() => {
      buscarHuespedes(fetch, apiBaseUrl, token, propertyId, q.trim() || undefined)
        .then((r) => !cancelado && setHuespedes(r))
        .catch((err) => !cancelado && setError(errorMessage(err, "No se pudo buscar el huésped.")));
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [apiBaseUrl, token, propertyId, q, arco.huespedId]);

  async function generar() {
    setBusy(true);
    setError(null);
    try {
      setResultado(await issueEnlaceMisDatos(fetch, apiBaseUrl, token, propertyId, arco.id, huespedId, enviarCorreo && tieneCorreo));
    } catch (err) {
      setError(errorMessage(err, "No se pudo generar el enlace."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      titulo="Enlace «Mis datos»"
      subtitulo={`${arco.folio}. El titular verá solo su perfil, estancias, consentimientos y el estado de su identidad (nunca el documento ni las notas internas). El enlace vence en 24 horas y deja de funcionar si la solicitud deja de estar procedente.`}
      anchoClase="max-w-3xl"
      onGuardar={() => void generar()}
      guardando={busy}
      textoBotonGuardar="Generar enlace"
      guardarDeshabilitado={huespedId === ""}
      bloquearCierre={busy}
    >
      <div className="flex flex-col gap-3">
        {!arco.huespedId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Buscar huésped">
              <Input id={`mis-datos-q-${arco.id}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre, correo o teléfono" />
            </FormField>
            <FormField label="Huésped titular" required>
              <NativeSelect id={`mis-datos-h-${arco.id}`} value={huespedId} onChange={(e) => setHuespedId(e.target.value)}>
                <option value="">Selecciona…</option>
                {huespedes.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.nombreCompleto}
                    {g.email ? ` · ${g.email}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
        )}
        <Checkbox
          id={`mis-datos-c-${arco.id}`}
          label={tieneCorreo ? "Enviar el enlace al correo del titular" : "El titular no dejó un correo: copia el enlace y entrégalo por otro medio"}
          checked={enviarCorreo && tieneCorreo}
          disabled={!tieneCorreo}
          onChange={(e) => setEnviarCorreo(e.target.checked)}
        />
        {error && <Callout tone="danger">{error}</Callout>}
        {resultado && (
          <div className="flex flex-col gap-1" data-testid="enlace-mis-datos-resultado">
            <FormField label={`Enlace para el titular (vence ${fechaHoraEsMx(resultado.venceEn)})`}>
              <div className="flex gap-2">
                <Input id={`mis-datos-url-${arco.id}`} value={resultado.enlace} readOnly onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(resultado.enlace).then(() => notify.success("Enlace copiado."))}>
                  Copiar
                </Button>
              </div>
            </FormField>
            <p className="text-xs text-muted-foreground">
              {resultado.correo === "encolado" && resultado.envioDeCorreo === "habilitado" && "El correo se envió o está por enviarse al titular."}
              {resultado.correo === "encolado" && resultado.envioDeCorreo === "pendiente_de_configuracion" && "El correo quedó en la cola, pero NO saldrá hasta que se configure el envío de correo (Resend). Copia el enlace y entrégalo por otro medio."}
              {resultado.correo === "sin_correo" && "El titular no dejó un correo: entrega el enlace por otro medio."}
              {resultado.correo === "omitido" && "No se envió correo (no se pidió o la cola no está disponible): entrega el enlace por otro medio."}
            </p>
          </div>
        )}
      </div>
    </FormDialog>
  );
}
