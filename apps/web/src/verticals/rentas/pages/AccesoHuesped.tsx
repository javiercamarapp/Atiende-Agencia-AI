// Rn-04 -- Acceso al huésped. Pantalla del staff (admin_gestora / operador:acceso_total, espejo de
// ACCESO_HUESPED_ROLES; el servidor y la RLS lo vuelven a exigir) para configurar cuándo se liberan
// las instrucciones de acceso (código de cerradura, dirección exacta): política por property,
// instrucciones por unidad, confirmación de pago de reservas directas y bitácora de envíos.
// Contra una base sin la migración 025 muestra "aún no disponible" en lugar de romperse.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import {
  confirmarPagoReserva,
  ETIQUETA_EVENTO_ACCESO,
  fetchBitacoraAcceso,
  fetchInstruccionAcceso,
  fetchPoliticaAcceso,
  fetchReservasAcceso,
  guardarInstruccionAcceso,
  guardarPoliticaAcceso,
} from "../lib/acceso-client.ts";
import type { EventoBitacoraAcceso, PoliticaAcceso, ReservaAcceso } from "../lib/acceso-client.ts";
import { fetchUnidades } from "../lib/calendario-client.ts";
import type { UnidadOption } from "../lib/calendario-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de ACCESO_HUESPED_ROLES (packages/domain-rentas/src/roles.ts).
const ACCESO_HUESPED_ROLES = new Set(["admin_gestora", "operador:acceso_total"]);
const POLITICA_VACIA: PoliticaAcceso = { activo: false, horasAntesCheckin: 24, horaCheckin: "15:00", exigirPago: true, otaCuentaComoPagada: true };
const INPUT_CLASES = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";

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

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const [p, u, r, b] = await Promise.all([
          fetchPoliticaAcceso(fetch, apiBaseUrl, token, propertyId),
          fetchUnidades(fetch, apiBaseUrl, token, propertyId),
          fetchReservasAcceso(fetch, apiBaseUrl, token, propertyId),
          fetchBitacoraAcceso(fetch, apiBaseUrl, token, propertyId),
        ]);
        if (cancelado) return;
        setDisponible(p.disponible);
        setPolitica(p.politica ?? POLITICA_VACIA);
        setUnidades(u);
        setReservas(r.reservas);
        setBitacora(b.eventos);
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

  const encabezado = (
    <header>
      <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Acceso al huésped</h1>
      <p className="m-0 text-[13px] text-muted-foreground">
        Las instrucciones de acceso (código de cerradura, dirección exacta) se envían por correo solo cuando faltan las horas que definas para el check-in y únicamente si la reserva está confirmada y
        pagada según tu política. Cada envío queda en la bitácora, sin datos personales.
      </p>
    </header>
  );

  if (!puede) {
    return (
      <div className="flex flex-col gap-4 max-w-[640px]">
        {encabezado}
        <p className="m-0 text-[13px] text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a esta sección. Roles con acceso: <strong className="text-foreground">admin_gestora</strong> y{" "}
          <strong className="text-foreground">operador:acceso_total</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 max-w-[960px]">
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
                <label className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={politica.activo} onChange={(e) => setPolitica({ ...politica, activo: e.target.checked })} />
                  Liberar instrucciones automáticamente (apagado = nunca se envía nada)
                </label>
                <div className="flex flex-wrap gap-3">
                  <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                    Horas antes del check-in (1 a 168)
                    <Input type="number" min={1} max={168} value={politica.horasAntesCheckin} onChange={(e) => setPolitica({ ...politica, horasAntesCheckin: Number(e.target.value) })} />
                  </Label>
                  <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                    Hora local de check-in
                    <Input type="time" value={politica.horaCheckin} onChange={(e) => setPolitica({ ...politica, horaCheckin: e.target.value })} />
                  </Label>
                </div>
                <label className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={politica.exigirPago} onChange={(e) => setPolitica({ ...politica, exigirPago: e.target.checked })} />
                  Exigir pago confirmado
                </label>
                <label className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={politica.otaCuentaComoPagada} onChange={(e) => setPolitica({ ...politica, otaCuentaComoPagada: e.target.checked })} />
                  Las reservas de Airbnb, Vrbo y Booking cuentan como pagadas (la plataforma cobra al reservar)
                </label>
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
                <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  Unidad
                  <select
                    value={unidadId}
                    onChange={(e) => {
                      setUnidadId(e.target.value);
                      void cargarInstruccion(e.target.value);
                    }}
                    className={INPUT_CLASES}
                  >
                    <option value="">Selecciona una unidad…</option>
                    {unidades.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nombre}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  Dirección exacta
                  <Input type="text" value={direccion} maxLength={500} onChange={(e) => setDireccion(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  Código de acceso (opcional)
                  <Input type="text" value={codigo} maxLength={100} autoComplete="off" onChange={(e) => setCodigo(e.target.value)} />
                </Label>
                <Label className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  Indicaciones (opcional)
                  <textarea value={indicaciones} maxLength={2000} rows={3} onChange={(e) => setIndicaciones(e.target.value)} className={`${INPUT_CLASES} h-auto`} />
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
                          {r.liberada ? <Badge className="text-[10px]">Instrucciones enviadas</Badge> : r.pagoConfirmado ? <Badge variant="secondary" className="text-[10px]">Pago confirmado</Badge> : <Badge variant="outline" className="text-[10px]">Sin pago confirmado</Badge>}
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
    </div>
  );
}
