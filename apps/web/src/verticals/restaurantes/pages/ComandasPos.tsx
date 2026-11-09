// Comandas al POS -- captura asistida de SoftRestaurant (Los Taquitos de PM). Mientras el POS no tenga API, el pedido entra por voz,
// WhatsApp o web y alguien lo teclea en SoftRestaurant: esta pantalla es esa cola. Todo es real: cada control llama a
// apps/api/.../restaurantes/admin-softrestaurant.ts (rol, alcance por sucursal, validacion y bitacora en el servidor).
//   * Estado del POS: modo efectivo y adaptador. Sin adaptador real el selector de modo queda deshabilitado y se explica el 409.
//   * Cola por sucursal con filtros de estado; "Copiar para POS" y "Marcar capturada" (nota opcional = folio del POS).
//   * Umbral de aviso de captura manual por sucursal (owner/admin; requiere la migracion 054).
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  Selector,
  PageContainer, PageHeader,
  StatusBadge,
  Tabs,
  TabsList,
  TabsTrigger,
  formatMoney,
  notify,
  useConfirm,
  useT,
} from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesComandas } from "@atiende/ui/i18n/restaurantes/comandas";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { ClipboardCopy, RefreshCw } from "lucide-react";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { fetchBranches } from "../dashboard-client.ts";
import type { BranchOption } from "../dashboard-client.ts";
import {
  ESTADOS_FILTRO_POR_DEFECTO,
  ETIQUETA_ESTADO_COMANDA,
  TONO_ESTADO_COMANDA,
  antiguedadTexto,
  fetchComandas,
  fetchConfigPos,
  fijarModoPos,
  fijarUmbralCapturaManual,
  marcarComandaCapturada,
  referenciaPedido,
  telefonoEnmascarado,
  textoParaPos,
} from "../lib/pos-comandas-client.ts";
import type { ComandaWire, ComandasWire, ConfigPosWire, EstadoComandaWire, ModoPos } from "../lib/pos-comandas-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ADMINS: ReadonlySet<string> = new Set(["owner", "admin"]);
/** Estados desde los que el staff puede marcar la comanda como capturada (los mismos que acepta la base). */
const CAPTURABLES: ReadonlySet<EstadoComandaWire> = new Set(["pendiente", "fallida", "captura_manual"]);
const REFRESCO_MS = 30_000;

type FiltroCola = "activas" | EstadoComandaWire | "resueltas";

// Las etiquetas se leen en el render (`t(clave)` o ETIQUETA_ESTADO_COMANDA, que traduce en cada lectura).
const FILTROS: ReadonlyArray<{ readonly valor: FiltroCola; readonly clave: Clave; readonly estados: readonly EstadoComandaWire[] }> = [
  { valor: "activas", clave: "restaurantes.comandas.filtro.activas", estados: ESTADOS_FILTRO_POR_DEFECTO },
  { valor: "captura_manual", clave: "restaurantes.comanda.captura_manual", estados: ["captura_manual"] },
  { valor: "fallida", clave: "restaurantes.comanda.fallida", estados: ["fallida"] },
  { valor: "pendiente", clave: "restaurantes.comanda.pendiente", estados: ["pendiente"] },
  { valor: "enviada", clave: "restaurantes.comanda.enviada", estados: ["enviada"] },
  { valor: "resueltas", clave: "restaurantes.comandas.filtro.resueltas", estados: ["confirmada", "capturada_manual"] },
];

const ETIQUETA_MODO: Readonly<Record<ModoPos, Clave>> = {
  apagado: "restaurantes.comandas.modo.apagado",
  sombra: "restaurantes.comandas.modo.sombra",
  activo: "restaurantes.comandas.modo.activo",
};

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ComandasPosPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
  const t = useT(restaurantesComun, restaurantesComandas);
  const esAdmin = ADMINS.has(role);
  const [config, setConfig] = useState<ConfigPosWire | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [sucursales, setSucursales] = useState<readonly BranchOption[]>([]);
  const [filtro, setFiltro] = useState<FiltroCola>("activas");
  const [branchId, setBranchId] = useState<string>("");
  const [cola, setCola] = useState<ComandasWire | null>(null);
  const [colaError, setColaError] = useState<string | null>(null);
  // Los contadores de las pestanas sobreviven al cambio de filtro (la cola no): vienen del ultimo `resumen` recibido.
  const [resumen, setResumen] = useState<ComandasWire["resumen"] | null>(null);
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const [cargando, setCargando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [minutos, setMinutos] = useState<Record<string, string>>({});
  const [guardandoModo, setGuardandoModo] = useState(false);
  const { pedirTexto, dialogo } = useConfirm();

  const refrescar = useCallback(() => setVersion((v) => v + 1), []);

  // Configuracion del POS + sucursales (una vez por sucursal activa / refresco manual).
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const cfg = await fetchConfigPos(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setConfig(cfg);
        setConfigError(null);
        setMinutos((previo) => {
          const siguiente: Record<string, string> = { ...previo };
          for (const [id, m] of Object.entries(cfg.umbralCapturaManual.porSucursal)) siguiente[id] = String(m);
          return siguiente;
        });
      } catch (err) {
        if (!cancelado) setConfigError(mensaje(err, t("restaurantes.comandas.error.estado")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version]);

  useEffect(() => {
    let cancelado = false;
    fetchBranches(fetch, apiBaseUrl, token, orgSlug)
      .then((b) => !cancelado && setSucursales(Array.isArray(b) ? b : []))
      .catch(() => !cancelado && setSucursales([]));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, orgSlug]);

  // QA-restaurantes-R2-botones-03: al cambiar de filtro o de sucursal se descarta la cola anterior (y su error); si la nueva carga falla solo se
  // ve el EstadoError, nunca comandas de otro filtro con sus botones activos. El refresco de 30 s y 'Actualizar' no la vacian.
  useEffect(() => {
    setCola(null);
    setColaError(null);
  }, [apiBaseUrl, token, propertyId, filtro, branchId]);

  // La cola: con el filtro y la sucursal elegidos; se vuelve a consultar sola cada 30 s mientras la pantalla esta abierta.
  useEffect(() => {
    let cancelado = false;
    const estados = FILTROS.find((f) => f.valor === filtro)?.estados ?? ESTADOS_FILTRO_POR_DEFECTO;
    async function cargar() {
      setCargando(true);
      try {
        const r = await fetchComandas(fetch, apiBaseUrl, token, propertyId, { estados, branchId: branchId || undefined, limit: 50 });
        if (cancelado) return;
        setCola(r);
        setResumen(r.resumen);
        setColaError(null);
        setAhoraMs(Date.now());
      } catch (err) {
        if (!cancelado) setColaError(mensaje(err, t("restaurantes.comandas.error.cola")));
      } finally {
        if (!cancelado) setCargando(false);
      }
    }
    void cargar();
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void cargar();
    }, REFRESCO_MS);
    return () => {
      cancelado = true;
      clearInterval(id);
    };
  }, [apiBaseUrl, token, propertyId, filtro, branchId, version]);

  const nombreSucursal = (id: string) => sucursales.find((s) => s.propertyId === id)?.name ?? t("restaurantes.comandas.sucursal");

  async function copiar(c: ComandaWire) {
    try {
      await navigator.clipboard.writeText(textoParaPos(c));
      notify.success(t("restaurantes.comandas.copiada"));
    } catch {
      notify.error(t("restaurantes.comandas.noCopio"));
    }
  }

  async function marcarCapturada(c: ComandaWire) {
    const nota = await pedirTexto({
      titulo: t("restaurantes.comandas.capturar.titulo", { ref: referenciaPedido(c.orderId) }),
      descripcion: t("restaurantes.comandas.capturar.descripcion"),
      confirmar: t("restaurantes.comandas.capturar.confirmar"),
      cancelar: t("restaurantes.volver"),
      campo: { etiqueta: t("restaurantes.comandas.capturar.folio"), placeholder: t("restaurantes.comandas.capturar.folioEjemplo"), requerido: false, maxLength: 300 },
    });
    if (nota === null) return; // Volver, Escape o cerrar: no se llama al API
    setOcupado(c.id);
    try {
      await marcarComandaCapturada(fetch, apiBaseUrl, token, propertyId, c.id, nota.trim() || null);
      notify.success(t("restaurantes.comandas.capturar.hecho"));
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, t("restaurantes.comandas.capturar.error")));
    } finally {
      setOcupado(null);
    }
  }

  async function cambiarModo(modo: ModoPos) {
    setGuardandoModo(true);
    try {
      await fijarModoPos(fetch, apiBaseUrl, token, propertyId, modo);
      notify.success(t("restaurantes.comandas.modo.actualizado"));
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, t("restaurantes.comandas.modo.error")));
    } finally {
      setGuardandoModo(false);
    }
  }

  async function guardarUmbral(id: string) {
    const texto = (minutos[id] ?? "").trim();
    const valor = Number(texto);
    const umbral = config?.umbralCapturaManual;
    if (!umbral) return;
    if (!/^\d+$/.test(texto) || valor < umbral.minimo || valor > umbral.maximo) {
      notify.error(t("restaurantes.comandas.umbral.rango", { min: umbral.minimo, max: umbral.maximo }));
      return;
    }
    setOcupado(`umbral:${id}`);
    try {
      await fijarUmbralCapturaManual(fetch, apiBaseUrl, token, propertyId, id, valor);
      notify.success(t("restaurantes.comandas.umbral.guardado"));
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, t("restaurantes.comandas.umbral.error")));
    } finally {
      setOcupado(null);
    }
  }

  const real = config?.adaptador.esReal === true;

  return (
    <PageContainer padding="none">
      <PageHeader titulo={t("restaurantes.comandas.titulo")} />

      {configError && <EstadoError mensaje={configError} onReintentar={refrescar} />}
      {!config && !configError && <EstadoCargando etiqueta={t("restaurantes.comandas.cargandoEstado")} />}

      {config && (
        <section className="flex flex-col gap-2" aria-label={t("restaurantes.comandas.estadoAria")}>
          {!real && (
            <Callout tone="warning" titulo={t("restaurantes.comandas.noConectado.titulo")} data-testid="pos-no-conectado">
              {t("restaurantes.comandas.noConectado.texto")}
            </Callout>
          )}
          {config.disponible === false && (
            <Callout tone="neutral" titulo={t("restaurantes.comandas.sinMigracion.titulo")} data-testid="pos-sin-migracion">
              {t("restaurantes.comandas.sinMigracion.texto")}
            </Callout>
          )}
          <Card>
            <CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
              <div>
                <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.comandas.modoEfectivo")}</p>
                <p className="m-0 mt-0.5 text-xs text-muted-foreground" data-testid="pos-modo-actual">
                  {t("restaurantes.comandas.adaptador", { modo: t(ETIQUETA_MODO[config.modo]), nombre: config.adaptador.nombre, real: t(real ? "restaurantes.comandas.adaptadorReal" : "restaurantes.comandas.adaptadorNoReal") })}
                </p>
              </div>
              {esAdmin ? (
                <FormField label={t("restaurantes.comandas.modo.campo")} hint={!real ? t("restaurantes.comandas.modo.deshabilitado") : undefined} className="w-full max-w-xs">
                  <Selector
                    id="pos-modo"
                    size="sm"
                    value={config.modo}
                    disabled={!real || guardandoModo}
                    onChange={(e) => void cambiarModo(e.target.value as ModoPos)}
                  >
                    <option value="apagado">{t("restaurantes.comandas.modo.opcion.apagado")}</option>
                    <option value="sombra">{t("restaurantes.comandas.modo.opcion.sombra")}</option>
                    <option value="activo">{t("restaurantes.comandas.modo.opcion.activo")}</option>
                  </Selector>
                </FormField>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.comandas.modo.soloAdmin")}</p>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label={t("restaurantes.comandas.colaAria")}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Tabs value={filtro} onValueChange={(v) => setFiltro(v as FiltroCola)}>
            <TabsList className="flex-wrap">
              {FILTROS.map((f) => (
                <TabsTrigger key={f.valor} value={f.valor}>
                  {t(f.clave)}
                  {f.valor !== "activas" && f.valor !== "resueltas" && resumen ? ` (${resumen[f.valor] ?? 0})` : ""}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-end gap-2">
            {sucursales.length > 1 && (
              <FormField label={t("restaurantes.comandas.sucursal")}>
                <Selector id="pos-sucursal" size="sm" value={branchId} onChange={(e) => setBranchId(e.target.value)} wrapperClassName="w-auto min-w-44">
                  <option value="">{t("restaurantes.comandas.todasSucursales")}</option>
                  {sucursales.map((s) => (
                    <option key={s.propertyId} value={s.propertyId}>
                      {s.name}
                    </option>
                  ))}
                </Selector>
              </FormField>
            )}
            <Button type="button" size="sm" variant="outline" onClick={refrescar} disabled={cargando}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
              {t("restaurantes.comandas.actualizar")}
            </Button>
          </div>
        </div>

        {colaError && <EstadoError mensaje={colaError} onReintentar={refrescar} />}
        {!cola && !colaError && <EstadoCargando etiqueta={t("restaurantes.comandas.cargando")} />}
        {cola && !cola.disponible && <EstadoVacio mensaje={t("restaurantes.comandas.colaNoDisponible")} />}
        {cola && cola.disponible && cola.comandas.length === 0 && <EstadoVacio mensaje={t("restaurantes.comandas.vacio")} />}

        <div className="flex flex-col gap-2.5">
          {cola?.comandas.map((c) => {
            const p = c.comanda;
            return (
              <Card key={c.id} data-testid={`comanda-${c.id}`}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <p className="m-0 font-semibold text-foreground">
                        {t("restaurantes.comandas.pedido", { ref: referenciaPedido(c.orderId), cliente: p.cliente.nombre })}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {telefonoEnmascarado(p.cliente.telefono)} · {nombreSucursal(c.propertyId)} (POS {p.sucursal}) · {antiguedadTexto(c.creadoEn, ahoraMs)}{/* // i18n-ignorar: «POS» es sigla, igual en ingles */}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-start gap-1.5 self-start">
                      <StatusBadge tone="neutral" dot={false}>
                        {t(p.tipo === "domicilio" ? "restaurantes.canal.domicilio" : "restaurantes.canal.recoger")}
                      </StatusBadge>
                      <StatusBadge tone={TONO_ESTADO_COMANDA[c.estado]} data-testid={`estado-${c.id}`}>
                        {ETIQUETA_ESTADO_COMANDA[c.estado]}
                      </StatusBadge>
                    </div>
                  </div>

                  <ul className="m-0 mt-2 list-none p-0 text-sm text-foreground">
                    {p.items.map((it, i) => (
                      <li key={i}>
                        {it.cantidad}× <span className="font-mono text-xs">{it.codigo}</span>
                        {it.nombre ? ` ${it.nombre}` : ""}
                        {it.modificadores.length > 0 && <span className="text-xs text-muted-foreground"> · {it.modificadores.map((m) => m.nombre ?? m.codigo).join(", ")}</span>}
                        {it.nota && <span className="text-xs text-muted-foreground">{t("restaurantes.comandas.nota", { nota: it.nota })}</span>}
                      </li>
                    ))}
                  </ul>
                  {p.notas && <p className="mt-1 text-xs text-muted-foreground">{t("restaurantes.comandas.notas", { notas: p.notas })}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.totalPedido !== null ? t("restaurantes.comandas.totalPedido", { total: formatMoney(c.totalPedido) }) : t("restaurantes.comandas.totalNoDisponible")}
                    {p.propina !== undefined && p.propina > 0 ? t("restaurantes.comandas.propina", { propina: formatMoney(p.propina) }) : ""}
                    {t("restaurantes.comandas.cobro", { forma: t(p.formaPago === "tarjeta" ? "restaurantes.comandas.forma.tarjeta" : "restaurantes.comandas.forma.efectivo") })}
                  </p>
                  {(c.estado === "captura_manual" || c.estado === "fallida") && c.ultimoError && (
                    <p className="mt-1 text-xs text-destructive">
                      {t("restaurantes.comandas.motivo", { error: c.ultimoError, intentos: c.intentos, max: c.maxIntentos })}
                    </p>
                  )}
                  {c.estado === "capturada_manual" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("restaurantes.comandas.capturadaAMano")}{c.notaCaptura ? t("restaurantes.comandas.folioCaptura", { folio: c.notaCaptura }) : ""}
                      {c.capturadoEn ? ` · ${fechaHoraEsMx(c.capturadoEn)}` : ""}
                    </p>
                  )}
                  {c.estado === "confirmada" && c.folio && <p className="mt-1 text-xs text-muted-foreground">{t("restaurantes.comandas.folio", { folio: c.folio })}</p>}

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" variant="outline" onClick={() => void copiar(c)}>
                      <ClipboardCopy className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      {t("restaurantes.comandas.copiar")}
                    </Button>
                    {CAPTURABLES.has(c.estado) && (
                      <Button type="button" size="sm" onClick={() => void marcarCapturada(c)} loading={ocupado === c.id}>
                        {t("restaurantes.comandas.capturar.confirmar")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {esAdmin && config && (
        <section className="flex flex-col gap-2" aria-label={t("restaurantes.comandas.umbral.titulo")}>
          <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.comandas.umbral.titulo")}</p>
          <p className="m-0 text-xs text-muted-foreground">
            {t("restaurantes.comandas.umbral.texto", { min: config.umbralCapturaManual.porOmisionMin })}
          </p>
          {!config.umbralCapturaManual.disponible ? (
            <Callout tone="neutral" titulo={t("restaurantes.comandas.umbral.noDisponible")} data-testid="umbral-sin-migracion">
              {t("restaurantes.comandas.umbral.sinMigracion")}
            </Callout>
          ) : sucursales.length === 0 ? (
            <EstadoVacio mensaje={t("restaurantes.comandas.umbral.sinSucursales")} />
          ) : (
            <div className="flex flex-col gap-2">
              {sucursales.map((s) => {
                const actual = config.umbralCapturaManual.porSucursal[s.propertyId];
                return (
                  <Card key={s.propertyId}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <p className="m-0 text-sm font-semibold text-foreground">{s.name}</p>
                        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{actual === undefined ? t("restaurantes.comandas.umbral.sinConfigurar", { min: config.umbralCapturaManual.porOmisionMin }) : t("restaurantes.comandas.umbral.min", { min: actual })}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          aria-label={t("restaurantes.comandas.umbral.aria", { sucursal: s.name })}
                          min={config.umbralCapturaManual.minimo}
                          max={config.umbralCapturaManual.maximo}
                          value={minutos[s.propertyId] ?? ""}
                          onChange={(e) => setMinutos((m) => ({ ...m, [s.propertyId]: e.target.value }))}
                          className="w-24"
                        />
                        <Button type="button" size="sm" variant="outline" onClick={() => void guardarUmbral(s.propertyId)} loading={ocupado === `umbral:${s.propertyId}`}>
                          {t("restaurantes.comandas.guardar")}

                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {dialogo}
    </PageContainer>
  );
}
