// D-P3-13 -- reglas de clasificacion por RFC emisor (y ClaveProdServ opcional) PERSISTIDAS en el servidor: el despacho corrige una vez y los siguientes CFDI de ese
// emisor salen con esa categoria (method correccion, confianza 0.95) sin pasar por la cola de revision. Reemplaza la tabla que el navegador reenviaba en cada llamada.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, Input, Label, NativeSelect } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { eliminarCorreccion, esRfcValido, fetchCatalogoClasificacion, fetchCorrecciones, guardarCorreccion } from "../lib/clasificacion-client.ts";
import type { CatalogoClasificacion, CorreccionClasificacionVista } from "../lib/clasificacion-client.ts";
import { formatDate } from "../lib/format.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function CorreccionesRfcCard({ apiBaseUrl, token, propertyId }: Props) {
  const [lista, setLista] = useState<{ readonly estado: "ok" | "no_disponible"; readonly correcciones: readonly CorreccionClasificacionVista[] } | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoClasificacion | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [rfc, setRfc] = useState("");
  const [claveProdServ, setClaveProdServ] = useState("");
  const [categoria, setCategoria] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setErrorCarga(null);
    try {
      const [l, c] = await Promise.all([fetchCorrecciones(fetch, apiBaseUrl, token, propertyId), fetchCatalogoClasificacion(fetch, apiBaseUrl, token, propertyId)]);
      setLista(l);
      setCatalogo(c);
    } catch (err) {
      setErrorCarga(err instanceof Error ? err.message : "No se pudieron cargar las correcciones por RFC.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const rfcNormalizado = rfc.trim().toUpperCase();
  const cpValida = claveProdServ.trim() === "" || /^[0-9]{8}$/.test(claveProdServ.trim());
  const cuentaValida = cuenta.trim() === "" || /^[0-9]{4,10}$/.test(cuenta.trim());
  const puedeGuardar = esRfcValido(rfcNormalizado) && cpValida && cuentaValida && categoria !== "";

  async function agregar(e: FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
    setGuardando(true);
    setError(null);
    try {
      await guardarCorreccion(fetch, apiBaseUrl, token, propertyId, { rfcEmisor: rfcNormalizado, claveProdServ: claveProdServ.trim() || null, categoria, cuenta: cuenta.trim() || null });
      setRfc("");
      setClaveProdServ("");
      setCategoria("");
      setCuenta("");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla.");
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(id: string) {
    setQuitando(id);
    setError(null);
    try {
      await eliminarCorreccion(fetch, apiBaseUrl, token, propertyId, id);
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar la regla.");
    } finally {
      setQuitando(null);
    }
  }

  const columnas: DataTableColumna<CorreccionClasificacionVista>[] = [
    { id: "rfc", encabezado: "RFC emisor", principal: true, valorOrden: (c) => c.rfcEmisor, celda: (c) => <span className="font-mono text-xs">{c.rfcEmisor}</span> },
    { id: "cp", encabezado: "ClaveProdServ", celda: (c) => <span className="font-mono text-xs text-muted-foreground">{c.claveProdServ ?? "Cualquiera"}</span> },
    { id: "categoria", encabezado: "Categoría", valorOrden: (c) => c.nombre, celda: (c) => c.nombre },
    { id: "cuenta", encabezado: "Cuenta de cargo", celda: (c) => <span className="font-mono text-xs text-muted-foreground">{c.cuenta ?? "La del mapeo"}</span> },
    { id: "actualizada", encabezado: "Actualizada", valorOrden: (c) => c.actualizadaEn, celda: (c) => <span className="text-xs text-muted-foreground">{formatDate(c.actualizadaEn)}</span> },
    {
      id: "acciones",
      encabezado: "",
      alinear: "right",
      celda: (c) => (
        <Button type="button" variant="outline" size="sm" className="h-8 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive" disabled={quitando === c.id} onClick={() => void quitar(c.id)}>
          <Trash2 />
          {quitando === c.id ? "…" : "Quitar"}
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Correcciones por RFC emisor</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Reglas guardadas en el servidor: los CFDI de ese emisor (y, si la indicas, esa ClaveProdServ) salen con la categoría elegida, con prioridad máxima y sin pasar por la cola de revisión. Se crean también al corregir un CFDI con «Recordar para este emisor».
        </p>
        {errorCarga && <EstadoError mensaje={errorCarga} onReintentar={() => void cargar()} />}
        {!lista && !errorCarga && <EstadoCargando etiqueta="Cargando correcciones…" lineas={2} />}
        {lista?.estado === "no_disponible" && (
          <p role="status" className="text-sm text-muted-foreground">
            Las correcciones por RFC aún no están disponibles en este ambiente: falta aplicar la migración 026.
          </p>
        )}
        {lista?.estado === "ok" && lista.correcciones.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Todavía no hay reglas. Corrige la categoría de un CFDI y márcala para recordarla, o agrega una abajo.
          </p>
        )}
        {lista?.estado === "ok" && lista.correcciones.length > 0 && <DataTable etiqueta="Correcciones por RFC emisor" columnas={columnas} filas={lista.correcciones} obtenerId={(c) => c.id} paginacion={false} />}

        {lista?.estado === "ok" && catalogo && (
          <form onSubmit={(e) => void agregar(e)} className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="corr-rfc" className="text-xs text-muted-foreground">
                RFC emisor
              </Label>
              <Input id="corr-rfc" type="text" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} aria-invalid={rfc.trim() !== "" && !esRfcValido(rfcNormalizado)} className="h-9 w-40 text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="corr-cp" className="text-xs text-muted-foreground">
                ClaveProdServ (opcional)
              </Label>
              <Input id="corr-cp" type="text" inputMode="numeric" value={claveProdServ} onChange={(e) => setClaveProdServ(e.target.value)} aria-invalid={!cpValida} className="h-9 w-32 text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="corr-categoria" className="text-xs text-muted-foreground">
                Categoría
              </Label>
              <NativeSelect id="corr-categoria" size="sm" value={categoria} onChange={(e) => setCategoria(e.target.value)} wrapperClassName="w-56">
                <option value="">Elige…</option>
                {catalogo.categorias.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="corr-cuenta" className="text-xs text-muted-foreground">
                Cuenta (opcional)
              </Label>
              <Input id="corr-cuenta" type="text" inputMode="numeric" value={cuenta} onChange={(e) => setCuenta(e.target.value)} aria-invalid={!cuentaValida} className="h-9 w-28 text-xs" />
            </div>
            <Button type="submit" size="sm" disabled={!puedeGuardar || guardando} loading={guardando} loadingText="Guardando…">
              <Plus />
              Guardar regla
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
