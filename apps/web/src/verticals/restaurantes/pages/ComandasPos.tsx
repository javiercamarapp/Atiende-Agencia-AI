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
  NativeSelect,
  PageContainer,
  StatusBadge,
  Tabs,
  TabsList,
  TabsTrigger,
  formatMoney,
  notify,
  useConfirm,
} from "@atiende/ui";
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

const FILTROS: ReadonlyArray<{ readonly valor: FiltroCola; readonly etiqueta: string; readonly estados: readonly EstadoComandaWire[] }> = [
  { valor: "activas", etiqueta: "Por atender", estados: ESTADOS_FILTRO_POR_DEFECTO },
  { valor: "captura_manual", etiqueta: ETIQUETA_ESTADO_COMANDA.captura_manual, estados: ["captura_manual"] },
  { valor: "fallida", etiqueta: ETIQUETA_ESTADO_COMANDA.fallida, estados: ["fallida"] },
  { valor: "pendiente", etiqueta: ETIQUETA_ESTADO_COMANDA.pendiente, estados: ["pendiente"] },
  { valor: "enviada", etiqueta: ETIQUETA_ESTADO_COMANDA.enviada, estados: ["enviada"] },
  { valor: "resueltas", etiqueta: "Resueltas", estados: ["confirmada", "capturada_manual"] },
];

const ETIQUETA_MODO: Readonly<Record<ModoPos, string>> = {
  apagado: "Apagado: no se envía nada al POS",
  sombra: "Sombra: se encola en paralelo para comparar contra caja",
  activo: "Activo: se envía al POS al crear el pedido",
};

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ComandasPosPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
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
        if (!cancelado) setConfigError(mensaje(err, "No se pudo cargar el estado de SoftRestaurant."));
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
        if (!cancelado) setColaError(mensaje(err, "No se pudo cargar la cola de comandas."));
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

  const nombreSucursal = (id: string) => sucursales.find((s) => s.propertyId === id)?.name ?? "Sucursal";

  async function copiar(c: ComandaWire) {
    try {
      await navigator.clipboard.writeText(textoParaPos(c));
      notify.success("Comanda copiada: pégala en SoftRestaurant.");
    } catch {
      notify.error("Este navegador no permitió copiar. Selecciona el texto de la comanda y cópialo a mano.");
    }
  }

  async function marcarCapturada(c: ComandaWire) {
    const nota = await pedirTexto({
      titulo: `Marcar capturada la comanda ${referenciaPedido(c.orderId)}`,
      descripcion: "Confírmalo solo cuando ya la capturaste en SoftRestaurant: se dejan de reintentar los envíos automáticos de esta comanda.",
      confirmar: "Marcar capturada",
      cancelar: "Volver",
      campo: { etiqueta: "Folio del POS (opcional)", placeholder: "Ej. T1-004512", requerido: false, maxLength: 300 },
    });
    if (nota === null) return; // Volver, Escape o cerrar: no se llama al API
    setOcupado(c.id);
    try {
      await marcarComandaCapturada(fetch, apiBaseUrl, token, propertyId, c.id, nota.trim() || null);
      notify.success("Comanda marcada como capturada.");
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, "No se pudo marcar la comanda como capturada."));
    } finally {
      setOcupado(null);
    }
  }

  async function cambiarModo(modo: ModoPos) {
    setGuardandoModo(true);
    try {
      await fijarModoPos(fetch, apiBaseUrl, token, propertyId, modo);
      notify.success("Modo de SoftRestaurant actualizado.");
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, "No se pudo cambiar el modo."));
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
      notify.error(`Escribe un número entero de minutos entre ${umbral.minimo} y ${umbral.maximo}.`);
      return;
    }
    setOcupado(`umbral:${id}`);
    try {
      await fijarUmbralCapturaManual(fetch, apiBaseUrl, token, propertyId, id, valor);
      notify.success("Umbral guardado.");
      refrescar();
    } catch (err) {
      notify.error(mensaje(err, "No se pudo guardar el umbral."));
    } finally {
      setOcupado(null);
    }
  }

  const real = config?.adaptador.esReal === true;

  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina lo pinta la barra superior del shell (contrato de pagina UNI-4): el h1 queda solo para lectores de pantalla. */}
      <h1 className="sr-only">Comandas al POS</h1>

      {configError && <EstadoError mensaje={configError} onReintentar={refrescar} />}
      {!config && !configError && <EstadoCargando etiqueta="Cargando el estado de SoftRestaurant…" />}

      {config && (
        <section className="flex flex-col gap-2" aria-label="Estado de SoftRestaurant">
          {!real && (
            <Callout tone="warning" titulo="SoftRestaurant no conectado: requiere la API del distribuidor" data-testid="pos-no-conectado">
              Mientras tanto los pedidos no se envían solos: alguien captura cada comanda en el POS desde esta cola (captura asistida). Con el adaptador sin configurar, el servidor
              rechaza (409) cualquier modo distinto de «Apagado».
            </Callout>
          )}
          {config.disponible === false && (
            <Callout tone="neutral" titulo="Cola no disponible aún" data-testid="pos-sin-migracion">
              Requiere la migración 024 de restaurantes en esta base de datos.
            </Callout>
          )}
          <Card>
            <CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
              <div>
                <p className="m-0 text-sm font-semibold text-foreground">Modo efectivo</p>
                <p className="m-0 mt-0.5 text-xs text-muted-foreground" data-testid="pos-modo-actual">
                  {ETIQUETA_MODO[config.modo]} · adaptador «{config.adaptador.nombre}» {real ? "(real)" : "(no real)"}
                </p>
              </div>
              {esAdmin ? (
                <FormField label="Modo" hint={!real ? "Deshabilitado: requiere el adaptador real de SoftRestaurant." : undefined} className="w-full max-w-xs">
                  <NativeSelect
                    id="pos-modo"
                    size="sm"
                    value={config.modo}
                    disabled={!real || guardandoModo}
                    onChange={(e) => void cambiarModo(e.target.value as ModoPos)}
                  >
                    <option value="apagado">Apagado</option>
                    <option value="sombra">Sombra</option>
                    <option value="activo">Activo</option>
                  </NativeSelect>
                </FormField>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">El modo solo lo cambia un dueño o administrador.</p>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-3" aria-label="Cola de comandas">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Tabs value={filtro} onValueChange={(v) => setFiltro(v as FiltroCola)}>
            <TabsList className="flex-wrap">
              {FILTROS.map((f) => (
                <TabsTrigger key={f.valor} value={f.valor}>
                  {f.etiqueta}
                  {f.valor !== "activas" && f.valor !== "resueltas" && resumen ? ` (${resumen[f.valor] ?? 0})` : ""}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-end gap-2">
            {sucursales.length > 1 && (
              <FormField label="Sucursal">
                <NativeSelect id="pos-sucursal" size="sm" value={branchId} onChange={(e) => setBranchId(e.target.value)} wrapperClassName="w-auto min-w-44">
                  <option value="">Todas mis sucursales</option>
                  {sucursales.map((s) => (
                    <option key={s.propertyId} value={s.propertyId}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            )}
            <Button type="button" size="sm" variant="outline" onClick={refrescar} disabled={cargando}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
              Actualizar
            </Button>
          </div>
        </div>

        {colaError && <EstadoError mensaje={colaError} onReintentar={refrescar} />}
        {!cola && !colaError && <EstadoCargando etiqueta="Cargando comandas…" />}
        {cola && !cola.disponible && <EstadoVacio mensaje="La cola de comandas aún no está disponible: requiere la migración 024 de restaurantes en esta base." />}
        {cola && cola.disponible && cola.comandas.length === 0 && <EstadoVacio mensaje="No hay comandas en este filtro." />}

        <div className="flex flex-col gap-2.5">
          {cola?.comandas.map((c) => {
            const p = c.comanda;
            return (
              <Card key={c.id} data-testid={`comanda-${c.id}`}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <p className="m-0 font-semibold text-foreground">
                        Pedido {referenciaPedido(c.orderId)} · {p.cliente.nombre}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {telefonoEnmascarado(p.cliente.telefono)} · {nombreSucursal(c.propertyId)} (POS {p.sucursal}) · {antiguedadTexto(c.creadoEn, ahoraMs)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-start gap-1.5 self-start">
                      <StatusBadge tone="neutral" dot={false}>
                        {p.tipo === "domicilio" ? "Domicilio" : "Recoger"}
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
                        {it.nota && <span className="text-xs text-muted-foreground"> · nota: {it.nota}</span>}
                      </li>
                    ))}
                  </ul>
                  {p.notas && <p className="mt-1 text-xs text-muted-foreground">Notas: {p.notas}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.totalPedido !== null ? `Total del pedido $${formatMoney(c.totalPedido)}` : "Total no disponible"}
                    {p.propina !== undefined && p.propina > 0 ? ` · Propina $${formatMoney(p.propina)}` : ""} · {p.formaPago === "tarjeta" ? "Tarjeta" : "Efectivo"} · cobra caja o el repartidor
                  </p>
                  {(c.estado === "captura_manual" || c.estado === "fallida") && c.ultimoError && (
                    <p className="mt-1 text-xs text-destructive">
                      Motivo: {c.ultimoError} · intentos {c.intentos}/{c.maxIntentos}
                    </p>
                  )}
                  {c.estado === "capturada_manual" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Capturada a mano{c.notaCaptura ? ` · folio del POS: ${c.notaCaptura}` : ""}
                      {c.capturadoEn ? ` · ${fechaHoraEsMx(c.capturadoEn)}` : ""}
                    </p>
                  )}
                  {c.estado === "confirmada" && c.folio && <p className="mt-1 text-xs text-muted-foreground">Folio del POS: {c.folio}</p>}

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" variant="outline" onClick={() => void copiar(c)}>
                      <ClipboardCopy className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Copiar para POS
                    </Button>
                    {CAPTURABLES.has(c.estado) && (
                      <Button type="button" size="sm" onClick={() => void marcarCapturada(c)} loading={ocupado === c.id}>
                        Marcar capturada
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
        <section className="flex flex-col gap-2" aria-label="Aviso de captura manual por sucursal">
          <p className="m-0 text-sm font-semibold text-foreground">Aviso de captura manual por sucursal</p>
          <p className="m-0 text-xs text-muted-foreground">
            Si una comanda lleva más de estos minutos esperando captura manual, el equipo recibe un aviso en la campana. Sin configurar son {config.umbralCapturaManual.porOmisionMin} minutos.
          </p>
          {!config.umbralCapturaManual.disponible ? (
            <Callout tone="neutral" titulo="No disponible aún" data-testid="umbral-sin-migracion">
              Requiere la migración 054 de restaurantes en esta base de datos.
            </Callout>
          ) : sucursales.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay sucursales activas." />
          ) : (
            <div className="flex flex-col gap-2">
              {sucursales.map((s) => {
                const actual = config.umbralCapturaManual.porSucursal[s.propertyId];
                return (
                  <Card key={s.propertyId}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <p className="m-0 text-sm font-semibold text-foreground">{s.name}</p>
                        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{actual === undefined ? `Sin configurar (${config.umbralCapturaManual.porOmisionMin} min)` : `${actual} min`}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          aria-label={`Minutos de espera en ${s.name}`}
                          min={config.umbralCapturaManual.minimo}
                          max={config.umbralCapturaManual.maximo}
                          value={minutos[s.propertyId] ?? ""}
                          onChange={(e) => setMinutos((m) => ({ ...m, [s.propertyId]: e.target.value }))}
                          className="w-24"
                        />
                        <Button type="button" size="sm" variant="outline" onClick={() => void guardarUmbral(s.propertyId)} loading={ocupado === `umbral:${s.propertyId}`}>
                          Guardar
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
