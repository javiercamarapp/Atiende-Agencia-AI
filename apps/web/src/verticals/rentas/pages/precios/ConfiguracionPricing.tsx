// Configuración de pricing de una unidad (Rn-23): LEE lo guardado (GET .../configuracion-precios),
// lo EDITA con FormDialog (POST/PATCH) y lo BORRA con useConfirm de dos pasos (DELETE). Cancelar o
// Escape en la confirmación nunca ejecuta nada. Solo se monta para admin_gestora (el servidor
// re-valida el rol en cada escritura: este gate es solo UX). La tarifa base se versiona por
// `vigenteDesde`: se cambia con un POST y su historial no se borra.
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, StatusBadge, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  basisPointsAPorcentaje,
  borrarConfiguracionPricing,
  crearDescuentoDuracion,
  crearReglaCanal,
  crearReglaMinStay,
  crearTarifaBase,
  crearTemporada,
  dineroDeCentavos,
  editarConfiguracionPricing,
  fetchConfiguracionPricing,
  TODOS_LOS_CANALES,
} from "../../lib/pricing-client.ts";
import type {
  ConfiguracionPricing as Configuracion,
  DescuentoRegistro,
  MinStayRegistro,
  RecursoPricing,
  ReglaCanalRegistro,
  TarifaBaseRegistro,
  TemporadaRegistro,
} from "../../lib/pricing-client.ts";
import { DIAS_SEMANA, FormularioDescuento, FormularioMinStay, FormularioReglaCanal, FormularioTarifaBase, FormularioTemporada } from "./formularios.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
  /** Se llama tras cada escritura exitosa (el cotizador descarta su resultado viejo). */
  readonly onCambio: () => void;
}

type Dialogo =
  | { readonly tipo: "tarifa" }
  | { readonly tipo: "temporada"; readonly registro: TemporadaRegistro | null }
  | { readonly tipo: "descuento"; readonly registro: DescuentoRegistro | null }
  | { readonly tipo: "minstay"; readonly registro: MinStayRegistro | null }
  | { readonly tipo: "canal"; readonly registro: ReglaCanalRegistro | null };

const nombreCanal = (codigo: string) => TODOS_LOS_CANALES.find((c) => c.codigo === codigo)?.nombre ?? codigo;

function Seccion({ titulo, cantidad, onAgregar, textoAgregar, ocupado, children }: { titulo: string; cantidad?: number; onAgregar: () => void; textoAgregar: string; ocupado: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">{cantidad === undefined ? titulo : `${titulo} (${cantidad})`}</CardTitle>
        <Button type="button" size="sm" disabled={ocupado} onClick={onAgregar}>
          {textoAgregar}
        </Button>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

export function ConfiguracionPricing({ apiBaseUrl, token, propertyId, unidadId, onCambio }: Props) {
  const { confirmar, dialogo: dialogoConfirmar } = useConfirm();
  const [config, setConfig] = useState<Configuracion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const c = await fetchConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (!cancelado) setConfig(c);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la configuración de precios.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, unidadId, recarga]);

  // Al cambiar de unidad se descarta lo de la anterior para no mostrar precios ajenos.
  useEffect(() => {
    setConfig(null);
    setDialogo(null);
    setAviso(null);
    setErrorAccion(null);
  }, [unidadId]);

  const cerrarDialogo = useCallback(() => {
    setDialogo(null);
    setErrorDialogo(null);
  }, []);

  async function guardar(accion: () => Promise<unknown>, mensajeOk: string) {
    setOcupado(true);
    setErrorDialogo(null);
    try {
      await accion();
      setDialogo(null);
      setAviso(mensajeOk);
      setErrorAccion(null);
      setRecarga((n) => n + 1);
      onCambio();
    } catch (err) {
      setErrorDialogo(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setOcupado(false);
    }
  }

  async function borrar(recurso: RecursoPricing, id: string, titulo: string, descripcion: string, mensajeOk: string) {
    const acepto = await confirmar({ titulo, descripcion, tono: "danger", confirmar: "Borrar", cancelar: "Cancelar" });
    if (!acepto) return;
    setOcupado(true);
    setAviso(null);
    setErrorAccion(null);
    try {
      await borrarConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId, recurso, id);
      setAviso(mensajeOk);
      setRecarga((n) => n + 1);
      onCambio();
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo borrar.");
    } finally {
      setOcupado(false);
    }
  }

  const abrir = (d: Dialogo) => {
    setErrorDialogo(null);
    setDialogo(d);
  };

  if (error && !config) return <EstadoError titulo="No se pudo cargar la configuración" mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />;
  if (!config) return <EstadoCargando lineas={4} />;

  const hoyVigenteId = config.tarifaBaseVigente?.id;
  const monedaUnidad = config.tarifaBaseVigente?.moneda ?? config.historialTarifaBase[0]?.moneda ?? config.temporadas[0]?.moneda ?? "MXN";

  const accionesFila = (editar: () => void, borrarFila: () => void) => (
    <div className="flex flex-wrap justify-end gap-1.5">
      <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={editar}>
        Editar
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={borrarFila}>
        Borrar
      </Button>
    </div>
  );

  const columnasTarifa: readonly DataTableColumna<TarifaBaseRegistro>[] = [
    { id: "desde", encabezado: "Vigente desde", principal: true, celda: (t) => <span className="font-medium text-foreground">{t.vigenteDesde}</span> },
    { id: "precio", encabezado: "Precio por noche", alinear: "right", celda: (t) => <span className="tabular-nums">{dineroDeCentavos(t.precioNocheCentavos, t.moneda)}</span> },
    { id: "estado", encabezado: "Estado", celda: (t) => (t.id === hoyVigenteId ? <StatusBadge tone="success">Vigente</StatusBadge> : <StatusBadge tone="neutral">{config.tarifaBaseVigente && t.vigenteDesde < config.tarifaBaseVigente.vigenteDesde ? "Anterior" : "Programada"}</StatusBadge>) },
  ];

  const columnasTemporada: readonly DataTableColumna<TemporadaRegistro>[] = [
    { id: "nombre", encabezado: "Temporada", principal: true, valorOrden: (t) => t.nombre, celda: (t) => <span className="font-medium text-foreground">{t.nombre}</span> },
    { id: "rango", encabezado: "Fechas", valorOrden: (t) => t.rango.inicio, celda: (t) => `${t.rango.inicio} a ${t.rango.fin}` },
    { id: "precio", encabezado: "Precio por noche", alinear: "right", celda: (t) => <span className="tabular-nums">{dineroDeCentavos(t.precioNocheCentavos, t.moneda)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      alinear: "right",
      celda: (t) =>
        accionesFila(
          () => abrir({ tipo: "temporada", registro: t }),
          () => void borrar("temporadas", t.id, `Borrar la temporada «${t.nombre}»`, "Las noches de esas fechas volverán a cotizarse con la tarifa base.", "Temporada borrada."),
        ),
    },
  ];

  const columnasDescuento: readonly DataTableColumna<DescuentoRegistro>[] = [
    { id: "noches", encabezado: "Desde", principal: true, valorOrden: (d) => d.nochesMinimas, celda: (d) => <span className="font-medium text-foreground">{d.nochesMinimas} noches</span> },
    { id: "pct", encabezado: "Descuento", alinear: "right", celda: (d) => <span className="tabular-nums">{basisPointsAPorcentaje(d.porcentajeDescuentoBasisPoints)} %</span> },
    { id: "fuente", encabezado: "Fuente", celda: (d) => <span className="text-xs text-muted-foreground">{d.fuente}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      alinear: "right",
      celda: (d) =>
        accionesFila(
          () => abrir({ tipo: "descuento", registro: d }),
          () => void borrar("descuentos-duracion", d.id, `Borrar el descuento de ${d.nochesMinimas}+ noches`, "Las estancias largas dejarán de recibir este descuento.", "Descuento borrado."),
        ),
    },
  ];

  const columnasMinStay: readonly DataTableColumna<MinStayRegistro>[] = [
    { id: "rango", encabezado: "Fechas", principal: true, valorOrden: (r) => r.rango.inicio, celda: (r) => <span className="font-medium text-foreground">{`${r.rango.inicio} a ${r.rango.fin}`}</span> },
    { id: "dia", encabezado: "Check-in", celda: (r) => (r.diaSemanaCheckIn === null ? "Todos los días" : DIAS_SEMANA[r.diaSemanaCheckIn]) },
    { id: "noches", encabezado: "Mínimo", alinear: "right", celda: (r) => `${r.nochesMinimas} noches` },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      alinear: "right",
      celda: (r) =>
        accionesFila(
          () => abrir({ tipo: "minstay", registro: r }),
          () => void borrar("min-stay", r.id, "Borrar la regla de estancia mínima", `Se quitará el mínimo de ${r.nochesMinimas} noches para ${r.rango.inicio} a ${r.rango.fin}.`, "Regla de estancia mínima borrada."),
        ),
    },
  ];

  const columnasCanal: readonly DataTableColumna<ReglaCanalRegistro>[] = [
    { id: "canal", encabezado: "Canal", principal: true, valorOrden: (r) => nombreCanal(r.canalCodigo), celda: (r) => <span className="font-medium text-foreground">{nombreCanal(r.canalCodigo)}</span> },
    { id: "markup", encabezado: "Markup", alinear: "right", celda: (r) => <span className="tabular-nums">{basisPointsAPorcentaje(r.markupBasisPoints)} %</span> },
    { id: "estado", encabezado: "Estado", celda: (r) => <StatusBadge tone={r.activo ? "success" : "neutral"}>{r.activo ? "Activa" : "Inactiva"}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      alinear: "right",
      celda: (r) =>
        accionesFila(
          () => abrir({ tipo: "canal", registro: r }),
          () => void borrar("reglas-canal", r.id, `Borrar la regla de ${nombreCanal(r.canalCodigo)}`, "Las cotizaciones para ese canal dejarán de llevar markup.", "Regla de canal borrada."),
        ),
    },
  ];

  const base = { onCerrar: cerrarDialogo, guardando: ocupado, error: errorDialogo };

  return (
    <section className="flex flex-col gap-4" aria-label="Configuración de pricing">
      <h2 className="font-display text-base font-semibold text-foreground m-0">Configuración de pricing</h2>
      {aviso && <Callout tone="success">{aviso}</Callout>}
      {errorAccion && <Callout tone="danger" titulo="No se pudo completar la acción" onDismiss={() => setErrorAccion(null)}>{errorAccion}</Callout>}
      {error && <EstadoError compacto mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!config.tarifaBaseVigente && (
        <Callout tone="warning" titulo="Sin tarifa base vigente">
          Esta unidad no tiene una tarifa base que ya aplique: la cotización no podrá calcular precios hasta que configures una.
        </Callout>
      )}

      <Seccion titulo="Tarifa base" onAgregar={() => abrir({ tipo: "tarifa" })} textoAgregar="Cambiar tarifa" ocupado={ocupado}>
        <DataTable etiqueta="Historial de tarifa base" columnas={columnasTarifa} filas={config.historialTarifaBase} obtenerId={(t) => t.id} vacio={{ titulo: "Sin tarifa base", mensaje: "Configura la primera con «Cambiar tarifa»." }} />
      </Seccion>

      <Seccion titulo="Temporadas" cantidad={config.temporadas.length} onAgregar={() => abrir({ tipo: "temporada", registro: null })} textoAgregar="Nueva temporada" ocupado={ocupado}>
        <DataTable etiqueta="Temporadas" columnas={columnasTemporada} filas={config.temporadas} obtenerId={(t) => t.id} vacio={{ titulo: "Sin temporadas", mensaje: "Todas las noches se cotizan con la tarifa base." }} />
      </Seccion>

      <Seccion titulo="Descuentos por duración" cantidad={config.descuentosDuracion.length} onAgregar={() => abrir({ tipo: "descuento", registro: null })} textoAgregar="Nuevo descuento" ocupado={ocupado}>
        <DataTable etiqueta="Descuentos por duración" columnas={columnasDescuento} filas={config.descuentosDuracion} obtenerId={(d) => d.id} vacio={{ titulo: "Sin descuentos", mensaje: "Las estancias largas no tienen descuento." }} />
      </Seccion>

      <Seccion titulo="Estancia mínima" cantidad={config.reglasMinStay.length} onAgregar={() => abrir({ tipo: "minstay", registro: null })} textoAgregar="Nueva regla" ocupado={ocupado}>
        <DataTable etiqueta="Reglas de estancia mínima" columnas={columnasMinStay} filas={config.reglasMinStay} obtenerId={(r) => r.id} vacio={{ titulo: "Sin reglas", mensaje: "No hay estancia mínima por fechas." }} />
      </Seccion>

      <Seccion titulo="Reglas por canal" cantidad={config.reglasCanal.length} onAgregar={() => abrir({ tipo: "canal", registro: null })} textoAgregar="Nueva regla" ocupado={ocupado}>
        <DataTable etiqueta="Reglas por canal" columnas={columnasCanal} filas={config.reglasCanal} obtenerId={(r) => r.id} vacio={{ titulo: "Sin reglas de canal", mensaje: "Ningún canal lleva markup." }} />
      </Seccion>

      {dialogo?.tipo === "tarifa" && (
        <FormularioTarifaBase
          {...base}
          actual={config.tarifaBaseVigente}
          onGuardar={(p) => void guardar(() => crearTarifaBase(fetch, apiBaseUrl, token, propertyId, unidadId, p), "Tarifa base guardada.")}
        />
      )}
      {dialogo?.tipo === "temporada" && (
        <FormularioTemporada
          {...base}
          registro={dialogo.registro}
          monedaSugerida={monedaUnidad}
          onGuardar={(p) =>
            void guardar(
              () => (dialogo.registro ? editarConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId, "temporadas", dialogo.registro.id, p) : crearTemporada(fetch, apiBaseUrl, token, propertyId, unidadId, p)),
              dialogo.registro ? "Temporada actualizada." : "Temporada creada.",
            )
          }
        />
      )}
      {dialogo?.tipo === "descuento" && (
        <FormularioDescuento
          {...base}
          registro={dialogo.registro}
          onGuardar={(p) =>
            void guardar(
              () => (dialogo.registro ? editarConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId, "descuentos-duracion", dialogo.registro.id, p) : crearDescuentoDuracion(fetch, apiBaseUrl, token, propertyId, unidadId, p)),
              dialogo.registro ? "Descuento actualizado." : "Descuento guardado.",
            )
          }
        />
      )}
      {dialogo?.tipo === "minstay" && (
        <FormularioMinStay
          {...base}
          registro={dialogo.registro}
          onGuardar={(p) =>
            void guardar(
              () => (dialogo.registro ? editarConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId, "min-stay", dialogo.registro.id, p) : crearReglaMinStay(fetch, apiBaseUrl, token, propertyId, unidadId, p)),
              dialogo.registro ? "Regla de estancia mínima actualizada." : "Regla de estancia mínima creada.",
            )
          }
        />
      )}
      {dialogo?.tipo === "canal" && (
        <FormularioReglaCanal
          {...base}
          registro={dialogo.registro}
          onGuardar={(p) =>
            void guardar(
              () => (dialogo.registro ? editarConfiguracionPricing(fetch, apiBaseUrl, token, propertyId, unidadId, "reglas-canal", dialogo.registro.id, { markupBasisPoints: p.markupBasisPoints, activo: p.activo }) : crearReglaCanal(fetch, apiBaseUrl, token, propertyId, unidadId, p)),
              dialogo.registro ? "Regla de canal actualizada." : "Regla de canal guardada.",
            )
          }
        />
      )}
      {dialogoConfirmar}
    </section>
  );
}
