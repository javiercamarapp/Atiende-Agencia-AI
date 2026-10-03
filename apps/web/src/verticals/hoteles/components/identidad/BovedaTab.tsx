// Pestana "Boveda" de Identidad (UNI-C gestion: extraida de Identidad.tsx). Lista de metadatos con DataTable; las acciones
// que pedian `window.prompt` ahora usan useConfirm (Cancelar/Escape NUNCA llaman a la API) y el feedback va por notify.
// Reglas (el servidor es la barrera real): el documento completo solo aparece tras "Revelar" (motivo obligatorio, queda en la
// bitacora) y se descarta con "Ocultar"; vive solo en estado local.
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, DataTable, EstadoCargando, EstadoError, EstadoVacio, StatusBadge, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { DOCUMENT_TYPE_LABELS, MOTIVO_BLOQUEO_LABELS, fetchIdentidades, requestPurga, revealIdentidad, verifyIdentidad } from "../../lib/identidad-client.ts";
import type { DocumentoRevelado, IdentidadList, IdentidadSummary } from "../../lib/identidad-client.ts";
import { blockIdentidad, placeRetencion, requestAccesoExcepcional } from "../../lib/privacidad-client.ts";
import { CapturaIdentidadDialog } from "./CapturaIdentidadDialog.tsx";
import { errorMessage, validarMotivoMin } from "./comun.ts";
import type { TabProps } from "./comun.ts";

export function BovedaTab({ apiBaseUrl, token, propertyId, canReveal, isAdmin }: TabProps & { canReveal: boolean; isAdmin: boolean }) {
  const [list, setList] = useState<IdentidadList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ readonly id: string; readonly doc: DocumentoRevelado } | null>(null);
  const [capturando, setCapturando] = useState(false);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      setList(await fetchIdentidades(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar la bóveda de identidad."));
    }
  }
  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleReveal(item: IdentidadSummary) {
    const motivo = await pedirTexto({
      titulo: "Revelar el documento completo",
      descripcion: "El motivo queda en la bitácora.",
      confirmar: "Revelar",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (mínimo 10 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarMotivoMin },
    });
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      setRevealed({ id: item.id, doc: await revealIdentidad(fetch, apiBaseUrl, token, propertyId, item.id, motivo) });
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo revelar el documento."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerify(item: IdentidadSummary) {
    setBusyId(item.id);
    try {
      await verifyIdentidad(fetch, apiBaseUrl, token, propertyId, item.id);
      notify.success("Identidad verificada.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo verificar la identidad."));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurgeRequest(item: IdentidadSummary) {
    const motivo = await pedirTexto({
      titulo: "Solicitar la purga de la identidad",
      descripcion: "Otra persona con rol owner/gm deberá aprobarla (doble control).",
      tono: "danger",
      confirmar: "Solicitar purga",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (mínimo 10 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarMotivoMin },
    });
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await requestPurga(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      notify.success("Solicitud de purga creada; falta la aprobación de otra persona (al aprobarla, la identidad se bloquea antes de purgarse).");
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo solicitar la purga."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleBlock(item: IdentidadSummary) {
    const motivo = await pedirTexto({
      titulo: "Bloquear la identidad",
      descripcion: "La identidad pierde el acceso operativo y se purgará al vencer la ventana, salvo retención legal.",
      tono: "danger",
      confirmar: "Bloquear",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (mínimo 10 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarMotivoMin },
    });
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await blockIdentidad(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      notify.success("Identidad bloqueada.");
      await load();
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo bloquear la identidad."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleHold(item: IdentidadSummary) {
    const folio = await pedirTexto({
      titulo: "Retención legal: folio del caso",
      descripcion: "Carpeta de investigación, expediente o folio de incidente.",
      confirmar: "Continuar",
      cancelar: "Cancelar",
      campo: { etiqueta: "Folio del caso", maxLength: 80 },
    });
    if (folio === null) return;
    const motivo = await pedirTexto({
      titulo: "Retención legal: motivo",
      descripcion: "Impide la purga mientras dure el caso.",
      confirmar: "Continuar",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarMotivoMin },
    });
    if (motivo === null) return;
    const autorizacion = await pedirTexto({
      titulo: "Retención legal: quién la autoriza",
      descripcion: "Oficio, área jurídica o dirección.",
      confirmar: "Aplicar retención",
      cancelar: "Cancelar",
      campo: { etiqueta: "Quién autoriza", maxLength: 120 },
    });
    if (autorizacion === null) return;
    setBusyId(item.id);
    try {
      await placeRetencion(fetch, apiBaseUrl, token, propertyId, item.id, { folio, motivo, autorizacion });
      notify.success("Retención legal aplicada: la identidad no se purgará mientras dure el caso.");
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo aplicar la retención legal."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleExceptionalAccess(item: IdentidadSummary) {
    const motivo = await pedirTexto({
      titulo: "Solicitar acceso excepcional",
      descripcion: "Otra persona con rol owner/gm deberá aprobarlo (doble control).",
      confirmar: "Solicitar acceso",
      cancelar: "Cancelar",
      campo: { etiqueta: "Motivo (10 a 300 caracteres)", multilinea: true, minLength: 10, maxLength: 300, validar: validarMotivoMin },
    });
    if (motivo === null) return;
    setBusyId(item.id);
    try {
      await requestAccesoExcepcional(fetch, apiBaseUrl, token, propertyId, item.id, motivo);
      notify.success("Acceso excepcional solicitado; falta la aprobación de otra persona (pestaña Privacidad > Retención y bloqueo).");
    } catch (err) {
      notify.error(errorMessage(err, "No se pudo solicitar el acceso excepcional."));
    } finally {
      setBusyId(null);
    }
  }

  const columnas: DataTableColumna<IdentidadSummary>[] = [
    {
      id: "documento",
      encabezado: "Documento",
      principal: true,
      celda: (it) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {DOCUMENT_TYPE_LABELS[it.tipoDocumento]} {it.ultimos4 ? `****${it.ultimos4}` : ""} {it.nacionalidad ? `· ${it.nacionalidad}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Huésped: {it.huespedId} · Retención hasta {it.retencionHasta} · {it.verificadaEn ? "Verificada" : "Sin verificar"}
          </p>
          {it.estado === "bloqueada" && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="identidad-bloqueada">
              Bloqueada{it.motivoBloqueo ? ` (${MOTIVO_BLOQUEO_LABELS[it.motivoBloqueo]})` : ""}: sin acceso operativo; se purgará después del {it.bloqueadaHasta ?? "fin de la ventana"}, salvo retención legal. Solo hay acceso excepcional con doble control.
            </p>
          )}
        </div>
      ),
    },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (it) => <StatusBadge tone={it.estado === "activo" ? "success" : "neutral"}>{it.estado === "activo" ? "Activa" : it.estado === "bloqueada" ? "Bloqueada" : "Purgada"}</StatusBadge>,
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (it) => (
        <div className="flex gap-2 flex-wrap">
          {it.estado === "bloqueada" && isAdmin && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleExceptionalAccess(it)} disabled={busyId === it.id}>
                Acceso excepcional
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleHold(it)} disabled={busyId === it.id}>
                Retención legal
              </Button>
            </>
          )}
          {it.estado === "activo" && (
            <>
              {canReveal && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleReveal(it)} disabled={busyId === it.id}>
                  Revelar
                </Button>
              )}
              {canReveal && !it.verificadaEn && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleVerify(it)} disabled={busyId === it.id}>
                  Marcar verificada
                </Button>
              )}
              {isAdmin && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleHold(it)} disabled={busyId === it.id}>
                  Retención legal
                </Button>
              )}
              {isAdmin && (
                <Button type="button" size="sm" variant="outline" onClick={() => void handleBlock(it)} disabled={busyId === it.id}>
                  Bloquear
                </Button>
              )}
              {isAdmin && (
                <Button type="button" size="sm" variant="destructive" onClick={() => void handlePurgeRequest(it)} disabled={busyId === it.id}>
                  Solicitar purga
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  const puedeCapturar = list !== null && list.disponible && list.llaveConfigurada;

  return (
    <div className="flex flex-col gap-3">
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!list && !error && <EstadoCargando etiqueta="Cargando identidades…" />}
      {list && !list.disponible && <EstadoVacio mensaje="La bóveda de identidad aún no está disponible en esta base (migración pendiente de aplicar)." />}
      {list && list.disponible && !list.llaveConfigurada && (
        <EstadoError titulo="Falta la llave de cifrado" mensaje="No se pueden capturar ni revelar documentos hasta configurar HOTELES_IDENTITY_KEY en la API. Nada se guarda sin cifrar." />
      )}
      {puedeCapturar && (
        <div className="flex justify-end">
          <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setCapturando(true)}>
            Capturar identidad
          </Button>
        </div>
      )}

      {revealed && (
        <Card>
          <CardContent className="p-3 text-sm flex flex-col gap-1" data-testid="documento-revelado">
            <Callout tone="warning" titulo="Documento revelado">Se descarta al ocultarlo o al cambiar de pestaña.</Callout>
            <p>
              <span className="text-muted-foreground">Nombre:</span> {revealed.doc.nombreCompleto}
            </p>
            <p>
              <span className="text-muted-foreground">Documento:</span> {revealed.doc.numeroDocumento}
            </p>
            {revealed.doc.fechaNacimiento && (
              <p>
                <span className="text-muted-foreground">Nacimiento:</span> {revealed.doc.fechaNacimiento}
              </p>
            )}
            {revealed.doc.vigenciaHasta && (
              <p>
                <span className="text-muted-foreground">Vigencia:</span> {revealed.doc.vigenciaHasta}
              </p>
            )}
            {revealed.doc.mrz && <pre className="text-xs whitespace-pre-wrap">{revealed.doc.mrz}</pre>}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(null)}>
                Ocultar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {list && list.disponible && (
        <DataTable
          etiqueta="Identidades"
          columnas={columnas}
          filas={list.items}
          obtenerId={(it) => it.id}
          vacio={{ mensaje: "Todavía no hay identidades capturadas en este hotel." }}
        />
      )}

      {puedeCapturar && <CapturaIdentidadDialog apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} open={capturando} onClose={() => setCapturando(false)} onCaptured={() => void load()} />}
      {dialogo}
    </div>
  );
}
