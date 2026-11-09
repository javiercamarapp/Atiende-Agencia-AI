// R-16: Avisos. Cada persona del staff elige que avisos in-app recibe (campana y pagina de notificaciones) y, para el pedido nuevo,
// si suena en el navegador ("Mis avisos"). Owner/admin ven ademas la matriz equipo x aviso (y la editan) y fijan los minutos de
// gracia de la alerta de "entrega tardia" por sucursal. Todo es real: cada control llama a un endpoint con rol, validacion y
// bitacora (apps/api/.../restaurantes/admin-avisos.ts); el servidor y la base re-validan quien puede editar a quien.
import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button, Card, CardContent, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, PageContainer, PageHeader, StatusBadge, Switch, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesAvisos } from "@atiende/ui/i18n/restaurantes/avisos";
import { fetchAvisos, guardarPreferenciaAviso, guardarUmbralEntrega } from "../lib/avisos-client.ts";
import type { AvisosWire, MiembroAvisosWire, PreferenciaAvisoWire } from "../lib/avisos-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ADMINS: ReadonlySet<string> = new Set(["owner", "admin"]);
const ROLE_LABELS: Readonly<Record<string, Clave>> = {
  owner: "restaurantes.avisos.rol.owner",
  admin: "restaurantes.avisos.rol.admin",
  staff: "restaurantes.avisos.rol.staff",
  repartidor: "restaurantes.avisos.rol.repartidor",
};

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

function reemplazar(lista: readonly PreferenciaAvisoWire[], tipo: string, parche: Partial<PreferenciaAvisoWire>): PreferenciaAvisoWire[] {
  return lista.map((p) => (p.tipo === tipo ? { ...p, ...parche } : p));
}

export function AvisosStaffPage({ apiBaseUrl, token, propertyId, role, staffEmail }: RestaurantesShellContext) {
  const t = useT(restaurantesAvisos);
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
        if (!cancelado) setError(mensaje(err, t("restaurantes.avisos.error.cargar")));
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
      setEstado({ tono: "ok", texto: t("restaurantes.avisos.ok.cambio") });
    } catch (err) {
      setEstado({ tono: "error", texto: mensaje(err, t("restaurantes.avisos.error.cambio")) });
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
      if (!/^\d+$/.test(texto)) throw new Error(t("restaurantes.avisos.error.minutosEntero"));
      const valor = Number(texto);
      await guardarUmbralEntrega(fetch, apiBaseUrl, token, propertyId, { propertyId: sucursalId, minutos: valor });
      setEstado({ tono: "ok", texto: t("restaurantes.avisos.ok.gracia") });
      setVersion((n) => n + 1);
    } catch (err) {
      setEstado({ tono: "error", texto: mensaje(err, t("restaurantes.avisos.error.gracia")) });
    } finally {
      setOcupado(null);
    }
  }

  return (
    <PageContainer padding="none">
      <PageHeader titulo={t("restaurantes.avisos.titulo")} />
      <p className="m-0 text-ui text-muted-foreground">{t("restaurantes.avisos.intro")}</p>

      {error && <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />}
      {!error && datos === null && <EstadoCargando lineas={3} />}
      {!error && datos && !datos.disponible && (
        <EstadoVacio icon={BellRing} titulo={t("restaurantes.avisos.noDisponible.titulo")} mensaje={t("restaurantes.avisos.noDisponible.mensaje")} />
      )}

      {!error && datos && datos.disponible && (
        <>
          {estado && (
            <p role="status" className={`m-0 text-sm ${estado.tono === "error" ? "text-destructive" : "text-foreground"}`}>
              {estado.texto}
            </p>
          )}

          <section className="flex flex-col gap-2" aria-label={t("restaurantes.avisos.mios")}>
            <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.avisos.mios")}</p>
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
                            label={t("restaurantes.avisos.sonido")}
                            checked={encendido && (p?.sonido ?? true)}
                            disabled={!encendido || ocupado === `yo:${e.tipo}`}
                            onChange={(ev) => void cambiar(e.tipo, { sonido: ev.target.checked })}
                          />
                        )}
                        <Switch aria-label={t("restaurantes.avisos.avisarme", { aviso: e.etiqueta })} checked={encendido} disabled={ocupado === `yo:${e.tipo}`} onCheckedChange={(v) => void cambiar(e.tipo, { enabled: v })} />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </section>

          {esAdmin && datos.equipo && (
            <section className="flex flex-col gap-2" aria-label={t("restaurantes.avisos.equipo")}>
              <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.avisos.equipo")}</p>
              <p className="m-0 text-xs text-muted-foreground">
                {t("restaurantes.avisos.equipoIntro")}
              </p>
              {datos.equipo.length === 0 ? (
                <EstadoVacio mensaje={t("restaurantes.avisos.equipoVacio")} />
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <DataTable<MiembroAvisosWire>
                      etiqueta={t("restaurantes.avisos.tabla")}
                      filas={datos.equipo}
                      obtenerId={(m) => m.userId}
                      paginacion={false}
                      columnas={[
                        {
                          id: "persona",
                          encabezado: t("restaurantes.avisos.persona"),
                          principal: true,
                          celda: (m) => (
                            <div>
                              <p className="m-0 text-sm font-semibold text-foreground">{m.fullName || m.email}</p>
                              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <StatusBadge tone="neutral" dot={false}>
                                  {ROLE_LABELS[m.verticalRole] ? t(ROLE_LABELS[m.verticalRole] as Clave) : m.verticalRole}
                                </StatusBadge>
                                {m.email === staffEmail && <span>{t("restaurantes.avisos.tu")}</span>}
                              </div>
                            </div>
                          ),
                        },
                        ...datos.eventos.map((e) => ({
                          id: e.tipo,
                          encabezado: e.etiqueta,
                          alinear: "center" as const,
                          celda: (m: MiembroAvisosWire) => {
                            const p = m.preferencias.find((x) => x.tipo === e.tipo);
                            const bloqueado = role === "admin" && m.verticalRole === "owner" && m.email !== staffEmail;
                            return (
                              <Checkbox
                                aria-label={t("restaurantes.avisos.para", { aviso: e.etiqueta, persona: m.fullName || m.email })}
                                checked={p?.enabled ?? true}
                                disabled={bloqueado || ocupado === `${m.userId}:${e.tipo}`}
                                onChange={(ev) => void cambiar(e.tipo, { enabled: ev.target.checked }, m)}
                              />
                            );
                          },
                        })),
                      ]}
                    />
                  </CardContent>
                </Card>
              )}
            </section>
          )}

          {esAdmin && datos.umbrales && (
            <section className="flex flex-col gap-2" aria-label={t("restaurantes.avisos.tardia")}>
              <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.avisos.tardia")}</p>
              <p className="m-0 text-xs text-muted-foreground">
                {t("restaurantes.avisos.tardiaIntro", { min: datos.umbralDefectoMin })}
              </p>
              {datos.umbrales.length === 0 ? (
                <EstadoVacio mensaje={t("restaurantes.avisos.sinSucursales")} />
              ) : (
                <div className="flex flex-col gap-2">
                  {datos.umbrales.map((u) => (
                    <Card key={u.propertyId}>
                      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                        <div>
                          <p className="m-0 text-sm font-semibold text-foreground">{u.nombre}</p>
                          <p className="m-0 mt-0.5 text-xs text-muted-foreground">{u.entregaTardiaMin === null ? t("restaurantes.avisos.sinConfigurar", { min: datos.umbralDefectoMin }) : t("restaurantes.avisos.min", { min: u.entregaTardiaMin })}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="numeric"
                            aria-label={t("restaurantes.avisos.graciaAria", { sucursal: u.nombre })}
                            min={datos.umbralMin ?? 10}
                            max={datos.umbralMax ?? 240}
                            step={1}
                            placeholder={String(datos.umbralDefectoMin)}
                            value={minutos[u.propertyId] ?? ""}
                            onChange={(ev) => setMinutos((m) => ({ ...m, [u.propertyId]: ev.target.value }))}
                            className="w-24"
                          />
                          <Button type="button" size="sm" variant="outline" loading={ocupado === `umbral:${u.propertyId}`} onClick={() => void guardarUmbral(u.propertyId)}>
                            {t("restaurantes.avisos.guardar")}

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
