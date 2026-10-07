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
  notify,
  resolverRango,
  statusTone,
} from "@atiende/ui";
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
  if (resumen.estado === "cargando") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato="Cargando…" />;
  if (resumen.estado === "error") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={`No se pudo cargar: ${resumen.mensaje}`} />;
  const m = medir(resumen.data);
  if ("sinDato" in m) return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={m.sinDato} />;
  return <StatCard key={clave} variante="neutra" icon={icon} label={label} value={m.value} nota={m.nota} delta={m.delta} deltaNota={m.deltaNota} />;
}

const nulo = (razon: string | undefined, porDefecto: string): { readonly sinDato: string } => ({ sinDato: razon ?? porDefecto });
const entero = (n: number): string => n.toLocaleString("es-MX");
const plural = (n: number, uno: string, varios: string): string => `${entero(n)} ${n === 1 ? uno : varios}`;

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
  const { carga: resumen, recargar: recargarResumen } = useCarga<ConsolaResumen>(() => fetchConsolaResumen(apiBaseUrl, token), dep, "No se pudo cargar el resumen de la consola.");
  const { carga: agentes, recargar: recargarAgentes } = useCarga<AgentesActividad>(() => fetchAgentesActividad(apiBaseUrl, token), dep, "No se pudo cargar la actividad de los agentes.");
  const { carga: organizaciones, recargar: recargarOrganizaciones } = useCarga<readonly OrganizacionConsola[]>(() => fetchOrganizacionesConsola(apiBaseUrl, token), dep, "No se pudieron cargar las organizaciones.");

  const [params] = useSearchParams();
  const r = resolverRango(params.get("rango"), "30");

  const [entrando, setEntrando] = useState<OrganizacionConsola | null>(null);
  const clienteFijados = useMemo(() => crearClienteFijadosSuperadmin(apiBaseUrl, token), [apiBaseUrl, token]);

  async function entrar(motivo?: string): Promise<void> {
    if (!entrando) return;
    try {
      await fetchImpersonacionJson(apiBaseUrl, token, "/superadmin/impersonacion/sesiones", { method: "POST", body: JSON.stringify({ organizationId: entrando.id, reason: motivo ?? "" }) });
      notify.success(`Sesión de impersonación iniciada en ${entrando.name} (15 min, solo lectura, en bitácora).`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo iniciar la impersonación.");
      throw err;
    }
  }

  const nombre = primerNombreOCorreo(staffFullName, staffEmail ?? "");

  // ---- Odometro de MRR contra la meta --------------------------------------------------------------------------------
  const mrr = resumen.estado === "ok" ? resumen.data.mrr : null;
  const mrrMxn = mrr?.valor ? Math.round(mrr.valor.totalMxn) : null;
  const sinPrecio = mrr?.valor?.organizacionesSinPrecio ?? 0;
  const sinDatoMrr = resumen.estado === "error" ? `No se pudo cargar: ${resumen.mensaje}` : resumen.estado === "cargando" ? "Cargando…" : (mrr?.razon ?? "Sin dato de MRR.");
  const destacado = (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro valor={mrrMxn} digitos={7} prefijo="$" etiqueta="MRR — META $1,000,000" sinDato={sinDatoMrr} tamano="lg" meta={META_MRR_MXN} />
      {/* El odometro solo se pinta desde `sm`: en movil el mismo dato va en texto. */}
      <p className="text-ui text-muted-foreground sm:hidden">
        MRR <span className="font-medium tabular-nums text-foreground">{mrrMxn === null ? "—" : `$${entero(mrrMxn)}`}</span> · meta $1,000,000
      </p>
      {mrrMxn !== null && sinPrecio > 0 && <p className="text-xs text-muted-foreground">{plural(sinPrecio, "organización sin precio", "organizaciones sin precio")}</p>}
    </div>
  );

  // ---- 9 StatCards ----------------------------------------------------------------------------------------------------
  const kpis: ReactNode[] = [
    tarjeta(resumen, "organizaciones", Building2, "Organizaciones", (d) => {
      const o = d.organizaciones.valor;
      if (!o) return nulo(d.organizaciones.razon, "Sin dato de organizaciones.");
      const verticales = o.porVertical.filter((v) => v.total > 0).length;
      return { value: entero(o.total), nota: o.total > 0 && o.demo === o.total ? "solo demo" : `${plural(verticales, "vertical", "verticales")}${o.demo > 0 ? ` · ${o.demo} demo` : ""}` };
    }),
    tarjeta(resumen, "gasto-ia", BadgeDollarSign, "Gastado en IA — histórico", (d) => {
      const g = d.gastoIa.valor;
      if (!g) return nulo(d.gastoIa.razon, "Sin dato de gasto de IA.");
      const dl = g.delta7d.valor;
      // pct null = los 7 dias previos no tienen consumo: "sin periodo comparable", nunca un 0 %. Subir un costo no es "bueno".
      const delta = dl === null ? undefined : dl.pct === null ? null : { pct: Math.round(dl.pct * 10) / 10, bueno: dl.pct <= 0 };
      return { value: usd(g.totalUsd), delta, deltaNota: "7d vs 7d", nota: delta === undefined ? `LLM ${usd(g.llmUsd)} · otros ${usd(g.otrosUsd)}` : undefined };
    }),
    tarjeta(resumen, "tokens", Cpu, "Tokens usados — histórico", (d) => {
      const t = d.tokens.valor;
      if (!t) return nulo(d.tokens.razon, "Sin dato de tokens.");
      return { value: entero(t.total), nota: `${entero(t.entrada)} entrada · ${entero(t.salida)} salida` };
    }),
    tarjeta(resumen, "operaciones", Workflow, "Operaciones atendidas", (d) => {
      const o = d.operaciones.valor;
      if (!o) return nulo(d.operaciones.razon, "Sin dato de operaciones.");
      return { value: entero(o.total), nota: o.verticalesSinFuente.length > 0 ? `sin fuente: ${o.verticalesSinFuente.join(", ")}` : "todas las verticales" };
    }),
    tarjeta(resumen, "voz", Phone, "Llamadas de voz — minutos", (d) => {
      const v = d.vozMinutos.valor;
      if (v === null) return nulo(d.vozMinutos.razon, "Sin dato de voz.");
      return { value: `${v.toLocaleString("es-MX", { maximumFractionDigits: 1 })} min`, nota: "histórico, de usage_cost_event" };
    }),
    tarjeta(resumen, "sucursales", Store, "Sucursales / propiedades", (d) => {
      const s = d.sucursales.valor;
      if (s === null) return nulo(d.sucursales.razon, "Sin dato de sucursales.");
      return { value: entero(s), nota: "activas" };
    }),
    tarjeta(resumen, "usuarios", Users, "Usuarios con acceso", (d) => {
      const u = d.usuarios.valor;
      if (!u) return nulo(d.usuarios.razon, "Sin dato de usuarios.");
      return { value: entero(u.total), nota: `${entero(u.staff)} staff · ${entero(u.superadmins)} superadmin` };
    }),
    tarjeta(resumen, "whatsapp", MessageCircle, "Conversaciones de WhatsApp", (d) => {
      const w = d.conversacionesWa.valor;
      if (!w) return nulo(d.conversacionesWa.razon, "Sin dato de conversaciones.");
      const conFuente = w.porVertical.filter((v) => v.total !== null).length;
      return { value: entero(w.total), nota: `en ${plural(conFuente, "vertical", "verticales")} con fuente` };
    }),
    // Tres ramas honestas: no se pudo leer / sin conversaciones hoy / "X de N".
    tarjeta(resumen, "sin-humano", MessagesSquare, "Resueltas sin humano — hoy", (d) => {
      const x = d.resueltasSinHumano.valor;
      if (!x) return nulo(d.resueltasSinHumano.razon, "No se pudo leer esta métrica.");
      if (x.total === 0) return { value: "0 de 0", nota: "Sin conversaciones hoy" };
      return { value: `${entero(x.resueltas)} de ${entero(x.total)}`, nota: `${x.porcentaje === null ? "" : `${x.porcentaje}% · `}${x.nota}` };
    }),
  ];

  // ---- pildoras: solo hacia rutas que existen en rutas.ts ----------------------------------------------------------------
  const acciones = (
    <>
      {rutaExiste("/superadmin/analitica") && <PillLink to="/superadmin/analitica">Ver analítica</PillLink>}
      {rutaExiste("/superadmin/consumo-ia") && <PillLink to="/superadmin/consumo-ia">Ver costos de IA</PillLink>}
      <PillLink to={PARTE_DIARIO}>Ver parte diario</PillLink>
    </>
  );

  const etiquetaRango = r.rango === "7" ? "últimos 7 días" : `últimos ${DIAS_SERIE} días (el resumen guarda ${DIAS_SERIE})`;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoMexico()}
        nombre={nombre}
        subtitulo="Toda Atiende en una pantalla — cifras reales, de todas las verticales"
        destacado={destacado}
        kpis={kpis}
        acciones={acciones}
      >
        <BloqueOrquestacion agentes={agentes} onReintentar={recargarAgentes} />
        <BloqueCorridas agentes={agentes} onReintentar={recargarAgentes} />
        {/* CHAT-17: tablero de fijados del Copiloto de plataforma (personal; se re-ejecuta con tu rol y tu step-up de ahora; `finanzas` no lo ve). */}
        <SeccionFijadosCopiloto cliente={clienteFijados} sinCompartir rutaCopiloto="/superadmin/copiloto" />

        <ChartCard
          titulo="Operaciones atendidas por día"
          subtitulo={etiquetaRango}
          tamano="S"
          accion={<GlobalFilter base="/superadmin" r={r} />}
        >
          {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando operaciones…</p>}
          {resumen.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${resumen.mensaje}`} onReintentar={recargarResumen} />}
          {resumen.estado === "ok" &&
            (resumen.data.operaciones.valor ? (
              <BarChartSimple
                datos={ventanaSerie(resumen.data.operaciones.valor.serie14d, r.rango).map((p) => ({ dia: p.dia, valor: p.cantidad }))}
                etiquetaValor={(v) => `${entero(v)} operaciones`}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{resumen.data.operaciones.razon ?? "Sin dato de operaciones."}</p>
            ))}
        </ChartCard>

        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          <ChartCard titulo="Costo de IA por día" subtitulo={`US$ · ${etiquetaRango}`} tamano="S">
            {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando costo…</p>}
            {resumen.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${resumen.mensaje}`} onReintentar={recargarResumen} />}
            {resumen.estado === "ok" &&
              (resumen.data.gastoIa.valor?.serie14d.valor ? (
                <AreaChartSimple
                  datos={ventanaSerie(resumen.data.gastoIa.valor.serie14d.valor, r.rango).map((p) => ({ dia: p.dia, valor: p.usd }))}
                  etiquetaValor={usd}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{resumen.data.gastoIa.valor?.serie14d.razon ?? resumen.data.gastoIa.razon ?? "Sin dato de costo."}</p>
              ))}
          </ChartCard>
          <ChartCard titulo="Costo por agente / rol" subtitulo="histórico, US$" tamano="S">
            {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando agentes…</p>}
            {agentes.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${agentes.mensaje}`} onReintentar={recargarAgentes} />}
            {agentes.estado === "ok" &&
              (agentes.data.agentes.valor ? (
                <Dona segmentos={costoPorAgente(agentes.data.agentes.valor)} sinDatos="Ningún agente ha registrado costo todavía." />
              ) : (
                <p className="text-xs text-muted-foreground">{agentes.data.agentes.razon ?? "Sin dato de agentes."}</p>
              ))}
          </ChartCard>
        </div>

        <BloqueOrganizaciones organizaciones={organizaciones} onReintentar={recargarOrganizaciones} onEntrar={setEntrando} />

        <ChartCard titulo="Conversaciones de WhatsApp por vertical" subtitulo="solo conteo: el contenido no se muestra aquí" tamano="S">
          {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando conversaciones…</p>}
          {resumen.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${resumen.mensaje}`} onReintentar={recargarResumen} />}
          {resumen.estado === "ok" &&
            (resumen.data.conversacionesWa.valor ? (
              <ConversacionesPorVertical filas={resumen.data.conversacionesWa.valor.porVertical} />
            ) : (
              <p className="text-xs text-muted-foreground">{resumen.data.conversacionesWa.razon ?? "Sin dato de conversaciones."}</p>
            ))}
        </ChartCard>
      </ResumenLayout>

      <ConfirmDialog
        open={entrando !== null}
        onOpenChange={(open) => !open && setEntrando(null)}
        titulo={entrando ? `Entrar a ${entrando.name}` : "Entrar"}
        descripcion="Sesión de impersonación de solo lectura, auditada y de 15 minutos. Queda en la bitácora con tu motivo."
        confirmar="Entrar"
        campo={{ etiqueta: "Motivo", multilinea: true, minLength: MOTIVO_MINIMO, maxLength: 500, ayuda: `Obligatorio, mínimo ${MOTIVO_MINIMO} caracteres.`, placeholder: "Ej. Ticket SOP-9001: el cliente reporta que su checkout falla." }}
        onConfirm={entrar}
      />
    </PageContainer>
  );
}

// ---- bloques ------------------------------------------------------------------------------------------------------------

function BloqueOrquestacion({ agentes, onReintentar }: { agentes: Carga<AgentesActividad>; onReintentar: () => void }) {
  const filas = agentes.estado === "ok" ? agentes.data.agentes.valor : null;
  const actividad = filas ? actividadPorGrupo(filas) : null;
  return (
    <ResumenSeccion titulo="Orquestación de agentes">
      {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">Cargando agentes…</p>}
      {agentes.estado === "error" && (
        <div className="sm:col-span-2 lg:col-span-3">
          <EstadoError compacto mensaje={`No se pudo cargar: ${agentes.mensaje}`} onReintentar={onReintentar} />
        </div>
      )}
      {agentes.estado === "ok" && actividad === null && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{agentes.data.agentes.razon ?? "Sin dato de actividad de agentes."}</p>}
      {actividad?.map(({ grupo, llamadas, costoUsd }) => {
        const linea = llamadas > 0 ? `${entero(llamadas)} llamadas al modelo · ${usd(costoUsd)} — histórico` : "Sin corridas registradas.";
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
  const corridas = agentes.estado === "ok" ? agentes.data.ultimaCorrida.valor : null;
  return (
    <Card className="p-3" role="region" aria-labelledby="resumen-ultima-corrida">
      <SectionLabel id="resumen-ultima-corrida">Agentes de las verticales — última corrida</SectionLabel>
      <div className="mt-2">
        {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando la última corrida…</p>}
        {agentes.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${agentes.mensaje}`} onReintentar={onReintentar} />}
        {agentes.estado === "ok" && corridas === null && <p className="text-xs text-muted-foreground">{agentes.data.ultimaCorrida.razon ?? "Sin dato de corridas."}</p>}
        {corridas !== null && corridas.length === 0 && (
          <EstadoVacio compacto titulo="Sin corridas" mensaje="Ningún cron ha registrado latido todavía en este despliegue." />
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
  const cuando = fechaHoraCorta(corrida.terminoEn);
  if (cuando === null) return <AgentRunCard nombre={corrida.nombre} />;
  const tono = AGENTE_CORRIDA_TONOS[corrida.estado];
  return (
    <AgentRunCard
      nombre={corrida.nombre}
      estado={{ tone: tono ?? "neutral", etiqueta: corrida.estado === "ok" ? "OK" : corrida.estado === "error" ? "Fallo" : corrida.estado }}
      meta={
        <>
          {cuando} · {NOMBRE_VERTICAL[corrida.vertical] ?? corrida.vertical} · tareas: no medido
          {" — "}
          <Link to="/superadmin/salud" className="font-medium underline">
            ver detalle
          </Link>
        </>
      }
    />
  );
}

function BloqueOrganizaciones({ organizaciones, onReintentar, onEntrar }: { organizaciones: Carga<readonly OrganizacionConsola[]>; onReintentar: () => void; onEntrar: (o: OrganizacionConsola) => void }) {
  return (
    <Card className="p-3" role="region" aria-labelledby="resumen-organizaciones">
      <SectionLabel id="resumen-organizaciones">Organizaciones</SectionLabel>
      <div className="mt-2">
        {organizaciones.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando organizaciones…</p>}
        {organizaciones.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${organizaciones.mensaje}`} onReintentar={onReintentar} />}
        {organizaciones.estado === "ok" && organizaciones.data.length === 0 && <EstadoVacio compacto titulo="Sin organizaciones" mensaje="Todavía no hay organizaciones en la plataforma." />}
        {organizaciones.estado === "ok" && organizaciones.data.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Usuarios</TableHead>
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
                        <StatusBadge tone={statusTone(ORG_STATUS_TONES, o.status)}>{o.status === "active" ? "Activa" : o.status === "suspended" ? "Suspendida" : "Prueba"}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{o.staffCount}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" className="gap-1.5 rounded-full" aria-label={`Entrar a ${o.name}`} onClick={() => onEntrar(o)}>
                          <LogIn className="size-3.5" strokeWidth={1.75} />
                          Entrar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-faint">
              Plan, operaciones y costo de IA por organización: no disponible aún (el resumen solo entrega totales por vertical).
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function ConversacionesPorVertical({ filas }: { filas: readonly { vertical: string; total: number | null; razon?: string }[] }) {
  const conDato = filas.filter((f) => f.total !== null).map((f) => ({ etiqueta: NOMBRE_VERTICAL[f.vertical] ?? f.vertical, valor: f.total as number }));
  const sinFuente = filas.filter((f) => f.total === null);
  return (
    <div className="space-y-3">
      <HBars datos={conDato} sinDatos="Ninguna vertical tiene conversaciones de WhatsApp registradas." />
      {sinFuente.length > 0 && (
        <ul className="space-y-0.5 text-xs text-faint">
          {sinFuente.map((f) => (
            <li key={f.vertical} className="truncate" title={f.razon}>
              <span className="font-medium text-muted-foreground">{NOMBRE_VERTICAL[f.vertical] ?? f.vertical}</span>: — {f.razon ?? "sin dato"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
