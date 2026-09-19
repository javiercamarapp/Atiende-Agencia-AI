// "Romper cristal" (break-glass) -- Fase 10b, cierra el gap señalado por la
// auditoría del 18-sep-2026 ("break-glass de superadmin construido pero
// desconectado de toda ruta HTTP", y del panel). Backend real: apps/api/src/
// routes/superadmin-break-glass.ts (ya verificado contra las funciones security
// definer de rentas.break_glass_session/rentas.break_glass_access_log). Mismo
// patrón de sesión/manejo de errores que GastoApi.tsx/Prospectos.tsx.
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { AlertOctagon, Clock, DoorOpen, History, Lock, Unlock } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";

interface Sesion {
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly openedAtMs: number;
  readonly expiresAtMs: number;
  readonly closedAtMs: number | null;
  readonly closedBy: string | null;
  readonly activa: boolean;
  readonly remainingMs: number;
}

interface BitacoraEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly resourceType: string;
  readonly resourceScope: Record<string, unknown>;
  readonly resultSummary: { readonly total?: number } & Record<string, unknown>;
  readonly occurredAtMs: number;
  readonly seq: number;
  readonly hash: string;
}

interface ReservaResumen {
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly estado: string;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
}

// Fase 10c -- lectores restantes del break-glass (ver packages/domain-rentas/src/
// break-glass/tipos.ts para el tipo real que cada uno espeja; los nombres de campo
// son EXACTAMENTE los que c.json() serializa desde esas interfaces TS, ver
// apps/api/src/routes/superadmin-break-glass.ts::registrarLectorTenant).
interface FinanzasResumen {
  readonly id: string;
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly moneda: string;
  readonly montoBrutoCentavos: number;
  readonly netoCentavos: number;
  readonly createdAtMs: number;
}

interface PayoutResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly canalId: string;
  readonly referenciaExterna: string | null;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
}

interface PricingResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string;
}

interface MensajeriaResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalCodigo: string;
  readonly huespedNombre: string | null;
  readonly fechaCheckIn: string | null;
  readonly fechaCheckOut: string | null;
  readonly reservaConfirmada: boolean;
}

interface LimpiezaResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly tipo: string;
  readonly estado: string;
  readonly prioridad: string;
  readonly programadaPara: string;
}

/** `urlImportacionEnmascarada` -- NUNCA la URL completa, ver el comentario de
 *  cabecera de `rentas.list_sync_ical_for_break_glass` (020_break_glass_lectores.sql). */
interface SyncIcalResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly urlImportacionEnmascarada: string;
  readonly activo: boolean;
  readonly intentosFallidosConsecutivos: number;
  readonly motivoCuarentena: string | null;
}

function centavosAMoneda(centavos: number, moneda: string): string {
  return `${(centavos / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda}`;
}

/** Un recurso del break-glass -- ruta de API (`path`), clave del JSON de
 *  respuesta (`jsonKey`), etiqueta de pestaña, y cómo pintar una fila de su
 *  propio tipo. Mismo orden que `registrarLectorTenant` en la API. */
interface RecursoBreakGlass {
  readonly key: string;
  readonly path: string;
  readonly jsonKey: string;
  readonly etiqueta: string;
  readonly renderFila: (item: Record<string, unknown>) => string;
  readonly mensajeVacio: string;
}

const RECURSOS: readonly RecursoBreakGlass[] = [
  {
    key: "reservas",
    path: "reservas",
    jsonKey: "reservas",
    etiqueta: "Reservas",
    mensajeVacio: "El tenant no tiene reservas directas registradas.",
    renderFila: (i) => {
      const r = i as unknown as ReservaResumen;
      return `${r.checkIn} → ${r.checkOut} · ${r.estado} · ${r.huespedNombre ?? "sin nombre registrado"}`;
    },
  },
  {
    key: "finanzas",
    path: "finanzas",
    jsonKey: "finanzas",
    etiqueta: "Finanzas",
    mensajeVacio: "El tenant no tiene movimiento financiero por reserva registrado.",
    renderFila: (i) => {
      const r = i as unknown as FinanzasResumen;
      return `Bruto ${centavosAMoneda(r.montoBrutoCentavos, r.moneda)} · Neto ${centavosAMoneda(r.netoCentavos, r.moneda)}`;
    },
  },
  {
    key: "payouts",
    path: "payouts",
    jsonKey: "payouts",
    etiqueta: "Payouts",
    mensajeVacio: "El tenant no tiene payouts por canal registrados.",
    renderFila: (i) => {
      const r = i as unknown as PayoutResumen;
      return `${r.fechaPayout} · ${centavosAMoneda(r.montoTotalCentavos, r.moneda)}${r.referenciaExterna ? ` · ${r.referenciaExterna}` : ""}`;
    },
  },
  {
    key: "pricing",
    path: "pricing",
    jsonKey: "pricing",
    etiqueta: "Pricing",
    mensajeVacio: "El tenant no tiene tarifa base registrada.",
    renderFila: (i) => {
      const r = i as unknown as PricingResumen;
      return `Desde ${r.vigenteDesde} · ${centavosAMoneda(r.precioNocheCentavos, r.moneda)}/noche`;
    },
  },
  {
    key: "mensajeria",
    path: "mensajeria",
    jsonKey: "mensajeria",
    etiqueta: "Mensajería",
    mensajeVacio: "El tenant no tiene conversaciones con huéspedes registradas.",
    renderFila: (i) => {
      const r = i as unknown as MensajeriaResumen;
      return `${r.canalCodigo} · ${r.huespedNombre ?? "sin nombre registrado"}${r.reservaConfirmada ? " · reserva confirmada" : ""}`;
    },
  },
  {
    key: "limpieza",
    path: "limpieza",
    jsonKey: "limpieza",
    etiqueta: "Limpieza/mantenimiento",
    mensajeVacio: "El tenant no tiene tareas de limpieza/mantenimiento/inspección registradas.",
    renderFila: (i) => {
      const r = i as unknown as LimpiezaResumen;
      return `${r.programadaPara} · ${r.tipo} · ${r.estado} (${r.prioridad})`;
    },
  },
  {
    key: "sync_ical",
    path: "sync-ical",
    jsonKey: "syncIcal",
    etiqueta: "Sync iCal",
    mensajeVacio: "El tenant no tiene feeds de sincronización de calendario conectados.",
    renderFila: (i) => {
      const r = i as unknown as SyncIcalResumen;
      return `${r.urlImportacionEnmascarada} · ${r.activo ? "activo" : "inactivo"}${r.motivoCuarentena ? ` · en cuarentena: ${r.motivoCuarentena}` : ""}`;
    },
  },
];

const DURACIONES = [
  { minutos: 15, etiqueta: "15 minutos" },
  { minutos: 30, etiqueta: "30 minutos" },
  { minutos: 60, etiqueta: "1 hora" },
  { minutos: 120, etiqueta: "2 horas" },
  { minutos: 240, etiqueta: "4 horas (máximo)" },
];

function fechaHoraEsMx(ms: number): string {
  return new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

function duracionRestante(remainingMs: number): string {
  const totalMin = Math.floor(remainingMs / 60_000);
  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;
  if (horas > 0) return `${horas}h ${minutos}min`;
  return `${minutos}min`;
}

function EstadoSesion({ sesion }: { readonly sesion: Sesion }) {
  if (sesion.activa) return <Badge>Activa · {duracionRestante(sesion.remainingMs)} restantes</Badge>;
  if (sesion.closedAtMs) return <Badge variant="outline">Cerrada manualmente</Badge>;
  return <Badge variant="outline">Vencida</Badge>;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

export function SuperAdminBreakGlassPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [sesiones, setSesiones] = useState<readonly Sesion[] | null>(null);
  const [bitacora, setBitacora] = useState<readonly BitacoraEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const [abriendo, setAbriendo] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [duracionMinutos, setDuracionMinutos] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [cerrando, setCerrando] = useState<string | null>(null);

  // Fase 10c -- panel de datos del tenant, generalizado a los 7 recursos de
  // RECURSOS (antes solo cubría reservas). `datosPanelSesionId` es la sesión
  // activa cuyo panel está abierto (o null si está cerrado); `recursoActivo` es
  // la pestaña seleccionada dentro de ese panel; `filtroPropertyId` es el
  // filtro opcional por propiedad, compartido por las 7 pestañas del MISMO
  // panel (se limpia al cambiar de sesión). Cada recurso se cachea por separado
  // en `datosPorRecurso`/`errorPorRecurso` -- cambiar de pestaña no vuelve a
  // pedir un recurso ya leído en esta sesión de UI, salvo que cambie el filtro
  // por propiedad (`datosPorRecurso` se limpia en ese caso).
  const [datosPanelSesionId, setDatosPanelSesionId] = useState<string | null>(null);
  const [recursoActivo, setRecursoActivo] = useState<string>(RECURSOS[0]!.key);
  const [filtroPropertyId, setFiltroPropertyId] = useState("");
  const [datosPorRecurso, setDatosPorRecurso] = useState<Record<string, readonly Record<string, unknown>[] | null>>({});
  const [errorPorRecurso, setErrorPorRecurso] = useState<Record<string, string | null>>({});
  const [cargandoRecurso, setCargandoRecurso] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const [s, b] = await Promise.all([
        fetchJson<{ sessions: Sesion[] }>(apiBaseUrl, token, "/superadmin/break-glass/sesiones"),
        fetchJson<{ entries: BitacoraEntry[] }>(apiBaseUrl, token, "/superadmin/break-glass/bitacora"),
      ]);
      setSesiones(s.sessions);
      setBitacora(b.entries);
    } catch {
      setError("No se pudo cargar el estado de romper-cristal.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  function abrirModal() {
    setOrgId("");
    setMotivo("");
    setDuracionMinutos(30);
    setFormError(null);
    setAbriendo(true);
  }

  async function abrirAcceso(e: FormEvent) {
    e.preventDefault();
    if (!orgId.trim()) {
      setFormError("El id de la organización es obligatorio.");
      return;
    }
    if (motivo.trim().length < 20) {
      setFormError("El motivo debe tener al menos 20 caracteres -- una justificación real, no un placeholder.");
      return;
    }
    setFormError(null);
    setGuardando(true);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/break-glass/sesiones", {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId.trim(), reason: motivo, durationMinutes: duracionMinutos }),
      });
      setAbriendo(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo abrir el acceso de emergencia.");
    } finally {
      setGuardando(false);
    }
  }

  async function cerrarAcceso(sesion: Sesion) {
    setCerrando(sesion.id);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/break-glass/sesiones/${sesion.id}/cerrar`, { method: "POST" });
      await cargar();
    } catch {
      setError("No se pudo cerrar el acceso.");
    } finally {
      setCerrando(null);
    }
  }

  function togglePanelDatos(sesion: Sesion) {
    if (datosPanelSesionId === sesion.id) {
      setDatosPanelSesionId(null);
      return;
    }
    setDatosPanelSesionId(sesion.id);
    setRecursoActivo(RECURSOS[0]!.key);
    setFiltroPropertyId("");
    setDatosPorRecurso({});
    setErrorPorRecurso({});
    void leerRecurso(sesion, RECURSOS[0]!, "");
  }

  async function leerRecurso(sesion: Sesion, recurso: RecursoBreakGlass, propertyId: string) {
    setCargandoRecurso(recurso.key);
    setErrorPorRecurso((prev) => ({ ...prev, [recurso.key]: null }));
    try {
      const qs = propertyId.trim() ? `?propertyId=${encodeURIComponent(propertyId.trim())}` : "";
      const r = await fetchJson<Record<string, Record<string, unknown>[]>>(
        apiBaseUrl,
        token,
        `/superadmin/break-glass/organizaciones/${sesion.organizationId}/${recurso.path}${qs}`,
      );
      setDatosPorRecurso((prev) => ({ ...prev, [recurso.key]: r[recurso.jsonKey] ?? [] }));
    } catch (err) {
      setErrorPorRecurso((prev) => ({ ...prev, [recurso.key]: err instanceof Error ? err.message : `No se pudo leer "${recurso.etiqueta}" del tenant.` }));
    } finally {
      setCargandoRecurso(null);
    }
  }

  function cambiarRecursoActivo(sesion: Sesion, key: string) {
    setRecursoActivo(key);
    if (datosPorRecurso[key] === undefined) {
      const recurso = RECURSOS.find((r) => r.key === key);
      if (recurso) void leerRecurso(sesion, recurso, filtroPropertyId);
    }
  }

  function aplicarFiltroPropiedad(sesion: Sesion, propertyId: string) {
    setFiltroPropertyId(propertyId);
    setDatosPorRecurso({});
    setErrorPorRecurso({});
    const recurso = RECURSOS.find((r) => r.key === recursoActivo) ?? RECURSOS[0]!;
    void leerRecurso(sesion, recurso, propertyId);
  }

  if (error && !sesiones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!sesiones || !bitacora) return <EstadoCargando etiqueta="Cargando romper-cristal…" />;

  const activas = sesiones.filter((s) => s.activa);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <AlertOctagon className="w-5 h-5 text-destructive" strokeWidth={1.75} />
            Romper cristal
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Acceso de emergencia, auditado e inalterable, a los datos de un tenant de rentas fuera del flujo normal de autorización.
          </p>
        </div>
        <Button className="rounded-full gap-1.5" onClick={abrirModal}>
          <DoorOpen className="w-3.5 h-3.5" strokeWidth={1.75} />
          Abrir acceso de emergencia
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard label="Accesos activos ahora" value={String(activas.length)} icon={Unlock} />
        <StatCard label="Accesos totales (histórico)" value={String(sesiones.length)} icon={History} />
        <StatCard label="Lecturas en la bitácora" value={String(bitacora.length)} icon={Lock} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accesos de emergencia — activos e históricos</CardTitle>
        </CardHeader>
        <CardContent>
          {sesiones.length === 0 ? (
            <EstadoVacio mensaje="Todavía no has abierto ningún acceso de romper-cristal." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Abierto</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sesiones.map((s) => (
                    <Fragment key={s.id}>
                      <TableRow>
                        <TableCell className="font-mono text-xs">{s.organizationId}</TableCell>
                        <TableCell className="max-w-[320px] truncate" title={s.reason}>
                          {s.reason}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{fechaHoraEsMx(s.openedAtMs)}</TableCell>
                        <TableCell>
                          <EstadoSesion sesion={s} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 justify-end">
                            {s.activa && (
                              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => togglePanelDatos(s)}>
                                <Clock className="w-3.5 h-3.5" strokeWidth={1.75} />
                                {datosPanelSesionId === s.id ? "Ocultar datos del tenant" : "Ver datos del tenant"}
                              </Button>
                            )}
                            {s.activa && (
                              <Button variant="outline" size="sm" onClick={() => void cerrarAcceso(s)} disabled={cerrando === s.id}>
                                {cerrando === s.id ? "Cerrando…" : "Cerrar"}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {datosPanelSesionId === s.id && (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/30 p-3">
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center gap-2">
                                <Label htmlFor={`break-glass-property-filter-${s.id}`} className="text-xs text-muted-foreground whitespace-nowrap">
                                  Filtrar por propiedad (opcional)
                                </Label>
                                <Input
                                  id={`break-glass-property-filter-${s.id}`}
                                  value={filtroPropertyId}
                                  onChange={(e) => setFiltroPropertyId(e.target.value)}
                                  onBlur={() => aplicarFiltroPropiedad(s, filtroPropertyId)}
                                  onKeyDown={(e) => e.key === "Enter" && aplicarFiltroPropiedad(s, filtroPropertyId)}
                                  placeholder="uuid de la propiedad"
                                  className="h-7 max-w-xs text-xs"
                                />
                              </div>
                              <Tabs value={recursoActivo} onValueChange={(key) => cambiarRecursoActivo(s, key)}>
                                <TabsList className="h-9 flex-wrap">
                                  {RECURSOS.map((r) => (
                                    <TabsTrigger key={r.key} value={r.key} className="text-xs px-2.5 py-1">
                                      {r.etiqueta}
                                    </TabsTrigger>
                                  ))}
                                </TabsList>
                                {RECURSOS.map((r) => {
                                  const datos = datosPorRecurso[r.key];
                                  const err = errorPorRecurso[r.key];
                                  return (
                                    <TabsContent key={r.key} value={r.key}>
                                      {cargandoRecurso === r.key && <p className="text-xs text-muted-foreground p-2">Leyendo {r.etiqueta.toLowerCase()} del tenant…</p>}
                                      {err && (
                                        <p role="alert" className="text-xs text-destructive p-2">
                                          {err}
                                        </p>
                                      )}
                                      {!err && cargandoRecurso !== r.key && datos && datos.length === 0 && <p className="text-xs text-muted-foreground p-2">{r.mensajeVacio}</p>}
                                      {!err && datos && datos.length > 0 && (
                                        <div className="p-2 flex flex-col gap-1">
                                          {datos.map((item, idx) => (
                                            <div key={typeof item.id === "string" ? item.id : typeof item.ocupacionId === "string" ? item.ocupacionId : idx} className="text-xs text-foreground">
                                              {r.renderFila(item)}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </TabsContent>
                                  );
                                })}
                              </Tabs>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bitácora inmutable</CardTitle>
        </CardHeader>
        <CardContent>
          {bitacora.length === 0 ? (
            <EstadoVacio mensaje="Sin lecturas de romper-cristal registradas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Recurso</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Resumen</TableHead>
                    <TableHead>Cuándo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bitacora.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground">{e.seq}</TableCell>
                      <TableCell className="font-mono text-xs">{e.organizationId}</TableCell>
                      <TableCell>{e.resourceType}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={e.reason}>
                        {e.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{typeof e.resultSummary.total === "number" ? `${e.resultSummary.total} registro(s)` : "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fechaHoraEsMx(e.occurredAtMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ModalFormularioLateral
        open={abriendo}
        onOpenChange={(open) => setAbriendo(open)}
        titulo="Abrir acceso de emergencia"
        subtitulo="Romper cristal — auditado, con motivo obligatorio y duración acotada."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAbriendo(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-abrir-break-glass" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Abriendo…" : "Abrir acceso"}
            </Button>
          </>
        }
      >
        <form id="form-abrir-break-glass" onSubmit={abrirAcceso} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-org-id">Id de la organización objetivo</Label>
            <Input id="break-glass-org-id" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="uuid de la organización" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <textarea
              id="break-glass-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              placeholder="Ej. Ticket SOP-4821: el tenant reporta un cobro duplicado, necesito revisar sus reservas para diagnosticar."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-duracion">Duración</Label>
            <select
              id="break-glass-duracion"
              value={duracionMinutos}
              onChange={(e) => setDuracionMinutos(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {DURACIONES.map((d) => (
                <option key={d.minutos} value={d.minutos}>
                  {d.etiqueta}
                </option>
              ))}
            </select>
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}
