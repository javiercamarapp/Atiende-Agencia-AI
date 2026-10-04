// D-35 + D-02 -- conciliacion PERSISTIDA dentro de la pantalla de Conciliacion: guarda la corrida como sesion de un periodo, lista las sesiones, confirma
// los pares que el SERVIDOR vuelve a calcular con el motor, deshace con motivo (useConfirm) y pide sugerencias al nivel 4 (IA) que quedan pendientes hasta que
// una persona las aprueba o rechaza. Datos reales: rutas de apps/api/.../despachos/conciliacion-persistida.ts (migracion 021). Esta pantalla solo oculta lo
// que el servidor rechazaria por rol; el servidor y la base son la autoridad. Sin IA configurada el boton lo dice (503 honesto) en lugar de simular.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, Lock, Save, Undo2, X } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, FormField, Input, notify, StatusBadge, useConfirm } from "@atiende/ui";
import {
  cerrarSesionConciliacion,
  confirmarParesConciliacion,
  crearSesionConciliacion,
  deshacerMatchConciliacion,
  listarSesionesConciliacion,
  obtenerSesionConciliacion,
  resolverSugerenciaConciliacion,
  sugerirConIaConciliacion,
} from "../lib/conciliacion-client.ts";
import type { CfdiSesion, DetalleSesionConciliacion, MovimientoSesion, SesionConciliacionResumen } from "../lib/conciliacion-client.ts";
import { formatMoney } from "../lib/format.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Cosmetico (admin/contador): el servidor es la autoridad. */
  readonly puedeGestionar: boolean;
}

const mensajeDe = (err: unknown, porDefecto: string): string => (err instanceof Error && err.message ? err.message : porDefecto);
const ETIQUETA_ESTADO_MOV = { conciliado: "Conciliado", sugerido: "Sugerido por IA", sin_conciliar: "Sin conciliar" } as const;
const TONO_ESTADO_MOV = { conciliado: "success", sugerido: "info", sin_conciliar: "neutral" } as const;
const ETIQUETA_ORIGEN = { motor: "Motor", llm_aprobado: "IA aprobada", manual: "Manual" } as const;
const periodoActual = (): string => new Date().toISOString().slice(0, 7);

function textoCfdi(c: CfdiSesion | undefined): string {
  return c ? `${c.emisorNombre ?? "Sin nombre"} · ${c.folioFiscal.slice(0, 8)} · ${formatMoney(c.total)}` : "CFDI no disponible";
}

export function SesionesConciliacion({ apiBaseUrl, token, propertyId, puedeGestionar }: Props) {
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [sesiones, setSesiones] = useState<readonly SesionConciliacionResumen[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState(periodoActual());
  const [cuenta, setCuenta] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorCrear, setErrorCrear] = useState<string | null>(null);

  const [abierta, setAbierta] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<DetalleSesionConciliacion | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<ReadonlySet<string>>(new Set());
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [avisoIa, setAvisoIa] = useState<{ tono: "warning" | "info"; texto: string } | null>(null);

  const cargarLista = useCallback(async () => {
    setError(null);
    try {
      const r = await listarSesionesConciliacion(fetch, apiBaseUrl, token, propertyId);
      setSesiones(r.sesiones);
      setDisponible(r.disponible);
    } catch (err) {
      setError(mensajeDe(err, "No se pudieron cargar las sesiones."));
    } finally {
      setCargando(false);
    }
  }, [apiBaseUrl, token, propertyId]);

  const cargarDetalle = useCallback(
    async (id: string) => {
      setCargandoDetalle(true);
      setErrorDetalle(null);
      try {
        const d = await obtenerSesionConciliacion(fetch, apiBaseUrl, token, propertyId, id);
        setDetalle(d);
        setSeleccion(new Set(d.propuestas.map((p) => `${p.movimientoId}|${p.invoiceId}`)));
      } catch (err) {
        setDetalle(null);
        setErrorDetalle(mensajeDe(err, "No se pudo cargar la sesión."));
      } finally {
        setCargandoDetalle(false);
      }
    },
    [apiBaseUrl, token, propertyId],
  );

  useEffect(() => {
    setCargando(true);
    setAbierta(null);
    setDetalle(null);
    void cargarLista();
  }, [cargarLista]);

  const cfdiPorId = useMemo(() => new Map((detalle?.cfdis ?? []).map((c) => [c.id, c])), [detalle]);
  const movPorId = useMemo(() => new Map((detalle?.movimientos ?? []).map((m) => [m.id, m])), [detalle]);
  const sesionAbierta = detalle?.sesion.estado === "abierta";

  async function abrir(id: string) {
    setAbierta(id);
    setAvisoIa(null);
    await cargarDetalle(id);
  }

  /** Ejecuta una escritura, refresca lista y detalle, y avisa. Un error del servidor (periodo cerrado, rol, etc.) se muestra tal cual. */
  async function ejecutar(clave: string, accion: () => Promise<string>) {
    setOcupado(clave);
    setErrorDetalle(null);
    try {
      const mensaje = await accion();
      notify.success(mensaje);
    } catch (err) {
      setErrorDetalle(mensajeDe(err, "No se pudo completar la operación."));
    } finally {
      setOcupado(null);
      await cargarLista();
      if (abierta) await cargarDetalle(abierta);
    }
  }

  async function crear() {
    setErrorCrear(null);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
      setErrorCrear("Elige un periodo válido (mes y año).");
      return;
    }
    setGuardando(true);
    try {
      const r = await crearSesionConciliacion(fetch, apiBaseUrl, token, propertyId, periodo, cuenta.trim() || undefined);
      notify.success(`Sesión guardada con ${r.movimientos} movimiento(s).`);
      await cargarLista();
      await abrir(r.sesion.id);
    } catch (err) {
      setErrorCrear(mensajeDe(err, "No se pudo guardar la sesión."));
    } finally {
      setGuardando(false);
    }
  }

  async function confirmarSeleccion() {
    if (!detalle) return;
    const pares = detalle.propuestas.filter((p) => seleccion.has(`${p.movimientoId}|${p.invoiceId}`)).map((p) => ({ movimientoId: p.movimientoId, invoiceId: p.invoiceId }));
    await ejecutar("confirmar", async () => {
      const r = await confirmarParesConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id, pares);
      return `${r.matches.length} conciliación(es) confirmada(s).`;
    });
  }

  async function deshacer(matchId: string) {
    const motivo = await pedirTexto({
      titulo: "Deshacer conciliación",
      descripcion: "El movimiento y el CFDI vuelven a quedar libres. El motivo queda en el historial.",
      tono: "danger",
      confirmar: "Deshacer",
      campo: { etiqueta: "Motivo", multilinea: true, minLength: 3, maxLength: 500, placeholder: "Por qué se deshace" },
    });
    if (motivo === null) return;
    await ejecutar(`deshacer:${matchId}`, async () => {
      await deshacerMatchConciliacion(fetch, apiBaseUrl, token, propertyId, matchId, motivo);
      return "Conciliación deshecha.";
    });
  }

  async function sugerir() {
    if (!detalle) return;
    setAvisoIa(null);
    await ejecutar("ia", async () => {
      try {
        const r = await sugerirConIaConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id);
        if (r.sugerencias.length === 0) setAvisoIa({ tono: "info", texto: "La IA no encontró sugerencias nuevas con suficiente confianza. Nada cambió en la conciliación." });
        return `${r.sugerencias.length} sugerencia(s) por revisar.`;
      } catch (err) {
        // 503 "IA no configurada" u otro fallo: se dice tal cual, nunca se simula una respuesta.
        setAvisoIa({ tono: "warning", texto: mensajeDe(err, "No se pudieron generar sugerencias con IA.") });
        throw err;
      }
    });
  }

  async function resolver(id: string, aprobar: boolean) {
    if (!aprobar) {
      const ok = await confirmar({
        titulo: "Rechazar sugerencia",
        descripcion: "La sugerencia de la IA se descarta y no se puede deshacer.",
        tono: "danger",
        confirmar: "Rechazar",
      });
      if (!ok) return;
    }
    await ejecutar(`${aprobar ? "aprobar" : "rechazar"}:${id}`, async () => {
      await resolverSugerenciaConciliacion(fetch, apiBaseUrl, token, propertyId, id, aprobar);
      return aprobar ? "Sugerencia aprobada: conciliación creada." : "Sugerencia rechazada.";
    });
  }

  async function cerrar() {
    if (!detalle) return;
    const ok = await confirmar({
      titulo: `Cerrar la sesión ${detalle.sesion.periodo}`,
      descripcion: "Una sesión cerrada ya no admite confirmar, aprobar ni sugerir. Esta acción no se puede deshacer.",
      tono: "danger",
      confirmar: "Cerrar sesión",
    });
    if (!ok) return;
    await ejecutar("cerrar", async () => {
      await cerrarSesionConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id);
      return "Sesión cerrada.";
    });
  }

  const pendientes = (detalle?.sugerencias ?? []).filter((s) => s.estado === "pendiente");
  const vigentes = (detalle?.matches ?? []).filter((m) => m.deshechoEn === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conciliación guardada por periodo</CardTitle>
        <CardDescription>
          Guarda la corrida como sesión: los movimientos del estado de cuenta ya importados se concilian contra los CFDI, las confirmaciones quedan guardadas y se pueden deshacer con motivo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!disponible && (
          <Callout tone="warning">
            La conciliación guardada todavía no está disponible en esta base: falta aplicar la migración 021. Hasta entonces las sesiones no se pueden crear.
          </Callout>
        )}
        {error && <EstadoError mensaje={error} onReintentar={() => void cargarLista()} />}

        {puedeGestionar && disponible && (
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Periodo">
              <Input id="sesion-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-44" />
            </FormField>
            <FormField label="Cuenta (opcional)">
              <Input id="sesion-cuenta" value={cuenta} onChange={(e) => setCuenta(e.target.value)} placeholder="CLABE o número" className="w-56" />
            </FormField>
            <Button type="button" loading={guardando} iconLeft={<Save />} onClick={() => void crear()}>
              Guardar como sesión
            </Button>
          </div>
        )}
        {errorCrear && <Callout tone="danger">{errorCrear}</Callout>}

        {cargando ? (
          <EstadoCargando etiqueta="Cargando sesiones…" />
        ) : (
          <DataTable
            etiqueta="Sesiones de conciliación"
            obtenerId={(s) => s.id}
            filas={sesiones}
            paginacion={{ tamano: 8 }}
            vacio={{ mensaje: disponible ? "Todavía no hay sesiones. Importa un estado de cuenta y guarda una sesión del periodo." : "Sin sesiones: falta la migración 021." }}
            columnas={[
              { id: "periodo", encabezado: "Periodo", principal: true, valorOrden: (s) => s.periodo, celda: (s) => <span className="font-mono text-xs">{s.periodo}</span> },
              { id: "cuenta", encabezado: "Cuenta", celda: (s) => <span className="text-muted-foreground">{s.cuenta ?? "Todas"}</span> },
              { id: "estado", encabezado: "Estado", celda: (s) => <StatusBadge tone={s.estado === "abierta" ? "info" : "neutral"}>{s.estado === "abierta" ? "Abierta" : "Cerrada"}</StatusBadge> },
              { id: "movs", encabezado: "Movimientos", alinear: "right", valorOrden: (s) => s.totalMovimientos, celda: (s) => s.totalMovimientos },
              { id: "conc", encabezado: "Conciliados", alinear: "right", valorOrden: (s) => s.matchesVigentes, celda: (s) => s.matchesVigentes },
              { id: "sug", encabezado: "Sugerencias por revisar", alinear: "right", valorOrden: (s) => s.sugerenciasPendientes, celda: (s) => s.sugerenciasPendientes },
              {
                id: "acc",
                encabezado: "",
                etiqueta: "Acciones",
                ocultarEnTarjeta: false,
                celda: (s) => (
                  <Button type="button" size="sm" variant={abierta === s.id ? "secondary" : "outline"} onClick={() => void abrir(s.id)} aria-label={`Abrir sesión ${s.periodo}`}>
                    {abierta === s.id ? "Abierta" : "Abrir"}
                  </Button>
                ),
              },
            ]}
          />
        )}

        {abierta && (
          <section aria-label="Detalle de la sesión" className="flex flex-col gap-4 border-t border-border pt-4">
            {cargandoDetalle && !detalle && <EstadoCargando etiqueta="Cargando sesión…" />}
            {errorDetalle && <EstadoError mensaje={errorDetalle} onReintentar={() => void cargarDetalle(abierta)} />}
            {avisoIa && (
              <Callout tone={avisoIa.tono}>{avisoIa.texto}</Callout>
            )}
            {detalle && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-foreground">
                    Sesión {detalle.sesion.periodo} {detalle.sesion.cuenta ? `· cuenta ${detalle.sesion.cuenta}` : ""}
                    <StatusBadge tone={sesionAbierta ? "info" : "neutral"} className="ml-2">
                      {sesionAbierta ? "Abierta" : "Cerrada"}
                    </StatusBadge>
                  </h2>
                  {puedeGestionar && sesionAbierta && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" loading={ocupado === "ia"} loadingText="Consultando IA…" iconLeft={<Bot />} onClick={() => void sugerir()}>
                        Sugerir con IA
                      </Button>
                      <Button type="button" variant="outline" size="sm" loading={ocupado === "cerrar"} loadingText="Cerrando…" iconLeft={<Lock />} onClick={() => void cerrar()}>
                        Cerrar sesión
                      </Button>
                    </div>
                  )}
                </div>

                {sesionAbierta && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-foreground">Propuestas del motor</h3>
                    <p className="text-xs text-muted-foreground">El servidor vuelve a calcular estas propuestas al confirmar: solo se guardan las que el motor sigue proponiendo.</p>
                    <DataTable
                      etiqueta="Propuestas del motor"
                      obtenerId={(p) => `${p.movimientoId}|${p.invoiceId}`}
                      filas={detalle.propuestas}
                      paginacion={{ tamano: 10 }}
                      seleccionable={puedeGestionar}
                      seleccion={seleccion}
                      onSeleccionChange={setSeleccion}
                      vacio={{ mensaje: "El motor no tiene propuestas pendientes en esta sesión." }}
                      columnas={[
                        { id: "mov", encabezado: "Movimiento", principal: true, celda: (p) => <MovimientoCelda m={movPorId.get(p.movimientoId)} /> },
                        { id: "cfdi", encabezado: "CFDI", celda: (p) => <span className="text-xs">{textoCfdi(cfdiPorId.get(p.invoiceId))}</span> },
                        { id: "nivel", encabezado: "Nivel", celda: (p) => <StatusBadge tone={p.nivel === 1 ? "success" : "info"}>{p.nivel === 1 ? "Exacto" : "Fuzzy"}</StatusBadge> },
                        { id: "conf", encabezado: "Confianza", alinear: "right", valorOrden: (p) => p.confianza, celda: (p) => `${Math.round(p.confianza)}%` },
                      ]}
                    />
                    {puedeGestionar && (
                      <div>
                        <Button type="button" size="sm" loading={ocupado === "confirmar"} loadingText="Confirmando…" iconLeft={<Check />} disabled={seleccion.size === 0} onClick={() => void confirmarSeleccion()}>
                          Confirmar seleccionados ({seleccion.size})
                        </Button>
                      </div>
                    )}
                    {detalle.multiLinea.length > 0 && (
                      <Callout tone="info">
                        {detalle.multiLinea.length} pago(s) cubren varios CFDI a la vez (multi-línea): se muestran en la conciliación de arriba, pero no se confirman desde aquí.
                      </Callout>
                    )}
                  </div>
                )}

                {pendientes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-foreground">Sugerencias de IA por revisar</h3>
                    <p className="text-xs text-muted-foreground">Ninguna se aplica sola: apruébalas o recházalas una por una.</p>
                    <DataTable
                      etiqueta="Sugerencias de IA"
                      obtenerId={(s) => s.id}
                      filas={pendientes}
                      paginacion={{ tamano: 10 }}
                      columnas={[
                        { id: "mov", encabezado: "Movimiento", principal: true, celda: (s) => <MovimientoCelda m={movPorId.get(s.movimientoId)} /> },
                        { id: "cfdi", encabezado: "CFDI sugerido", celda: (s) => <span className="text-xs">{textoCfdi(cfdiPorId.get(s.invoiceId))}</span> },
                        { id: "conf", encabezado: "Confianza", alinear: "right", valorOrden: (s) => s.confianza, celda: (s) => `${Math.round(s.confianza)}%` },
                        { id: "razon", encabezado: "Razón de la IA", celda: (s) => <span className="text-xs text-muted-foreground">{s.razon}</span> },
                        {
                          id: "acc",
                          encabezado: "",
                          etiqueta: "Acciones",
                          celda: (s) =>
                            puedeGestionar && sesionAbierta ? (
                              <div className="flex gap-1.5">
                                <Button type="button" size="sm" loading={ocupado === `aprobar:${s.id}`} iconLeft={<Check />} onClick={() => void resolver(s.id, true)} aria-label="Aprobar sugerencia">
                                  Aprobar
                                </Button>
                                <Button type="button" size="sm" variant="outline" loading={ocupado === `rechazar:${s.id}`} iconLeft={<X />} onClick={() => void resolver(s.id, false)} aria-label="Rechazar sugerencia">
                                  Rechazar
                                </Button>
                              </div>
                            ) : null,
                        },
                      ]}
                    />
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-foreground">Conciliaciones confirmadas ({vigentes.length})</h3>
                  <DataTable
                    etiqueta="Conciliaciones confirmadas"
                    obtenerId={(m) => m.id}
                    filas={vigentes}
                    paginacion={{ tamano: 10 }}
                    vacio={{ mensaje: "Todavía no hay conciliaciones confirmadas en esta sesión." }}
                    columnas={[
                      { id: "mov", encabezado: "Movimiento", principal: true, celda: (m) => <MovimientoCelda m={movPorId.get(m.movimientoId)} /> },
                      { id: "cfdi", encabezado: "CFDI", celda: (m) => <span className="text-xs">{textoCfdi(cfdiPorId.get(m.invoiceId))}</span> },
                      { id: "origen", encabezado: "Origen", celda: (m) => <StatusBadge tone={m.origen === "manual" ? "neutral" : m.origen === "llm_aprobado" ? "info" : "success"}>{ETIQUETA_ORIGEN[m.origen]}</StatusBadge> },
                      { id: "conf", encabezado: "Confianza", alinear: "right", celda: (m) => (m.confianza === null ? "—" : `${Math.round(m.confianza)}%`) },
                      {
                        id: "acc",
                        encabezado: "",
                        etiqueta: "Acciones",
                        celda: (m) =>
                          puedeGestionar ? (
                            <Button type="button" size="sm" variant="outline" loading={ocupado === `deshacer:${m.id}`} iconLeft={<Undo2 />} onClick={() => void deshacer(m.id)} aria-label="Deshacer conciliación">
                              Deshacer
                            </Button>
                          ) : null,
                      },
                    ]}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-foreground">Movimientos del periodo ({detalle.movimientos.length})</h3>
                  <DataTable
                    etiqueta="Movimientos de la sesión"
                    obtenerId={(m) => m.id}
                    filas={detalle.movimientos}
                    paginacion={{ tamano: 10 }}
                    columnas={[
                      { id: "fecha", encabezado: "Fecha", principal: true, valorOrden: (m) => m.fecha, celda: (m) => formatFechaSolo(m.fecha) },
                      { id: "desc", encabezado: "Descripción", celda: (m) => m.descripcion },
                      { id: "monto", encabezado: "Monto", alinear: "right", valorOrden: (m) => m.monto, celda: (m) => <span className="font-mono text-xs">{formatMoney(m.monto)}</span> },
                      { id: "estado", encabezado: "Estado", celda: (m) => <StatusBadge tone={TONO_ESTADO_MOV[m.estado]}>{ETIQUETA_ESTADO_MOV[m.estado]}</StatusBadge> },
                    ]}
                  />
                </div>
              </>
            )}
          </section>
        )}
        {dialogo}
      </CardContent>
    </Card>
  );
}

function MovimientoCelda({ m }: { m: MovimientoSesion | undefined }) {
  if (!m) return <span className="text-muted-foreground">Movimiento no disponible</span>;
  return (
    <span className="text-xs">
      {formatFechaSolo(m.fecha)} · {m.descripcion || "Sin descripción"} · <span className="font-mono">{formatMoney(m.monto)}</span>
    </span>
  );
}
