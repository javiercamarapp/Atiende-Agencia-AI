// D-32 -- Honorarios: igualas (contrato recurrente de honorarios con cada cliente) y sus prefacturas mensuales, con generacion idempotente, aprobacion,
// timbrado y cancelacion con motivo SAT. TODO sale del servidor (apps/api/.../despachos/honorarios.ts): aqui no se calcula nada fiscal. Estado honesto del PAC:
// sin credencial (D-20) no se ofrece "Timbrar" y la pantalla dice que el timbrado esta pendiente; sin la migracion 023 dice que aun no esta disponible.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Ban, CheckCircle2, FilePlus2, Pencil, Plus, Stamp, Trash2 } from "lucide-react";
import { Button, Callout, Checkbox, DataTable, EstadoCargando, EstadoError, FormDialog, Input, Label, NativeSelect, notify, PageContainer, StatusBadge, useConfirm } from "@atiende/ui";
import {
  FORMULARIO_IGUALA_VACIO,
  ETIQUETAS_ESTADO,
  MOTIVOS_CANCELACION,
  TONOS_ESTADO,
  aprobarPrefactura,
  bpAPorcentaje,
  cancelarPrefactura,
  crearIguala,
  cuerpoIguala,
  editarIguala,
  eliminarIguala,
  errorCancelacion,
  erroresIguala,
  fetchIgualas,
  fetchPrefacturas,
  formularioDesdeIguala,
  generarPrefacturas,
  timbrarPrefactura,
} from "../lib/honorarios-client.ts";
import type { Iguala, IgualaFormulario, ListaIgualas, ListaPrefacturas, MotivoCancelacion, Prefactura } from "../lib/honorarios-client.ts";
import { centavosAPesos, dinero, pesosACentavos } from "../lib/libro-client.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Espejo cosmetico de GESTIONAR_HONORARIOS_ROLES (@atiende/domain-despachos/src/roles.ts): solo el dueno del despacho escribe; el servidor y la base son la autoridad.
const GESTIONAR_ROLES: ReadonlySet<string> = new Set(["admin"]);
const periodoActual = (): string => new Date().toISOString().slice(0, 7);
const mensajeDe = (err: unknown, porDefecto: string): string => (err instanceof Error && err.message ? err.message : porDefecto);
const TASAS: ReadonlyArray<{ valor: string; etiqueta: string }> = [
  { valor: "1600", etiqueta: "16 %" },
  { valor: "800", etiqueta: "8 % (frontera, por verificar)" },
  { valor: "0", etiqueta: "0 %" },
];

function FormularioIguala({ id, inicial, guardando, errorServidor, onGuardar }: { id: string; inicial: IgualaFormulario; guardando: boolean; errorServidor: string | null; onGuardar: (f: IgualaFormulario) => void }) {
  const [f, setF] = useState<IgualaFormulario>(inicial);
  const [intento, setIntento] = useState(false);
  const errores = erroresIguala(f, pesosACentavos);
  const set = <K extends keyof IgualaFormulario>(k: K, v: IgualaFormulario[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const verError = (campo: string) =>
    intento && errores[campo] ? (
      <p role="alert" className="text-xs text-destructive">
        {errores[campo]}
      </p>
    ) : null;
  function enviar(e: FormEvent) {
    e.preventDefault();
    setIntento(true);
    if (Object.keys(errores).length === 0) onGuardar(f);
  }
  return (
    <form id={id} onSubmit={enviar} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-concepto`}>Concepto</Label>
        <Input id={`${id}-concepto`} value={f.concepto} maxLength={200} placeholder="Iguala contable mensual" disabled={guardando} onChange={(e) => set("concepto", e.target.value)} />
        {verError("concepto")}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-monto`}>Monto base mensual (MXN, sin IVA)</Label>
          <Input id={`${id}-monto`} value={f.montoPesos} inputMode="decimal" placeholder="2,500.00" disabled={guardando} onChange={(e) => set("montoPesos", e.target.value)} />
          {verError("montoPesos")}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-iva`}>Tasa de IVA</Label>
          <NativeSelect id={`${id}-iva`} value={f.tasaIvaBp} disabled={guardando} onChange={(e) => set("tasaIvaBp", e.target.value)}>
            {TASAS.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.etiqueta}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-dia`}>Día de emisión</Label>
          <Input id={`${id}-dia`} value={f.diaEmision} inputMode="numeric" maxLength={2} disabled={guardando} onChange={(e) => set("diaEmision", e.target.value.replace(/\D/g, ""))} />
          {verError("diaEmision")}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-isr`}>Retención de ISR (%)</Label>
          <Input id={`${id}-isr`} value={f.retencionIsrPorcentaje} inputMode="decimal" placeholder="0" disabled={guardando} onChange={(e) => set("retencionIsrPorcentaje", e.target.value)} />
          {verError("retencionIsrPorcentaje")}
        </div>
        <div className="flex items-end pb-1.5">
          <Checkbox checked={f.retieneIvaDosTercios} disabled={guardando} onChange={(e) => set("retieneIvaDosTercios", e.target.checked)} label="Retiene dos terceras partes del IVA" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Las prefacturas con retenciones se generan y se aprueban, pero no se timbran hasta que el fiscalista verifique el criterio (D-34).
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-cps`}>Clave de producto o servicio (SAT)</Label>
          <Input id={`${id}-cps`} value={f.claveProdServ} inputMode="numeric" maxLength={8} className="font-mono" disabled={guardando} onChange={(e) => set("claveProdServ", e.target.value.replace(/\D/g, ""))} />
          {verError("claveProdServ")}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-cu`}>Clave de unidad (SAT)</Label>
          <Input id={`${id}-cu`} value={f.claveUnidad} maxLength={3} className="font-mono uppercase" disabled={guardando} onChange={(e) => set("claveUnidad", e.target.value.toUpperCase())} />
          {verError("claveUnidad")}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-uso`}>Uso de CFDI</Label>
          <Input id={`${id}-uso`} value={f.usoCfdi} maxLength={3} className="font-mono uppercase" disabled={guardando} onChange={(e) => set("usoCfdi", e.target.value.toUpperCase())} />
          {verError("usoCfdi")}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Las claves del SAT quedan «por verificar» con el fiscalista (D-34). El receptor (RFC, régimen y CP) sale de la ficha del cliente en Cartera.</p>
      <Checkbox checked={f.activa} disabled={guardando} onChange={(e) => set("activa", e.target.checked)} label="Iguala activa (genera prefactura cada mes)" />
      {errorServidor && (
        <p role="alert" className="text-sm text-destructive">
          {errorServidor}
        </p>
      )}
    </form>
  );
}

export function HonorariosPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const { confirmar, dialogo } = useConfirm();
  const [igualas, setIgualas] = useState<ListaIgualas | null>(null);
  const [lista, setLista] = useState<ListaPrefacturas | null>(null);
  const [periodo, setPeriodo] = useState(periodoActual());
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [omitidas, setOmitidas] = useState<readonly { igualaId: string; concepto: string; motivo: string }[]>([]);
  const [editando, setEditando] = useState<Iguala | "nueva" | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState<Prefactura | null>(null);
  const [motivo, setMotivo] = useState<string>("");
  const [folio, setFolio] = useState("");
  const [errorCancelar, setErrorCancelar] = useState<string | null>(null);

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const [i, p] = await Promise.all([fetchIgualas(fetch, apiBaseUrl, token, propertyId), fetchPrefacturas(fetch, apiBaseUrl, token, propertyId, periodo)]);
      setIgualas(i);
      setLista(p);
    } catch (err) {
      setError(mensajeDe(err, "No se pudieron cargar los honorarios."));
    } finally {
      setCargando(false);
    }
  }, [apiBaseUrl, token, propertyId, periodo]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function ejecutar(clave: string, accion: () => Promise<string>) {
    setOcupado(clave);
    try {
      notify.success(await accion());
      await cargar();
    } catch (err) {
      notify.error(mensajeDe(err, "No se pudo completar la operación."));
      await cargar();
    } finally {
      setOcupado(null);
    }
  }

  async function guardarIguala(f: IgualaFormulario) {
    if (editando === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const cuerpo = cuerpoIguala(f, pesosACentavos);
      if (editando === "nueva") await crearIguala(fetch, apiBaseUrl, token, propertyId, cuerpo);
      else await editarIguala(fetch, apiBaseUrl, token, propertyId, editando.id, cuerpo);
      notify.success(editando === "nueva" ? "Iguala creada." : "Iguala actualizada.");
      setEditando(null);
      await cargar();
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudo guardar la iguala."));
    } finally {
      setGuardando(false);
    }
  }

  async function eliminar(i: Iguala) {
    if (!(await confirmar({ titulo: `Eliminar la iguala «${i.concepto}»`, descripcion: "Solo se puede eliminar si nunca generó prefacturas; si ya facturó, desactívala.", tono: "danger", confirmar: "Eliminar" }))) return;
    await ejecutar(`eliminar:${i.id}`, async () => {
      await eliminarIguala(fetch, apiBaseUrl, token, propertyId, i.id);
      return "Iguala eliminada.";
    });
  }

  async function generar() {
    setOcupado("generar");
    setOmitidas([]);
    try {
      const r = await generarPrefacturas(fetch, apiBaseUrl, token, propertyId, periodo);
      setOmitidas(r.omitidas);
      notify.success(r.generadas > 0 ? `${r.generadas} prefactura(s) generada(s) para ${r.periodo}.` : `No hay prefacturas nuevas para ${r.periodo} (${r.yaExistian} ya existían).`);
      await cargar();
    } catch (err) {
      notify.error(mensajeDe(err, "No se pudieron generar las prefacturas."));
    } finally {
      setOcupado(null);
    }
  }

  async function aprobar(p: Prefactura) {
    await ejecutar(`aprobar:${p.id}`, async () => {
      await aprobarPrefactura(fetch, apiBaseUrl, token, propertyId, p.id);
      return "Prefactura aprobada.";
    });
  }

  async function timbrar(p: Prefactura) {
    const ok = await confirmar({
      titulo: `Timbrar la prefactura de ${p.periodo}`,
      descripcion: `Se emitirá un CFDI por ${dinero(p.baseCentavos + p.ivaCentavos)} a ${p.receptor.razonSocial}. Un CFDI timbrado solo se deshace cancelándolo ante el SAT.`,
      confirmar: "Timbrar",
    });
    if (!ok) return;
    await ejecutar(`timbrar:${p.id}`, async () => {
      const r = await timbrarPrefactura(fetch, apiBaseUrl, token, propertyId, p.id);
      if (r.advertencias.length > 0) notify.warning(r.advertencias[0]!);
      return r.yaTimbrada ? "La prefactura ya estaba timbrada." : "CFDI timbrado.";
    });
  }

  function abrirCancelar(p: Prefactura) {
    setCancelando(p);
    setMotivo("");
    setFolio("");
    setErrorCancelar(null);
  }

  async function cancelar(e: FormEvent) {
    e.preventDefault();
    if (!cancelando) return;
    const problema = errorCancelacion(motivo, folio);
    if (problema) {
      setErrorCancelar(problema);
      return;
    }
    const p = cancelando;
    const ok = await confirmar({
      titulo: `Cancelar la prefactura de ${p.periodo}`,
      descripcion: p.estado === "timbrada" ? "Se cancelará el CFDI ante el SAT a través del PAC. No se puede deshacer." : "La prefactura queda cancelada. No se puede deshacer.",
      tono: "danger",
      confirmar: "Cancelar prefactura",
    });
    if (!ok) return;
    setOcupado(`cancelar:${p.id}`);
    setErrorCancelar(null);
    try {
      await cancelarPrefactura(fetch, apiBaseUrl, token, propertyId, p.id, motivo as MotivoCancelacion, motivo === "01" ? folio.trim().toLowerCase() : null);
      notify.success("Prefactura cancelada.");
      setCancelando(null);
      await cargar();
    } catch (err) {
      setErrorCancelar(mensajeDe(err, "No se pudo cancelar la prefactura."));
    } finally {
      setOcupado(null);
    }
  }

  const noDisponible = igualas?.estado === "no_disponible" || lista?.estado === "no_disponible";
  const pacConfigurado = lista?.pac.configurado === true;
  const puedeCancelarTimbrada = pacConfigurado;

  function acciones(p: Prefactura) {
    if (!puedeGestionar) return null;
    const ocupadoAqui = ocupado?.endsWith(p.id) === true;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {p.estado === "borrador" && (
          <Button type="button" size="sm" loading={ocupado === `aprobar:${p.id}`} loadingText="Aprobando…" iconLeft={<CheckCircle2 />} disabled={ocupadoAqui} onClick={() => void aprobar(p)}>
            Aprobar
          </Button>
        )}
        {(p.estado === "aprobada" || p.estado === "fallida") &&
          (pacConfigurado && p.timbrable.ok ? (
            <Button type="button" size="sm" loading={ocupado === `timbrar:${p.id}`} loadingText="Timbrando…" iconLeft={<Stamp />} disabled={ocupadoAqui} onClick={() => void timbrar(p)}>
              {p.estado === "fallida" ? "Reintentar timbrado" : "Timbrar"}
            </Button>
          ) : (
            <span className="max-w-[16rem] text-right text-xs text-muted-foreground">{!p.timbrable.ok ? p.timbrable.motivo : "Timbrado pendiente: falta credencial del PAC (D-20)."}</span>
          ))}
        {(p.estado === "borrador" || p.estado === "aprobada" || p.estado === "fallida" || (p.estado === "timbrada" && puedeCancelarTimbrada)) && (
          <Button type="button" size="sm" variant="outline" iconLeft={<Ban />} disabled={ocupadoAqui} onClick={() => abrirCancelar(p)}>
            Cancelar
          </Button>
        )}
      </div>
    );
  }

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Honorarios</h1>
          <p className="mt-1 text-sm text-muted-foreground">Igualas del cliente y las prefacturas que se generan cada mes.</p>
        </div>
        {puedeGestionar && !noDisponible && (
          <Button
            type="button"
            size="sm"
            iconLeft={<Plus />}
            onClick={() => {
              setErrorGuardar(null);
              setEditando("nueva");
            }}
          >
            Nueva iguala
          </Button>
        )}
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void cargar()} />}
      {cargando && !igualas && <EstadoCargando etiqueta="Cargando honorarios…" />}

      {noDisponible && (
        <Callout tone="warning" role="status">
          La facturación de honorarios todavía no está disponible en esta base: falta aplicar la migración 023. No se muestra información incompleta.
        </Callout>
      )}
      {lista && !noDisponible && (
        <Callout tone={pacConfigurado ? "success" : "warning"} role="status">
          {pacConfigurado ? "PAC configurado: las prefacturas aprobadas se pueden timbrar." : "Timbrado pendiente: falta credencial del PAC (D-20). Puedes crear igualas, generar y aprobar prefacturas; todavía no se timbran."}
        </Callout>
      )}

      {igualas && !noDisponible && (
        <section aria-labelledby="titulo-igualas" className="flex flex-col gap-2">
          <h2 id="titulo-igualas" className="text-sm font-semibold text-foreground">
            Igualas
          </h2>
          <DataTable
            etiqueta="Igualas del cliente"
            obtenerId={(i) => i.id}
            filas={igualas.igualas}
            paginacion={false}
            vacio={{ mensaje: "Este cliente todavía no tiene igualas." }}
            columnas={[
              { id: "concepto", encabezado: "Concepto", principal: true, celda: (i) => <span className="font-semibold text-foreground">{i.concepto}</span> },
              { id: "monto", encabezado: "Monto base", celda: (i) => <span className="tabular-nums">{dinero(i.montoBaseCentavos)}</span> },
              {
                id: "impuestos",
                encabezado: "IVA y retenciones",
                celda: (i) => (
                  <span className="text-xs text-muted-foreground">
                    IVA {i.tasaIvaBp / 100} %{i.retencionIsrBp > 0 ? ` · ISR ${bpAPorcentaje(i.retencionIsrBp)} %` : ""}
                    {i.retieneIvaDosTercios ? " · IVA 2/3" : ""}
                  </span>
                ),
              },
              { id: "dia", encabezado: "Emisión", celda: (i) => <span className="text-muted-foreground">Día {i.diaEmision} de cada mes</span> },
              {
                id: "clave",
                encabezado: "Clave SAT",
                celda: (i) => (
                  <>
                    <span className="font-mono text-xs">{i.claveProdServ}</span> <StatusBadge tone={i.claveSatEstado === "verificada" ? "success" : "warning"}>{i.claveSatEstado === "verificada" ? "Verificada" : "Por verificar"}</StatusBadge>
                  </>
                ),
              },
              { id: "activa", encabezado: "Estado", celda: (i) => <StatusBadge tone={i.activa ? "success" : "neutral"}>{i.activa ? "Activa" : "Inactiva"}</StatusBadge> },
              {
                id: "acciones",
                encabezado: "",
                celda: (i) =>
                  puedeGestionar ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        iconLeft={<Pencil />}
                        onClick={() => {
                          setErrorGuardar(null);
                          setEditando(i);
                        }}
                      >
                        Editar
                      </Button>
                      <Button type="button" size="sm" variant="outline" iconLeft={<Trash2 />} loading={ocupado === `eliminar:${i.id}`} loadingText="Eliminando…" onClick={() => void eliminar(i)}>
                        Eliminar
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </section>
      )}

      {lista && !noDisponible && (
        <section aria-labelledby="titulo-prefacturas" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="titulo-prefacturas" className="text-sm font-semibold text-foreground">
              Prefacturas del periodo
            </h2>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="honorarios-periodo">Periodo</Label>
                <Input id="honorarios-periodo" type="month" value={periodo} max={periodoActual()} onChange={(e) => e.target.value && setPeriodo(e.target.value)} />
              </div>
              {puedeGestionar && (
                <Button type="button" size="sm" iconLeft={<FilePlus2 />} loading={ocupado === "generar"} loadingText="Generando…" onClick={() => void generar()}>
                  Generar prefacturas
                </Button>
              )}
            </div>
          </div>
          {omitidas.length > 0 && (
            <Callout tone="warning" role="status">
              {omitidas.map((o) => `${o.concepto}: ${o.motivo}`).join(" · ")}
            </Callout>
          )}
          <DataTable
            etiqueta="Prefacturas del periodo"
            obtenerId={(p) => p.id}
            filas={lista.prefacturas}
            paginacion={false}
            vacio={{ mensaje: `No hay prefacturas de ${periodo}. Genera las del periodo desde las igualas activas.` }}
            columnas={[
              {
                id: "concepto",
                encabezado: "Concepto",
                principal: true,
                celda: (p) => (
                  <>
                    <span className="font-semibold text-foreground">{p.concepto}</span>
                    <div className="text-xs font-normal text-muted-foreground">
                      {p.receptor.razonSocial} · <span className="font-mono">{p.receptor.rfc}</span>
                    </div>
                  </>
                ),
              },
              { id: "emision", encabezado: "Emisión", celda: (p) => <span className="text-muted-foreground">{p.fechaEmision}</span> },
              {
                id: "total",
                encabezado: "Total a cobrar",
                celda: (p) => (
                  <>
                    <span className="tabular-nums font-semibold">{dinero(p.totalCentavos)}</span>
                    <div className="text-xs text-muted-foreground">
                      Base {dinero(p.baseCentavos)} + IVA {dinero(p.ivaCentavos)}
                      {p.retencionIsrCentavos + p.retencionIvaCentavos > 0 ? ` − retenciones ${dinero(p.retencionIsrCentavos + p.retencionIvaCentavos)}` : ""}
                    </div>
                  </>
                ),
              },
              {
                id: "estado",
                encabezado: "Estado",
                celda: (p) => (
                  <>
                    <StatusBadge tone={TONOS_ESTADO[p.estado]}>{ETIQUETAS_ESTADO[p.estado]}</StatusBadge>
                    {p.estado === "fallida" && p.errorTimbrado && <div className="mt-1 text-xs text-muted-foreground">Motivo: {p.errorTimbrado}</div>}
                    {p.uuid && <div className="mt-1 font-mono text-xs text-muted-foreground">{p.uuid.slice(0, 8)}…</div>}
                    {p.estado === "timbrada" && (p.urlPdf || p.urlXml) && (
                      <div className="mt-1 flex gap-2 text-xs">
                        {p.urlPdf && (
                          <a className="underline" href={p.urlPdf} target="_blank" rel="noreferrer">
                            PDF
                          </a>
                        )}
                        {p.urlXml && (
                          <a className="underline" href={p.urlXml} target="_blank" rel="noreferrer">
                            XML
                          </a>
                        )}
                      </div>
                    )}
                  </>
                ),
              },
              { id: "acciones", encabezado: "", celda: (p) => acciones(p) },
            ]}
          />
        </section>
      )}

      <FormDialog
        open={editando !== null}
        onOpenChange={(abrir) => !abrir && !guardando && setEditando(null)}
        titulo={editando === "nueva" ? "Nueva iguala" : "Editar iguala"}
        subtitulo="Contrato recurrente de honorarios con este cliente."
        anchoClase="max-w-2xl"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-iguala" className="rounded-full px-6" loading={guardando} loadingText="Guardando…">
              {editando === "nueva" ? "Crear iguala" : "Guardar cambios"}
            </Button>
          </>
        }
      >
        {editando !== null && (
          <FormularioIguala
            key={editando === "nueva" ? "nueva" : editando.id}
            id="form-iguala"
            inicial={editando === "nueva" ? FORMULARIO_IGUALA_VACIO : formularioDesdeIguala(editando, centavosAPesos)}
            guardando={guardando}
            errorServidor={errorGuardar}
            onGuardar={(f) => void guardarIguala(f)}
          />
        )}
      </FormDialog>

      <FormDialog
        open={cancelando !== null}
        onOpenChange={(abrir) => !abrir && ocupado === null && setCancelando(null)}
        titulo="Cancelar prefactura"
        subtitulo={cancelando ? `${cancelando.concepto} · ${cancelando.periodo}` : undefined}
        anchoClase="max-w-lg"
        bloquearCierre={ocupado !== null}
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setCancelando(null)} disabled={ocupado !== null}>
              Volver
            </Button>
            <Button type="submit" form="form-cancelar-prefactura" variant="destructive" className="rounded-full px-6" loading={ocupado?.startsWith("cancelar:") === true} loadingText="Cancelando…">
              Continuar
            </Button>
          </>
        }
      >
        <form id="form-cancelar-prefactura" onSubmit={(e) => void cancelar(e)} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cancelar-motivo">Motivo de cancelación (SAT)</Label>
            <NativeSelect id="cancelar-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
              <option value="">Elige un motivo…</option>
              {MOTIVOS_CANCELACION.map((m) => (
                <option key={m.clave} value={m.clave}>
                  {m.etiqueta}
                </option>
              ))}
            </NativeSelect>
          </div>
          {motivo === "01" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cancelar-folio">Folio fiscal (UUID) del CFDI que lo sustituye</Label>
              <Input id="cancelar-folio" value={folio} className="font-mono" maxLength={36} onChange={(e) => setFolio(e.target.value)} />
            </div>
          )}
          {cancelando?.estado === "timbrada" && <p className="text-xs text-muted-foreground">Esta prefactura ya tiene un CFDI: se cancelará primero ante el SAT a través del PAC y solo entonces aquí.</p>}
          {errorCancelar && (
            <p role="alert" className="text-sm text-destructive">
              {errorCancelar}
            </p>
          )}
        </form>
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
