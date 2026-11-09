// CFO-08 · pestaña SoftRestaurant, en tres bloques: (a) comandas que enviamos, (b) importar el reporte exportado de SoftRestaurant (con lotes cargados y su
// cobertura) y (c) domicilio vs presencial con el cuadre diario básico (semáforo con los umbrales de la configuración del CFO). Cada bloque carga por su cuenta:
// uno que falla no tumba a los otros. Cifras `null` = «—».
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardPaste, FileUp, Settings2, ReceiptText, Store } from "lucide-react";
import type { CuadreSrVista, FilaCuadreApi, LotesSrVista, OperacionVista, SemaforoCuadre } from "@atiende/domain-restaurantes/cfo";
import type { LoteSr } from "@atiende/domain-restaurantes/cfo";
import { BarrasAgrupadas, Button, Callout, Card, ChartCard, DataTable, EstadoVacio, PageContainer, Semaforo, StatCard, TablaDatosGrafica, useT } from "@atiende/ui";
import type { Clave, EstadoSemaforo } from "@atiende/ui";
import { restaurantesCfoSr } from "@atiende/ui/i18n/restaurantes/cfoSr";
import { puedeEn } from "../lib/permisos.ts";
import { AjustesCfoDialogo } from "./AjustesCfoDialogo.tsx";
import { fetchCuadreSr, fetchLotesSr, fetchOperacion } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { ImportarSrDialogo } from "./ImportarSrDialogo.tsx";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, claveCarga, diaCorto } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

// Textos en espanol de referencia para las pruebas; en pantalla salen del catalogo (restaurantes.cfoSr.*), que sigue al idioma.
// i18n-ignorar
export const TITULO_SIN_SR = "Sin datos de mostrador de SoftRestaurant";
// i18n-ignorar
export const MENSAJE_SIN_SR = "Sube el reporte de ventas por tipo de servicio o el listado de cuentas para ver cuánto vendes en mostrador y cuadrar tus pedidos a domicilio";
// i18n-ignorar
export const TEXTO_COMANDAS_APAGADO = "El envío de comandas está apagado; no hay datos de captura";
// i18n-ignorar
export const ROTULO_CUADRE = "Cuadre básico por día; el cuadre por pedido llega con el folio estructurado (fase 2).";

const SEMAFORO_CUADRE: Readonly<Record<SemaforoCuadre, { readonly estado: EstadoSemaforo; readonly clave: Clave }>> = {
  verde: { estado: "verde", clave: "restaurantes.cfoSr.sem.verde" },
  ambar: { estado: "ambar", clave: "restaurantes.cfoSr.sem.ambar" },
  rojo: { estado: "rojo", clave: "restaurantes.cfoSr.sem.rojo" },
  sin_datos: { estado: "sin_dato", clave: "restaurantes.cfoSr.sem.sin_datos" },
};
const ETIQUETA_MODO: Readonly<Record<string, Clave>> = { apagado: "restaurantes.cfoSr.modo.apagado", sombra: "restaurantes.cfoSr.modo.sombra", activo: "restaurantes.cfoSr.modo.activo" };

// ---- (a) Comandas ---------------------------------------------------------------------------------------------------------------------

function Comandas({ d, base, abrir }: { readonly d: OperacionVista; readonly base: string; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  const t = useT(restaurantesCfoSr);
  const c = d.comandas;
  const s = c.sumas;
  const modo = (m: string): string => (ETIQUETA_MODO[m] ? t(ETIQUETA_MODO[m] as Clave) : m);
  if (c.modo === "apagado") {
    return (
      <EstadoVacio
        icon={ClipboardPaste}
        titulo={t("restaurantes.cfoSr.comandasApagado")}
        mensaje={t("restaurantes.cfoSr.comandasApagadoMensaje")}
        accion={
          <Link to={`${base}/comandas-pos`} className="text-ui font-medium text-primary underline-offset-4 hover:underline" data-testid="comandas-enlace-pos">
            {t("restaurantes.cfoSr.irComandas")}
          </Link>
        }
      />
    );
  }
  const pendientes = s.capturaManualPendientes + s.pendientesEnviadas;
  return (
    <div className="space-y-2.5" data-testid="sr-comandas">
      <p className="m-0 text-xs text-muted-foreground">
        {t("restaurantes.cfoSr.modoEnvio")}<strong className="font-semibold text-foreground">{modo(c.modo)}</strong>
        {s.sucursalesEncendidas < s.sucursalesTotal ? t("restaurantes.cfoSr.tasasCuentan", { encendidas: entero(s.sucursalesEncendidas), total: entero(s.sucursalesTotal) }) : ""}.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ClipboardPaste} label={t("restaurantes.cfoSr.encoladas")} value={entero(s.encoladas)} nota={t("restaurantes.cfoSr.encoladasNota")} />
        <StatCard icon={ClipboardPaste} label={t("restaurantes.cfoSr.confirmadas")} value={entero(s.confirmadas)} nota={t("restaurantes.cfoSr.confirmadasNota")} />
        <StatCard icon={ClipboardPaste} label={t("restaurantes.cfoSr.aMano")} value={entero(s.capturadasManual)} nota={t("restaurantes.cfoSr.aManoNota")} />
        <StatCard icon={ClipboardPaste} label={t("restaurantes.cfoSr.fallidas")} value={entero(s.fallidas)} nota={t("restaurantes.cfoSr.fallidasNota")} />
        <StatCard icon={ClipboardPaste} label={t("restaurantes.cfoSr.pendientes")} value={entero(pendientes)} nota={t("restaurantes.cfoSr.pendientesNota", { porCapturar: entero(s.capturaManualPendientes), sinConfirmar: entero(s.pendientesEnviadas) })} />
        <StatCard icon={ReceiptText} label={t("restaurantes.cfoSr.tasaCaptura")} value={textoCifra(c.tasaCaptura, "pct")} nota={t("restaurantes.cfoSr.tasaCapturaNota")} {...(c.tasaCaptura.valor === null ? { sinDato: t("restaurantes.cfoSr.sinEncoladas") } : {})} />
        <StatCard
          icon={ReceiptText}
          label={t("restaurantes.cfoSr.minutosCaptura")}
          value={minutos(c.minutosACaptura.valor)}
          nota={t("restaurantes.cfoSr.minutosCapturaNota")}
          {...(c.minutosACaptura.valor === null ? { sinDato: t("restaurantes.cfoSr.sinCapturadas") } : {})}
        />
        <StatCard icon={ReceiptText} label={t("restaurantes.cfoSr.vencidas")} value={entero(s.vencidasUmbral)} nota={t("restaurantes.cfoSr.vencidasNota")} />
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="comandas-folios">
        <span>{t("restaurantes.cfoSr.foliosPos", { n: entero(s.conFolioPos) })}</span>
        <span className="inline-flex items-center gap-1">
          {t("restaurantes.cfoSr.foliosDeclarados", { n: entero(s.conFolioDeclarado) })}
          <span className="rounded-full border border-warning/30 bg-warning-tint px-1.5 py-0.5 text-2xs font-medium text-warning">{t("restaurantes.cfoSr.textoLibre")}</span>
        </span>
        <ChipDeCifra cifra={c.tasaCaptura} mostrarMedido />
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <BotonPedidos etiqueta={t("restaurantes.cfoSr.verPedidosPeriodo")} onClick={() => abrir({})} />
        <Link to={`${base}/comandas-pos`} className="text-ui font-medium text-primary underline-offset-4 hover:underline">
          {t("restaurantes.cfoSr.irComandas")}
        </Link>
      </div>
      {c.porSucursal.length > 1 && (
        <Card className="overflow-hidden">
          <DataTable<(typeof c.porSucursal)[number]>
            etiqueta={t("restaurantes.cfoSr.comandasSucursal")}
            filas={c.porSucursal}
            obtenerId={(f) => f.propertyId}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "n", encabezado: t("restaurantes.cfoSr.col.sucursal"), principal: true, celda: (f) => f.nombre },
              { id: "m", encabezado: t("restaurantes.cfoSr.col.envio"), celda: (f) => modo(f.modo) },
              { id: "e", encabezado: t("restaurantes.cfoSr.encoladas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.encoladas) },
              { id: "c", encabezado: t("restaurantes.cfoSr.confirmadas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.confirmadas) },
              { id: "a", encabezado: t("restaurantes.cfoSr.col.aMano"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.capturadasManual) },
              { id: "f", encabezado: t("restaurantes.cfoSr.fallidas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.fallidas) },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

// ---- (b) Importar reporte y lotes ------------------------------------------------------------------------------------------------------

const ETIQUETA_TIPO: Readonly<Record<string, Clave>> = { resumen_servicio: "restaurantes.cfoSr.tipo.resumen_servicio", cuentas: "restaurantes.cfoSr.tipo.cuentas" };

function Lotes({ d, nombres }: { readonly d: LotesSrVista; readonly nombres: ReadonlyMap<string, string> }) {
  const t = useT(restaurantesCfoSr);
  return (
    <div className="space-y-2.5" data-testid="sr-lotes">
      {d.cobertura.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("restaurantes.cfoSr.cobertura")}>
          {d.cobertura.map((c) => (
            <li key={c.propertyId} className="rounded-md border border-border px-2.5 py-1 text-xs" data-testid="sr-cobertura">
              <span className="font-medium">{nombres.get(c.propertyId) ?? t("restaurantes.cfoSr.sucursal")}</span>: {c.diasConDato === 0 ? t("restaurantes.cfoSr.sinDias") : t("restaurantes.cfoSr.diasCubre", { count: c.diasConDato, n: entero(c.diasConDato), desde: c.diaMin ? diaCorto(c.diaMin) : SIN_DATO, hasta: c.diaMax ? diaCorto(c.diaMax) : SIN_DATO })}
            </li>
          ))}
        </ul>
      )}
      <Card className="overflow-hidden">
        <DataTable<LoteSr>
          etiqueta={t("restaurantes.cfoSr.lotes")}
          filas={d.lotes}
          obtenerId={(f) => f.id}
          paginacion={{ tamano: 8 }}
          vista="tabla"
          vacio={{ titulo: t("restaurantes.cfoSr.sinLotes"), mensaje: t("restaurantes.cfoSr.sinLotesMensaje") }}
          columnas={[
            { id: "a", encabezado: t("restaurantes.cfoSr.col.archivo"), principal: true, celda: (f) => f.nombreArchivo },
            { id: "s", encabezado: t("restaurantes.cfoSr.col.sucursal"), celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
            { id: "t", encabezado: t("restaurantes.cfoSr.col.tipo"), celda: (f) => (ETIQUETA_TIPO[f.tipo] ? t(ETIQUETA_TIPO[f.tipo] as Clave) : f.tipo) },
            { id: "c", encabezado: t("restaurantes.cfoSr.col.cubre"), celda: (f) => (f.fechaMin && f.fechaMax ? t("restaurantes.cfoSr.rango", { desde: diaCorto(f.fechaMin), hasta: diaCorto(f.fechaMax) }) : SIN_DATO) },
            { id: "ac", encabezado: t("restaurantes.cfoSr.col.aceptados"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.aceptados) },
            { id: "re", encabezado: t("restaurantes.cfoSr.col.rechazados"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.rechazados) },
            { id: "e", encabezado: t("restaurantes.cfoSr.col.estado"), celda: (f) => t(f.estado === "aplicado" ? "restaurantes.cfoSr.aplicado" : "restaurantes.cfoSr.reemplazado") },
          ]}
        />
      </Card>
    </div>
  );
}

// ---- (c) Domicilio vs presencial y cuadre ----------------------------------------------------------------------------------------------

function Cuadre({ d, props, onSubir, onUmbrales }: { readonly d: CuadreSrVista; readonly props: CfoPaginaProps; readonly onSubir: () => void; readonly onUmbrales: () => void }) {
  const t = useT(restaurantesCfoSr);
  const nombres = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  if (d.filas.length === 0) {
    return (
      <EstadoVacio
        icon={Store}
        titulo={t("restaurantes.cfoSr.sinSrTitulo")}
        mensaje={t("restaurantes.cfoSr.sinSrMensaje")}
        accion={
          puedeEn(props.role, "cfo.importar_sr") ? (
            <Button type="button" onClick={onSubir} className="gap-1.5" data-testid="cuadre-subir">
              <FileUp className="size-4" aria-hidden="true" />
              {t("restaurantes.cfoSr.importarReporte")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  const porSucursal = d.porSucursal.filter((s) => s.diasConDato > 0);
  const suma = (id: string | null, k: "nuestroDomicilioCentavos" | "srDomicilioCentavos") => d.filas.filter((f) => id === null || f.propertyId === id).reduce((a, f) => a + (f[k] ?? 0), 0);
  const grupos = [...porSucursal.map((s) => ({ etiqueta: s.nombre, id: s.propertyId })), { etiqueta: t("restaurantes.cfoSr.total"), id: null as string | null }];
  const u = d.umbrales;
  return (
    <div className="space-y-2.5" data-testid="sr-cuadre">
      <Callout tone="neutral" data-testid="cuadre-regla-total">
        {t("restaurantes.cfoSr.reglaTotal")}
      </Callout>
      <ChartCard titulo={t("restaurantes.cfoSr.domicilioVs")} subtitulo={t("restaurantes.cfoSr.domicilioVsSub")} tamano="M">
        <BarrasAgrupadas
          series={[
            { id: "nuestro", etiqueta: t("restaurantes.cfoSr.serieAgente") },
            { id: "sr", etiqueta: t("restaurantes.cfoSr.serieSr") },
          ]}
          grupos={grupos.map((g) => ({ etiqueta: g.etiqueta, valores: { nuestro: suma(g.id, "nuestroDomicilioCentavos"), sr: suma(g.id, "srDomicilioCentavos") } }))}
          formato={pesos}
          sinDatos={t("restaurantes.cfoSr.sinDomicilio")}
        />
        <TablaDatosGrafica
          titulo={t("restaurantes.cfoSr.domicilioTabla")}
          encabezados={[t("restaurantes.cfoSr.col.sucursal"), t("restaurantes.cfoSr.serieAgente"), "SoftRestaurant"]}
          filas={grupos.map((g) => [g.etiqueta, pesosExactos(suma(g.id, "nuestroDomicilioCentavos")), pesosExactos(suma(g.id, "srDomicilioCentavos"))])}
        />
        <p className="mt-2 text-2xs text-muted-foreground" data-testid="cuadre-sin-desglose">
          {t("restaurantes.cfoSr.sinDesglose")}
        </p>
      </ChartCard>
      <ChartCard
        titulo={t("restaurantes.cfoSr.cuadreDiario")}
        subtitulo={t("restaurantes.cfoSr.rotuloCuadre")}
        tamano="M"
        accion={
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onUmbrales} data-testid="cuadre-umbrales-abrir">
            <Settings2 className="size-3.5" aria-hidden="true" />
            {t("restaurantes.cfoSr.ajustarUmbrales")}
          </Button>
        }
      >
        <DataTable<FilaCuadreApi>
          etiqueta={t("restaurantes.cfoSr.cuadreTabla")}
          filas={d.filas}
          obtenerId={(f) => `${f.propertyId}-${f.diaNegocio}`}
          paginacion={{ tamano: 10 }}
          vista="tabla"
          atributosFila={(f) => ({ "data-semaforo": f.semaforo, "data-dia": f.diaNegocio })}
          columnas={[
            { id: "d", encabezado: t("restaurantes.cfoSr.col.dia"), principal: true, celda: (f) => diaCorto(f.diaNegocio) },
            { id: "s", encabezado: t("restaurantes.cfoSr.col.sucursal"), celda: (f) => nombres.get(f.propertyId) ?? f.nombre },
            { id: "n", encabezado: t("restaurantes.cfoSr.col.agente"), alinear: "right", className: "tabular-nums", celda: (f) => t("restaurantes.cfoSr.agentePedidos", { monto: pesos(f.nuestroDomicilioCentavos), n: entero(f.nuestroPedidos) }) },
            { id: "r", encabezado: "SoftRestaurant", alinear: "right", className: "tabular-nums", celda: (f) => (f.srDomicilioCentavos === null ? SIN_DATO : t("restaurantes.cfoSr.srCuentas", { monto: pesos(f.srDomicilioCentavos), n: entero(f.srTickets) })) },
            { id: "df", encabezado: t("restaurantes.cfoSr.col.diferencia"), alinear: "right", className: "tabular-nums", celda: (f) => (f.diferenciaCentavos === null ? SIN_DATO : `${f.diferenciaCentavos > 0 ? "+" : f.diferenciaCentavos < 0 ? "−" : ""}${pesosExactos(Math.abs(f.diferenciaCentavos))}`) },
            { id: "pc", encabezado: t("restaurantes.cfoSr.col.diferenciaPct"), alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.diferenciaPct) },
            { id: "sm", encabezado: t("restaurantes.cfoSr.col.semaforo"), celda: (f) => <Semaforo estado={SEMAFORO_CUADRE[f.semaforo].estado} texto={t(SEMAFORO_CUADRE[f.semaforo].clave)} /> },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground" data-testid="cuadre-umbrales">
          {t("restaurantes.cfoSr.umbralesTexto", { verdePct: porcentaje(u.verdePct), verdeMonto: pesos(u.verdeCentavos), ambarPct: porcentaje(u.ambarPct) })}
        </p>
        <div className="mt-2">
          <BotonPedidos etiqueta={t("restaurantes.cfoSr.verDomicilio")} onClick={() => props.abrirPedidos({ canal: "domicilio" })} />
        </div>
      </ChartCard>
    </div>
  );
}

// ---- Página ---------------------------------------------------------------------------------------------------------------------------------

export function CfoSoftRestaurant(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoSr);
  const clave = claveCarga(filtros);
  const operacion = useCargaCfo(() => fetchOperacion(api, filtros), [clave, api.propertyId, api.token]);
  const lotes = useCargaCfo(() => fetchLotesSr(api, filtros), [clave, api.propertyId, api.token]);
  const cuadre = useCargaCfo(() => fetchCuadreSr(api, filtros), [clave, api.propertyId, api.token]);
  const [importando, setImportando] = useState(false);
  const [ajustes, setAjustes] = useState(false);
  const puedeImportar = puedeEn(props.role, "cfo.importar_sr");
  const nombres = new Map(props.alcance.sucursales.map((s) => [s.propertyId, s.nombre]));
  // Un archivo = una sucursal: solo las sucursales del alcance elegido en la barra.
  const elegibles = props.alcance.sucursales.filter((s) => filtros.sucursales === null || filtros.sucursales.includes(s.propertyId.toLowerCase()));
  const recargarTodo = () => {
    lotes.recargar();
    cuadre.recargar();
  };

  return (
    <PageContainer padding="none" data-testid="cfo-softrestaurant">
      <section aria-labelledby="sr-a" className="space-y-2.5">
        <h2 id="sr-a" className="font-display text-base font-semibold">
          {t("restaurantes.cfoSr.seccionComandas")}
        </h2>
        <CargaCfoVista carga={operacion.carga} onReintentar={operacion.recargar} etiqueta={t("restaurantes.cfoSr.cargandoComandas")}>
          {(d) => (
            <Comandas d={d} base={props.base} abrir={props.abrirPedidos} />
          )}
        </CargaCfoVista>
      </section>

      <section aria-labelledby="sr-b" className="space-y-2.5" data-testid="sr-bloque-importar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sr-b" className="font-display text-base font-semibold">
            {t("restaurantes.cfoSr.seccionImportar")}
          </h2>
          {puedeImportar && (
            <Button type="button" onClick={() => setImportando(true)} className="gap-1.5" data-testid="sr-importar-abrir">
              <FileUp className="size-4" aria-hidden="true" />
              {t("restaurantes.cfoSr.importarReporte")}
            </Button>
          )}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {t("restaurantes.cfoSr.importarAyuda")}
        </p>
        <CargaCfoVista carga={lotes.carga} onReintentar={lotes.recargar} etiqueta={t("restaurantes.cfoSr.cargandoLotes")}>
          {(d) => <Lotes d={d} nombres={nombres} />}
        </CargaCfoVista>
      </section>

      <section aria-labelledby="sr-c" className="space-y-2.5">
        <h2 id="sr-c" className="font-display text-base font-semibold">
          {t("restaurantes.cfoSr.seccionCuadre")}
        </h2>
        <CargaCfoVista carga={cuadre.carga} onReintentar={cuadre.recargar} etiqueta={t("restaurantes.cfoSr.cargandoCuadre")}>
          {(d) => (
            <>
              {/* El estado vacío ya dice «Sin datos de mostrador»: no se repite el aviso del servicio. */}
              <AvisosCfo vista={{ ...d, avisos: d.filas.length === 0 ? d.avisos.filter((a) => !a.startsWith("Sin datos de mostrador")) : d.avisos }} />
              <Cuadre d={d} props={props} onSubir={() => setImportando(true)} onUmbrales={() => setAjustes(true)} />
            </>
          )}
        </CargaCfoVista>
      </section>

      {puedeImportar && <ImportarSrDialogo abierto={importando} onCerrar={() => setImportando(false)} api={api} sucursales={elegibles} onTerminado={recargarTodo} />}
      <AjustesCfoDialogo abierto={ajustes} onCerrar={() => setAjustes(false)} api={api} onGuardado={recargarTodo} />
    </PageContainer>
  );
}
