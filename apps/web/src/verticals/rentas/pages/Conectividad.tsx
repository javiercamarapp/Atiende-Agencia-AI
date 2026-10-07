// Paridad3 Rn-P3-15/16/17 -- Conectividad por unidad y canal. Tres bloques, todos con datos REALES (ningún estado se
// marca a mano ni se inventa):
//  1. Matriz: filas = unidades, columnas = canales con feed iCal. Cada celda sale del monitor de sync (import) y de las
//     consultas reales de la OTA al token de exportación (export): conectado, solo importa, solo exporta, sin conectar,
//     pendiente de sincronizar, fallando o en cuarentena. La columna lleva la latencia declarada y su confianza.
//  2. Asistente paso a paso de la celda elegida: cada paso verificable se marca con evidencia (feed conectado, última
//     sincronización, URL con token creada, última consulta del canal); lo que se hace dentro del panel del canal queda
//     sin marca. La acción real (conectar, probar, rotar la URL, sincronizar) vive en Sincronización iCal.
//  3. Catálogo de canales de México: vía de hoy, latencia con fuente, y el motivo exacto con su cita cuando la vía está
//     bloqueada (API de partner). NUNCA un botón "Conectar API": sin adaptador no se ofrece nada que parezca funcionar.
// Gate de rol en el CLIENTE calcado de SYNC_CALENDARIO_LECTURA_ROLES; el servidor re-valida siempre.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Circle, ExternalLink, Network, RefreshCcw } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, statusTone, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { ETIQUETA_ESTADO_CELDA, fetchCatalogoCanales, fetchMatrizConectividad, pasosAsistente } from "../lib/conectividad-client.ts";
import type { CanalCatalogo, CeldaConectividad, MatrizConectividad, ViaHoy } from "../lib/conectividad-client.ts";
import { CELDA_CONECTIVIDAD_TONES } from "../lib/status-tones.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de SYNC_CALENDARIO_LECTURA_ROLES (packages/domain-rentas/src/roles.ts) -- apps/web nunca importa un paquete domain-*.
const SYNC_CALENDARIO_LECTURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"]);

const ETIQUETA_VIA_HOY: Record<ViaHoy, string> = {
  ical: "iCal disponible",
  partner: "Requiere acuerdo de partner",
  manual: "Manual (sin feed)",
  sin_evidencia: "Sin evidencia",
  sin_adaptador: "Sin adaptador en Atiende",
};
const TONO_VIA_HOY: Record<ViaHoy, "success" | "warning" | "neutral"> = { ical: "success", partner: "warning", manual: "neutral", sin_evidencia: "warning", sin_adaptador: "neutral" };
const ETIQUETA_CONFIANZA = { alta: "alta", media: "media", baja: "baja", sin_evidencia: "sin evidencia" } as const;

function fechaCorta(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("es-MX") : "nunca";
}

function detalleCelda(c: CeldaConectividad): string | null {
  if (c.estado === "en_cuarentena") return c.import.motivoCuarentena ?? "Feed en cuarentena.";
  if (c.estado === "fallando") return `${c.import.intentosFallidosConsecutivos} intento(s) fallido(s) seguido(s).`;
  if (c.export.ultimoAccesoEn) return `El canal consultó: ${fechaCorta(c.export.ultimoAccesoEn)}`;
  if (c.import.ultimaSincronizacionExitosaEn) return `Última sincronización: ${fechaCorta(c.import.ultimaSincronizacionExitosaEn)}`;
  return null;
}

export function ConectividadPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? SYNC_CALENDARIO_LECTURA_ROLES.has(org.rol) : false;
  const [params, setParams] = useSearchParams();

  const [matriz, setMatriz] = useState<MatrizConectividad | null>(null);
  const [catalogo, setCatalogo] = useState<readonly CanalCatalogo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const [m, c] = await Promise.all([fetchMatrizConectividad(fetch, apiBaseUrl, token, propertyId), fetchCatalogoCanales(fetch, apiBaseUrl, token, propertyId)]);
        if (cancelado) return;
        setMatriz(m);
        setCatalogo(c);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la conectividad de los canales.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeLeer, recarga]);

  const encabezado = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Conectividad de canales</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Estado real de cada unidad en cada canal, con la latencia que declara el canal y el motivo exacto de lo que todavía no se puede conectar. Cada canal funciona distinto: no asumas que lo que pasa
          con uno pasa igual con otro.
        </p>
      </div>
      {puedeLeer && (
        <Button type="button" variant="outline" size="sm" onClick={() => setRecarga((n) => n + 1)}>
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Actualizar
        </Button>
      )}
    </header>
  );

  if (!puedeLeer) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        {encabezado}
        <p className="m-0 text-sm text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a la conectividad de canales. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong>,{" "}
          <strong className="text-foreground">operador:calendario_mensajeria</strong> y <strong className="text-foreground">operador:solo_calendario</strong>.
        </p>
      </PageContainer>
    );
  }

  const unidadSel = params.get("unidad");
  const canalSel = params.get("canal");
  const columnas = matriz?.canales ?? [];
  const celdaSel = matriz && unidadSel && canalSel ? matriz.unidades.find((u) => u.id === unidadSel)?.celdas.find((c) => c.canal === canalSel) : undefined;
  const canalCatSel = columnas.find((c) => c.canalAtiende === canalSel);
  const unidadNombreSel = matriz?.unidades.find((u) => u.id === unidadSel)?.nombre;

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      {encabezado}

      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!error && (matriz === null || catalogo === null) && <EstadoCargando lineas={4} />}

      {!error && matriz !== null && catalogo !== null && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Matriz de conectividad</CardTitle>
            </CardHeader>
            <CardContent className={matriz.unidades.length > 0 ? "p-0" : undefined}>
              {matriz.unidades.length === 0 ? (
                <EstadoVacio icon={Network} titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene unidades. Da de alta una en Catálogo para conectarla a los canales." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unidad</TableHead>
                      {columnas.map((c) => (
                        <TableHead key={c.codigo}>
                          <span className="block text-foreground">{c.nombre}</span>
                          <span className="block text-2xs font-normal normal-case text-muted-foreground">
                            Latencia: {c.latencia.texto} ({ETIQUETA_CONFIANZA[c.latencia.confianza]})
                          </span>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matriz.unidades.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="text-xs font-medium">{u.nombre}</TableCell>
                        {columnas.map((c) => {
                          const celda = u.celdas.find((x) => x.canal === c.canalAtiende);
                          if (!celda) return <TableCell key={c.codigo} />;
                          const detalle = detalleCelda(celda);
                          return (
                            <TableCell key={c.codigo} className="align-top">
                              <div className="flex flex-col items-start gap-1">
                                <StatusBadge tone={statusTone(CELDA_CONECTIVIDAD_TONES, celda.estado)}>{ETIQUETA_ESTADO_CELDA[celda.estado]}</StatusBadge>
                                {detalle && <span className="text-2xs text-muted-foreground">{detalle}</span>}
                                {celda.export.estado === "no_disponible_aun" && <span className="text-2xs text-muted-foreground">Exportación: no disponible aún en este entorno.</span>}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Abrir el asistente de ${u.nombre} en ${c.nombre}`}
                                  onClick={() => setParams({ unidad: u.id, canal: c.canalAtiende ?? "" })}
                                >
                                  Asistente
                                </Button>
                              </div>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {celdaSel && canalCatSel && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm">
                  Asistente: {canalCatSel.nombre} · {unidadNombreSel}
                </CardTitle>
                <div className="flex flex-wrap gap-1.5">
                  <Button asChild size="sm">
                    <Link to={`/rentas/${orgSlug}/ical-sync`}>Abrir Sincronización iCal</Link>
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setParams({})}>
                    Cerrar
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {canalCatSel.viaIcal !== "disponible" && (
                  <div role="note" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
                    <div className="flex flex-col gap-1">
                      <p className="m-0 font-semibold text-foreground">Sin evidencia de que {canalCatSel.nombre} ofrezca iCal</p>
                      <p className="m-0 text-muted-foreground">{canalCatSel.descripcionVia}.</p>
                      {canalCatSel.bloqueo && (
                        <p className="m-0 text-muted-foreground">
                          {canalCatSel.bloqueo.motivo} <span className="italic">({canalCatSel.bloqueo.cita})</span>
                        </p>
                      )}
                    </div>
                  </div>
                )}
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {pasosAsistente(canalCatSel, celdaSel).map((paso, i) => (
                    <li key={paso.id} className="flex items-start gap-2 text-sm">
                      {paso.hecho === true ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" strokeWidth={1.75} aria-label="Hecho" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-label={paso.hecho === false ? "Pendiente" : "Sin verificar"} />
                      )}
                      <div className="flex flex-col">
                        <span className="text-foreground">
                          {i + 1}. {paso.texto}
                        </span>
                        <span className="text-xs text-muted-foreground">{paso.evidencia}</span>
                      </div>
                    </li>
                  ))}
                </ol>
                {canalCatSel.urlProcesoOficial && (
                  <a href={canalCatSel.urlProcesoOficial} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs text-primary hover:underline">
                    Ayuda oficial de {canalCatSel.nombre} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                )}
                <p className="m-0 text-xs text-muted-foreground">
                  El estado de conexión nunca se marca a mano: cambia solo cuando hay evidencia real de sincronización o de que el canal consultó tu calendario.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Canales de distribución en México</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="m-0 text-xs text-muted-foreground">
                Datos tomados de las fichas de investigación de cada canal. Lo que no tiene fuente aparece como «sin evidencia»: no se muestra ninguna cifra estimada. Los canales que requieren un acuerdo de
                partner no tienen conexión por API en Atiende todavía.
              </p>
              <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
                {catalogo.map((c) => (
                  <li key={c.codigo} className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{c.nombre}</span>
                      <StatusBadge tone={statusTone(TONO_VIA_HOY, c.viaHoy)}>{ETIQUETA_VIA_HOY[c.viaHoy]}</StatusBadge>
                    </div>
                    <p className="m-0 text-muted-foreground">{c.descripcionVia}</p>
                    <p className="m-0 text-muted-foreground">
                      <strong className="text-foreground">Latencia:</strong> {c.latencia.texto} (confianza {ETIQUETA_CONFIANZA[c.latencia.confianza]}
                      {c.latencia.fuente ? `; fuente ${c.latencia.fuente}` : ""})
                    </p>
                    {c.bloqueo && (
                      <p className="m-0 text-muted-foreground">
                        <strong className="text-foreground">Por qué no hay conexión directa:</strong> {c.bloqueo.motivo} <span className="italic">({c.bloqueo.cita})</span>
                      </p>
                    )}
                    {c.requisitos.length > 0 && (
                      <p className="m-0 text-muted-foreground">
                        <strong className="text-foreground">Qué hay que conseguir:</strong> {c.requisitos.join("; ")}.
                      </p>
                    )}
                    {c.urlProcesoOficial && (
                      <a href={c.urlProcesoOficial} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-primary hover:underline">
                        Proceso oficial <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
