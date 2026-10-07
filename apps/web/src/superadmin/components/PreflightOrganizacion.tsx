// Pestana "Listo para produccion" de la ficha de una organizacion (go-live G-05/G-16). Backend real: GET /superadmin/organizaciones/:id/preflight
// (solo lectura, solo superadmin): una lista de verificaciones por area con su estado, el detalle sin secretos y como resolver cada una con el
// enlace a la pantalla que lo arregla. Estados: cargando, error con reintento y datos; una fuente que no se pudo leer se dice en un aviso y su
// verificacion sale "Aviso", nunca "En orden". "Volver a verificar" vuelve a leer todo desde el servidor.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlert, CircleCheck, ListChecks, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, StatCard, StatusBadge } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchJson } from "../lib/fetch-json.ts";
import { NOMBRE_AREA_PREFLIGHT, NOMBRE_ESTADO_PREFLIGHT, RAZON_FUENTE_PREFLIGHT, TONO_ESTADO_PREFLIGHT, semaforoDeArea } from "../lib/preflight.ts";
import type { RespuestaPreflight } from "../lib/preflight.ts";

type Carga = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "ok"; readonly datos: RespuestaPreflight };

const NOMBRE_FUENTE: Readonly<Record<string, string>> = { crons: "los latidos de los crons", equipo: "el equipo", datos: "los datos del restaurante", mfa: "tu MFA" };

export function PreflightOrganizacion({ apiBaseUrl, token, organizacionId }: { readonly apiBaseUrl: string; readonly token: string; readonly organizacionId: string }) {
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [verificando, setVerificando] = useState(false);

  const cargar = useCallback(async () => {
    setVerificando(true);
    try {
      const datos = await fetchJson<RespuestaPreflight>(apiBaseUrl, token, `/superadmin/organizaciones/${encodeURIComponent(organizacionId)}/preflight`);
      if (!datos || !Array.isArray(datos.areas) || !datos.resumen) throw new Error("forma inesperada");
      setCarga({ estado: "ok", datos });
    } catch {
      setCarga({ estado: "error", mensaje: "No se pudo verificar la organización." });
    } finally {
      setVerificando(false);
    }
  }, [apiBaseUrl, token, organizacionId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (carga.estado === "cargando") return <EstadoCargando etiqueta="Verificando la organización…" />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;

  const { resumen, areas, fuentes, generadoEn } = carga.datos;
  const fuentesConProblema = Object.entries(fuentes).filter(([, estado]) => estado !== "ok");

  return (
    <div className="grid gap-2.5" aria-label="Listo para producción">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ui text-muted-foreground">Verificado {fechaHoraEsMx(generadoEn)}</p>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={verificando} onClick={() => void cargar()}>
          <RefreshCw className={`size-3.5${verificando ? " animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
          Volver a verificar
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <StatCard
          variante="neutra"
          icon={CircleAlert}
          label="Pendientes"
          value={String(resumen.pendientes)}
          nota={resumen.listo ? "Nada bloquea el go-live." : resumen.pendientes === 0 ? "Sin pendientes, pero hay fuentes sin leer." : "Bloquean el go-live hasta resolverse."}
        />
        <StatCard variante="neutra" icon={TriangleAlert} label="Avisos" value={String(resumen.aviso)} nota="No bloquean, conviene revisarlos." />
        <StatCard variante="neutra" icon={CircleCheck} label="En orden" value={String(resumen.ok)} nota={`de ${resumen.total - resumen.no_aplica} verificaciones que aplican`} />
      </div>

      {fuentesConProblema.length > 0 && (
        <Callout tone="warning" role="status">
          No se pudo leer por completo:{" "}
          {fuentesConProblema.map(([fuente, estado]) => `${NOMBRE_FUENTE[fuente] ?? fuente} (${RAZON_FUENTE_PREFLIGHT[estado] ?? estado})`).join("; ")}. Sus verificaciones salen como aviso, no como en orden.
        </Callout>
      )}

      <div className="grid gap-2.5 lg:grid-cols-2">
        {areas
          .filter((a) => a.verificaciones.length > 0)
          .map((a) => {
            const semaforo = semaforoDeArea(a.verificaciones);
            return (
              <Card key={a.area} className="min-w-0" data-area={a.area} data-semaforo={semaforo}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <ListChecks className="size-4" strokeWidth={1.75} aria-hidden="true" />
                      {NOMBRE_AREA_PREFLIGHT[a.area]}
                    </span>
                    <StatusBadge tone={TONO_ESTADO_PREFLIGHT[semaforo]}>{NOMBRE_ESTADO_PREFLIGHT[semaforo]}</StatusBadge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-dashed divide-line2" aria-label={NOMBRE_AREA_PREFLIGHT[a.area]}>
                    {a.verificaciones.map((v) => (
                      <li key={v.id} className="flex items-start justify-between gap-3 py-1.5 text-ui" data-verificacion={v.id} data-estado={v.estado}>
                        <span className="min-w-0">
                          <span className="block text-foreground">{v.titulo}</span>
                          <span className="block text-xs text-muted-foreground">{v.detalle}</span>
                          {v.estado !== "ok" && v.estado !== "no_aplica" && (
                            <span className="block text-xs text-muted-foreground">
                              {v.como_resolver.texto}{" "}
                              {v.como_resolver.enlace && (
                                <Link to={v.como_resolver.enlace} className="text-primary underline underline-offset-2">
                                  Ir a la pantalla
                                </Link>
                              )}
                            </span>
                          )}
                        </span>
                        <StatusBadge tone={TONO_ESTADO_PREFLIGHT[v.estado]}>{NOMBRE_ESTADO_PREFLIGHT[v.estado]}</StatusBadge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
      </div>
    </div>
  );
}
