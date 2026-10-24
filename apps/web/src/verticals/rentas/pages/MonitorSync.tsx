// Rn-01/Rn-02 -- Monitor de sincronización y conflictos de calendario. Pantalla del staff
// para ver, de un vistazo, el riesgo de overbooking entre canales: estado de cada feed
// iCal (al día / desactualizado / en espera / en cuarentena), las alertas abiertas del
// sync (cuarentena, conflictos detectados, errores) y los conflictos de calendario
// pendientes de resolver (dos reservas de canales distintos sobre las mismas noches, o una
// reserva sobre un bloqueo). Resolver un conflicto es una decisión HUMANA: el sistema
// nunca cancela una reserva por su cuenta. Cada conflicto tiene estado (abierto / resuelto /
// ignorado con motivo) y su historial de decisiones; "Marcar resuelto" solo procede si el
// solape ya no existe (el servidor lo verifica), si no, se ignora indicando el motivo. Las
// horas se muestran en la zona horaria de la property.
//
// Hecha con componentes de @atiende/ui (Card/StatusBadge/Button/Table/Estado*) y el cliente
// lib/ical-monitor-client.ts. Gate de rol en el CLIENTE calcado de
// SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES (el servidor re-valida
// siempre). Contra una base sin la migración 024 las alertas se muestran como "no
// disponibles aún" y resolver responde un error legible -- nunca una pantalla rota.
import { Fragment, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react";
import { Button, Card, Label, PageContainer, StatusBadge, statusTone, Textarea, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import {
  atenderAlertaSync,
  decidirConflicto,
  ETIQUETA_ESTADO_CONFLICTO,
  ETIQUETA_SALUD_FEED,
  ETIQUETA_TIPO_CONFLICTO,
  ETIQUETA_VIGENCIA_SOLAPE,
  fetchConflictos,
  fetchHistorialConflicto,
  fetchMonitorSync,
  validarMotivoDecision,
} from "../lib/ical-monitor-client.ts";
import type { ConflictoCalendario, FiltroEstadoConflictos, HistorialConflicto, MonitorSync, OcupacionConflicto, SeveridadAlerta } from "../lib/ical-monitor-client.ts";
import { resumenSincronizacion, sincronizarFeedAhora } from "../lib/conectividad-client.ts";
import { ESTADO_CONFLICTO_TONES, SALUD_FEED_TONES, SEVERIDAD_ALERTA_TONES, TIPO_CONFLICTO_TONES } from "../lib/status-tones.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES
// (packages/domain-rentas/src/roles.ts) -- apps/web nunca importa un paquete domain-*.
const SYNC_CALENDARIO_LECTURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"]);
const SYNC_CALENDARIO_ESCRITURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

const ETIQUETA_SEVERIDAD: Record<SeveridadAlerta, string> = { info: "Info", aviso: "Aviso", critica: "Crítica" };

const FILTROS: readonly { valor: FiltroEstadoConflictos; etiqueta: string }[] = [
  { valor: "abiertos", etiqueta: "Abiertos" },
  { valor: "resueltos", etiqueta: "Resueltos" },
  { valor: "ignorados", etiqueta: "Ignorados" },
  { valor: "todos", etiqueta: "Todos" },
];


/** Instante en la zona horaria de la PROPERTY (no la del navegador: un gestor en CDMX viendo una
 * property de Cancún debe ver la hora de Cancún). Una zona inválida cae a la del navegador. */
function formatearFechaHora(iso: string | null, zona: string): string {
  if (!iso) return "nunca";
  try {
    return new Date(iso).toLocaleString("es-MX", { timeZone: zona });
  } catch {
    return new Date(iso).toLocaleString("es-MX");
  }
}

function describirOcupacion(o: OcupacionConflicto | null): string {
  if (!o) return "—";
  const origen = o.canal ?? (o.capa === "bloqueo" ? "bloqueo" : "reserva directa");
  return `${origen}: ${o.inicio} → ${o.fin}`;
}

export function MonitorSyncPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? SYNC_CALENDARIO_LECTURA_ROLES.has(org.rol) : false;
  const puedeEscribir = org ? SYNC_CALENDARIO_ESCRITURA_ROLES.has(org.rol) : false;

  const [monitor, setMonitor] = useState<MonitorSync | null>(null);
  const [conflictos, setConflictos] = useState<readonly ConflictoCalendario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  // Resultado de la última "Sincronizar ahora" (Rn-P3-23), por feed.
  const [resultadoSync, setResultadoSync] = useState<{ feedId: string; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [filtro, setFiltro] = useState<FiltroEstadoConflictos>("abiertos");
  // Conflicto cuyo formulario de "Ignorar" está abierto, con su motivo.
  const [ignorando, setIgnorando] = useState<{ id: string; motivo: string } | null>(null);
  // Historial desplegado por conflicto (undefined = cerrado; "cargando" mientras llega).
  const [historiales, setHistoriales] = useState<Readonly<Record<string, HistorialConflicto | "cargando" | "error">>>({});

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const [m, c] = await Promise.all([fetchMonitorSync(fetch, apiBaseUrl, token, propertyId), fetchConflictos(fetch, apiBaseUrl, token, propertyId, filtro)]);
        if (cancelado) return;
        setMonitor(m);
        setConflictos(c.conflictos);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el monitor de sincronización.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeLeer, recarga, filtro]);

  async function ejecutarAccion(id: string, accion: () => Promise<void>) {
    setOcupado(id);
    setErrorAccion(null);
    try {
      await accion();
      setIgnorando(null);
      setHistoriales({});
      setRecarga((n) => n + 1);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(null);
    }
  }

  async function alternarHistorial(id: string) {
    if (historiales[id] !== undefined) {
      setHistoriales((h) => Object.fromEntries(Object.entries(h).filter(([clave]) => clave !== id)));
      return;
    }
    setHistoriales((h) => ({ ...h, [id]: "cargando" }));
    try {
      const historial = await fetchHistorialConflicto(fetch, apiBaseUrl, token, propertyId, id);
      setHistoriales((h) => ({ ...h, [id]: historial }));
    } catch {
      setHistoriales((h) => ({ ...h, [id]: "error" }));
    }
  }

  const encabezado = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Monitor de sincronización</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Estado de cada feed iCal, alertas del sync y conflictos de calendario (dos canales sobre las mismas noches). Resolver un conflicto es una decisión tuya: el sistema nunca cancela una
          reserva solo.
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
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso al monitor de sincronización. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong>,{" "}
          <strong className="text-foreground">operador:calendario_mensajeria</strong> y <strong className="text-foreground">operador:solo_calendario</strong>.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      {encabezado}

      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!error && (monitor === null || conflictos === null) && <EstadoCargando lineas={4} />}

      {!error && monitor !== null && conflictos !== null && (
        <>
          {errorAccion && <EstadoError mensaje={errorAccion} />}

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm">Conflictos de calendario ({monitor.conflictosAbiertos} abiertos)</CardTitle>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar conflictos por estado">
                {FILTROS.map((f) => (
                  <Button key={f.valor} type="button" size="sm" variant={filtro === f.valor ? "default" : "outline"} aria-pressed={filtro === f.valor} onClick={() => setFiltro(f.valor)}>
                    {f.etiqueta}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className={conflictos.length === 0 ? undefined : "p-0"}>
              {conflictos.length === 0 ? (
                <EstadoVacio
                  icon={CheckCircle2}
                  titulo={filtro === "abiertos" ? "Sin conflictos abiertos" : "Sin conflictos en este filtro"}
                  mensaje={filtro === "abiertos" ? "No hay dos reservas de canales distintos sobre las mismas noches pendientes de revisar." : "Ningún conflicto coincide con el estado elegido."}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unidad</TableHead>
                      <TableHead>Tipo / estado</TableHead>
                      <TableHead>Reservas en pugna</TableHead>
                      <TableHead>Detectado</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conflictos.map((k) => {
                      const historial = historiales[k.id];
                      return (
                        <Fragment key={k.id}>
                          <TableRow>
                            <TableCell className="text-xs">{k.unidadNombre ?? k.unidadId}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1">
                                <StatusBadge tone={statusTone(TIPO_CONFLICTO_TONES, k.tipo)}>
                                  {ETIQUETA_TIPO_CONFLICTO[k.tipo]}
                                </StatusBadge>
                                <StatusBadge tone={statusTone(ESTADO_CONFLICTO_TONES, k.estado)}>
                                  {ETIQUETA_ESTADO_CONFLICTO[k.estado]}
                                </StatusBadge>
                              </div>
                              {k.motivoResolucion && <div className="mt-1 text-xs text-muted-foreground">Motivo: {k.motivoResolucion}</div>}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div>{describirOcupacion(k.ocupacionA)}</div>
                              <div className="text-muted-foreground">{describirOcupacion(k.ocupacionB)}</div>
                              {k.solape && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  Noches en conflicto: {k.solape.inicio} → {k.solape.fin} ({ETIQUETA_VIGENCIA_SOLAPE[k.solape.vigencia]})
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {k.detectadoEnLocal ?? formatearFechaHora(k.detectadoEn, monitor.zonaHoraria)}
                              {k.resueltoEn && <div>Cerrado: {k.resueltoEnLocal ?? formatearFechaHora(k.resueltoEn, monitor.zonaHoraria)}</div>}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {puedeEscribir && k.estado === "abierto" && (
                                  <>
                                    <Button type="button" size="sm" variant="outline" disabled={ocupado === k.id} onClick={() => ejecutarAccion(k.id, () => decidirConflicto(fetch, apiBaseUrl, token, propertyId, k.id, { accion: "resuelto" }))}>
                                      {ocupado === k.id ? "Guardando…" : "Marcar resuelto"}
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" disabled={ocupado === k.id} onClick={() => setIgnorando(ignorando?.id === k.id ? null : { id: k.id, motivo: "" })}>
                                      Ignorar…
                                    </Button>
                                  </>
                                )}
                                {k.estado !== "abierto" && (
                                  <Button type="button" size="sm" variant="ghost" onClick={() => alternarHistorial(k.id)}>
                                    {historial === undefined ? "Ver historial" : "Ocultar historial"}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                          {ignorando?.id === k.id && (
                            <TableRow>
                              <TableCell colSpan={5}>
                                <form
                                  className="flex flex-col gap-2"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const error = validarMotivoDecision({ accion: "ignorado", motivo: ignorando.motivo });
                                    if (error) {
                                      setErrorAccion(error);
                                      return;
                                    }
                                    void ejecutarAccion(k.id, () => decidirConflicto(fetch, apiBaseUrl, token, propertyId, k.id, { accion: "ignorado", motivo: ignorando.motivo }));
                                  }}
                                >
                                  <Label htmlFor={`motivo-${k.id}`} className="text-xs">
                                    Motivo para ignorar este conflicto (queda en el historial)
                                  </Label>
                                  <Textarea
                                    id={`motivo-${k.id}`}
                                    value={ignorando.motivo}
                                    maxLength={500}
                                    rows={2}
                                    placeholder="Ej.: es el mismo huésped reservando en dos plataformas"
                                    onChange={(e) => setIgnorando({ id: k.id, motivo: e.target.value })}
                                  />
                                  <div className="flex gap-2">
                                    <Button type="submit" size="sm" disabled={ocupado === k.id}>
                                      {ocupado === k.id ? "Guardando…" : "Ignorar conflicto"}
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" onClick={() => setIgnorando(null)}>
                                      Cancelar
                                    </Button>
                                  </div>
                                </form>
                              </TableCell>
                            </TableRow>
                          )}
                          {historial !== undefined && (
                            <TableRow>
                              <TableCell colSpan={5} className="text-xs">
                                {historial === "cargando" && <span className="text-muted-foreground">Cargando historial…</span>}
                                {historial === "error" && <span className="text-destructive">No se pudo cargar el historial.</span>}
                                {typeof historial === "object" &&
                                  (!historial.disponible ? (
                                    <span className="text-muted-foreground">El historial de decisiones todavía no está habilitado en esta base de datos.</span>
                                  ) : historial.entradas.length === 0 ? (
                                    <span className="text-muted-foreground">Sin decisiones registradas.</span>
                                  ) : (
                                    <ul className="m-0 list-none p-0">
                                      {historial.entradas.map((e) => (
                                        <li key={e.id}>
                                          {e.creadoEnLocal ?? "—"} · {e.accion === "ignorado" ? "Ignorado" : "Resuelto"} por {e.porMi ? "ti" : "otro miembro del equipo"}
                                          {e.motivo ? ` — ${e.motivo}` : ""}
                                        </li>
                                      ))}
                                    </ul>
                                  ))}
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Salud por canal</CardTitle>
            </CardHeader>
            <CardContent className={monitor.resumenPorCanal.length > 0 ? "p-0" : undefined}>
              {monitor.resumenPorCanal.length === 0 ? (
                <EstadoVacio icon={AlertTriangle} titulo="Sin canales conectados" mensaje="Cuando conectes un feed iCal, aquí verás el estado de cada canal de un vistazo." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canal</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Feeds</TableHead>
                      <TableHead>Unidades con problema</TableHead>
                      <TableHead>Sincronización más antigua</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monitor.resumenPorCanal.map((r) => (
                      <TableRow key={r.canal}>
                        <TableCell className="text-xs">{r.canal}</TableCell>
                        <TableCell>
                          <StatusBadge tone={statusTone(SALUD_FEED_TONES, r.peor)}>
                            {ETIQUETA_SALUD_FEED[r.peor]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-xs">{r.totalFeeds}</TableCell>
                        <TableCell className="text-xs">{r.unidadesConProblema}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatearFechaHora(r.sincronizacionMasAntiguaEn, monitor.zonaHoraria)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Alertas del sync ({monitor.alertas.length})</CardTitle>
            </CardHeader>
            <CardContent className={monitor.alertasDisponibles && monitor.alertas.length > 0 ? "p-0" : undefined}>
              {!monitor.alertasDisponibles ? (
                <EstadoVacio icon={AlertTriangle} titulo="Alertas no disponibles aún" mensaje="La bitácora de sincronización todavía no está habilitada en esta base de datos. Los conflictos y el estado de los feeds de arriba y abajo sí son reales." />
              ) : monitor.alertas.length === 0 ? (
                <EstadoVacio icon={CheckCircle2} titulo="Sin alertas abiertas" mensaje="Ningún feed requiere atención ahora mismo." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severidad</TableHead>
                      <TableHead>Canal / unidad</TableHead>
                      <TableHead>Detalle</TableHead>
                      <TableHead>Cuándo</TableHead>
                      {puedeEscribir && <TableHead />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monitor.alertas.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <StatusBadge tone={statusTone(SEVERIDAD_ALERTA_TONES, a.severidad)}>
                            {ETIQUETA_SEVERIDAD[a.severidad]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.canal} · {a.unidadNombre ?? a.unidadId}
                        </TableCell>
                        <TableCell className="text-xs">{a.detalle}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatearFechaHora(a.creadoEn, monitor.zonaHoraria)}</TableCell>
                        {puedeEscribir && (
                          <TableCell>
                            <Button type="button" size="sm" variant="outline" disabled={ocupado === a.id} onClick={() => ejecutarAccion(a.id, () => atenderAlertaSync(fetch, apiBaseUrl, token, propertyId, a.id))}>
                              {ocupado === a.id ? "Guardando…" : "Marcar atendida"}
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Feeds conectados ({monitor.feeds.length})</CardTitle>
            </CardHeader>
            <CardContent className={monitor.feeds.length > 0 ? "p-0" : undefined}>
              {monitor.feeds.length === 0 ? (
                <EstadoVacio icon={AlertTriangle} titulo="Sin feeds conectados" mensaje="Conecta el feed iCal de un canal en Sincronización iCal para empezar a evitar doble reserva." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canal / unidad</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Última sincronización exitosa</TableHead>
                      <TableHead>Próximo intento</TableHead>
                      {puedeEscribir && <TableHead />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monitor.feeds.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="text-xs">
                          {f.canal} · {f.unidadNombre ?? f.unidadId}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={statusTone(SALUD_FEED_TONES, f.salud)} title={f.motivoCuarentena ?? undefined}>
                            {ETIQUETA_SALUD_FEED[f.salud]}
                          </StatusBadge>
                          {f.intentosFallidosConsecutivos > 0 && <span className="ml-2 text-xs text-muted-foreground">{f.intentosFallidosConsecutivos} fallo(s) seguidos</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatearFechaHora(f.ultimaSincronizacionExitosaEn, monitor.zonaHoraria)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{f.proximoIntentoEn ? formatearFechaHora(f.proximoIntentoEn, monitor.zonaHoraria) : "—"}</TableCell>
                        {puedeEscribir && (
                          <TableCell className="text-right">
                            {f.activo && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={ocupado === f.id}
                                onClick={() =>
                                  void ejecutarAccion(f.id, async () => {
                                    const r = await sincronizarFeedAhora(fetch, apiBaseUrl, token, propertyId, f.unidadId, f.canal);
                                    setResultadoSync({ feedId: f.id, texto: resumenSincronizacion(r) });
                                  })
                                }
                              >
                                <RefreshCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {ocupado === f.id ? "Sincronizando…" : "Sincronizar ahora"}
                              </Button>
                            )}
                            {resultadoSync?.feedId === f.id && (
                              <p role="status" className="m-0 mt-1 text-xs text-muted-foreground">
                                {resultadoSync.texto}
                              </p>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
