// Privacidad de plataforma (PL-13), SOLO LECTURA: resumen por organizacion (ARCO abiertas y vencidas, aviso
// vigente, bloqueos de purga, ultima purga), solicitudes ARCO de todas las organizaciones con plazos y
// estados, y registro global de purgas (sin datos personales). Backend real:
// apps/api/src/routes/superadmin-privacidad.ts (ver docs/PRIVACIDAD-PLATAFORMA.md). Referencia operativa,
// no asesoria legal. Las solicitudes no traen telefono, correo ni nombre del titular.
import { useCallback, useEffect, useState } from "react";
import { Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, PageContainer, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
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
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Organización</th>
                        <th className="py-2 pr-3 font-medium">Vertical</th>
                        <th className="py-2 pr-3 font-medium">ARCO abiertas</th>
                        <th className="py-2 pr-3 font-medium">Vencidas</th>
                        <th className="py-2 pr-3 font-medium">Aviso vigente</th>
                        <th className="py-2 pr-3 font-medium">Bloqueos</th>
                        <th className="py-2 font-medium">Última purga</th>
                      </tr>
                    </thead>
                    <tbody>
                      {organizaciones.map((o) => (
                        <tr key={o.organizacionId} className="border-t border-border">
                          <td className="py-2 pr-3 font-medium">{o.organizacion}</td>
                          <td className="py-2 pr-3">{VERTICAL_ETIQUETA[o.vertical] ?? o.vertical}</td>
                          <td className="py-2 pr-3">{o.arcoAbiertas}</td>
                          <td className="py-2 pr-3">{o.arcoVencidas > 0 ? <StatusBadge tone="danger">{o.arcoVencidas}</StatusBadge> : 0}</td>
                          <td className="py-2 pr-3">
                            {o.avisoVersion === null ? <StatusBadge tone="warning">Sin aviso</StatusBadge> : `Versión ${o.avisoVersion} (${o.avisoAceptaciones} ${o.avisoAceptaciones === 1 ? "aceptación" : "aceptaciones"})`}
                          </td>
                          <td className="py-2 pr-3">{o.bloqueosActivos > 0 ? <StatusBadge tone="warning">{o.bloqueosActivos} activo{o.bloqueosActivos === 1 ? "" : "s"}</StatusBadge> : "—"}</td>
                          <td className="py-2">
                            {o.ultimaPurgaEnMs === null ? "—" : `${fechaMs(o.ultimaPurgaEnMs)} · ${PURGA_ETIQUETA[o.ultimaPurgaEstado ?? ""] ?? o.ultimaPurgaEstado ?? ""}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Organización</th>
                        <th className="py-2 pr-3 font-medium">Vertical</th>
                        <th className="py-2 pr-3 font-medium">Referencia</th>
                        <th className="py-2 pr-3 font-medium">Derecho</th>
                        <th className="py-2 pr-3 font-medium">Estado</th>
                        <th className="py-2 pr-3 font-medium">Recibida</th>
                        <th className="py-2 font-medium">Plazo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {solicitudes.map((r) => (
                        <tr key={`${r.vertical}:${r.id}`} className="border-t border-border">
                          <td className="py-2 pr-3">{r.organizacion ?? r.organizacionId}</td>
                          <td className="py-2 pr-3">{VERTICAL_ETIQUETA[r.vertical] ?? r.vertical}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{r.referencia}</td>
                          <td className="py-2 pr-3">{DERECHO_ETIQUETA[r.derecho] ?? r.derecho}</td>
                          <td className="py-2 pr-3">{ESTADO_ARCO_ETIQUETA[r.estado] ?? r.estado}</td>
                          <td className="py-2 pr-3">{fechaMs(r.abiertaEnMs)}</td>
                          <td className="py-2">
                            <StatusBadge tone={PLAZO_TONO[r.plazo.estado]}>{PLAZO_ETIQUETA[r.plazo.estado]}</StatusBadge>
                            <span className="ml-2 text-xs text-muted-foreground">{textoPlazo(r.plazo)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Fecha</th>
                        <th className="py-2 pr-3 font-medium">Organización</th>
                        <th className="py-2 pr-3 font-medium">Clase</th>
                        <th className="py-2 pr-3 font-medium">Estado</th>
                        <th className="py-2 pr-3 font-medium">Retención</th>
                        <th className="py-2 pr-3 font-medium">Afectadas</th>
                        <th className="py-2 pr-3 font-medium">Anonimizadas</th>
                        <th className="py-2 font-medium">Protegidas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {datos.purgas.purgas.map((p) => (
                        <tr key={p.seq} className="border-t border-border">
                          <td className="py-2 pr-3">{fechaMs(p.ocurrioEnMs)}</td>
                          <td className="py-2 pr-3">{p.organizacion ?? p.organizacionId}</td>
                          <td className="py-2 pr-3">{etiquetaClase(p.claseDato)}</td>
                          <td className="py-2 pr-3">
                            <StatusBadge tone={PURGA_TONO[p.estado] ?? "neutral"}>{PURGA_ETIQUETA[p.estado] ?? p.estado}</StatusBadge>
                          </td>
                          <td className="py-2 pr-3">{p.retencionDias === null ? "—" : `${p.retencionDias} días`}</td>
                          <td className="py-2 pr-3">{p.filasAfectadas}</td>
                          <td className="py-2 pr-3">{p.filasAnonimizadas}</td>
                          <td className="py-2">{p.filasProtegidas}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
