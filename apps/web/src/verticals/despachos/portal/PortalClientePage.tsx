// Pantalla publica del portal del cliente final del despacho (D-08), movil primero y ligera.
// El token vive en el FRAGMENTO de la URL (`/portal/cliente#t=...`): el navegador no lo envia al servidor ni
// lo manda en `Referer`. Aqui solo se lee de `location.hash`, se guarda en memoria del componente y se manda
// en el header `X-Portal-Token`; nunca se imprime ni se escribe en almacenamiento.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CalendarClock, Download, FileText, FileUp, MessageSquare, ShieldCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoVacio, StatusBadge, Textarea } from "@atiende/ui";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";
import {
  avanceCierre,
  descargarPortalCfdiCsv,
  ETIQUETA_SENTIDO_CFDI,
  fetchPortalCfdi,
  enviarMensajePortal,
  estadoCierre,
  estadoDocumento,
  estadoObligacion,
  fetchPortalResumen,
  nombreMes,
  PortalClienteError,
  subirDocumentoPortal,
  tokenDeFragmento,
  validarArchivoLocal,
} from "../lib/portal-cliente-client.ts";
import type { PortalCfdiCliente, PortalResumen } from "../lib/portal-cliente-client.ts";
import { formatCentavos } from "../lib/format.ts";
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

type Fase = { readonly tipo: "cargando" } | { readonly tipo: "sin_enlace" } | { readonly tipo: "no_disponible" } | { readonly tipo: "listo"; readonly resumen: PortalResumen };

export function PortalClientePage({ apiBaseUrl, hash }: PortalClientePageProps) {
  const token = useRef<string | null>(tokenDeFragmento(hash ?? window.location.hash));
  const [fase, setFase] = useState<Fase>(token.current ? { tipo: "cargando" } : { tipo: "sin_enlace" });
  const [aviso, setAviso] = useState<{ tono: "success" | "danger" | "info"; texto: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [enviando, setEnviando] = useState(false);
  // D-P3-22: "Mis CFDI" -- carga aparte para que un fallo de esta lista no tumbe el resto del portal.
  const [cfdi, setCfdi] = useState<{ readonly estado: "cargando" | "listo" | "error" | "no_disponible"; readonly lista: readonly PortalCfdiCliente[]; readonly tope: number }>({ estado: "cargando", lista: [], tope: 500 });
  const [verTodos, setVerTodos] = useState(false);
  const [exportando, setExportando] = useState(false);

  useEffect(() => {
    document.title = "Portal del cliente";
  }, []);

  const cargar = useCallback(async () => {
    const t = token.current;
    if (!t) return;
    try {
      setFase({ tipo: "listo", resumen: await fetchPortalResumen(fetch, apiBaseUrl, t) });
    } catch (err) {
      // Mismo mensaje para enlace inexistente, expirado o revocado: la pantalla no revela cual fue.
      if (err instanceof PortalClienteError && err.status === 503) setFase({ tipo: "no_disponible" });
      else setFase({ tipo: "sin_enlace" });
    }
  }, [apiBaseUrl]);

  const cargarCfdi = useCallback(async () => {
    const t = token.current;
    if (!t) return;
    try {
      const r = await fetchPortalCfdi(fetch, apiBaseUrl, t);
      setCfdi({ estado: "listo", lista: r.cfdi, tope: r.tope });
    } catch (err) {
      setCfdi({ estado: err instanceof PortalClienteError && err.status === 503 ? "no_disponible" : "error", lista: [], tope: 500 });
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void cargar();
    void cargarCfdi();
  }, [cargar, cargarCfdi]);

  async function exportarCsv() {
    const t = token.current;
    if (!t) return;
    setExportando(true);
    setAviso(null);
    try {
      const blob = await descargarPortalCfdiCsv(fetch, apiBaseUrl, t);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mis-cfdi.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof PortalClienteError ? err.message : "No se pudo exportar tus CFDI. Intenta de nuevo." });
    } finally {
      setExportando(false);
    }
  }

  async function alElegirArchivo(e: ChangeEvent<HTMLInputElement>) {
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
      const r = await subirDocumentoPortal(fetch, apiBaseUrl, t, archivo);
      // Un XML valido se acepta solo: el despacho ya lo tiene registrado (D-P3-22).
      setAviso({ tono: "success", texto: r.duplicado ? `Ya habíamos recibido “${r.nombreArchivo}”.` : r.estado === "aceptado" ? `Recibimos “${r.nombreArchivo}” y ya quedó registrado con tu despacho.` : `Recibimos “${r.nombreArchivo}”. Tu despacho lo revisará.` });
      await Promise.all([cargar(), cargarCfdi()]);
    } catch (err) {
      setAviso({ tono: "danger", texto: err instanceof PortalClienteError ? err.message : "No se pudo subir el archivo. Intenta de nuevo." });
    } finally {
      setSubiendo(false);
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4" aria-hidden="true" /> Mis CFDI</CardTitle>
          <CardDescription>Los comprobantes que tu despacho tiene registrados a tu nombre.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {cfdi.estado === "cargando" && <EstadoCargando etiqueta="Cargando tus CFDI…" lineas={2} />}
          {cfdi.estado === "error" && (
            <p role="alert" className="text-sm text-destructive">
              No se pudieron cargar tus CFDI. <button type="button" className="underline underline-offset-2" onClick={() => void cargarCfdi()}>Reintentar</button>
            </p>
          )}
          {cfdi.estado === "no_disponible" && <p role="status" className="text-sm text-muted-foreground">Esta lista aún no está disponible. Contacta a tu despacho.</p>}
          {cfdi.estado === "listo" && cfdi.lista.length === 0 && <p role="status" className="text-sm text-muted-foreground">Tu despacho aún no tiene CFDI registrados a tu nombre.</p>}
          {cfdi.estado === "listo" && cfdi.lista.length > 0 && (
            <>
              <ul className="flex flex-col gap-2">
                {(verTodos ? cfdi.lista : cfdi.lista.slice(0, 8)).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{c.emisorNombre ?? c.rfcEmisor}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFechaSolo(c.fecha)} · {ETIQUETA_SENTIDO_CFDI[c.direccion ?? "indeterminado"]} · <span className="font-mono">{c.folioFiscal.slice(0, 8)}…</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="text-sm tabular-nums text-foreground">{formatCentavos(c.totalCentavos)}</span>
                      {c.excluido ? <StatusBadge tone="danger">Excluido</StatusBadge> : c.estadoSat === "cancelado" ? <StatusBadge tone="danger">Cancelado</StatusBadge> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {cfdi.lista.length > 8 ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setVerTodos(!verTodos)}>
                    {verTodos ? "Ver menos" : `Ver los ${cfdi.lista.length}`}
                  </Button>
                ) : (
                  <span />
                )}
                <Button type="button" size="sm" disabled={exportando} loading={exportando} loadingText="Exportando…" onClick={() => void exportarCsv()}>
                  <Download />
                  Exportar CSV
                </Button>
              </div>
              {cfdi.lista.length >= cfdi.tope && <p className="text-xs text-muted-foreground">Se muestran los {cfdi.tope} más recientes.</p>}
            </>
          )}
        </CardContent>
      </Card>

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
