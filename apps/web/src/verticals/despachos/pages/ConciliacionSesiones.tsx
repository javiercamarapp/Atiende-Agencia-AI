// D-35 + D-02 -- conciliacion PERSISTIDA dentro de la pantalla de Conciliacion: guarda la corrida como sesion de un periodo, lista las sesiones, confirma
// los pares que el SERVIDOR vuelve a calcular con el motor, deshace con motivo (useConfirm) y pide sugerencias al nivel 4 (IA) que quedan pendientes hasta que
// una persona las aprueba o rechaza. Datos reales: rutas de apps/api/.../despachos/conciliacion-persistida.ts (migracion 021). Esta pantalla solo oculta lo
// que el servidor rechazaria por rol; el servidor y la base son la autoridad. Sin IA configurada el boton lo dice (503 honesto) en lugar de simular.
// D-P3-10/11/12 (migracion 025): las propuestas se GUARDAN en la sesion (boton "Recalcular"), un movimiento con 2+ combinaciones N-a-1 se muestra como
// "ambiguo" (nunca se confirma sin elegir; confirmar un grupo llega con la tabla de grupos, D-07) y uno sin combinacion como "sin conciliar" con los CFDI mas
// cercanos; un CFDI de direccion indeterminada exige revision explicita; el interruptor del piloto automatico de nivel 1 (apagado por omision) lo cambia solo el admin.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, Lock, RefreshCw, Save, Undo2, X } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, Input, Label, notify, StatusBadge, Switch, useConfirm } from "@atiende/ui";
import {
  cerrarSesionConciliacion,
  confirmarParesConciliacion,
  crearSesionConciliacion,
  deshacerMatchConciliacion,
  guardarConfiguracionConciliacion,
  leerConfiguracionConciliacion,
  listarSesionesConciliacion,
  obtenerSesionConciliacion,
  recalcularSesionConciliacion,
  resolverSugerenciaConciliacion,
  sugerirConIaConciliacion,
} from "../lib/conciliacion-client.ts";
import type { CfdiSesion, DetalleSesionConciliacion, MotivoSinConciliar, MovimientoSesion, SesionConciliacionResumen } from "../lib/conciliacion-client.ts";
import { formatMoney } from "../lib/format.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Cosmetico (admin/contador): el servidor es la autoridad. */
  readonly puedeGestionar: boolean;
  /** Cosmetico (solo admin): cambia el interruptor del piloto automatico. El servidor y la base repiten el guard. */
  readonly esAdmin?: boolean;
}

const mensajeDe = (err: unknown, porDefecto: string): string => (err instanceof Error && err.message ? err.message : porDefecto);
const ETIQUETA_ESTADO_MOV = { conciliado: "Conciliado", sugerido: "Sugerido por IA", ambiguo: "Ambiguo", sin_conciliar: "Sin conciliar" } as const;
const TONO_ESTADO_MOV = { conciliado: "success", sugerido: "info", ambiguo: "warning", sin_conciliar: "neutral" } as const;
const ETIQUETA_ORIGEN = { motor: "Motor", llm_aprobado: "IA aprobada", manual: "Manual", autopiloto: "Piloto automático" } as const;
const ETIQUETA_MOTIVO: Record<MotivoSinConciliar, string> = {
  sin_candidato: "Ningún CFDI candidato",
  pocos_candidatos: "Menos de 2 CFDI en la ventana de fechas",
  sin_combinacion: "Ninguna combinación de CFDI suma el monto",
  demasiados_candidatos: "Más de 60 CFDI candidatos: no se evalúa para no inventar una combinación",
  presupuesto_agotado: "La búsqueda de combinaciones superó su presupuesto: no se propone nada parcial",
  ambiguo: "Varias combinaciones posibles",
};
const periodoActual = (): string => new Date().toISOString().slice(0, 7);

function textoCfdi(c: CfdiSesion | undefined): string {
  return c ? `${c.emisorNombre ?? "Sin nombre"} · ${c.folioFiscal.slice(0, 8)} · ${formatMoney(c.total)}` : "CFDI no disponible";
}

export function SesionesConciliacion({ apiBaseUrl, token, propertyId, puedeGestionar, esAdmin = false }: Props) {
  const { confirmar: pedirConfirmacion, pedirTexto, dialogo } = useConfirm();
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
  const [piloto, setPiloto] = useState<{ readonly cargado: boolean; readonly activo: boolean }>({ cargado: false, activo: false });
  const [guardandoPiloto, setGuardandoPiloto] = useState(false);

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
        // Una propuesta con dirección indeterminada NO viene preseleccionada: solo se confirma tras revisarla.
        setSeleccion(new Set(d.propuestas.filter((p) => !p.requiereRevision).map((p) => `${p.movimientoId}|${p.invoiceId}`)));
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

  useEffect(() => {
    if (!esAdmin) {
      setPiloto({ cargado: false, activo: false });
      return;
    }
    let vigente = true;
    leerConfiguracionConciliacion(fetch, apiBaseUrl, token, propertyId)
      .then((c) => vigente && setPiloto({ cargado: true, activo: c.autoconfirmarNivel1 }))
      .catch(() => vigente && setPiloto({ cargado: false, activo: false })); // sin dato (rol de solo lectura: 403, base sin migrar, error) no se muestra un interruptor que no sabemos si funciona
    return () => {
      vigente = false;
    };
  }, [apiBaseUrl, token, propertyId, esAdmin]);

  async function cambiarPiloto(activo: boolean) {
    setGuardandoPiloto(true);
    try {
      const r = await guardarConfiguracionConciliacion(fetch, apiBaseUrl, token, propertyId, activo);
      setPiloto({ cargado: true, activo: r.autoconfirmarNivel1 });
      notify.success(r.autoconfirmarNivel1 ? "Piloto automático encendido." : "Piloto automático apagado.");
    } catch (err) {
      // 503 (base sin la migración 025) o 403: se dice tal cual, el interruptor no cambia.
      notify.error(mensajeDe(err, "No se pudo cambiar el piloto automático."));
    } finally {
      setGuardandoPiloto(false);
    }
  }

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
    const elegidas = detalle.propuestas.filter((p) => seleccion.has(`${p.movimientoId}|${p.invoiceId}`));
    const aRevisar = elegidas.filter((p) => p.requiereRevision);
    if (aRevisar.length > 0) {
      const ok = await pedirConfirmacion({
        titulo: `Confirmar ${aRevisar.length} CFDI de dirección indeterminada`,
        descripcion: "No se pudo saber si estos CFDI son emitidos o recibidos. Confirma solo si ya revisaste que el movimiento del banco corresponde a ese comprobante.",
        confirmar: "Ya los revisé",
      });
      if (!ok) return;
    }
    const pares = elegidas.map((p) => ({ movimientoId: p.movimientoId, invoiceId: p.invoiceId, ...(p.requiereRevision ? { revisado: true } : {}) }));
    await ejecutar("confirmar", async () => {
      const r = await confirmarParesConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id, pares);
      return `${r.matches.length} conciliación(es) confirmada(s).`;
    });
  }

  async function recalcular() {
    if (!detalle) return;
    await ejecutar("recalcular", async () => {
      const r = await recalcularSesionConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id);
      return r.guardado ? "Propuestas recalculadas y guardadas." : "Propuestas recalculadas (esta base aún no las guarda: falta la migración 025).";
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
    await ejecutar(`${aprobar ? "aprobar" : "rechazar"}:${id}`, async () => {
      await resolverSugerenciaConciliacion(fetch, apiBaseUrl, token, propertyId, id, aprobar);
      return aprobar ? "Sugerencia aprobada: conciliación creada." : "Sugerencia rechazada.";
    });
  }

  async function cerrar() {
    if (!detalle) return;
    await ejecutar("cerrar", async () => {
      await cerrarSesionConciliacion(fetch, apiBaseUrl, token, propertyId, detalle.sesion.id);
      return "Sesión cerrada.";
    });
  }

  const pendientes = (detalle?.sugerencias ?? []).filter((s) => s.estado === "pendiente");
  const vigentes = (detalle?.matches ?? []).filter((m) => m.deshechoEn === null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Conciliación guardada por periodo</CardTitle>
        <p className="text-sm text-muted-foreground">
          Guarda la corrida como sesión: los movimientos del estado de cuenta ya importados se concilian contra los CFDI, las confirmaciones quedan guardadas y se pueden deshacer con motivo.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!disponible && (
          <Callout tone="warning" role="status">
            La conciliación guardada todavía no está disponible en esta base: falta aplicar la migración 021. Hasta entonces las sesiones no se pueden crear.
          </Callout>
        )}
        {error && <EstadoError mensaje={error} onReintentar={() => void cargarLista()} />}

        {disponible && piloto.cargado && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Piloto automático de nivel 1</p>
              <p className="text-xs text-muted-foreground">
                Al guardar un estado de cuenta el sistema deja la sesión lista y, con esto encendido, confirma solo los cruces exactos únicos (un solo CFDI posible para el movimiento y un solo movimiento para el CFDI).
                Nunca confirma grupos, cruces aproximados ni sugerencias de IA; cada uno queda en la bitácora y se puede deshacer con motivo.
              </p>
            </div>
            <Switch aria-label="Piloto automático de nivel 1" checked={piloto.activo} disabled={guardandoPiloto} onCheckedChange={(v) => void cambiarPiloto(v)} />
          </div>
        )}

        {puedeGestionar && disponible && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="sesion-periodo">Periodo</Label>
              <Input id="sesion-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-44" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sesion-cuenta">Cuenta (opcional)</Label>
              <Input id="sesion-cuenta" value={cuenta} onChange={(e) => setCuenta(e.target.value)} placeholder="CLABE o número" className="w-56" />
            </div>
            <Button type="button" loading={guardando} loadingText="Guardando…" iconLeft={<Save />} onClick={() => void crear()}>
              Guardar como sesión
            </Button>
          </div>
        )}
        {errorCrear && (
          <p role="alert" className="text-sm text-destructive">
            {errorCrear}
          </p>
        )}

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
              <Callout tone={avisoIa.tono} role="status">
                {avisoIa.texto}
              </Callout>
            )}
            {detalle && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    Sesión {detalle.sesion.periodo} {detalle.sesion.cuenta ? `· cuenta ${detalle.sesion.cuenta}` : ""}
                    <StatusBadge tone={sesionAbierta ? "info" : "neutral"} className="ml-2">
                      {sesionAbierta ? "Abierta" : "Cerrada"}
                    </StatusBadge>
                  </h2>
                  {puedeGestionar && sesionAbierta && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" loading={ocupado === "recalcular"} loadingText="Recalculando…" iconLeft={<RefreshCw />} onClick={() => void recalcular()}>
                        Recalcular
                      </Button>
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
                    <p className="text-xs text-muted-foreground">
                      {detalle.propuestasFuente === "guardadas" && detalle.propuestasEn
                        ? `Calculadas el ${formatFechaSolo(detalle.propuestasEn.slice(0, 10))}; usa «Recalcular» si llegaron CFDI o movimientos nuevos. `
                        : "Se calcularon al abrir la sesión (esta sesión aún no tiene propuestas guardadas); «Recalcular» las guarda. "}
                      Al confirmar, el servidor vuelve a verificar cada par con el motor: solo se guardan los que el motor sigue proponiendo.
                    </p>
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
                        { id: "rev", encabezado: "Revisión", celda: (p) => (p.requiereRevision ? <StatusBadge tone="warning">Dirección indeterminada</StatusBadge> : <span className="text-muted-foreground">—</span>) },
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
                      <Callout tone="info" role="status">
                        {detalle.multiLinea.length} pago(s) cubren varios CFDI a la vez (multi-línea): se muestran en la conciliación de arriba, pero no se confirman desde aquí.
                      </Callout>
                    )}
                  </div>
                )}

                {sesionAbierta && (detalle.ambiguas ?? []).length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-foreground">Ambiguos ({detalle.ambiguas!.length})</h3>
                    <p className="text-xs text-muted-foreground">
                      Varias combinaciones de CFDI suman el mismo movimiento: el motor no elige una por ti. Confirmar un grupo todavía no está disponible (llega con la tabla de grupos, D-07): por ahora solo se muestran.
                    </p>
                    <ul className="flex flex-col gap-2" aria-label="Movimientos ambiguos">
                      {detalle.ambiguas!.map((a) => (
                        <li key={a.movimientoId} className="rounded-lg border border-border p-3">
                          <p className="text-sm font-medium text-foreground">
                            Ambiguo: elige una de {a.combinaciones.length}
                            {a.truncado ? "+" : ""} combinaciones
                          </p>
                          <p className="mt-0.5 text-xs">
                            <MovimientoCelda m={movPorId.get(a.movimientoId)} />
                          </p>
                          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
                            {a.combinaciones.slice(0, 10).map((comb, i) => (
                              <li key={i}>{comb.map((id) => textoCfdi(cfdiPorId.get(id))).join("  +  ")}</li>
                            ))}
                          </ol>
                          {a.combinaciones.length > 10 && <p className="mt-1 text-xs text-muted-foreground">Se muestran las primeras 10.</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {sesionAbierta && (detalle.sinConciliar ?? []).filter((x) => x.motivo !== "ambiguo" && detalle.movimientos.find((m) => m.id === x.movimientoId)?.estado === "sin_conciliar").length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-foreground">Sin conciliar: más cercanos</h3>
                    <p className="text-xs text-muted-foreground">Por qué el motor no propuso nada y qué CFDI quedan más cerca en monto (solo informativo: no se aplica ninguno).</p>
                    <DataTable
                      etiqueta="Movimientos sin conciliar"
                      obtenerId={(x) => x.movimientoId}
                      filas={(detalle.sinConciliar ?? []).filter((x) => x.motivo !== "ambiguo" && detalle.movimientos.find((m) => m.id === x.movimientoId)?.estado === "sin_conciliar")}
                      paginacion={{ tamano: 10 }}
                      columnas={[
                        { id: "mov", encabezado: "Movimiento", principal: true, celda: (x) => <MovimientoCelda m={movPorId.get(x.movimientoId)} /> },
                        { id: "motivo", encabezado: "Motivo", celda: (x) => <span className="text-xs">{ETIQUETA_MOTIVO[x.motivo]}</span> },
                        {
                          id: "cercanos",
                          encabezado: "CFDI más cercanos",
                          celda: (x) =>
                            x.cercanos.length === 0 ? (
                              <span className="text-xs text-muted-foreground">Ninguno compatible</span>
                            ) : (
                              <ul className="flex flex-col gap-0.5 text-xs">
                                {x.cercanos.map((c) => (
                                  <li key={c.invoiceId}>
                                    {textoCfdi(cfdiPorId.get(c.invoiceId))} <span className="text-muted-foreground">(a {formatMoney(c.diferenciaCentavos / 100)})</span>
                                  </li>
                                ))}
                              </ul>
                            ),
                        },
                      ]}
                    />
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
