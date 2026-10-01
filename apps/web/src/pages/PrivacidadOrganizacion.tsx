// Privacidad de la organizacion (PL-13), para el owner/admin del cliente: solicitudes ARCO de todos los
// verticales con plazos y estados, politicas de retencion (con su valor por defecto), bloqueo previo a purga,
// registro de purgas y aviso de privacidad versionado con su aceptacion. Backend real:
// apps/api/src/routes/privacidad-org.ts (/v1/privacidad/*); la organizacion sale del token.
//
// Documentacion operativa, NO asesoria legal: los plazos y los dias por defecto son una referencia tecnica
// conservadora (dias de calendario); el responsable debe validarlos con su asesor juridico
// (ver docs/PRIVACIDAD-PLATAFORMA.md). Las solicitudes no muestran telefono, correo ni nombre del titular: el
// detalle con datos personales sigue en el panel de cada vertical.
//
// Presentacion (DS v2): PageContainer/PageHeader, Card por bloque, StatusBadge para plazos y purgas, Callout para
// avisos persistentes y FormField/Input/NativeSelect/Textarea para los formularios.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Textarea, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import {
  DERECHO_ETIQUETA,
  ESTADO_ARCO_ETIQUETA,
  ORIGEN_ETIQUETA,
  PLAZO_ETIQUETA,
  PLAZO_TONO,
  PURGA_ETIQUETA,
  PURGA_TONO,
  VERTICAL_ETIQUETA,
  etiquetaClase,
  fechaMs,
  llamarJson,
  textoPlazo,
} from "../lib/privacidad-plataforma.ts";
import type { PlazosReferencia, PurgaRegistro, SolicitudArcoPlataforma } from "../lib/privacidad-plataforma.ts";

interface Politica {
  readonly claseDato: string;
  readonly vertical: string;
  readonly descripcion: string;
  readonly ejecuta: "plataforma" | "vertical";
  readonly defectoDias: number;
  readonly minimoDias: number;
  readonly maximoDias: number;
  readonly diasEfectivos: number;
  readonly origen: string;
}

interface Bloqueo {
  readonly id: string;
  readonly claseDato: string | null;
  readonly motivo: string;
  readonly colocadoEnMs: number;
  readonly liberadoEnMs: number | null;
  readonly activo: boolean;
}

interface Aviso {
  readonly version: number;
  readonly titulo: string;
  readonly resumen: string;
  readonly url: string;
  readonly publicadoEnMs: number;
  readonly aceptaciones: number;
  readonly aceptadoPorMi: boolean;
  readonly vigente: boolean;
}

interface Resumen {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly plazos?: PlazosReferencia;
  readonly arco?: { readonly total: number; readonly solicitudes: readonly SolicitudArcoPlataforma[] };
  readonly retencion?: readonly Politica[];
  readonly bloqueos?: readonly Bloqueo[];
  readonly purgas?: readonly PurgaRegistro[];
  readonly avisos?: readonly Aviso[];
}

export interface PrivacidadOrganizacionPageProps {
  readonly apiBaseUrl: string;
  readonly token: string;
}

export function PrivacidadOrganizacionPage({ apiBaseUrl, token }: PrivacidadOrganizacionPageProps) {
  const base = `${apiBaseUrl.replace(/\/$/, "")}/v1/privacidad`;
  const [datos, setDatos] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prohibido, setProhibido] = useState(false);
  const [accionError, setAccionError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [dias, setDias] = useState<Record<string, string>>({});
  const [claseBloqueo, setClaseBloqueo] = useState("");
  const [motivoBloqueo, setMotivoBloqueo] = useState("");
  const [titulo, setTitulo] = useState("");
  const [resumenAviso, setResumenAviso] = useState("");
  const [urlAviso, setUrlAviso] = useState("");

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setDatos(await llamarJson<Resumen>(fetch, `${base}/resumen`, token));
      setProhibido(false);
    } catch (err) {
      if (err instanceof Error && /owner|admin/i.test(err.message)) setProhibido(true);
      else setError("No se pudo cargar la privacidad de la organización.");
    }
  }, [base, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function ejecutar(accion: () => Promise<unknown>): Promise<boolean> {
    setOcupado(true);
    setAccionError(null);
    try {
      await accion();
      await cargar();
      return true;
    } catch (err) {
      setAccionError(err instanceof Error ? err.message : "No se pudo completar la acción.");
      return false;
    } finally {
      setOcupado(false);
    }
  }

  if (prohibido) return <EstadoError mensaje="Solo el owner o un admin de la organización puede administrar la privacidad." />;
  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando privacidad…" />;

  const encabezado = (
    <PageHeader
      titulo="Privacidad de la organización"
      descripcion="Solicitudes de derechos ARCO, retención de datos, bloqueo previo a purga y aviso de privacidad de todos tus verticales. Referencia operativa, no asesoría legal: valida plazos y avisos con tu asesor jurídico."
    />
  );

  if (!datos.disponible) {
    return (
      <PageContainer>
        {encabezado}
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          La privacidad de la organización aún no está habilitada en este ambiente (migración 0036 pendiente de aplicar). No se perdió ningún dato y no hay purgas pendientes.
        </Callout>
      </PageContainer>
    );
  }

  const plazos = datos.plazos;
  const arco = datos.arco?.solicitudes ?? [];
  const vencidas = arco.filter((r) => r.plazo.estado === "vencida").length;
  const politicas = datos.retencion ?? [];
  const bloqueos = datos.bloqueos ?? [];
  const bloqueosActivos = bloqueos.filter((b) => b.activo);
  const purgas = datos.purgas ?? [];
  const avisos = datos.avisos ?? [];
  const vigente = avisos.find((a) => a.vigente);

  function guardarPolitica(p: Politica) {
    const n = Number(dias[p.claseDato] ?? p.diasEfectivos);
    return ejecutar(() => llamarJson(fetch, `${base}/retencion/${p.claseDato}`, token, { method: "PUT", body: { dias: n } }));
  }

  function colocarBloqueo(e: FormEvent) {
    e.preventDefault();
    void ejecutar(async () => {
      await llamarJson(fetch, `${base}/bloqueos`, token, { method: "POST", body: { claseDato: claseBloqueo === "" ? null : claseBloqueo, motivo: motivoBloqueo } });
      setMotivoBloqueo("");
    });
  }

  function publicarAviso(e: FormEvent) {
    e.preventDefault();
    void ejecutar(async () => {
      await llamarJson(fetch, `${base}/avisos`, token, { method: "POST", body: { titulo, resumen: resumenAviso, url: urlAviso } });
      setTitulo("");
      setResumenAviso("");
      setUrlAviso("");
    });
  }

  return (
    <PageContainer>
      {encabezado}
      {accionError && (
        <Callout tone="danger" titulo="No se pudo completar la acción">
          {accionError}
        </Callout>
      )}
      {bloqueosActivos.length > 0 && (
        <Callout tone="warning" titulo="Hay purgas detenidas por retención legal">
          Mientras el bloqueo siga activo no se borra ni se anonimiza nada de la clase afectada. Libéralo cuando el caso se cierre.
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Solicitudes de derechos ARCO</CardTitle>
          <CardDescription>
            {plazos ? `Referencia: ${plazos.respuestaDias} días para responder y ${plazos.ejecucionDias} más para ejecutar (días naturales). ` : ""}
            {vencidas > 0 ? `${vencidas} vencida${vencidas === 1 ? "" : "s"}.` : "Ninguna vencida."} Para atender una solicitud o ver al titular, usa el panel Privacidad de su vertical.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {arco.length === 0 ? (
            <EstadoVacio titulo="Sin solicitudes" mensaje="Todavía no hay solicitudes de derechos ARCO en ningún vertical." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Referencia</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Derecho</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Recibida</TableHead>
                    <TableHead>Plazo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {arco.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.referencia}</TableCell>
                      <TableCell>{VERTICAL_ETIQUETA[r.vertical] ?? r.vertical}</TableCell>
                      <TableCell>{DERECHO_ETIQUETA[r.derecho] ?? r.derecho}</TableCell>
                      <TableCell>{ESTADO_ARCO_ETIQUETA[r.estado] ?? r.estado}</TableCell>
                      <TableCell>{fechaMs(r.abiertaEnMs)}</TableCell>
                      <TableCell>
                        <StatusBadge tone={PLAZO_TONO[r.plazo.estado]}>{PLAZO_ETIQUETA[r.plazo.estado]}</StatusBadge>
                        <span className="ml-2 text-xs text-muted-foreground">{textoPlazo(r.plazo)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {datos.arco && datos.arco.total > arco.length && <p className="mt-2 text-xs text-muted-foreground">Mostrando {arco.length} de {datos.arco.total} solicitudes.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Retención de datos</CardTitle>
          <CardDescription>Días que se conserva cada tipo de dato antes de purgarlo. Sin política propia rige la configuración del vertical y, si no existe, el valor por defecto.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {politicas.map((p) => {
            const editable = p.ejecuta === "plataforma";
            const idCampo = `ret-${p.claseDato}`;
            return (
              <div key={p.claseDato} className="grid gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="grid gap-1">
                  <p className="m-0 text-sm font-medium">{etiquetaClase(p.claseDato)}</p>
                  <p className="m-0 text-xs text-muted-foreground">{p.descripcion}</p>
                  <p className="m-0 text-xs text-muted-foreground">
                    Defecto {p.defectoDias} días · rango {p.minimoDias} a {p.maximoDias} · hoy {p.diasEfectivos} días ({ORIGEN_ETIQUETA[p.origen] ?? p.origen})
                  </p>
                  {!editable && <p className="m-0 text-xs text-muted-foreground">La purga de esta clase la corre el propio vertical con su configuración; aquí solo se documenta el valor por defecto.</p>}
                </div>
                {editable && (
                  <div className="flex flex-wrap items-end gap-2">
                    <FormField label="Días" id={idCampo}>
                      <Input type="number" min={p.minimoDias} max={p.maximoDias} value={dias[p.claseDato] ?? String(p.diasEfectivos)} onChange={(e) => setDias({ ...dias, [p.claseDato]: e.target.value })} className="w-28" />
                    </FormField>
                    <Button type="button" disabled={ocupado} onClick={() => void guardarPolitica(p)}>
                      Guardar
                    </Button>
                    {p.origen === "organizacion" && (
                      <Button type="button" variant="outline" disabled={ocupado} onClick={() => void ejecutar(() => llamarJson(fetch, `${base}/retencion/${p.claseDato}`, token, { method: "DELETE" }))}>
                        Restablecer
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Bloqueo previo a purga (retención legal)</CardTitle>
          <CardDescription>Un bloqueo activo detiene la purga de esa clase (o de todas) hasta que lo liberes. Además, nunca se purga a un titular con una solicitud ARCO abierta.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form onSubmit={colocarBloqueo} className="grid gap-3 sm:grid-cols-2">
            <FormField label="Clase de dato">
              <NativeSelect value={claseBloqueo} onChange={(e) => setClaseBloqueo(e.target.value)}>
                <option value="">Todas las clases</option>
                {politicas.map((p) => (
                  <option key={p.claseDato} value={p.claseDato}>
                    {etiquetaClase(p.claseDato)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Motivo (10 a 300 caracteres)" required>
              <Textarea value={motivoBloqueo} maxLength={300} rows={2} onChange={(e) => setMotivoBloqueo(e.target.value)} placeholder="Ej. Requerimiento de autoridad en curso" />
            </FormField>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={ocupado || motivoBloqueo.trim().length < 10}>
                Colocar bloqueo
              </Button>
            </div>
          </form>
          {bloqueos.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">No hay bloqueos registrados.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {bloqueos.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border p-3 text-sm">
                  <span>
                    <StatusBadge tone={b.activo ? "warning" : "neutral"}>{b.activo ? "Activo" : "Liberado"}</StatusBadge> <span className="ml-2">{etiquetaClase(b.claseDato)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {b.motivo} · {fechaMs(b.colocadoEnMs)}
                    </span>
                  </span>
                  {b.activo && (
                    <Button type="button" variant="outline" disabled={ocupado} onClick={() => void ejecutar(() => llamarJson(fetch, `${base}/bloqueos/${b.id}/liberar`, token, { method: "POST", body: {} }))}>
                      Liberar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Registro de purgas</CardTitle>
          <CardDescription>Qué se purgó, cuándo y cuántas filas. Sin datos personales. La purga automática no está programada: se ejecuta cuando la plataforma la dispara.</CardDescription>
        </CardHeader>
        <CardContent>
          {purgas.length === 0 ? (
            <EstadoVacio titulo="Sin purgas registradas" mensaje="Todavía no se ha ejecutado ni simulado ninguna purga para tu organización." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Clase</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Retención</TableHead>
                    <TableHead>Afectadas</TableHead>
                    <TableHead>Anonimizadas</TableHead>
                    <TableHead>Protegidas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purgas.map((p) => (
                    <TableRow key={p.seq}>
                      <TableCell>{fechaMs(p.ocurrioEnMs)}</TableCell>
                      <TableCell>{etiquetaClase(p.claseDato)}</TableCell>
                      <TableCell>
                        <StatusBadge tone={PURGA_TONO[p.estado] ?? "neutral"}>{PURGA_ETIQUETA[p.estado] ?? p.estado}</StatusBadge>
                      </TableCell>
                      <TableCell>{p.retencionDias === null ? "—" : `${p.retencionDias} días`}</TableCell>
                      <TableCell>{p.filasAfectadas}</TableCell>
                      <TableCell>{p.filasAnonimizadas}</TableCell>
                      <TableCell>{p.filasProtegidas}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Aviso de privacidad</CardTitle>
          <CardDescription>
            Cada publicación crea una versión nueva que queda registrada con su huella y con quién la aceptó; quien publica la acepta al hacerlo. Los textos publicados no se editan: para cambiarlos, publica una versión nueva.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {vigente && !vigente.aceptadoPorMi && (
            <Callout
              tone="info"
              titulo={`Falta tu aceptación de la versión ${vigente.version}`}
              accion={
                <Button type="button" disabled={ocupado} onClick={() => void ejecutar(() => llamarJson(fetch, `${base}/avisos/${vigente.version}/aceptar`, token, { method: "POST", body: {} }))}>
                  Aceptar versión {vigente.version}
                </Button>
              }
            >
              Revisa el aviso vigente y acéptalo si estás de acuerdo.
            </Callout>
          )}
          {avisos.length === 0 && <Callout tone="warning" titulo="Todavía no hay aviso de privacidad publicado">Publica el primero para dejar evidencia de la versión vigente.</Callout>}
          {avisos.length > 0 && (
            <ul className="m-0 grid list-none gap-2 p-0">
              {avisos.map((a) => (
                <li key={a.version} className="rounded-card border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      Versión {a.version} · {a.titulo}
                    </span>
                    <StatusBadge tone={a.vigente ? "success" : "neutral"}>{a.vigente ? "Vigente" : "Anterior"}</StatusBadge>
                  </div>
                  <p className="m-0 mt-1 text-xs text-muted-foreground">{a.resumen}</p>
                  <p className="m-0 mt-1 text-xs text-muted-foreground">
                    Publicada {fechaMs(a.publicadoEnMs)} · {a.aceptaciones} {a.aceptaciones === 1 ? "aceptación" : "aceptaciones"} ·{" "}
                    <a href={a.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                      Aviso integral
                    </a>
                  </p>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={publicarAviso} className="grid gap-3 border-t border-border pt-4">
            <FormField label="Título" required>
              <Input value={titulo} maxLength={200} onChange={(e) => setTitulo(e.target.value)} placeholder="Aviso de privacidad" />
            </FormField>
            <FormField label="Aviso simplificado (10 a 2000 caracteres)" required>
              <Textarea value={resumenAviso} maxLength={2000} rows={3} onChange={(e) => setResumenAviso(e.target.value)} placeholder="Qué datos usas, para qué y cómo ejercer los derechos ARCO." />
            </FormField>
            <FormField label="URL del aviso integral (https)" required>
              <Input value={urlAviso} maxLength={500} onChange={(e) => setUrlAviso(e.target.value)} placeholder="https://tu-sitio.mx/aviso-de-privacidad" />
            </FormField>
            <div>
              <Button type="submit" disabled={ocupado || titulo.trim().length < 3 || resumenAviso.trim().length < 10 || !/^https:\/\/\S+$/u.test(urlAviso.trim())}>
                Publicar nueva versión
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
