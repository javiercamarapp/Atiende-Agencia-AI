// Privacidad de plataforma (PL-13), SOLO LECTURA: resumen por organizacion (ARCO abiertas y vencidas, aviso
// vigente, bloqueos de purga, ultima purga), solicitudes ARCO de todas las organizaciones con plazos y
// estados, y registro global de purgas (sin datos personales). Backend real:
// apps/api/src/routes/superadmin-privacidad.ts (ver docs/PRIVACIDAD-PLATAFORMA.md). Referencia operativa,
// no asesoria legal. Las solicitudes no traen telefono, correo ni nombre del titular.
import { useCallback, useEffect, useState } from "react";
import { Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, PageContainer, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import {
  DERECHO_ETIQUETA,
  ESTADO_ARCO_ETIQUETA,
  PLAZO_ETIQUETA,
  PLAZO_TONO,
  PURGA_ETIQUETA,
  PURGA_TONO,
  VERTICAL_ETIQUETA,
  etiquetaClase,
  fechaMs,
  llamarJson,
  textoPlazo,
} from "../../lib/privacidad-plataforma.ts";
import type { PlazosReferencia, PurgaRegistro, SolicitudArcoPlataforma } from "../../lib/privacidad-plataforma.ts";

interface FilaResumen {
  readonly organizacionId: string;
  readonly organizacion: string;
  readonly vertical: string;
  readonly arcoAbiertas: number;
  readonly arcoVencidas: number;
  readonly avisoVersion: number | null;
  readonly avisoAceptaciones: number;
  readonly bloqueosActivos: number;
  readonly ultimaPurgaEnMs: number | null;
  readonly ultimaPurgaEstado: string | null;
}

interface RespuestaResumen {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly total: number;
  readonly organizaciones: readonly FilaResumen[];
}

interface RespuestaArco {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly plazos?: PlazosReferencia;
  readonly total: number;
  readonly solicitudes: readonly SolicitudArcoPlataforma[];
}

interface RespuestaPurgas {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly purgas: readonly PurgaRegistro[];
}

interface Datos {
  readonly resumen: RespuestaResumen;
  readonly arco: RespuestaArco;
  readonly purgas: RespuestaPurgas;
}

export function SuperAdminPrivacidadPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const base = `${apiBaseUrl.replace(/\/$/, "")}/superadmin/privacidad`;
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soloVencidas, setSoloVencidas] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const [resumen, arco, purgas] = await Promise.all([
        llamarJson<RespuestaResumen>(fetch, `${base}/resumen`, token),
        llamarJson<RespuestaArco>(fetch, `${base}/arco?abiertas=1&limite=200`, token),
        llamarJson<RespuestaPurgas>(fetch, `${base}/purgas?limite=100`, token),
      ]);
      setDatos({ resumen, arco, purgas });
    } catch {
      setError("No se pudo cargar la privacidad de plataforma.");
    }
  }, [base, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando privacidad…" />;

  const encabezado = (
    <PageHeader
      titulo="Privacidad de plataforma"
      descripcion="Solicitudes de derechos ARCO de todas las organizaciones con sus plazos, avisos de privacidad vigentes y registro de purgas por retención. Solo lectura; referencia operativa, no asesoría legal."
    />
  );

  if (!datos.resumen.disponible) {
    return (
      <PageContainer>
        {encabezado}
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          La privacidad de plataforma aún no está habilitada (migración 0036 pendiente de aplicar). Nada se ha purgado ni registrado.
        </Callout>
      </PageContainer>
    );
  }

  const organizaciones = datos.resumen.organizaciones;
  const solicitudes = datos.arco.solicitudes.filter((r) => !soloVencidas || r.plazo.estado === "vencida");
  const vencidasTotal = organizaciones.reduce((a, o) => a + o.arcoVencidas, 0);
  const plazos = datos.arco.plazos;

  return (
    <PageContainer>
      {encabezado}
      {vencidasTotal > 0 && (
        <Callout tone="danger" titulo={`${vencidasTotal} solicitud${vencidasTotal === 1 ? "" : "es"} ARCO vencida${vencidasTotal === 1 ? "" : "s"}`}>
          Avisa al responsable de cada organización: el plazo de referencia ya pasó.
        </Callout>
      )}
      <Tabs defaultValue="organizaciones">
        <TabsList>
          <TabsTrigger value="organizaciones">Organizaciones</TabsTrigger>
          <TabsTrigger value="arco">Solicitudes ARCO</TabsTrigger>
          <TabsTrigger value="purgas">Purgas</TabsTrigger>
        </TabsList>

        <TabsContent value="organizaciones">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Resumen por organización</CardTitle>
              <CardDescription>Primero las organizaciones con más solicitudes vencidas.</CardDescription>
            </CardHeader>
            <CardContent>
              {organizaciones.length === 0 ? (
                <EstadoVacio titulo="Sin organizaciones" mensaje="No hay organizaciones registradas." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organización</TableHead>
                        <TableHead>Vertical</TableHead>
                        <TableHead>ARCO abiertas</TableHead>
                        <TableHead>Vencidas</TableHead>
                        <TableHead>Aviso vigente</TableHead>
                        <TableHead>Bloqueos</TableHead>
                        <TableHead>Última purga</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {organizaciones.map((o) => (
                        <TableRow key={o.organizacionId}>
                          <TableCell className="font-medium">{o.organizacion}</TableCell>
                          <TableCell>{VERTICAL_ETIQUETA[o.vertical] ?? o.vertical}</TableCell>
                          <TableCell>{o.arcoAbiertas}</TableCell>
                          <TableCell>{o.arcoVencidas > 0 ? <StatusBadge tone="danger">{o.arcoVencidas}</StatusBadge> : 0}</TableCell>
                          <TableCell>
                            {o.avisoVersion === null ? <StatusBadge tone="warning">Sin aviso</StatusBadge> : `Versión ${o.avisoVersion} (${o.avisoAceptaciones} ${o.avisoAceptaciones === 1 ? "aceptación" : "aceptaciones"})`}
                          </TableCell>
                          <TableCell>{o.bloqueosActivos > 0 ? <StatusBadge tone="warning">{o.bloqueosActivos} activo{o.bloqueosActivos === 1 ? "" : "s"}</StatusBadge> : "—"}</TableCell>
                          <TableCell>
                            {o.ultimaPurgaEnMs === null ? "—" : `${fechaMs(o.ultimaPurgaEnMs)} · ${PURGA_ETIQUETA[o.ultimaPurgaEstado ?? ""] ?? o.ultimaPurgaEstado ?? ""}`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {datos.resumen.total > organizaciones.length && <p className="mt-2 text-xs text-muted-foreground">Mostrando {organizaciones.length} de {datos.resumen.total} organizaciones.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="arco">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Solicitudes ARCO abiertas</CardTitle>
              <CardDescription>
                {plazos ? `Referencia: ${plazos.respuestaDias} días para responder y ${plazos.ejecucionDias} más para ejecutar (días naturales). ` : ""}
                <label className="ml-1 inline-flex items-center gap-1.5 text-xs">
                  <Checkbox checked={soloVencidas} onChange={(e) => setSoloVencidas(e.target.checked)} />
                  Solo vencidas
                </label>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {solicitudes.length === 0 ? (
                <EstadoVacio titulo="Sin solicitudes" mensaje={soloVencidas ? "No hay solicitudes vencidas." : "No hay solicitudes ARCO abiertas."} />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organización</TableHead>
                        <TableHead>Vertical</TableHead>
                        <TableHead>Referencia</TableHead>
                        <TableHead>Derecho</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead>Recibida</TableHead>
                        <TableHead>Plazo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {solicitudes.map((r) => (
                        <TableRow key={`${r.vertical}:${r.id}`}>
                          <TableCell>{r.organizacion ?? r.organizacionId}</TableCell>
                          <TableCell>{VERTICAL_ETIQUETA[r.vertical] ?? r.vertical}</TableCell>
                          <TableCell className="font-mono text-xs">{r.referencia}</TableCell>
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
                  {datos.arco.total > datos.arco.solicitudes.length && <p className="mt-2 text-xs text-muted-foreground">Mostrando {datos.arco.solicitudes.length} de {datos.arco.total} solicitudes abiertas.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="purgas">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Registro de purgas</CardTitle>
              <CardDescription>Qué se purgó, cuándo y cuántas filas, sin datos personales. La purga no está programada: se dispara con el endpoint interno de plataforma.</CardDescription>
            </CardHeader>
            <CardContent>
              {datos.purgas.purgas.length === 0 ? (
                <EstadoVacio titulo="Sin purgas registradas" mensaje="Todavía no se ha ejecutado ni simulado ninguna purga." />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Fecha</TableHead>
                        <TableHead>Organización</TableHead>
                        <TableHead>Clase</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead>Retención</TableHead>
                        <TableHead>Afectadas</TableHead>
                        <TableHead>Anonimizadas</TableHead>
                        <TableHead>Protegidas</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.purgas.purgas.map((p) => (
                        <TableRow key={p.seq}>
                          <TableCell>{fechaMs(p.ocurrioEnMs)}</TableCell>
                          <TableCell>{p.organizacion ?? p.organizacionId}</TableCell>
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
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
