// Panel del despacho para el portal del cliente final (D-08): crear/revocar enlaces, revisar la bandeja de
// documentos (aceptar un CFDI usa la MISMA ingesta que "importar XML"), y responder mensajes. El enlace completo
// solo se muestra al crearlo (la base guarda unicamente su hash): hay que copiarlo y entregarlo al cliente.
// Esta pantalla NO envia correos ni WhatsApp: avisar al cliente es una accion manual del despacho.
import { useCallback, useEffect, useState } from "react";
import { Copy, Download, Link2, Plus } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Textarea, notify, useConfirm } from "@atiende/ui";
import {
  aceptarPortalDocumento,
  crearPortalEnlace,
  descargarPortalDocumento,
  enviarPortalMensajeStaff,
  estadoDocumento,
  estadoEnlace,
  fetchPortalDocumentos,
  fetchPortalEnlaces,
  fetchPortalMensajes,
  rechazarPortalDocumento,
  revocarPortalEnlace,
} from "../lib/portal-cliente-client.ts";
import type { PortalDocumentoStaff, PortalEnlaceStaff, PortalMensajeStaff } from "../lib/portal-cliente-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import { formatDateTime } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const TIPO_ETIQUETA: Readonly<Record<PortalDocumentoStaff["tipo"], string>> = { cfdi_xml: "CFDI (XML)", pdf: "PDF", imagen: "Imagen" };

export function PortalClientePage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = GESTIONAR_ROLES.has(role);
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [enlaces, setEnlaces] = useState<readonly PortalEnlaceStaff[]>([]);
  const [documentos, setDocumentos] = useState<readonly PortalDocumentoStaff[]>([]);
  const [mensajes, setMensajes] = useState<readonly PortalMensajeStaff[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tono: "success" | "danger" | "info"; texto: string } | null>(null);
  const [dialogoEnlace, setDialogoEnlace] = useState(false);
  const [etiqueta, setEtiqueta] = useState("");
  const [dias, setDias] = useState("30");
  const [urlNueva, setUrlNueva] = useState<string | null>(null);
  const [respuesta, setRespuesta] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      // Secuencial: comparten la misma conexion/transaccion del request del servidor.
      const e = await fetchPortalEnlaces(fetch, apiBaseUrl, token, propertyId);
      const d = await fetchPortalDocumentos(fetch, apiBaseUrl, token, propertyId);
      const m = await fetchPortalMensajes(fetch, apiBaseUrl, token, propertyId);
      setDisponible(e.disponible && d.disponible && m.disponible);
      setEnlaces(e.enlaces);
      setDocumentos(d.documentos);
      setMensajes(m.mensajes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el portal del cliente.");
    } finally {
      setCargando(false);
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function accion(fn: () => Promise<string | null>) {
    setOcupado(true);
    setAviso(null);
    try {
      const texto = await fn();
      if (texto) setAviso({ tono: "success", texto });
      await cargar();
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof Error ? err.message : "No se pudo completar la operación." });
    } finally {
      setOcupado(false);
    }
  }

  async function alCrear() {
    setOcupado(true);
    setAviso(null);
    try {
      const r = await crearPortalEnlace(fetch, apiBaseUrl, token, propertyId, etiqueta.trim(), Number(dias));
      setUrlNueva(r.url);
      setEtiqueta("");
      setDialogoEnlace(false);
      notify.success("Enlace creado.");
      await cargar();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo crear el enlace.");
    } finally {
      setOcupado(false);
    }
  }

  async function copiar(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setAviso({ tono: "success", texto: "Enlace copiado." });
    } catch {
      setAviso({ tono: "info", texto: "No se pudo copiar automáticamente: selecciona el enlace y cópialo." });
    }
  }

  async function descargar(d: PortalDocumentoStaff) {
    try {
      const { blob, nombre } = await descargarPortalDocumento(fetch, apiBaseUrl, token, propertyId, d.id, d.nombreArchivo);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof Error ? err.message : "No se pudo descargar el documento." });
    }
  }

  async function revocar(e: PortalEnlaceStaff) {
    const ok = await confirmar({
      titulo: "Revocar enlace",
      descripcion: `El enlace «${e.etiqueta}» dejará de funcionar de inmediato y el cliente ya no podrá entrar con él. No se puede deshacer.`,
      tono: "danger",
      confirmar: "Revocar",
    });
    if (!ok) return;
    await accion(async () => {
      await revocarPortalEnlace(fetch, apiBaseUrl, token, propertyId, e.id);
      return "Enlace revocado.";
    });
  }

  async function aceptar(d: PortalDocumentoStaff) {
    await accion(async () => {
      const r = await aceptarPortalDocumento(fetch, apiBaseUrl, token, propertyId, d.id);
      return r.invoiceId ? "CFDI ingresado. Revisa su validación en CFDI." : "Documento aceptado.";
    });
  }

  async function rechazar(d: PortalDocumentoStaff) {
    const motivo = await pedirTexto({
      titulo: "Rechazar documento",
      descripcion: `«${d.nombreArchivo}» quedará rechazado y el cliente verá el motivo. No se puede deshacer.`,
      tono: "danger",
      confirmar: "Rechazar",
      campo: { etiqueta: "Motivo del rechazo (el cliente lo verá)", multilinea: true, requerido: false, maxLength: 500 },
    });
    if (motivo === null) return;
    await accion(async () => {
      await rechazarPortalDocumento(fetch, apiBaseUrl, token, propertyId, d.id, motivo);
      return "Documento rechazado.";
    });
  }

  async function responder() {
    const cuerpo = respuesta.trim();
    if (!cuerpo) return;
    await accion(async () => {
      await enviarPortalMensajeStaff(fetch, apiBaseUrl, token, propertyId, cuerpo);
      setRespuesta("");
      return null;
    });
  }

  if (cargando) return <EstadoCargando />;
  if (error) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;

  return (
    <PageContainer>
      <PageHeader
        titulo="Portal del cliente"
        descripcion="Comparte un enlace privado para que tu cliente vea el estatus de sus obligaciones, suba CFDI y documentos, y te escriba."
        acciones={
          puedeGestionar && disponible ? (
            <Button size="sm" onClick={() => setDialogoEnlace(true)}>
              <Plus />
              Crear enlace
            </Button>
          ) : undefined
        }
      />

      {!disponible && (
        <Callout tone="warning" titulo="Portal aún no disponible">
          Este ambiente todavía no tiene aplicada la migración del portal del cliente. Puedes ver esta pantalla, pero no crear enlaces.
        </Callout>
      )}
      {aviso && (
        <Callout tone={aviso.tono} onDismiss={() => setAviso(null)}>
          {aviso.texto}
        </Callout>
      )}

      {urlNueva && (
        <Callout tone="info" titulo="Enlace creado: cópialo ahora" icon={<Link2 className="size-4" aria-hidden="true" />}>
          <p className="mb-2">Por seguridad este enlace solo se muestra una vez. Si lo pierdes, revócalo y crea otro.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={urlNueva} aria-label="Enlace del portal" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void copiar(urlNueva)}>
              <Copy aria-hidden="true" /> Copiar
            </Button>
            <Button type="button" variant="ghost" onClick={() => setUrlNueva(null)}>
              Listo
            </Button>
          </div>
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Enlaces del cliente</CardTitle>
          <CardDescription>Cada enlace es privado, expira y se puede revocar en cualquier momento.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {enlaces.length === 0 ? (
            <EstadoVacio compacto mensaje="Aún no has creado enlaces para este cliente." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {enlaces.map((e) => {
                const est = estadoEnlace(e);
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{e.etiqueta}</p>
                      <p className="text-xs text-muted-foreground">
                        Expira el {formatFechaSolo(e.expiraEn.slice(0, 10))} · último acceso: {formatDateTime(e.ultimoUsoEn)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge tone={est.tono}>{est.etiqueta}</StatusBadge>
                      {puedeGestionar && est.etiqueta === "Vigente" && (
                        <Button size="sm" variant="destructive" disabled={ocupado} onClick={() => void revocar(e)}>
                          Revocar
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documentos recibidos</CardTitle>
          <CardDescription>Aceptar un CFDI lo ingresa al flujo normal de CFDI (validación, lista 69-B del SAT y revisión).</CardDescription>
        </CardHeader>
        <CardContent>
          {documentos.length === 0 ? (
            <EstadoVacio compacto mensaje="No hay documentos recibidos." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {documentos.map((d) => {
                const est = estadoDocumento(d.estado);
                return (
                  <li key={d.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{d.nombreArchivo}</p>
                        <p className="text-xs text-muted-foreground">
                          {TIPO_ETIQUETA[d.tipo]} · {Math.max(1, Math.round(d.tamanoBytes / 1024))} KB · {formatDateTime(d.creadoEn)}
                          {d.resumen.folio_fiscal ? ` · UUID ${d.resumen.folio_fiscal.slice(0, 8)}… · total $${d.resumen.total ?? ""}` : ""}
                        </p>
                      </div>
                      <StatusBadge tone={est.tono}>{est.etiqueta}</StatusBadge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void descargar(d)}>
                        <Download aria-hidden="true" /> Descargar
                      </Button>
                      {puedeGestionar && d.estado === "recibido" && (
                        <>
                          <Button size="sm" disabled={ocupado} onClick={() => void aceptar(d)}>
                            Aceptar
                          </Button>
                          <Button size="sm" variant="destructive" disabled={ocupado} onClick={() => void rechazar(d)}>
                            Rechazar
                          </Button>
                        </>
                      )}
                    </div>
                    {d.estado === "rechazado" && d.motivo && <p className="text-xs text-muted-foreground">Motivo: {d.motivo}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mensajes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mensajes.length === 0 && <EstadoVacio compacto mensaje="Aún no hay mensajes." />}
          <ul className="flex flex-col gap-2">
            {mensajes.map((m) => (
              <li key={m.id} className={m.autor === "despacho" ? "self-end rounded-card bg-primary/10 px-3 py-2 text-sm" : "self-start rounded-card bg-muted px-3 py-2 text-sm"}>
                <p className="whitespace-pre-wrap break-words text-foreground">{m.cuerpo}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.autor === "despacho" ? "Despacho" : "Cliente"} · {formatDateTime(m.creadoEn)}
                </p>
              </li>
            ))}
          </ul>
          {puedeGestionar && disponible && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void responder();
              }}
              className="flex flex-col gap-2"
            >
              <FormField label="Responder al cliente">
                <Textarea value={respuesta} onChange={(e) => setRespuesta(e.target.value)} maxLength={2000} rows={3} placeholder="Escribe tu respuesta…" />
              </FormField>
              <Button type="submit" className="self-start" loading={ocupado} disabled={respuesta.trim().length === 0}>
                Enviar respuesta
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={dialogoEnlace}
        onOpenChange={(abierto) => {
          if (!ocupado) setDialogoEnlace(abierto);
        }}
        titulo="Crear enlace del cliente"
        subtitulo="El enlace es privado y expira; solo se muestra completo al crearlo."
        anchoClase="max-w-lg"
        onGuardar={() => void alCrear()}
        guardando={ocupado}
        guardarDeshabilitado={etiqueta.trim().length === 0}
        textoBotonGuardar="Crear enlace"
        bloquearCierre={ocupado}
      >
        <div className="grid gap-3">
          <FormField label="Para quién es" required>
            <Input id="portal-etiqueta" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} maxLength={80} placeholder="Ej. Contacto de administración" />
          </FormField>
          <FormField label="Vigencia">
            <NativeSelect id="portal-dias" value={dias} onChange={(e) => setDias(e.target.value)}>
              <option value="7">7 días</option>
              <option value="30">30 días</option>
              <option value="90">90 días</option>
              <option value="180">180 días</option>
              <option value="365">365 días</option>
            </NativeSelect>
          </FormField>
        </div>
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
