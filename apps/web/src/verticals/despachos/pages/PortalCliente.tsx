// Panel del despacho para el portal del cliente final (D-08): crear/revocar enlaces, revisar la bandeja de
// documentos (aceptar un CFDI usa la MISMA ingesta que "importar XML"), y responder mensajes. El enlace completo
// solo se muestra al crearlo (la base guarda unicamente su hash): hay que copiarlo y entregarlo al cliente.
// Esta pantalla NO envia correos ni WhatsApp: avisar al cliente es una accion manual del despacho.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Copy, Download, Link2 } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, Input, Label, NativeSelect, PageContainer, StatusBadge, Textarea } from "@atiende/ui";
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
import type { DataTableColumna } from "@atiende/ui";
import type { PortalDocumentoStaff, PortalEnlaceStaff, PortalMensajeStaff } from "../lib/portal-cliente-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

function fechaHora(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });
}

const TIPO_ETIQUETA: Readonly<Record<PortalDocumentoStaff["tipo"], string>> = { cfdi_xml: "CFDI (XML)", pdf: "PDF", imagen: "Imagen" };

export function PortalClientePage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = GESTIONAR_ROLES.has(role);
  const [enlaces, setEnlaces] = useState<readonly PortalEnlaceStaff[]>([]);
  const [documentos, setDocumentos] = useState<readonly PortalDocumentoStaff[]>([]);
  const [mensajes, setMensajes] = useState<readonly PortalMensajeStaff[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tono: "success" | "danger" | "info"; texto: string } | null>(null);
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

  async function alCrear(e: FormEvent) {
    e.preventDefault();
    await accion(async () => {
      const r = await crearPortalEnlace(fetch, apiBaseUrl, token, propertyId, etiqueta.trim(), Number(dias));
      setUrlNueva(r.url);
      setEtiqueta("");
      return null;
    });
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

  async function rechazar(d: PortalDocumentoStaff) {
    const motivo = window.prompt("Motivo del rechazo (el cliente lo verá):", "") ?? null;
    if (motivo === null) return;
    await accion(async () => {
      await rechazarPortalDocumento(fetch, apiBaseUrl, token, propertyId, d.id, motivo);
      return "Documento rechazado.";
    });
  }

  async function responder(e: FormEvent) {
    e.preventDefault();
    const cuerpo = respuesta.trim();
    if (!cuerpo) return;
    await accion(async () => {
      await enviarPortalMensajeStaff(fetch, apiBaseUrl, token, propertyId, cuerpo);
      setRespuesta("");
      return null;
    });
  }

  const columnasEnlaces: DataTableColumna<PortalEnlaceStaff>[] = [
    { id: "etiqueta", encabezado: "Para quién", principal: true, valorOrden: (e) => e.etiqueta, celda: (e) => <span className="font-medium text-foreground">{e.etiqueta}</span> },
    { id: "expira", encabezado: "Expira", valorOrden: (e) => e.expiraEn, celda: (e) => formatFechaSolo(e.expiraEn.slice(0, 10)) },
    { id: "ultimoUso", encabezado: "Último acceso", valorOrden: (e) => e.ultimoUsoEn, celda: (e) => fechaHora(e.ultimoUsoEn) },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (e) => estadoEnlace(e).etiqueta,
      celda: (e) => {
        const est = estadoEnlace(e);
        return <StatusBadge tone={est.tono}>{est.etiqueta}</StatusBadge>;
      },
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (e) =>
        puedeGestionar && estadoEnlace(e).etiqueta === "Vigente" ? (
          <Button size="sm" variant="outline" disabled={ocupado} onClick={() => void accion(async () => { await revocarPortalEnlace(fetch, apiBaseUrl, token, propertyId, e.id); return "Enlace revocado."; })}>Revocar</Button>
        ) : null,
    },
  ];

  const columnasDocumentos: DataTableColumna<PortalDocumentoStaff>[] = [
    {
      id: "archivo",
      encabezado: "Archivo",
      principal: true,
      valorOrden: (d) => d.nombreArchivo,
      celda: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{d.nombreArchivo}</p>
          {d.resumen.folio_fiscal ? <p className="text-xs text-muted-foreground">UUID {d.resumen.folio_fiscal.slice(0, 8)}… · total ${d.resumen.total ?? ""}</p> : null}
        </div>
      ),
    },
    { id: "tipo", encabezado: "Tipo", valorOrden: (d) => TIPO_ETIQUETA[d.tipo], celda: (d) => TIPO_ETIQUETA[d.tipo] },
    { id: "tamano", encabezado: "Tamaño", alinear: "right", valorOrden: (d) => d.tamanoBytes, celda: (d) => `${Math.max(1, Math.round(d.tamanoBytes / 1024))} KB` },
    { id: "recibido", encabezado: "Recibido", valorOrden: (d) => d.creadoEn, celda: (d) => fechaHora(d.creadoEn) },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (d) => estadoDocumento(d.estado).etiqueta,
      celda: (d) => {
        const est = estadoDocumento(d.estado);
        return (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge tone={est.tono}>{est.etiqueta}</StatusBadge>
            {d.estado === "rechazado" && d.motivo ? <p className="text-xs text-muted-foreground">Motivo: {d.motivo}</p> : null}
          </div>
        );
      },
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (d) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void descargar(d)}><Download className="mr-1.5 size-4" aria-hidden="true" /> Descargar</Button>
          {puedeGestionar && d.estado === "recibido" && (
            <>
              <Button size="sm" disabled={ocupado} onClick={() => void accion(async () => { const r = await aceptarPortalDocumento(fetch, apiBaseUrl, token, propertyId, d.id); return r.invoiceId ? "CFDI ingresado. Revisa su validación en CFDI." : "Documento aceptado."; })}>Aceptar</Button>
              <Button size="sm" variant="outline" disabled={ocupado} onClick={() => void rechazar(d)}>Rechazar</Button>
            </>
          )}
        </div>
      ),
    },
  ];

  if (cargando) return <PageContainer><EstadoCargando /></PageContainer>;
  if (error) return <PageContainer><EstadoError mensaje={error} onReintentar={() => void cargar()} /></PageContainer>;

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Portal del cliente</h1>
          <p className="text-sm text-muted-foreground">Comparte un enlace privado para que tu cliente vea el estatus de sus obligaciones, suba CFDI y documentos, y te escriba.</p>
        </div>

        {!disponible && <Callout tone="warning" titulo="Portal aún no disponible">Este ambiente todavía no tiene aplicada la migración del portal del cliente. Puedes ver esta pantalla, pero no crear enlaces.</Callout>}
        {aviso && <Callout tone={aviso.tono} onDismiss={() => setAviso(null)}>{aviso.texto}</Callout>}

        {urlNueva && (
          <Callout tone="info" titulo="Enlace creado: cópialo ahora" icon={<Link2 className="size-4" aria-hidden="true" />}>
            <p className="mb-2">Por seguridad este enlace solo se muestra una vez. Si lo pierdes, revócalo y crea otro.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={urlNueva} aria-label="Enlace del portal" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={() => void copiar(urlNueva)}><Copy className="mr-1.5 size-4" aria-hidden="true" /> Copiar</Button>
              <Button type="button" variant="ghost" onClick={() => setUrlNueva(null)}>Listo</Button>
            </div>
          </Callout>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enlaces del cliente</CardTitle>
            <CardDescription>Cada enlace es privado, expira y se puede revocar en cualquier momento.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {puedeGestionar && disponible && (
              <form onSubmit={(e) => void alCrear(e)} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="portal-etiqueta">Para quién es</Label>
                  <Input id="portal-etiqueta" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} maxLength={80} placeholder="Ej. Contacto de administración" required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="portal-dias">Vigencia</Label>
                  <NativeSelect id="portal-dias" value={dias} onChange={(e) => setDias(e.target.value)}>
                    <option value="7">7 días</option>
                    <option value="30">30 días</option>
                    <option value="90">90 días</option>
                    <option value="180">180 días</option>
                    <option value="365">365 días</option>
                  </NativeSelect>
                </div>
                <Button type="submit" disabled={ocupado || etiqueta.trim().length === 0}>Crear enlace</Button>
              </form>
            )}
            <DataTable
              etiqueta="Enlaces del cliente"
              columnas={columnasEnlaces}
              filas={enlaces}
              obtenerId={(e) => e.id}
              vacio={{ mensaje: "Aún no has creado enlaces para este cliente." }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Documentos recibidos</CardTitle>
            <CardDescription>Aceptar un CFDI lo ingresa al flujo normal de CFDI (validación, lista 69-B del SAT y revisión).</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              etiqueta="Documentos recibidos"
              columnas={columnasDocumentos}
              filas={documentos}
              obtenerId={(d) => d.id}
              vacio={{ mensaje: "No hay documentos recibidos." }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mensajes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {mensajes.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay mensajes.</p>}
            <ul className="flex flex-col gap-2">
              {mensajes.map((m) => (
                <li key={m.id} className={m.autor === "despacho" ? "self-end rounded-card bg-primary/10 px-3 py-2 text-sm" : "self-start rounded-card bg-muted px-3 py-2 text-sm"}>
                  <p className="whitespace-pre-wrap break-words text-foreground">{m.cuerpo}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{m.autor === "despacho" ? "Despacho" : "Cliente"} · {fechaHora(m.creadoEn)}</p>
                </li>
              ))}
            </ul>
            {puedeGestionar && disponible && (
              <form onSubmit={(e) => void responder(e)} className="flex flex-col gap-2">
                <Textarea value={respuesta} onChange={(e) => setRespuesta(e.target.value)} maxLength={2000} rows={3} placeholder="Responder al cliente…" aria-label="Respuesta al cliente" />
                <Button type="submit" disabled={ocupado || respuesta.trim().length === 0}>Enviar respuesta</Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
