// CFO-08 · pestaña SoftRestaurant, en tres bloques: (a) comandas que enviamos, (b) importar el reporte exportado de SoftRestaurant (con lotes cargados y su
// cobertura) y (c) domicilio vs presencial con el cuadre diario básico (semáforo con los umbrales de la configuración del CFO). Cada bloque carga por su cuenta:
// uno que falla no tumba a los otros. Cifras `null` = «—».
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardPaste, FileUp, Settings2, ReceiptText, Store } from "lucide-react";
import type { CuadreSrVista, FilaCuadreApi, LotesSrVista, OperacionVista, SemaforoCuadre } from "@atiende/domain-restaurantes/cfo";
import type { LoteSr } from "@atiende/domain-restaurantes/cfo";
import { BarrasAgrupadas, Button, Callout, ChartCard, DataTable, EstadoVacio, PageContainer, Semaforo, StatCard, TablaDatosGrafica } from "@atiende/ui";
import type { EstadoSemaforo } from "@atiende/ui";
import { puedeEn } from "../lib/permisos.ts";
import { AjustesCfoDialogo } from "./AjustesCfoDialogo.tsx";
import { fetchCuadreSr, fetchLotesSr, fetchOperacion } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { ImportarSrDialogo } from "./ImportarSrDialogo.tsx";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, claveCarga, diaCorto } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export const TITULO_SIN_SR = "Sin datos de mostrador de SoftRestaurant";
export const MENSAJE_SIN_SR = "Sube el reporte de ventas por tipo de servicio o el listado de cuentas para ver cuánto vendes en mostrador y cuadrar tus pedidos a domicilio";
export const TEXTO_COMANDAS_APAGADO = "El envío de comandas está apagado; no hay datos de captura";
export const ROTULO_CUADRE = "Cuadre básico por día; el cuadre por pedido llega con el folio estructurado (fase 2).";

const SEMAFORO_CUADRE: Readonly<Record<SemaforoCuadre, { readonly estado: EstadoSemaforo; readonly texto: string }>> = {
  verde: { estado: "verde", texto: "Cuadra" },
  ambar: { estado: "ambar", texto: "Revisar" },
  rojo: { estado: "rojo", texto: "No cuadra" },
  sin_datos: { estado: "sin_dato", texto: "Sin dato" },
};
const ETIQUETA_MODO: Readonly<Record<string, string>> = { apagado: "Apagado", sombra: "En sombra (no manda al POS)", activo: "Activo" };

// ---- (a) Comandas ---------------------------------------------------------------------------------------------------------------------

function Comandas({ d, base, abrir }: { readonly d: OperacionVista; readonly base: string; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  const c = d.comandas;
  const s = c.sumas;
  if (c.modo === "apagado") {
    return (
      <EstadoVacio
        icon={ClipboardPaste}
        titulo={TEXTO_COMANDAS_APAGADO}
        mensaje="Cuando enciendas el envío de comandas a SoftRestaurant, aquí verás cuántas se capturan y en cuánto tiempo."
        accion={
          <Link to={`${base}/comandas-pos`} className="text-ui font-medium text-primary underline-offset-4 hover:underline" data-testid="comandas-enlace-pos">
            Ir a Comandas al POS
          </Link>
        }
      />
    );
  }
  const pendientes = s.capturaManualPendientes + s.pendientesEnviadas;
  return (
    <div className="space-y-2.5" data-testid="sr-comandas">
      <p className="m-0 text-xs text-muted-foreground">
        Modo del envío: <strong className="font-semibold text-foreground">{ETIQUETA_MODO[c.modo] ?? c.modo}</strong>
        {s.sucursalesEncendidas < s.sucursalesTotal ? ` · las tasas cuentan ${entero(s.sucursalesEncendidas)} de ${entero(s.sucursalesTotal)} sucursales (las apagadas no envían)` : ""}.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ClipboardPaste} label="Encoladas" value={entero(s.encoladas)} nota="Comandas que enviamos a SoftRestaurant" />
        <StatCard icon={ClipboardPaste} label="Confirmadas" value={entero(s.confirmadas)} nota="El POS devolvió su folio" />
        <StatCard icon={ClipboardPaste} label="Capturadas a mano" value={entero(s.capturadasManual)} nota="Alguien las tecleó en el POS" />
        <StatCard icon={ClipboardPaste} label="Fallidas" value={entero(s.fallidas)} nota="No se pudieron enviar" />
        <StatCard icon={ClipboardPaste} label="Pendientes" value={entero(pendientes)} nota={`${entero(s.capturaManualPendientes)} por capturar · ${entero(s.pendientesEnviadas)} enviadas sin confirmar`} />
        <StatCard icon={ReceiptText} label="Tasa de captura" value={textoCifra(c.tasaCaptura, "pct")} nota="(Confirmadas + capturadas a mano) entre encoladas" {...(c.tasaCaptura.valor === null ? { sinDato: "Sin comandas encoladas en el periodo." } : {})} />
        <StatCard
          icon={ReceiptText}
          label="Minutos hasta la captura"
          value={minutos(c.minutosACaptura.valor)}
          nota="Promedio entre que se encola y se captura (el servicio aún no entrega mediana ni p90)"
          {...(c.minutosACaptura.valor === null ? { sinDato: "Aún no hay comandas capturadas con tiempo." } : {})}
        />
        <StatCard icon={ReceiptText} label="Vencidas sobre el umbral" value={entero(s.vencidasUmbral)} nota="Llevan más tiempo sin capturar que el umbral configurado" />
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="comandas-folios">
        <span>Folios del POS confirmados: {entero(s.conFolioPos)}</span>
        <span className="inline-flex items-center gap-1">
          Folios declarados por quien capturó: {entero(s.conFolioDeclarado)}
          <span className="rounded-full border border-warning/30 bg-warning-tint px-1.5 py-0.5 text-2xs font-medium text-warning">texto libre: confianza baja</span>
        </span>
        <ChipDeCifra cifra={c.tasaCaptura} mostrarMedido />
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <BotonPedidos etiqueta="Ver pedidos del periodo" onClick={() => abrir({})} />
        <Link to={`${base}/comandas-pos`} className="text-ui font-medium text-primary underline-offset-4 hover:underline">
          Ir a Comandas al POS
        </Link>
      </div>
      {c.porSucursal.length > 1 && (
        <DataTable<(typeof c.porSucursal)[number]>
          etiqueta="Comandas por sucursal"
          filas={c.porSucursal}
          obtenerId={(f) => f.propertyId}
          paginacion={false}
          vista="tabla"
          columnas={[
            { id: "n", encabezado: "Sucursal", principal: true, celda: (f) => f.nombre },
            { id: "m", encabezado: "Envío", celda: (f) => ETIQUETA_MODO[f.modo] ?? f.modo },
            { id: "e", encabezado: "Encoladas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.encoladas) },
            { id: "c", encabezado: "Confirmadas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.confirmadas) },
            { id: "a", encabezado: "A mano", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.capturadasManual) },
            { id: "f", encabezado: "Fallidas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sumas.fallidas) },
          ]}
        />
      )}
    </div>
  );
}

// ---- (b) Importar reporte y lotes ------------------------------------------------------------------------------------------------------

const ETIQUETA_TIPO: Readonly<Record<string, string>> = { resumen_servicio: "Ventas por tipo de servicio", cuentas: "Listado de cuentas" };

function Lotes({ d, nombres }: { readonly d: LotesSrVista; readonly nombres: ReadonlyMap<string, string> }) {
  return (
    <div className="space-y-2.5" data-testid="sr-lotes">
      {d.cobertura.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Cobertura de los reportes cargados">
          {d.cobertura.map((c) => (
            <li key={c.propertyId} className="rounded-md border border-border px-2.5 py-1 text-xs" data-testid="sr-cobertura">
              <span className="font-medium">{nombres.get(c.propertyId) ?? "Sucursal"}</span>: {c.diasConDato === 0 ? "sin días cargados" : `${entero(c.diasConDato)} ${c.diasConDato === 1 ? "día" : "días"} (${c.diaMin ? diaCorto(c.diaMin) : SIN_DATO} a ${c.diaMax ? diaCorto(c.diaMax) : SIN_DATO})`}
            </li>
          ))}
        </ul>
      )}
      <DataTable<LoteSr>
        etiqueta="Lotes de reportes de SoftRestaurant cargados"
        filas={d.lotes}
        obtenerId={(f) => f.id}
        paginacion={{ tamano: 8 }}
        vista="tabla"
        vacio={{ titulo: "Todavía no cargas ningún reporte", mensaje: "Cuando importes un reporte aparecerá aquí con los días que cubre." }}
        columnas={[
          { id: "a", encabezado: "Archivo", principal: true, celda: (f) => f.nombreArchivo },
          { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
          { id: "t", encabezado: "Tipo", celda: (f) => ETIQUETA_TIPO[f.tipo] ?? f.tipo },
          { id: "c", encabezado: "Cubre", celda: (f) => (f.fechaMin && f.fechaMax ? `${diaCorto(f.fechaMin)} a ${diaCorto(f.fechaMax)}` : SIN_DATO) },
          { id: "ac", encabezado: "Aceptados", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.aceptados) },
          { id: "re", encabezado: "Rechazados", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.rechazados) },
          { id: "e", encabezado: "Estado", celda: (f) => (f.estado === "aplicado" ? "Aplicado" : "Reemplazado") },
        ]}
      />
    </div>
  );
}

// ---- (c) Domicilio vs presencial y cuadre ----------------------------------------------------------------------------------------------

function Cuadre({ d, props, onSubir, onUmbrales }: { readonly d: CuadreSrVista; readonly props: CfoPaginaProps; readonly onSubir: () => void; readonly onUmbrales: () => void }) {
  const nombres = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  if (d.filas.length === 0) {
    return (
      <EstadoVacio
        icon={Store}
        titulo={TITULO_SIN_SR}
        mensaje={MENSAJE_SIN_SR}
        accion={
          puedeEn(props.role, "cfo.importar_sr") ? (
            <Button type="button" onClick={onSubir} className="gap-1.5" data-testid="cuadre-subir">
              <FileUp className="size-4" aria-hidden="true" />
              Importar reporte
            </Button>
          ) : undefined
        }
      />
    );
  }
  const porSucursal = d.porSucursal.filter((s) => s.diasConDato > 0);
  const suma = (id: string | null, k: "nuestroDomicilioCentavos" | "srDomicilioCentavos") => d.filas.filter((f) => id === null || f.propertyId === id).reduce((a, f) => a + (f[k] ?? 0), 0);
  const grupos = [...porSucursal.map((s) => ({ etiqueta: s.nombre, id: s.propertyId })), { etiqueta: "Total", id: null as string | null }];
  const u = d.umbrales;
  return (
    <div className="space-y-2.5" data-testid="sr-cuadre">
      <Callout tone="neutral" data-testid="cuadre-regla-total">
        Con el reporte cargado, el total del negocio es el de SoftRestaurant. Tus pedidos del agente son un subconjunto: el domicilio ya está dentro del «domicilio» de SoftRestaurant, así que nunca se suman los dos.
      </Callout>
      <ChartCard titulo="Domicilio: agente contra SoftRestaurant" subtitulo="Ventas a domicilio de los días que el reporte trae" tamano="M">
        <BarrasAgrupadas
          series={[
            { id: "nuestro", etiqueta: "Pedidos del agente" },
            { id: "sr", etiqueta: "Domicilio en SoftRestaurant" },
          ]}
          grupos={grupos.map((g) => ({ etiqueta: g.etiqueta, valores: { nuestro: suma(g.id, "nuestroDomicilioCentavos"), sr: suma(g.id, "srDomicilioCentavos") } }))}
          formato={pesos}
          sinDatos="Sin ventas a domicilio en los días del reporte"
        />
        <TablaDatosGrafica
          titulo="Domicilio del agente contra SoftRestaurant"
          encabezados={["Sucursal", "Pedidos del agente", "SoftRestaurant"]}
          filas={grupos.map((g) => [g.etiqueta, pesosExactos(suma(g.id, "nuestroDomicilioCentavos")), pesosExactos(suma(g.id, "srDomicilioCentavos"))])}
        />
        <p className="mt-2 text-2xs text-muted-foreground" data-testid="cuadre-sin-desglose">
          Por ahora solo se compara el domicilio. El desglose de comedor, para llevar y rápido de SoftRestaurant todavía no lo entrega el servicio del CFO.
        </p>
      </ChartCard>
      <ChartCard
        titulo="Cuadre diario de domicilio"
        subtitulo={ROTULO_CUADRE}
        tamano="M"
        accion={
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onUmbrales} data-testid="cuadre-umbrales-abrir">
            <Settings2 className="size-3.5" aria-hidden="true" />
            Ajustar umbrales
          </Button>
        }
      >
        <DataTable<FilaCuadreApi>
          etiqueta="Cuadre diario de domicilio contra SoftRestaurant"
          filas={d.filas}
          obtenerId={(f) => `${f.propertyId}-${f.diaNegocio}`}
          paginacion={{ tamano: 10 }}
          vista="tabla"
          atributosFila={(f) => ({ "data-semaforo": f.semaforo, "data-dia": f.diaNegocio })}
          columnas={[
            { id: "d", encabezado: "Día", principal: true, celda: (f) => diaCorto(f.diaNegocio) },
            { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? f.nombre },
            { id: "n", encabezado: "Agente", alinear: "right", className: "tabular-nums", celda: (f) => `${pesos(f.nuestroDomicilioCentavos)} · ${entero(f.nuestroPedidos)} ped.` },
            { id: "r", encabezado: "SoftRestaurant", alinear: "right", className: "tabular-nums", celda: (f) => (f.srDomicilioCentavos === null ? SIN_DATO : `${pesos(f.srDomicilioCentavos)} · ${entero(f.srTickets)} cuentas`) },
            { id: "df", encabezado: "Diferencia", alinear: "right", className: "tabular-nums", celda: (f) => (f.diferenciaCentavos === null ? SIN_DATO : `${f.diferenciaCentavos > 0 ? "+" : f.diferenciaCentavos < 0 ? "−" : ""}${pesosExactos(Math.abs(f.diferenciaCentavos))}`) },
            { id: "pc", encabezado: "Diferencia %", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.diferenciaPct) },
            { id: "sm", encabezado: "Semáforo", celda: (f) => <Semaforo estado={SEMAFORO_CUADRE[f.semaforo].estado} texto={SEMAFORO_CUADRE[f.semaforo].texto} /> },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground" data-testid="cuadre-umbrales">
          Cuadra si la diferencia es de {porcentaje(u.verdePct)} o menos y de {pesos(u.verdeCentavos)} o menos; se revisa hasta {porcentaje(u.ambarPct)}; después no cuadra (también si difiere en 2 o más pedidos). Diferencia = agente − SoftRestaurant.
        </p>
        <div className="mt-2">
          <BotonPedidos etiqueta="Ver pedidos a domicilio" onClick={() => props.abrirPedidos({ canal: "domicilio" })} />
        </div>
      </ChartCard>
    </div>
  );
}

// ---- Página ---------------------------------------------------------------------------------------------------------------------------------

export function CfoSoftRestaurant(props: CfoPaginaProps) {
  const { api, filtros } = props;
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
          Comandas que enviamos a SoftRestaurant
        </h2>
        <CargaCfoVista carga={operacion.carga} onReintentar={operacion.recargar} etiqueta="Cargando las comandas…">
          {(d) => (
            <Comandas d={d} base={props.base} abrir={props.abrirPedidos} />
          )}
        </CargaCfoVista>
      </section>

      <section aria-labelledby="sr-b" className="space-y-2.5" data-testid="sr-bloque-importar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sr-b" className="font-display text-base font-semibold">
            Importar reporte de SoftRestaurant
          </h2>
          {puedeImportar && (
            <Button type="button" onClick={() => setImportando(true)} className="gap-1.5" data-testid="sr-importar-abrir">
              <FileUp className="size-4" aria-hidden="true" />
              Importar reporte
            </Button>
          )}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Sube el reporte exportado de SoftRestaurant (.csv o .xlsx). Se muestra una vista previa antes de guardar y no se suben datos de tus clientes. Los nombres de las columnas de SoftRestaurant son una inferencia: confirma el mapeo.
        </p>
        <CargaCfoVista carga={lotes.carga} onReintentar={lotes.recargar} etiqueta="Cargando los reportes cargados…">
          {(d) => <Lotes d={d} nombres={nombres} />}
        </CargaCfoVista>
      </section>

      <section aria-labelledby="sr-c" className="space-y-2.5">
        <h2 id="sr-c" className="font-display text-base font-semibold">
          Domicilio vs presencial y cuadre
        </h2>
        <CargaCfoVista carga={cuadre.carga} onReintentar={cuadre.recargar} etiqueta="Cargando el cuadre…">
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
