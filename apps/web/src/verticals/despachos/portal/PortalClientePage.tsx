// Pantalla publica del portal del cliente final del despacho (D-08), movil primero y ligera.
// El token vive en el FRAGMENTO de la URL (`/portal/cliente#t=...`): el navegador no lo envia al servidor ni
// lo manda en `Referer`. Aqui solo se lee de `location.hash`, se guarda en memoria del componente y se manda
// en el header `X-Portal-Token`; nunca se imprime ni se escribe en almacenamiento.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CalendarClock, ClipboardList, Download, FileUp, MessageSquare, ShieldCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoVacio, StatusBadge, Textarea } from "@atiende/ui";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";
import {
  avanceCierre,
  descargarReportePortal,
  enviarMensajePortal,
  ETIQUETA_RENGLON_PORTAL,
  estadoCierre,
  estadoDocumento,
  estadoObligacion,
  fetchPortalReportes,
  fetchPortalResumen,
  fetchPortalSolicitudes,
  nombreMes,
  PortalClienteError,
  renglonAdmiteArchivo,
  subirDocumentoPortal,
  tokenDeFragmento,
  validarArchivoLocal,
} from "../lib/portal-cliente-client.ts";
import type { PortalArchivoReporte, PortalReporteCierre, PortalResumen, PortalSolicitud } from "../lib/portal-cliente-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

function formatFechaHora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });
}

export interface PortalClientePageProps {
  readonly apiBaseUrl: string;
  /** Solo para pruebas: por defecto lee `window.location.hash`. */
  readonly hash?: string;
}

/** `solicitudes` / `reportes` = null: la base aun no tiene la migracion 027 y la pantalla oculta esa seccion (no finge funcionalidad). */
type Fase =
  | { readonly tipo: "cargando" }
  | { readonly tipo: "sin_enlace" }
  | { readonly tipo: "no_disponible" }
  | { readonly tipo: "listo"; readonly resumen: PortalResumen; readonly solicitudes: readonly PortalSolicitud[] | null; readonly reportes: readonly PortalReporteCierre[] | null };

export function PortalClientePage({ apiBaseUrl, hash }: PortalClientePageProps) {
  const token = useRef<string | null>(tokenDeFragmento(hash ?? window.location.hash));
  const [fase, setFase] = useState<Fase>(token.current ? { tipo: "cargando" } : { tipo: "sin_enlace" });
  const [aviso, setAviso] = useState<{ tono: "success" | "danger" | "info"; texto: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    document.title = "Portal del cliente";
  }, []);

  const cargar = useCallback(async () => {
    const t = token.current;
    if (!t) return;
    try {
      const resumen = await fetchPortalResumen(fetch, apiBaseUrl, t);
      // Solicitudes y reportes son secciones nuevas: si fallan por cualquier motivo el resto del portal sigue funcionando.
      const solicitudes = await fetchPortalSolicitudes(fetch, apiBaseUrl, t).catch(() => null);
      const reportes = await fetchPortalReportes(fetch, apiBaseUrl, t).catch(() => null);
      setFase({ tipo: "listo", resumen, solicitudes, reportes });
    } catch (err) {
      // Mismo mensaje para enlace inexistente, expirado o revocado: la pantalla no revela cual fue.
      if (err instanceof PortalClienteError && err.status === 503) setFase({ tipo: "no_disponible" });
      else setFase({ tipo: "sin_enlace" });
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function alElegirArchivo(e: ChangeEvent<HTMLInputElement>, renglonId?: string) {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    const t = token.current;
    if (!archivo || !t) return;
    const problema = validarArchivoLocal(archivo);
    if (problema) {
      setAviso({ tono: "danger", texto: problema });
      return;
    }
    setSubiendo(true);
    setAviso(null);
    try {
      const r = await subirDocumentoPortal(fetch, apiBaseUrl, t, archivo, renglonId);
      const aviso = r.duplicado ? `Ya habíamos recibido “${r.nombreArchivo}”.` : `Recibimos “${r.nombreArchivo}”. Tu despacho lo revisará.`;
      setAviso({ tono: r.renglon && !r.renglon.vinculado ? "info" : "success", texto: r.renglon && !r.renglon.vinculado ? `${aviso} Ese documento ya no se necesita para la solicitud.` : aviso });
      await cargar();
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof PortalClienteError ? err.message : "No se pudo subir el archivo. Intenta de nuevo." });
    } finally {
      setSubiendo(false);
    }
  }

  async function alDescargarReporte(archivo: PortalArchivoReporte) {
    const t = token.current;
    if (!t) return;
    setAviso(null);
    try {
      const { blob, nombre } = await descargarReportePortal(fetch, apiBaseUrl, t, archivo);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof PortalClienteError ? err.message : "No se pudo descargar el reporte." });
    }
  }

  async function alEnviarMensaje(e: FormEvent) {
    e.preventDefault();
    const t = token.current;
    const cuerpo = mensaje.trim();
    if (!t || cuerpo.length === 0) return;
    setEnviando(true);
    setAviso(null);
    try {
      await enviarMensajePortal(fetch, apiBaseUrl, t, cuerpo);
      setMensaje("");
      await cargar();
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof PortalClienteError ? err.message : "No se pudo enviar el mensaje." });
    } finally {
      setEnviando(false);
    }
  }

  if (fase.tipo === "cargando") return <main className="mx-auto max-w-2xl p-4"><EstadoCargando /></main>;
  if (fase.tipo === "sin_enlace") {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <EstadoVacio titulo="Este enlace no es válido" mensaje="El enlace pudo haber expirado o ser reemplazado. Pide uno nuevo a tu despacho contable." />
      </main>
    );
  }
  if (fase.tipo === "no_disponible") {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <EstadoVacio titulo="El portal aún no está disponible" mensaje="Contacta a tu despacho contable." />
      </main>
    );
  }

  const r = fase.resumen;
  const solicitudes = fase.solicitudes;
  const reportes = fase.reportes;
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 pb-12">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{r.despacho.nombre}</p>
        <h1 className="text-xl font-semibold text-foreground">{r.cliente.nombre}</h1>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" aria-hidden="true" /> Enlace privado, vigente hasta el {formatFechaSolo(r.expiraEn.slice(0, 10), "larga")}.
        </p>
      </header>

      {aviso && <Callout tone={aviso.tono} onDismiss={() => setAviso(null)}>{aviso.texto}</Callout>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4" aria-hidden="true" /> Obligaciones ante el SAT</CardTitle>
          <CardDescription>Estatus de tus declaraciones y cumplimientos.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {r.obligaciones.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay obligaciones registradas.</p>}
          {r.obligaciones.map((o) => {
            const e = estadoObligacion(o.estado);
            return (
              <div key={`${o.tipo}-${o.periodo}`} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{o.tipo} · {o.periodo}</p>
                  <p className="text-xs text-muted-foreground">
                    {o.fechaPresentacion ? `Presentada el ${formatFechaSolo(o.fechaPresentacion)}` : `Vence el ${formatFechaSolo(o.fechaLimite)}`}
                  </p>
                </div>
                <StatusBadge tone={e.tono}>{e.etiqueta}</StatusBadge>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cierre mensual</CardTitle>
          <CardDescription>Avance del cierre contable de cada mes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {r.cierres.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay cierres abiertos.</p>}
          {r.cierres.map((c) => {
            const e = estadoCierre(c.estado);
            return (
              <div key={`${c.anio}-${c.mes}`} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium capitalize text-foreground">{nombreMes(c.mes, c.anio)}</p>
                  <StatusBadge tone={e.tono}>{e.etiqueta}</StatusBadge>
                </div>
                <BarraProgreso valor={avanceCierre(c)} tono={c.estado === "closed" ? "success" : "primary"} aria-label={`Avance del cierre de ${nombreMes(c.mes, c.anio)}`} />
                <p className="text-xs text-muted-foreground">{c.tareasListas} de {c.tareasTotal} tareas listas</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {solicitudes !== null && solicitudes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="size-4" aria-hidden="true" /> Documentos que te pidió tu despacho</CardTitle>
            <CardDescription>Súbelos aquí para que tu despacho pueda cerrar tu mes.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {solicitudes.map((s) => (
              <div key={s.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium capitalize text-foreground">{nombreMes(s.mes, s.ejercicio)}</p>
                  <StatusBadge tone={s.estado === "completa" ? "success" : "warning"}>{s.estado === "completa" ? "Completo" : "Faltan documentos"}</StatusBadge>
                </div>
                <ul className="flex flex-col gap-2">
                  {s.renglones.map((g) => {
                    const e = ETIQUETA_RENGLON_PORTAL[g.estado];
                    return (
                      <li key={g.id} className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 text-sm text-foreground">{g.etiqueta}</span>
                          <StatusBadge tone={e.tono}>{e.etiqueta}</StatusBadge>
                        </div>
                        {g.estado === "no_aplica" && g.motivo && <p className="text-xs text-muted-foreground">Tu despacho indicó: {g.motivo}</p>}
                        {renglonAdmiteArchivo(g.estado) && (
                          <label className="block">
                            <span className="sr-only">Subir archivo para {g.etiqueta}</span>
                            <input
                              type="file"
                              accept=".xml,.pdf,.png,.jpg,.jpeg,application/xml,text/xml,application/pdf,image/png,image/jpeg"
                              disabled={subiendo}
                              onChange={(ev) => void alElegirArchivo(ev, g.id)}
                              className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
                            />
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {reportes !== null && reportes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Download className="size-4" aria-hidden="true" /> Reportes de tu cierre</CardTitle>
            <CardDescription>Tu despacho los publicó al cerrar cada mes.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {reportes.map((rep) => (
              <div key={`${rep.anio}-${rep.mes}`} className="flex flex-col gap-2">
                <p className="text-sm font-medium capitalize text-foreground">{nombreMes(rep.mes, rep.anio)}</p>
                <ul className="flex flex-col gap-1.5">
                  {rep.archivos.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm text-foreground">{a.nombreArchivo}</span>
                      <Button type="button" size="sm" variant="outline" onClick={() => void alDescargarReporte(a)}>
                        <Download />
                        Descargar
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><FileUp className="size-4" aria-hidden="true" /> Enviar documentos</CardTitle>
          <CardDescription>CFDI en XML, PDF o foto (PNG/JPEG), máximo 2 MB por archivo.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="block">
            <span className="sr-only">Elegir archivo</span>
            <input
              type="file"
              accept=".xml,.pdf,.png,.jpg,.jpeg,application/xml,text/xml,application/pdf,image/png,image/jpeg"
              disabled={subiendo}
              onChange={(e) => void alElegirArchivo(e)}
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
            />
          </label>
          {subiendo && <p className="text-sm text-muted-foreground">Subiendo…</p>}
          {r.documentos.length > 0 && (
            <ul className="flex flex-col gap-2">
              {r.documentos.map((d) => {
                const e = estadoDocumento(d.estado);
                return (
                  <li key={d.id} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm text-foreground">{d.nombreArchivo}</span>
                      <StatusBadge tone={e.tono}>{e.etiqueta}</StatusBadge>
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
          <CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="size-4" aria-hidden="true" /> Mensajes con tu despacho</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {r.mensajes.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay mensajes.</p>}
          <ul className="flex flex-col gap-2">
            {r.mensajes.map((m, i) => (
              <li key={`${m.creadoEn}-${i}`} className={m.autor === "cliente" ? "self-end rounded-card bg-primary/10 px-3 py-2 text-sm" : "self-start rounded-card bg-muted px-3 py-2 text-sm"}>
                <p className="whitespace-pre-wrap break-words text-foreground">{m.cuerpo}</p>
                <p className="mt-1 text-xs text-muted-foreground">{m.autor === "cliente" ? "Tú" : "Tu despacho"} · {formatFechaHora(m.creadoEn)}</p>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void alEnviarMensaje(e)} className="flex flex-col gap-2">
            <Textarea value={mensaje} onChange={(e) => setMensaje(e.target.value)} maxLength={2000} rows={3} placeholder="Escribe tu mensaje…" aria-label="Mensaje para tu despacho" />
            <Button type="submit" disabled={enviando || mensaje.trim().length === 0}>{enviando ? "Enviando…" : "Enviar mensaje"}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
