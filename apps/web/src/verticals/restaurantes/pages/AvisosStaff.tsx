// R-16: Avisos. Cada persona del staff elige que avisos in-app recibe (campana y pagina de notificaciones) y, para el pedido nuevo,
// si suena en el navegador ("Mis avisos"). Owner/admin ven ademas la matriz equipo x aviso (y la editan) y fijan los minutos de
// gracia de la alerta de "entrega tardia" por sucursal. Todo es real: cada control llama a un endpoint con rol, validacion y
// bitacora (apps/api/.../restaurantes/admin-avisos.ts); el servidor y la base re-validan quien puede editar a quien.
import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button, Card, CardContent, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, PageContainer, StatusBadge, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { fetchAvisos, guardarPreferenciaAviso, guardarUmbralEntrega } from "../lib/avisos-client.ts";
import type { AvisosWire, MiembroAvisosWire, PreferenciaAvisoWire } from "../lib/avisos-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ADMINS: ReadonlySet<string> = new Set(["owner", "admin"]);
const ROLE_LABELS: Record<string, string> = { owner: "Dueño", admin: "Administrador", staff: "Staff (gestión)", repartidor: "Repartidor" };

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

function reemplazar(lista: readonly PreferenciaAvisoWire[], tipo: string, parche: Partial<PreferenciaAvisoWire>): PreferenciaAvisoWire[] {
  return lista.map((p) => (p.tipo === tipo ? { ...p, ...parche } : p));
}

export function AvisosStaffPage({ apiBaseUrl, token, propertyId, role, staffEmail }: RestaurantesShellContext) {
  const esAdmin = ADMINS.has(role);
  const [datos, setDatos] = useState<AvisosWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState<{ readonly tono: "ok" | "error"; readonly texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [minutos, setMinutos] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const d = await fetchAvisos(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setDatos(d);
        setError(null);
        setMinutos(Object.fromEntries((d.umbrales ?? []).map((u) => [u.propertyId, u.entregaTardiaMin === null ? "" : String(u.entregaTardiaMin)])));
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudieron cargar los avisos."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  /** Guarda una preferencia (propia o de otra persona) y refleja el resultado solo cuando el servidor lo confirma. */
  async function cambiar(tipo: string, parche: { enabled?: boolean; sonido?: boolean }, miembro?: MiembroAvisosWire) {
    if (!datos) return;
    // Una fila del equipo que es la propia persona se guarda como preferencia propia (sin userId) y tambien refresca "Mis avisos".
    const propia = miembro === undefined || miembro.email === staffEmail;
    const actual = (miembro ? miembro.preferencias : datos.mias).find((p) => p.tipo === tipo);
    if (!actual) return;
    const siguiente = { enabled: parche.enabled ?? actual.enabled, sonido: parche.sonido ?? actual.sonido };
    const clave = `${miembro?.userId ?? "yo"}:${tipo}`;
    setOcupado(clave);
    setEstado(null);
    try {
      await guardarPreferenciaAviso(fetch, apiBaseUrl, token, propertyId, { tipo, enabled: siguiente.enabled, sonido: siguiente.sonido, ...(propia ? {} : { userId: miembro.userId }) });
      setDatos((d) => {
        if (!d) return d;
        return {
          ...d,
          mias: propia ? reemplazar(d.mias, tipo, siguiente) : d.mias,
          equipo: miembro && d.equipo ? d.equipo.map((m) => (m.userId === miembro.userId ? { ...m, preferencias: reemplazar(m.preferencias, tipo, siguiente) } : m)) : d.equipo,
        };
      });
      setEstado({ tono: "ok", texto: "Cambio guardado." });
    } catch (err) {
      setEstado({ tono: "error", texto: mensaje(err, "No se pudo guardar el cambio.") });
    } finally {
      setOcupado(null);
    }
  }

  async function guardarUmbral(sucursalId: string) {
    const texto = (minutos[sucursalId] ?? "").trim();
    setOcupado(`umbral:${sucursalId}`);
    setEstado(null);
    try {
      // Vacio o con letras NO es 0: se rechaza antes de llamar al servidor.
      if (!/^\d+$/.test(texto)) throw new Error("Escribe los minutos como un número entero.");
      const valor = Number(texto);
      await guardarUmbralEntrega(fetch, apiBaseUrl, token, propertyId, { propertyId: sucursalId, minutos: valor });
      setEstado({ tono: "ok", texto: "Tiempo de gracia guardado." });
      setVersion((n) => n + 1);
    } catch (err) {
      setEstado({ tono: "error", texto: mensaje(err, "No se pudo guardar el tiempo de gracia.") });
    } finally {
      setOcupado(null);
    }
  }

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">Avisos</h1>
        <p className="m-0 text-ui text-muted-foreground">Elige qué avisos recibes en la campana y en Notificaciones. Si apagas uno, dejas de recibirlo; el resto sigue igual.</p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />}
      {!error && datos === null && <EstadoCargando lineas={3} />}
      {!error && datos && !datos.disponible && (
        <EstadoVacio icon={BellRing} titulo="Avisos no disponibles aún" mensaje="Los avisos por persona todavía no están habilitados en esta base de datos. Mientras tanto recibes todos." />
      )}

      {!error && datos && datos.disponible && (
        <>
          {estado && (
            <p role="status" className={`m-0 text-sm ${estado.tono === "error" ? "text-destructive" : "text-foreground"}`}>
              {estado.texto}
            </p>
          )}

          <section className="flex flex-col gap-2" aria-label="Mis avisos">
            <p className="m-0 text-sm font-semibold text-foreground">Mis avisos</p>
            <Card>
              <CardContent className="flex flex-col divide-y divide-line2 p-0">
                {datos.eventos.map((e) => {
                  const p = datos.mias.find((m) => m.tipo === e.tipo);
                  const encendido = p?.enabled ?? true;
                  return (
                    <div key={e.tipo} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="m-0 text-sm font-semibold text-foreground">{e.etiqueta}</p>
                        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{e.descripcion}</p>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-foreground">
                        {e.sonidoAplica && (
                          <Checkbox
                            label="Sonido en el navegador"
                            checked={encendido && (p?.sonido ?? true)}
                            disabled={!encendido || ocupado === `yo:${e.tipo}`}
                            onChange={(ev) => void cambiar(e.tipo, { sonido: ev.target.checked })}
                          />
                        )}
                        <Switch aria-label={`Avisarme: ${e.etiqueta}`} checked={encendido} disabled={ocupado === `yo:${e.tipo}`} onCheckedChange={(v) => void cambiar(e.tipo, { enabled: v })} />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </section>

          {esAdmin && datos.equipo && (
            <section className="flex flex-col gap-2" aria-label="Avisos del equipo">
              <p className="m-0 text-sm font-semibold text-foreground">Avisos del equipo</p>
              <p className="m-0 text-xs text-muted-foreground">
                Enciende o apaga cada aviso por persona. Un administrador no puede cambiar los de un dueño; el servidor lo rechaza aunque la casilla aparezca aquí.
              </p>
              {datos.equipo.length === 0 ? (
                <EstadoVacio mensaje="Todavía no hay personas en el equipo." />
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Persona</TableHead>
                          {datos.eventos.map((e) => (
                            <TableHead key={e.tipo} className="text-center">
                              {e.etiqueta}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {datos.equipo.map((m) => {
                          const esUnoMismo = m.email === staffEmail;
                          const bloqueado = role === "admin" && m.verticalRole === "owner" && !esUnoMismo;
                          return (
                            <TableRow key={m.userId}>
                              <TableCell>
                                <p className="m-0 text-sm font-semibold text-foreground">{m.fullName || m.email}</p>
                                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <StatusBadge tone="neutral" dot={false}>
                                    {ROLE_LABELS[m.verticalRole] ?? m.verticalRole}
                                  </StatusBadge>
                                  {esUnoMismo && <span>tú</span>}
                                </div>
                              </TableCell>
                              {datos.eventos.map((e) => {
                                const p = m.preferencias.find((x) => x.tipo === e.tipo);
                                return (
                                  <TableCell key={e.tipo} className="text-center">
                                    <Checkbox
                                      aria-label={`${e.etiqueta} para ${m.fullName || m.email}`}
                                      checked={p?.enabled ?? true}
                                      disabled={bloqueado || ocupado === `${m.userId}:${e.tipo}`}
                                      onChange={(ev) => void cambiar(e.tipo, { enabled: ev.target.checked }, m)}
                                    />
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </section>
          )}

          {esAdmin && datos.umbrales && (
            <section className="flex flex-col gap-2" aria-label="Entrega tardía por sucursal">
              <p className="m-0 text-sm font-semibold text-foreground">Entrega tardía por sucursal</p>
              <p className="m-0 text-xs text-muted-foreground">
                Un pedido en preparación o en camino se avisa como tardío cuando pasa su hora prometida (la del repartidor asignado o la de recoger). Si no tiene una, se cuentan estos minutos
                desde que se creó o desde su hora programada. Sin configurar son {datos.umbralDefectoMin} minutos.
              </p>
              {datos.umbrales.length === 0 ? (
                <EstadoVacio mensaje="Todavía no hay sucursales activas." />
              ) : (
                <div className="flex flex-col gap-2">
                  {datos.umbrales.map((u) => (
                    <Card key={u.propertyId}>
                      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                        <div>
                          <p className="m-0 text-sm font-semibold text-foreground">{u.nombre}</p>
                          <p className="m-0 mt-0.5 text-xs text-muted-foreground">{u.entregaTardiaMin === null ? `Sin configurar (${datos.umbralDefectoMin} min)` : `${u.entregaTardiaMin} min`}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="numeric"
                            aria-label={`Minutos de gracia en ${u.nombre}`}
                            min={datos.umbralMin ?? 10}
                            max={datos.umbralMax ?? 240}
                            step={1}
                            placeholder={String(datos.umbralDefectoMin)}
                            value={minutos[u.propertyId] ?? ""}
                            onChange={(ev) => setMinutos((m) => ({ ...m, [u.propertyId]: ev.target.value }))}
                            className="w-24"
                          />
                          <Button type="button" size="sm" variant="outline" loading={ocupado === `umbral:${u.propertyId}`} onClick={() => void guardarUmbral(u.propertyId)}>
                            Guardar
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </PageContainer>
  );
}
