// Resumen de la consola de superadmin (raiz /superadmin): la composicion del Resumen de Likida con las piezas de
// @atiende/ui (ResumenLayout, Odometro, StatCard neutra, PillLink, ResumenSeccion, AgentRunCard, kit de graficas).
// Vive DENTRO de SuperAdminShell: la barra de pagina (icono + "Consola de Atiende", campana y fecha) la pone el shell.
//
// TODA cifra sale de un endpoint que ya existe y cada uno se pide POR SEPARADO; el que falla pinta su error solo en su
// bloque. Fuentes:
//   - tarjetas, odometro de MRR, operaciones y costo por dia, conversaciones ... GET /superadmin/consola/resumen
//   - orquestacion de agentes, ultima corrida, dona de costo por agente ......... GET /superadmin/consola/agentes-actividad
//   - tabla de organizaciones ................................................... GET /superadmin/organizations
// Un campo `null` se pinta "—" con su motivo, nunca 0. Un solo `h1` (el saludo, dentro de `ResumenLayout`).
//
// Huecos declarados (ver cuerpo del PR): fichas de agente (SA-L-09: las tarjetas no llevan enlace), tareas x/y de las
// corridas (SA-L-07: "no medido"), plan/operaciones/costo de IA POR organizacion (sin endpoint), y la politica del MRR
// sin step-up (la decide Javier).
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AgentRunCard,
  AreaChartSimple,
  BarChartSimple,
  Button,
  Card,
  ChartCard,
  ConfirmDialog,
  Dona,
  EstadoError,
  EstadoVacio,
  GlobalFilter,
  HBars,
  Odometro,
  PageContainer,
  PillLink,
  ResumenLayout,
  ResumenSeccion,
  SeccionFijadosCopiloto,
  SectionLabel,
  StatCard,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  localeActivo,
  notify,
  resolverRango,
  statusTone,
  traductorActivo,
  useT,
} from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { comun } from "@atiende/ui/i18n/comun";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminConsola } from "@atiende/ui/i18n/superadmin/consola";
import {
  BadgeDollarSign,
  Building2,
  Bot,
  Cpu,
  LogIn,
  MessageCircle,
  MessagesSquare,
  Phone,
  Store,
  Users,
  Workflow,
} from "lucide-react";
import { primerNombreOCorreo } from "../../lib/greeting.ts";
import { ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { PARTE_DIARIO } from "../rutas.ts";
import {
  DIAS_SERIE,
  META_MRR_MXN,
  NOMBRE_VERTICAL,
  actividadPorGrupo,
  costoPorAgente,
  fetchAgentesActividad,
  fetchConsolaResumen,
  fetchOrganizacionesConsola,
  fechaHoraCorta,
  rutaExiste,
  saludoMexico,
  usd,
  ventanaSerie,
} from "../lib/consola-client.ts";
import type { AgentesActividad, CorridaCron, ConsolaResumen, OrganizacionConsola } from "../lib/consola-client.ts";
import { fetchImpersonacionJson } from "./Impersonacion.tsx";
import { crearClienteFijadosSuperadmin } from "../lib/copiloto-cliente.ts";

const MOTIVO_MINIMO = 20;

// Helpers fuera de React (tarjetas, plurales): traducen al idioma activo; la pagina usa `useT` y se repinta al cambiarlo.
const tr = traductorActivo(comun, superadminComun, superadminConsola);

// ---- carga independiente por bloque ---------------------------------------------------------------------------------

type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "ok"; readonly data: T } | { readonly estado: "error"; readonly mensaje: string };

function useCarga<T>(cargar: () => Promise<T>, dependencias: readonly unknown[], mensajeVacio: string): { carga: Carga<T>; recargar: () => void } {
  const [carga, setCarga] = useState<Carga<T>>({ estado: "cargando" });
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    let cancelado = false;
    setCarga({ estado: "cargando" });
    cargar()
      .then((data) => {
        if (!cancelado) setCarga({ estado: "ok", data });
      })
      .catch((err) => {
        if (!cancelado) setCarga({ estado: "error", mensaje: err instanceof Error && err.message ? err.message : mensajeVacio });
      });
    return () => {
      cancelado = true;
    };
    // `cargar` se recrea en cada render: la identidad de la carga la fijan `dependencias`.
  }, [intento, ...dependencias]);
  return { carga, recargar: () => setIntento((n) => n + 1) };
}

interface Medida {
  readonly value: string;
  readonly nota?: string;
  readonly delta?: { readonly pct: number; readonly bueno: boolean } | null;
  readonly deltaNota?: string;
}

type Icono = typeof Building2;

/** Una `StatCard` a partir del resumen: dato real, "Cargando…", error del bloque o "—" + razon del campo. Nunca un cero inventado. */
function tarjeta(resumen: Carga<ConsolaResumen>, clave: string, icon: Icono, label: string, medir: (r: ConsolaResumen) => Medida | { readonly sinDato: string }) {
  if (resumen.estado === "cargando") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={tr("comun.cargando")} />;
  if (resumen.estado === "error") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={tr("superadmin.comun.noSePudoCargar", { mensaje: resumen.mensaje })} />;
  const m = medir(resumen.data);
  if ("sinDato" in m) return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={m.sinDato} />;
  return <StatCard key={clave} variante="neutra" icon={icon} label={label} value={m.value} nota={m.nota} delta={m.delta} deltaNota={m.deltaNota} />;
}

const nulo = (razon: string | undefined, porDefecto: string): { readonly sinDato: string } => ({ sinDato: razon ?? porDefecto });
const entero = (n: number): string => n.toLocaleString(localeActivo());
/** Plural del catalogo con la cifra ya formateada (`{n}`), igual que antes: `entero(n)` + la forma que toca. */
const plural = (clave: Clave, n: number): string => tr(clave, { count: n, n: entero(n) });

const AGENTE_CORRIDA_TONOS: Readonly<Record<string, "success" | "danger">> = { ok: "success", error: "danger" };

// ---- pagina -----------------------------------------------------------------------------------------------------------

export interface ConsolaResumenProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Nombre completo de la sesion; si falta, el saludo cae al correo (nunca "Usuario"). */
  readonly staffFullName?: string;
  readonly staffEmail?: string;
}

export function SuperAdminConsolaResumenPage({ apiBaseUrl, token, staffFullName, staffEmail }: ConsolaResumenProps) {
  const dep = [apiBaseUrl, token] as const;
  const t = useT(comun, superadminComun, superadminConsola);
  const { carga: resumen, recargar: recargarResumen } = useCarga<ConsolaResumen>(() => fetchConsolaResumen(apiBaseUrl, token), dep, t("superadmin.consola.error.resumen"));
  const { carga: agentes, recargar: recargarAgentes } = useCarga<AgentesActividad>(() => fetchAgentesActividad(apiBaseUrl, token), dep, t("superadmin.consola.error.agentes"));
  const { carga: organizaciones, recargar: recargarOrganizaciones } = useCarga<readonly OrganizacionConsola[]>(() => fetchOrganizacionesConsola(apiBaseUrl, token), dep, t("superadmin.comun.error.organizaciones"));

  const [params] = useSearchParams();
  const r = resolverRango(params.get("rango"), "30");

  const [entrando, setEntrando] = useState<OrganizacionConsola | null>(null);
  const clienteFijados = useMemo(() => crearClienteFijadosSuperadmin(apiBaseUrl, token), [apiBaseUrl, token]);

  async function entrar(motivo?: string): Promise<void> {
    if (!entrando) return;
    try {
      await fetchImpersonacionJson(apiBaseUrl, token, "/superadmin/impersonacion/sesiones", { method: "POST", body: JSON.stringify({ organizationId: entrando.id, reason: motivo ?? "" }) });
      notify.success(t("superadmin.consola.impersonacionIniciada", { nombre: entrando.name }));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t("superadmin.consola.error.impersonacion"));
      throw err;
    }
  }

  const nombre = primerNombreOCorreo(staffFullName, staffEmail ?? "");

  // ---- Odometro de MRR contra la meta --------------------------------------------------------------------------------
  const mrr = resumen.estado === "ok" ? resumen.data.mrr : null;
  const mrrMxn = mrr?.valor ? Math.round(mrr.valor.totalMxn) : null;
  const sinPrecio = mrr?.valor?.organizacionesSinPrecio ?? 0;
  const sinDatoMrr =
    resumen.estado === "error" ? t("superadmin.comun.noSePudoCargar", { mensaje: resumen.mensaje }) : resumen.estado === "cargando" ? t("comun.cargando") : (mrr?.razon ?? t("superadmin.consola.sinDatoMrr"));
  const destacado = (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro valor={mrrMxn} digitos={7} prefijo="$" etiqueta={t("superadmin.consola.odometro")} sinDato={sinDatoMrr} tamano="lg" meta={META_MRR_MXN} />
      {/* El odometro solo se pinta desde `sm`: en movil el mismo dato va en texto. */}
      <p className="ds3-resumen-movil text-ui text-muted-foreground sm:hidden">
        {/* // i18n-ignorar: MRR es sigla, igual en los dos idiomas */}
        MRR <span className="font-medium tabular-nums text-foreground">{mrrMxn === null ? "—" : `$${entero(mrrMxn)}`}</span> {t("superadmin.consola.movilMeta")}
      </p>
      {mrrMxn !== null && sinPrecio > 0 && <p className="text-xs text-muted-foreground">{plural("superadmin.consola.sinPrecio", sinPrecio)}</p>}
    </div>
  );

  // ---- 9 StatCards ----------------------------------------------------------------------------------------------------
  const kpis: ReactNode[] = [
    tarjeta(resumen, "organizaciones", Building2, t("superadmin.comun.organizaciones"), (d) => {
      const o = d.organizaciones.valor;
      if (!o) return nulo(d.organizaciones.razon, t("superadmin.consola.kpi.sinOrganizaciones"));
      const verticales = o.porVertical.filter((v) => v.total > 0).length;
      return {
        value: entero(o.total),
        nota:
          o.total > 0 && o.demo === o.total
            ? t("superadmin.consola.kpi.soloDemo")
            : `${plural("superadmin.consola.kpi.verticales", verticales)}${o.demo > 0 ? ` · ${t("superadmin.consola.kpi.demo", { n: String(o.demo) })}` : ""}`,
      };
    }),
    tarjeta(resumen, "gasto-ia", BadgeDollarSign, t("superadmin.consola.kpi.gastoIa"), (d) => {
      const g = d.gastoIa.valor;
      if (!g) return nulo(d.gastoIa.razon, t("superadmin.consola.kpi.sinGastoIa"));
      const dl = g.delta7d.valor;
      // pct null = los 7 dias previos no tienen consumo: "sin periodo comparable", nunca un 0 %. Subir un costo no es "bueno".
      const delta = dl === null ? undefined : dl.pct === null ? null : { pct: Math.round(dl.pct * 10) / 10, bueno: dl.pct <= 0 };
      return { value: usd(g.totalUsd), delta, deltaNota: "7d vs 7d", nota: delta === undefined ? t("superadmin.consola.kpi.llmOtros", { llm: usd(g.llmUsd), otros: usd(g.otrosUsd) }) : undefined };
    }),
    tarjeta(resumen, "tokens", Cpu, t("superadmin.consola.kpi.tokens"), (d) => {
      const tk = d.tokens.valor;
      if (!tk) return nulo(d.tokens.razon, t("superadmin.consola.kpi.sinTokens"));
      return { value: entero(tk.total), nota: t("superadmin.consola.kpi.entradaSalida", { entrada: entero(tk.entrada), salida: entero(tk.salida) }) };
    }),
    tarjeta(resumen, "operaciones", Workflow, t("superadmin.consola.kpi.operaciones"), (d) => {
      const o = d.operaciones.valor;
      if (!o) return nulo(d.operaciones.razon, t("superadmin.consola.kpi.sinOperaciones"));
      return { value: entero(o.total), nota: o.verticalesSinFuente.length > 0 ? t("superadmin.consola.kpi.sinFuente", { lista: o.verticalesSinFuente.join(", ") }) : t("superadmin.consola.kpi.todasVerticales") };
    }),
    tarjeta(resumen, "voz", Phone, t("superadmin.consola.kpi.voz"), (d) => {
      const v = d.vozMinutos.valor;
      if (v === null) return nulo(d.vozMinutos.razon, t("superadmin.consola.kpi.sinVoz"));
      return { value: `${v.toLocaleString(localeActivo(), { maximumFractionDigits: 1 })} min`, nota: t("superadmin.consola.kpi.vozNota") };
    }),
    tarjeta(resumen, "sucursales", Store, t("superadmin.consola.kpi.sucursales"), (d) => {
      const s = d.sucursales.valor;
      if (s === null) return nulo(d.sucursales.razon, t("superadmin.consola.kpi.sinSucursales"));
      return { value: entero(s), nota: t("superadmin.consola.kpi.activas") };
    }),
    tarjeta(resumen, "usuarios", Users, t("superadmin.consola.kpi.usuarios"), (d) => {
      const u = d.usuarios.valor;
      if (!u) return nulo(d.usuarios.razon, t("superadmin.consola.kpi.sinUsuarios"));
      return { value: entero(u.total), nota: `${entero(u.staff)} staff · ${entero(u.superadmins)} superadmin` };
    }),
    tarjeta(resumen, "whatsapp", MessageCircle, t("superadmin.consola.kpi.whatsapp"), (d) => {
      const w = d.conversacionesWa.valor;
      if (!w) return nulo(d.conversacionesWa.razon, t("superadmin.consola.kpi.sinConversaciones"));
      const conFuente = w.porVertical.filter((v) => v.total !== null).length;
      return { value: entero(w.total), nota: plural("superadmin.consola.kpi.conFuente", conFuente) };
    }),
    // Tres ramas honestas: no se pudo leer / sin conversaciones hoy / "X de N".
    tarjeta(resumen, "sin-humano", MessagesSquare, t("superadmin.consola.kpi.sinHumano"), (d) => {
      const x = d.resueltasSinHumano.valor;
      if (!x) return nulo(d.resueltasSinHumano.razon, t("superadmin.consola.kpi.sinMetrica"));
      if (x.total === 0) return { value: t("superadmin.consola.kpi.deTotal", { a: "0", b: "0" }), nota: t("superadmin.consola.kpi.sinConversacionesHoy") };
      return { value: t("superadmin.consola.kpi.deTotal", { a: entero(x.resueltas), b: entero(x.total) }), nota: `${x.porcentaje === null ? "" : `${x.porcentaje}% · `}${x.nota}` };
    }),
  ];

  // ---- pildoras: solo hacia rutas que existen en rutas.ts ----------------------------------------------------------------
  const acciones = (
    <>
      {rutaExiste("/superadmin/analitica") && <PillLink to="/superadmin/analitica">{t("superadmin.consola.pill.analitica")}</PillLink>}
      {rutaExiste("/superadmin/consumo-ia") && <PillLink to="/superadmin/consumo-ia">{t("superadmin.consola.pill.costos")}</PillLink>}
      <PillLink to={PARTE_DIARIO}>{t("superadmin.consola.pill.parte")}</PillLink>
    </>
  );

  const etiquetaRango = r.rango === "7" ? t("superadmin.consola.rango.siete") : t("superadmin.consola.rango.serie", { d: String(DIAS_SERIE) });
  const subtituloCosto = `US$ · ${etiquetaRango}`; // i18n-ignorar: moneda, igual en los dos idiomas

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoMexico()}
        nombre={nombre}
        subtitulo={t("superadmin.consola.subtitulo")}
        frase={
          mrrMxn === null ? undefined : (
            <>
              {t("superadmin.consola.frase.inicio")} <strong>${entero(mrrMxn)}</strong> {t("superadmin.consola.frase.meta")}
              {sinPrecio > 0 ? ` ${plural("superadmin.consola.frase.sinPrecio", sinPrecio)}` : ""}.
            </>
          )
        }
        destacado={destacado}
        kpis={kpis}
        acciones={acciones}
      >
        <BloqueOrquestacion agentes={agentes} onReintentar={recargarAgentes} />
        <BloqueCorridas agentes={agentes} onReintentar={recargarAgentes} />
        {/* CHAT-17: tablero de fijados del Copiloto de plataforma (personal; se re-ejecuta con tu rol y tu step-up de ahora; `finanzas` no lo ve). */}
        <SeccionFijadosCopiloto cliente={clienteFijados} sinCompartir rutaCopiloto="/superadmin/copiloto" />

        <ChartCard
          titulo={t("superadmin.consola.grafica.operaciones")}
          subtitulo={etiquetaRango}
          tamano="S"
          accion={<GlobalFilter base="/superadmin" r={r} />}
        >
          {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.consola.grafica.cargandoOperaciones")}</p>}
          {resumen.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: resumen.mensaje })} onReintentar={recargarResumen} />}
          {resumen.estado === "ok" &&
            (resumen.data.operaciones.valor ? (
              <BarChartSimple
                datos={ventanaSerie(resumen.data.operaciones.valor.serie14d, r.rango).map((p) => ({ dia: p.dia, valor: p.cantidad }))}
                etiquetaValor={(v) => t("superadmin.consola.grafica.nOperaciones", { n: entero(v) })}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{resumen.data.operaciones.razon ?? t("superadmin.consola.kpi.sinOperaciones")}</p>
            ))}
        </ChartCard>

        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          <ChartCard titulo={t("superadmin.consola.grafica.costo")} subtitulo={subtituloCosto} tamano="S">
            {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.consola.grafica.cargandoCosto")}</p>}
            {resumen.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: resumen.mensaje })} onReintentar={recargarResumen} />}
            {resumen.estado === "ok" &&
              (resumen.data.gastoIa.valor?.serie14d.valor ? (
                <AreaChartSimple
                  datos={ventanaSerie(resumen.data.gastoIa.valor.serie14d.valor, r.rango).map((p) => ({ dia: p.dia, valor: p.usd }))}
                  etiquetaValor={usd}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{resumen.data.gastoIa.valor?.serie14d.razon ?? resumen.data.gastoIa.razon ?? t("superadmin.consola.grafica.sinCosto")}</p>
              ))}
          </ChartCard>
          <ChartCard titulo={t("superadmin.consola.grafica.costoAgente")} subtitulo={t("superadmin.consola.grafica.historicoUsd")} tamano="S">
            {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.consola.grafica.cargandoAgentes")}</p>}
            {agentes.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: agentes.mensaje })} onReintentar={recargarAgentes} />}
            {agentes.estado === "ok" &&
              (agentes.data.agentes.valor ? (
                <Dona segmentos={costoPorAgente(agentes.data.agentes.valor)} sinDatos={t("superadmin.consola.grafica.sinCostoAgente")} />
              ) : (
                <p className="text-xs text-muted-foreground">{agentes.data.agentes.razon ?? t("superadmin.consola.grafica.sinAgentes")}</p>
              ))}
          </ChartCard>
        </div>

        <BloqueOrganizaciones organizaciones={organizaciones} onReintentar={recargarOrganizaciones} onEntrar={setEntrando} />

        <ChartCard titulo={t("superadmin.consola.grafica.whatsapp")} subtitulo={t("superadmin.consola.grafica.soloConteo")} tamano="S">
          {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.consola.grafica.cargandoConversaciones")}</p>}
          {resumen.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: resumen.mensaje })} onReintentar={recargarResumen} />}
          {resumen.estado === "ok" &&
            (resumen.data.conversacionesWa.valor ? (
              <ConversacionesPorVertical filas={resumen.data.conversacionesWa.valor.porVertical} />
            ) : (
              <p className="text-xs text-muted-foreground">{resumen.data.conversacionesWa.razon ?? t("superadmin.consola.kpi.sinConversaciones")}</p>
            ))}
        </ChartCard>
      </ResumenLayout>

      <ConfirmDialog
        open={entrando !== null}
        onOpenChange={(open) => !open && setEntrando(null)}
        titulo={entrando ? t("superadmin.comun.entrarA", { nombre: entrando.name }) : t("superadmin.comun.entrar")}
        descripcion={t("superadmin.consola.entrar.descripcion")}
        confirmar={t("superadmin.comun.entrar")}
        campo={{
          etiqueta: t("superadmin.comun.col.motivo"),
          multilinea: true,
          minLength: MOTIVO_MINIMO,
          maxLength: 500,
          ayuda: t("superadmin.comun.motivoAyuda", { n: MOTIVO_MINIMO }),
          placeholder: t("superadmin.consola.entrar.placeholder"),
        }}
        onConfirm={entrar}
      />
    </PageContainer>
  );
}

// ---- bloques ------------------------------------------------------------------------------------------------------------

function BloqueOrquestacion({ agentes, onReintentar }: { agentes: Carga<AgentesActividad>; onReintentar: () => void }) {
  const t = useT(superadminComun, superadminConsola);
  const filas = agentes.estado === "ok" ? agentes.data.agentes.valor : null;
  const actividad = filas ? actividadPorGrupo(filas) : null;
  return (
    <ResumenSeccion titulo={t("superadmin.consola.orquestacion")}>
      {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{t("superadmin.consola.grafica.cargandoAgentes")}</p>}
      {agentes.estado === "error" && (
        <div className="sm:col-span-2 lg:col-span-3">
          <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: agentes.mensaje })} onReintentar={onReintentar} />
        </div>
      )}
      {agentes.estado === "ok" && actividad === null && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{agentes.data.agentes.razon ?? t("superadmin.consola.sinActividad")}</p>}
      {actividad?.map(({ grupo, llamadas, costoUsd }) => {
        const linea = llamadas > 0 ? t("superadmin.consola.llamadas", { n: entero(llamadas), costo: usd(costoUsd) }) : t("superadmin.consola.sinCorridasRegistradas");
        // La flecha y el enlace solo existen si la ficha del agente tiene ruta en rutas.ts (SA-L-09 aun no las crea).
        const conRuta = rutaExiste(grupo.ruta);
        const cuerpo = (
          <>
            <Bot aria-hidden="true" className="mt-0.5 size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-foreground">{grupo.nombre}</span>
              <p className={llamadas > 0 ? "mt-0.5 text-xs text-muted-foreground" : "mt-0.5 text-xs text-faint"}>{linea}</p>
            </div>
          </>
        );
        return conRuta ? (
          <Link key={grupo.clave} to={grupo.ruta} className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-canvas">
            {cuerpo}
          </Link>
        ) : (
          <div key={grupo.clave} data-testid="tarjeta-agente" className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
            {cuerpo}
          </div>
        );
      })}
    </ResumenSeccion>
  );
}

function BloqueCorridas({ agentes, onReintentar }: { agentes: Carga<AgentesActividad>; onReintentar: () => void }) {
  const t = useT(superadminComun, superadminConsola);
  const corridas = agentes.estado === "ok" ? agentes.data.ultimaCorrida.valor : null;
  return (
    <Card className="p-3" role="region" aria-labelledby="resumen-ultima-corrida">
      <SectionLabel id="resumen-ultima-corrida">{t("superadmin.consola.corrida.titulo")}</SectionLabel>
      <div className="mt-2">
        {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.consola.corrida.cargando")}</p>}
        {agentes.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: agentes.mensaje })} onReintentar={onReintentar} />}
        {agentes.estado === "ok" && corridas === null && <p className="text-xs text-muted-foreground">{agentes.data.ultimaCorrida.razon ?? t("superadmin.consola.corrida.sinDato")}</p>}
        {corridas !== null && corridas.length === 0 && (
          <EstadoVacio compacto titulo={t("superadmin.consola.corrida.vacioTitulo")} mensaje={t("superadmin.consola.corrida.vacio")} />
        )}
        {corridas !== null && corridas.length > 0 && (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {corridas.map((c) => (
              <TarjetaCorrida key={c.cron} corrida={c} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function TarjetaCorrida({ corrida }: { corrida: CorridaCron }) {
  const t = useT(superadminComun, superadminConsola);
  const cuando = fechaHoraCorta(corrida.terminoEn);
  if (cuando === null) return <AgentRunCard nombre={corrida.nombre} />;
  const tono = AGENTE_CORRIDA_TONOS[corrida.estado];
  const ok = "OK"; // i18n-ignorar: sigla igual en los dos idiomas
  return (
    <AgentRunCard
      nombre={corrida.nombre}
      estado={{ tone: tono ?? "neutral", etiqueta: corrida.estado === "ok" ? ok : corrida.estado === "error" ? t("superadmin.consola.corrida.fallo") : corrida.estado }}
      meta={
        <>
          {cuando} · {NOMBRE_VERTICAL[corrida.vertical] ?? corrida.vertical} · {t("superadmin.consola.corrida.tareas")}
          {" — "}
          <Link to="/superadmin/salud" className="font-medium underline">
            {t("superadmin.consola.corrida.verDetalle")}
          </Link>
        </>
      }
    />
  );
}

function BloqueOrganizaciones({ organizaciones, onReintentar, onEntrar }: { organizaciones: Carga<readonly OrganizacionConsola[]>; onReintentar: () => void; onEntrar: (o: OrganizacionConsola) => void }) {
  const t = useT(superadminComun, superadminConsola);
  return (
    <Card className="p-3" role="region" aria-labelledby="resumen-organizaciones">
      <SectionLabel id="resumen-organizaciones">{t("superadmin.comun.organizaciones")}</SectionLabel>
      <div className="mt-2">
        {organizaciones.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("superadmin.comun.cargandoOrganizaciones")}</p>}
        {organizaciones.estado === "error" && <EstadoError compacto mensaje={t("superadmin.comun.noSePudoCargar", { mensaje: organizaciones.mensaje })} onReintentar={onReintentar} />}
        {organizaciones.estado === "ok" && organizaciones.data.length === 0 && (
          <EstadoVacio compacto titulo={t("superadmin.consola.orgs.vacioTitulo")} mensaje={t("superadmin.consola.orgs.vacio")} />
        )}
        {organizaciones.estado === "ok" && organizaciones.data.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("superadmin.comun.col.organizacion")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.vertical")}</TableHead>
                    <TableHead>{t("superadmin.comun.col.estado")}</TableHead>
                    <TableHead className="text-right">{t("superadmin.comun.col.usuarios")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizaciones.data.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="max-w-[160px] truncate font-medium text-foreground sm:max-w-[260px]" title={o.name}>
                        {o.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{NOMBRE_VERTICAL[o.vertical] ?? o.vertical}</TableCell>
                      <TableCell>
                        <StatusBadge tone={statusTone(ORG_STATUS_TONES, o.status)}>{t(o.status === "active" ? "superadmin.comun.estadoOrg.active" : o.status === "suspended" ? "superadmin.comun.estadoOrg.suspended" : "superadmin.comun.estadoOrg.trial")}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{o.staffCount}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" className="gap-1.5 rounded-full" aria-label={t("superadmin.comun.entrarA", { nombre: o.name })} onClick={() => onEntrar(o)}>
                          <LogIn className="size-3.5" strokeWidth={1.75} />
                          {t("superadmin.comun.entrar")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-faint">
              {t("superadmin.consola.orgs.nota")}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function ConversacionesPorVertical({ filas }: { filas: readonly { vertical: string; total: number | null; razon?: string }[] }) {
  const t = useT(superadminComun, superadminConsola);
  const conDato = filas.filter((f) => f.total !== null).map((f) => ({ etiqueta: NOMBRE_VERTICAL[f.vertical] ?? f.vertical, valor: f.total as number }));
  const sinFuente = filas.filter((f) => f.total === null);
  return (
    <div className="space-y-3">
      <HBars datos={conDato} sinDatos={t("superadmin.consola.grafica.sinWhatsapp")} />
      {sinFuente.length > 0 && (
        <ul className="space-y-0.5 text-xs text-faint">
          {sinFuente.map((f) => (
            <li key={f.vertical} className="truncate" title={f.razon}>
              <span className="font-medium text-muted-foreground">{NOMBRE_VERTICAL[f.vertical] ?? f.vertical}</span>: — {f.razon ?? t("superadmin.comun.sinDato")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
