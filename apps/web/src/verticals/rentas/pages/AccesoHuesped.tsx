// Rn-04 -- Acceso al huésped. Pantalla del staff (admin_gestora / operador:acceso_total, espejo de
// ACCESO_HUESPED_ROLES; el servidor y la RLS lo vuelven a exigir) para configurar cuándo se liberan
// las instrucciones de acceso (código de cerradura, dirección exacta): política por property,
// instrucciones por unidad, confirmación de pago de reservas directas y bitácora de envíos.
// Contra una base sin la migración 025 muestra "aún no disponible" en lugar de romperse.
//
// Rn-P3-08/09: además, el enlace público de pre-check-in de la propiedad (con el texto sugerido para pegarlo UNA vez en los «mensajes programados» de
// Airbnb o Booking) y su reglamento de la casa; y la lista «Pendientes de entregar» (reservas de OTA sin correo del huésped, cuyo acceso la liberación
// automática no pudo enviar) con «Copiar mensaje para la OTA» (instrucciones descifradas, lectura en bitácora) y «Marcar como entregado» (con confirmación).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, useConfirm } from "@atiende/ui";
import {
  confirmarPagoReserva,
  ETIQUETA_EVENTO_ACCESO,
  fetchBitacoraAcceso,
  fetchConfigPrecheckin,
  fetchInstruccionAcceso,
  fetchMensajeOta,
  fetchPendientesEntrega,
  fetchPoliticaAcceso,
  fetchReservasAcceso,
  guardarInstruccionAcceso,
  guardarPoliticaAcceso,
  guardarReglamentoPrecheckin,
  marcarEntregadaManual,
} from "../lib/acceso-client.ts";
import type { ConfigPrecheckin, EventoBitacoraAcceso, PendienteEntrega, PoliticaAcceso, ReservaAcceso } from "../lib/acceso-client.ts";
import { fetchUnidades } from "../lib/calendario-client.ts";
import type { UnidadOption } from "../lib/calendario-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de ACCESO_HUESPED_ROLES (packages/domain-rentas/src/roles.ts).
const ACCESO_HUESPED_ROLES = new Set(["admin_gestora", "operador:acceso_total"]);
const POLITICA_VACIA: PoliticaAcceso = { activo: false, horasAntesCheckin: 24, horaCheckin: "15:00", exigirPago: true, otaCuentaComoPagada: true };

async function copiarAlPortapapeles(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

export function AccesoHuespedPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puede = org ? ACCESO_HUESPED_ROLES.has(org.rol) : false;

  const [disponible, setDisponible] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [politica, setPolitica] = useState<PoliticaAcceso>(POLITICA_VACIA);
  const [unidades, setUnidades] = useState<readonly UnidadOption[]>([]);
  const [unidadId, setUnidadId] = useState("");
  const [direccion, setDireccion] = useState("");
  const [codigo, setCodigo] = useState("");
  const [indicaciones, setIndicaciones] = useState("");
  const [reservas, setReservas] = useState<readonly ReservaAcceso[]>([]);
  const [bitacora, setBitacora] = useState<readonly EventoBitacoraAcceso[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [pendientes, setPendientes] = useState<readonly PendienteEntrega[]>([]);
  const [pendientesDisponible, setPendientesDisponible] = useState(true);
  const [config, setConfig] = useState<ConfigPrecheckin | null>(null);
  const [reglamento, setReglamento] = useState("");
  /** Solo si el navegador no deja copiar: el mensaje se muestra para copiarlo a mano y se descarta al cerrarlo (contiene el codigo de acceso). */
  const [mensajeManual, setMensajeManual] = useState<{ readonly reservaId: string; readonly texto: string } | null>(null);
  const { confirmar, dialogo } = useConfirm();

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const [p, u, r, b, pend, cfg] = await Promise.all([
          fetchPoliticaAcceso(fetch, apiBaseUrl, token, propertyId),
          fetchUnidades(fetch, apiBaseUrl, token, propertyId),
          fetchReservasAcceso(fetch, apiBaseUrl, token, propertyId),
          fetchBitacoraAcceso(fetch, apiBaseUrl, token, propertyId),
          fetchPendientesEntrega(fetch, apiBaseUrl, token, propertyId),
          fetchConfigPrecheckin(fetch, apiBaseUrl, token, propertyId),
        ]);
        if (cancelado) return;
        setDisponible(p.disponible);
        setPolitica(p.politica ?? POLITICA_VACIA);
        setUnidades(u);
        setReservas(r.reservas);
        setBitacora(b.eventos);
        setPendientes(pend.pendientes);
        setPendientesDisponible(pend.disponible);
        setConfig(cfg);
        setReglamento(cfg.reglamento ?? "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el acceso al huésped.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puede, recarga]);

  const cargarInstruccion = useCallback(
    async (id: string) => {
      setDireccion("");
      setCodigo("");
      setIndicaciones("");
      if (!id) return;
      try {
        const r = await fetchInstruccionAcceso(fetch, apiBaseUrl, token, propertyId, id);
        if (r.instrucciones) {
          setDireccion(r.instrucciones.direccionExacta);
          setCodigo(r.instrucciones.codigoAcceso ?? "");
          setIndicaciones(r.instrucciones.instrucciones ?? "");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudieron cargar las instrucciones.");
      }
    },
    [apiBaseUrl, token, propertyId],
  );

  async function accion(clave: string, fn: () => Promise<string | void>) {
    setOcupado(clave);
    setError(null);
    setAviso(null);
    try {
      const msg = await fn();
      if (msg) setAviso(msg);
      setRecarga((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(null);
    }
  }

  async function copiarMensaje(p: PendienteEntrega) {
    setOcupado(`mensaje-${p.reservaId}`);
    setError(null);
    setAviso(null);
    setMensajeManual(null);
    try {
      const texto = await fetchMensajeOta(fetch, apiBaseUrl, token, propertyId, p.reservaId);
      if (texto === null) {
        setError("Aún no disponible: la base todavía no tiene las instrucciones de acceso cifradas.");
      } else if (await copiarAlPortapapeles(texto)) {
        setAviso("Mensaje copiado. Pégalo en la conversación de la reserva en la plataforma (Airbnb, Booking o Vrbo).");
      } else {
        setMensajeManual({ reservaId: p.reservaId, texto });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo preparar el mensaje.");
    } finally {
      setOcupado(null);
    }
  }

  async function marcarEntregado(p: PendienteEntrega) {
    const ok = await confirmar({
      titulo: "Marcar como entregado por la plataforma",
      descripcion: `Confirmas que ya enviaste el acceso de ${p.unidadNombre} (llegada ${p.checkIn}) por la plataforma de la reserva. Queda registrado en la bitácora y la liberación automática ya no lo enviará.`,
      confirmar: "Marcar como entregado",
      cancelar: "Cancelar",
    });
    if (!ok) return;
    setMensajeManual(null);
    await accion(`entrega-${p.reservaId}`, async () => {
      await marcarEntregadaManual(fetch, apiBaseUrl, token, propertyId, p.reservaId);
      return "Acceso marcado como entregado.";
    });
  }

  const encabezado = (
    <header>
      <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Acceso al huésped</h1>
      <p className="m-0 text-sm text-muted-foreground">
        Las instrucciones de acceso (código de cerradura, dirección exacta) se envían por correo solo cuando faltan las horas que definas para el check-in y únicamente si la reserva está confirmada y
        pagada según tu política. Cada envío queda en la bitácora, sin datos personales.
      </p>
    </header>
  );

  if (!puede) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        {encabezado}
        <p className="m-0 text-sm text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a esta sección. Roles con acceso: <strong className="text-foreground">admin_gestora</strong> y{" "}
          <strong className="text-foreground">operador:acceso_total</strong>.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      {encabezado}
      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {aviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{aviso}</p>}
      {disponible === null && !error && <EstadoCargando lineas={4} />}
      {disponible === false && (
        <EstadoVacio icon={KeyRound} titulo="Aún no disponible" mensaje="La liberación de acceso al huésped todavía no está habilitada en esta base de datos. Cuando se aplique la migración podrás configurarla aquí." />
      )}

      {disponible === true && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Pendientes de entregar ({pendientes.length})</CardTitle>
            </CardHeader>
            <CardContent className={pendientes.length > 0 ? "p-0" : undefined}>
              {!pendientesDisponible ? (
                <EstadoVacio titulo="Aún no disponible" mensaje="Requiere aplicar la migración 036 de rentas en esta base de datos." />
              ) : pendientes.length === 0 ? (
                <EstadoVacio titulo="Nada pendiente" mensaje="Ninguna reserva próxima se quedó sin recibir sus instrucciones por falta de correo del huésped." />
              ) : (
                <>
                  <p className="m-0 px-4 pt-3 text-xs text-muted-foreground">
                    Estas reservas llegaron sin correo del huésped (Airbnb, Booking y Vrbo no lo comparten), así que la liberación automática no pudo enviarles el acceso. Copia el mensaje y envíalo por la plataforma de la
                    reserva, o comparte el enlace de pre-check-in para que el huésped deje su correo.
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Unidad / huésped</TableHead>
                        <TableHead>Estancia</TableHead>
                        <TableHead>Canal</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendientes.map((p) => (
                        <TableRow key={p.reservaId}>
                          <TableCell className="text-xs">
                            <div>{p.unidadNombre}</div>
                            <div className="text-muted-foreground">{p.huespedNombre ?? "—"}</div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {p.checkIn} → {p.checkOut}
                          </TableCell>
                          <TableCell className="text-xs">{p.canal}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button type="button" size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void copiarMensaje(p)}>
                                {ocupado === `mensaje-${p.reservaId}` ? "Preparando…" : "Copiar mensaje para la OTA"}
                              </Button>
                              <Button type="button" size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void marcarEntregado(p)}>
                                Marcar como entregado por la OTA
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
              {mensajeManual && (
                <div className="flex flex-col gap-2 p-4">
                  <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                    Tu navegador no permitió copiar automáticamente. Selecciona y copia el mensaje:
                    <Textarea readOnly rows={8} value={mensajeManual.texto} onFocus={(e) => e.currentTarget.select()} />
                  </Label>
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setMensajeManual(null)}>
                    Cerrar
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Pre-check-in del huésped</CardTitle>
            </CardHeader>
            <CardContent>
              {config === null || !config.disponible ? (
                <EstadoVacio titulo="Aún no disponible" mensaje="El pre-check-in requiere aplicar la migración 036 de rentas en esta base de datos." />
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-xs text-muted-foreground">
                    Un enlace fijo para esta propiedad. Pégalo <strong className="text-foreground">una sola vez</strong> en los mensajes programados de Airbnb o Booking: el huésped escribe el código de su reserva y
                    los últimos 4 dígitos de su teléfono, deja su correo y la siguiente corrida le envía el acceso. No se pide identificación oficial.
                  </p>
                  <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                    Enlace público
                    <div className="flex gap-2">
                      <Input type="text" readOnly value={config.enlacePublico ?? ""} onFocus={(e) => e.currentTarget.select()} />
                      <Button type="button" size="sm" variant="outline" onClick={() => void accion("copiar-enlace", async () => ((await copiarAlPortapapeles(config.enlacePublico ?? "")) ? "Enlace copiado." : "No se pudo copiar: selecciona el enlace y cópialo."))}>
                        Copiar enlace
                      </Button>
                    </div>
                  </Label>
                  <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                    Texto sugerido para el mensaje programado
                    <Textarea readOnly rows={5} value={config.textoSugerido ?? ""} onFocus={(e) => e.currentTarget.select()} />
                  </Label>
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void accion("copiar-texto", async () => ((await copiarAlPortapapeles(config.textoSugerido ?? "")) ? "Texto copiado." : "No se pudo copiar: selecciona el texto y cópialo."))}>
                    Copiar texto sugerido
                  </Button>
                  <form
                    className="flex flex-col gap-3 border-t border-border pt-3"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void accion("reglamento", async () => {
                        await guardarReglamentoPrecheckin(fetch, apiBaseUrl, token, propertyId, reglamento.trim() === "" ? null : reglamento);
                        return "Reglamento guardado.";
                      });
                    }}
                  >
                    <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                      Reglamento de la casa (opcional)
                      <Textarea value={reglamento} maxLength={4000} rows={5} onChange={(e) => setReglamento(e.target.value)} />
                    </Label>
                    <p className="m-0 text-xs text-muted-foreground">Si lo escribes, el huésped debe aceptarlo para terminar su pre-check-in (versión actual: {config.reglamentoVersion}). Déjalo vacío para no pedirlo.</p>
                    <Button type="submit" size="sm" disabled={ocupado !== null} className="self-start">
                      {ocupado === "reglamento" ? "Guardando…" : "Guardar reglamento"}
                    </Button>
                  </form>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Política de liberación</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void accion("politica", async () => {
                    await guardarPoliticaAcceso(fetch, apiBaseUrl, token, propertyId, politica);
                    return "Política guardada.";
                  });
                }}
              >
                <Checkbox checked={politica.activo} onChange={(e) => setPolitica({ ...politica, activo: e.target.checked })} label="Liberar instrucciones automáticamente (apagado = nunca se envía nada)" />
                <div className="flex flex-wrap gap-3">
                  <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                    Horas antes del check-in (1 a 168)
                    <Input type="number" min={1} max={168} value={politica.horasAntesCheckin} onChange={(e) => setPolitica({ ...politica, horasAntesCheckin: Number(e.target.value) })} />
                  </Label>
                  <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                    Hora local de check-in
                    <Input type="time" value={politica.horaCheckin} onChange={(e) => setPolitica({ ...politica, horaCheckin: e.target.value })} />
                  </Label>
                </div>
                <Checkbox checked={politica.exigirPago} onChange={(e) => setPolitica({ ...politica, exigirPago: e.target.checked })} label="Exigir pago confirmado" />
                <Checkbox checked={politica.otaCuentaComoPagada} onChange={(e) => setPolitica({ ...politica, otaCuentaComoPagada: e.target.checked })} label="Las reservas de Airbnb, Vrbo y Booking cuentan como pagadas (la plataforma cobra al reservar)" />
                <Button type="submit" size="sm" disabled={ocupado !== null} className="self-start">
                  {ocupado === "politica" ? "Guardando…" : "Guardar política"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Instrucciones por unidad</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  if (!unidadId) {
                    setError("Elige una unidad.");
                    return;
                  }
                  void accion("instruccion", async () => {
                    await guardarInstruccionAcceso(fetch, apiBaseUrl, token, propertyId, unidadId, { direccionExacta: direccion, codigoAcceso: codigo || null, instrucciones: indicaciones || null });
                    return "Instrucciones guardadas.";
                  });
                }}
              >
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Unidad
                  <NativeSelect
                    value={unidadId}
                    onChange={(e) => {
                      setUnidadId(e.target.value);
                      void cargarInstruccion(e.target.value);
                    }}
                  >
                    <option value="">Selecciona una unidad…</option>
                    {unidades.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nombre}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Dirección exacta
                  <Input type="text" value={direccion} maxLength={500} onChange={(e) => setDireccion(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Código de acceso (opcional)
                  <Input type="text" value={codigo} maxLength={100} autoComplete="off" onChange={(e) => setCodigo(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-sm text-foreground">
                  Indicaciones (opcional)
                  <Textarea value={indicaciones} maxLength={2000} rows={3} onChange={(e) => setIndicaciones(e.target.value)} />
                </Label>
                <Button type="submit" size="sm" disabled={ocupado !== null || !unidadId} className="self-start">
                  {ocupado === "instruccion" ? "Guardando…" : "Guardar instrucciones"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Reservas próximas ({reservas.length})</CardTitle>
            </CardHeader>
            <CardContent className={reservas.length > 0 ? "p-0" : undefined}>
              {reservas.length === 0 ? (
                <EstadoVacio titulo="Sin reservas próximas" mensaje="No hay reservas confirmadas con check-out de hoy en adelante." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unidad / huésped</TableHead>
                      <TableHead>Estancia</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservas.map((r) => (
                      <TableRow key={r.reservaId}>
                        <TableCell className="text-xs">
                          <div>{r.unidadNombre}</div>
                          <div className="text-muted-foreground">{r.huespedNombre ?? "—"}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {r.checkIn} → {r.checkOut}
                        </TableCell>
                        <TableCell className="text-xs">{r.canal}</TableCell>
                        <TableCell>
                          {r.liberada ? (
                            <StatusBadge tone="success">Instrucciones enviadas</StatusBadge>
                          ) : r.pagoConfirmado ? (
                            <StatusBadge tone="info">Pago confirmado</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Sin pago confirmado</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell>
                          {!r.liberada && (
                            <Button type="button" size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void accion(r.reservaId, async () => {
                              await confirmarPagoReserva(fetch, apiBaseUrl, token, propertyId, r.reservaId, !r.pagoConfirmado);
                              return r.pagoConfirmado ? "Pago revocado." : "Pago confirmado.";
                            })}>
                              {r.pagoConfirmado ? "Revocar pago" : "Marcar pagada"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Bitácora de envíos</CardTitle>
            </CardHeader>
            <CardContent className={bitacora.length > 0 ? "p-0" : undefined}>
              {bitacora.length === 0 ? (
                <EstadoVacio titulo="Sin movimientos" mensaje="Aún no se ha liberado ni omitido ninguna instrucción." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cuándo</TableHead>
                      <TableHead>Reserva</TableHead>
                      <TableHead>Evento</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bitacora.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(e.creadoEn).toLocaleString("es-MX")}</TableCell>
                        <TableCell className="text-xs">{e.reservaId.slice(0, 8)}</TableCell>
                        <TableCell className="text-xs">{ETIQUETA_EVENTO_ACCESO[e.evento]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {dialogo}
    </PageContainer>
  );
}
