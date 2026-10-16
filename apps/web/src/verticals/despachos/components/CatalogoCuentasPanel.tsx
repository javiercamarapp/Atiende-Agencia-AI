// D-P3-16: pestaña «Catálogo» del libro. Además del alta de cuentas, muestra el nivel, la cuenta padre y el CÓDIGO AGRUPADOR del SAT de cada cuenta
// (obligatorio en el XML de contabilidad electrónica 1.3). Las cuentas sin código se señalan y el XML se niega a generarse hasta asignarlo: aquí se
// asigna uno por uno, o se acepta la propuesta del catálogo base con un botón explícito (son supuestos por validar con el fiscalista). También
// lanza la importación del catálogo y la balanza del proveedor anterior (D-P3-44).
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { FileUp, Plus, Tag } from "lucide-react";
import { Button, Callout, DataTable, FormDialog, Input, Label, NativeSelect, StatusBadge } from "@atiende/ui";
import { asignarAgrupadores, guardarCuenta, proponerAgrupadores, sembrarCatalogo } from "../lib/libro-client.ts";
import type { CuentaLibro } from "../lib/libro-client.ts";
import { ImportarContabilidadDialog } from "./ImportarContabilidadDialog.tsx";
import type { ModoImportacion } from "./ImportarContabilidadDialog.tsx";

const FORMATO_CODIGO = /^\d{3}(\.\d{1,2})?$/;

export interface CatalogoCuentasPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeGestionar: boolean;
  readonly cuentas: readonly CuentaLibro[];
  /** Ejecuta una acción, muestra su aviso/error en la página y recarga el libro. */
  readonly ejecutar: (accion: () => Promise<string>) => Promise<void>;
  /** Recarga el libro sin aviso (tras importar). */
  readonly onCambio: () => void;
}

export function CatalogoCuentasPanel({ apiBaseUrl, token, propertyId, puedeGestionar, cuentas, ejecutar, onCambio }: CatalogoCuentasPanelProps) {
  const [nueva, setNueva] = useState({ codigo: "", descripcion: "", naturaleza: "D" as "D" | "A", padre: "", agrupador: "" });
  const [asignando, setAsignando] = useState<CuentaLibro | null>(null);
  const [codigo, setCodigo] = useState("");
  const [errorAsignar, setErrorAsignar] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [importando, setImportando] = useState<ModoImportacion | null>(null);

  const sinCodigo = cuentas.filter((c) => !c.codigoAgrupador).length;
  const conPropuesta = cuentas.filter((c) => !c.codigoAgrupador && c.propuestaCodigo).length;
  const nivelDe = useMemo(() => new Map(cuentas.map((c) => [c.codigo, c.nivel ?? 1] as const)), [cuentas]);
  const padre = nueva.padre === "" ? null : nueva.padre;
  const codigoNuevoValido = nueva.agrupador === "" || FORMATO_CODIGO.test(nueva.agrupador);

  function abrirAsignar(c: CuentaLibro) {
    setErrorAsignar(null);
    setCodigo(c.codigoAgrupador ?? c.propuestaCodigo ?? "");
    setAsignando(c);
  }

  async function guardarCodigo(e: FormEvent) {
    e.preventDefault();
    if (!asignando) return;
    if (!FORMATO_CODIGO.test(codigo.trim())) {
      setErrorAsignar("El código del SAT lleva 3 dígitos, y opcionalmente un punto y 1 o 2 dígitos (por ejemplo 102.01).");
      return;
    }
    setGuardando(true);
    setErrorAsignar(null);
    try {
      await asignarAgrupadores(fetch, apiBaseUrl, token, propertyId, [{ codigo: asignando.codigo, codigoAgrupador: codigo.trim() }]);
      setAsignando(null);
      onCambio();
    } catch (err) {
      setErrorAsignar(err instanceof Error ? err.message : "No se pudo asignar el código.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {puedeGestionar && cuentas.length === 0 && (
        <Callout tone="info" role="status">
          Este cliente aún no tiene catálogo de cuentas.{" "}
          <Button type="button" size="sm" className="ml-2" onClick={() => void ejecutar(async () => `Catálogo base sembrado (${(await sembrarCatalogo(fetch, apiBaseUrl, token, propertyId)).agregadas} cuentas).`)}>
            Sembrar catálogo base
          </Button>
        </Callout>
      )}

      {cuentas.length > 0 &&
        (sinCodigo > 0 ? (
          <Callout tone="warning" role="status">
            {sinCodigo} de {cuentas.length} cuentas no tienen código agrupador del SAT: el XML de contabilidad electrónica no se genera hasta asignarlo.
            {puedeGestionar && conPropuesta > 0 && (
              <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => void ejecutar(async () => `Propuesta aplicada a ${(await proponerAgrupadores(fetch, apiBaseUrl, token, propertyId)).aplicadas} cuentas. Valídala con tu fiscalista antes de enviar.`)}>
                <Tag />
                Aplicar la propuesta del catálogo base ({conPropuesta})
              </Button>
            )}
          </Callout>
        ) : (
          <Callout tone="success" role="status">
            Todas las cuentas tienen código agrupador del SAT.
          </Callout>
        ))}

      {puedeGestionar && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setImportando("catalogo")}>
            <FileUp />
            Importar catálogo (XML)
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setImportando("apertura")} disabled={cuentas.length === 0}>
            <FileUp />
            Importar balanza de apertura (XML)
          </Button>
        </div>
      )}

      {puedeGestionar && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ejecutar(async () => {
              const c = await guardarCuenta(fetch, apiBaseUrl, token, propertyId, {
                codigo: nueva.codigo.trim(),
                descripcion: nueva.descripcion.trim(),
                naturaleza: nueva.naturaleza,
                nivel: padre ? (nivelDe.get(padre) ?? 1) + 1 : undefined,
                cuentaPadre: padre,
                codigoAgrupador: nueva.agrupador === "" ? null : nueva.agrupador,
              });
              setNueva({ codigo: "", descripcion: "", naturaleza: "D", padre: "", agrupador: "" });
              return `Cuenta ${c.codigo} guardada.`;
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="cuenta-codigo">Código</Label>
            <Input id="cuenta-codigo" value={nueva.codigo} inputMode="numeric" maxLength={10} className="w-32 font-mono" onChange={(e) => setNueva({ ...nueva, codigo: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="cuenta-descripcion">Descripción</Label>
            <Input id="cuenta-descripcion" value={nueva.descripcion} maxLength={200} onChange={(e) => setNueva({ ...nueva, descripcion: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cuenta-naturaleza">Naturaleza</Label>
            <NativeSelect id="cuenta-naturaleza" value={nueva.naturaleza} onChange={(e) => setNueva({ ...nueva, naturaleza: e.target.value as "D" | "A" })}>
              <option value="D">Deudora</option>
              <option value="A">Acreedora</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cuenta-padre">Subcuenta de</Label>
            <NativeSelect id="cuenta-padre" value={nueva.padre} onChange={(e) => setNueva({ ...nueva, padre: e.target.value })}>
              <option value="">Ninguna (cuenta de mayor)</option>
              {cuentas.map((c) => (
                <option key={c.codigo} value={c.codigo}>
                  {c.codigo} · {c.descripcion}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cuenta-agrupador">Código SAT</Label>
            <Input id="cuenta-agrupador" value={nueva.agrupador} inputMode="decimal" maxLength={6} placeholder="102.01" className="w-24 font-mono" onChange={(e) => setNueva({ ...nueva, agrupador: e.target.value.replace(/[^\d.]/g, "") })} />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!/^\d{4,10}$/.test(nueva.codigo) || nueva.descripcion.trim() === "" || !codigoNuevoValido}>
            <Plus />
            Guardar cuenta
          </Button>
        </form>
      )}

      <DataTable
        etiqueta="Catálogo de cuentas"
        obtenerId={(c) => c.codigo}
        filas={cuentas}
        paginacion={{ tamano: 20 }}
        vacio={{ mensaje: "Sin cuentas." }}
        columnas={[
          { id: "codigo", encabezado: "Código", principal: true, valorOrden: (c) => c.codigo, celda: (c) => <span className="font-mono text-xs">{c.codigo}</span> },
          { id: "descripcion", encabezado: "Descripción", celda: (c) => c.descripcion },
          { id: "nivel", encabezado: "Nivel", celda: (c) => <span className="text-muted-foreground">{c.nivel ?? 1}{c.cuentaPadre ? ` · de ${c.cuentaPadre}` : ""}</span> },
          { id: "naturaleza", encabezado: "Naturaleza", celda: (c) => <span className="text-muted-foreground">{c.naturaleza === "D" ? "Deudora" : "Acreedora"}</span> },
          {
            id: "sat",
            encabezado: "Código SAT",
            valorOrden: (c) => c.codigoAgrupador ?? "",
            celda: (c) => (c.codigoAgrupador ? <span className="font-mono text-xs">{c.codigoAgrupador}</span> : <StatusBadge tone="warning">Sin código</StatusBadge>),
          },
          {
            id: "acciones",
            encabezado: "",
            celda: (c) =>
              puedeGestionar ? (
                <Button type="button" variant="outline" size="sm" aria-label={`Asignar código SAT a la cuenta ${c.codigo}`} onClick={() => abrirAsignar(c)}>
                  <Tag />
                  {c.codigoAgrupador ? "Cambiar" : "Asignar"}
                </Button>
              ) : null,
          },
        ]}
      />

      <FormDialog
        open={asignando !== null}
        onOpenChange={(abrir) => !abrir && !guardando && setAsignando(null)}
        titulo="Código agrupador del SAT"
        subtitulo={asignando ? `${asignando.codigo} · ${asignando.descripcion}` : undefined}
        anchoClase="max-w-md"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAsignando(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-agrupador" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar código"}
            </Button>
          </>
        }
      >
        <form id="form-agrupador" onSubmit={(e) => void guardarCodigo(e)} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agrupador-codigo">Código</Label>
            <Input id="agrupador-codigo" value={codigo} inputMode="decimal" maxLength={6} className="w-32 font-mono" onChange={(e) => setCodigo(e.target.value.replace(/[^\d.]/g, ""))} />
            <p className="text-xs text-muted-foreground">
              Del catálogo de códigos agrupadores del Anexo 24 (por ejemplo 102.01 para bancos nacionales).
              {asignando?.propuestaCodigo ? ` El catálogo base propone ${asignando.propuestaCodigo}; es un supuesto por validar con tu fiscalista.` : ""}
            </p>
          </div>
          {errorAsignar && (
            <p role="alert" className="text-sm text-destructive">
              {errorAsignar}
            </p>
          )}
        </form>
      </FormDialog>

      {importando && (
        <ImportarContabilidadDialog
          modo={importando}
          open
          onOpenChange={(abrir) => !abrir && setImportando(null)}
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          onTerminado={onCambio}
        />
      )}
    </div>
  );
}
