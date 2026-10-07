// Pestana Tarifas: una fila por noche y tipo de habitacion en el rango elegido; editar el precio llama a `PUT .../tarifas/:id` (owner/gm,
// con bitacora). Un precio fijado a mano queda marcado "Precio manual" y la aplicacion automatica del motor de revenue no lo sobreescribe (una recomendacion aprobada por una persona si). Cancelar/Escape
// del dialogo solo cierran y nunca escriben. Dar de alta rangos nuevos sigue en Catalogo.
import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, Callout, DataTable, FormDialog, FormField, Input, NativeSelect, StatusBadge, toast } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchTarifas, guardarPrecioTarifa } from "../../lib/configuracion-client.ts";
import type { Tarifa } from "../../lib/configuracion-client.ts";
import { dineroMx } from "../../lib/dinero.ts";
import { fetchRoomTypes } from "../../lib/reservas-client.ts";
import type { RoomTypeOption } from "../../lib/reservas-client.ts";
import { formatFechaSolo } from "../../../../lib/formato-fecha.ts";
import { mensajeDe, numeroODefecto } from "./comun.ts";
import type { PestanaProps } from "./comun.ts";

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rangoPorOmision(): { desde: string; hasta: string } {
  const hoy = new Date();
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 29);
  return { desde: isoLocal(hoy), hasta: isoLocal(fin) };
}

export function TarifasTab({ apiBaseUrl, token, propertyId, puedeEscribir }: PestanaProps) {
  const [inicial] = useState(rangoPorOmision);
  const [desde, setDesde] = useState(inicial.desde);
  const [hasta, setHasta] = useState(inicial.hasta);
  const [tipoId, setTipoId] = useState("");
  const [tipos, setTipos] = useState<readonly RoomTypeOption[]>([]);
  const [tarifas, setTarifas] = useState<readonly Tarifa[] | null>(null);
  const [truncado, setTruncado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Tarifa | null>(null);
  const [precio, setPrecio] = useState("");
  const [minima, setMinima] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    setTarifas(null);
    try {
      const r = await fetchTarifas(fetch, apiBaseUrl, token, propertyId, { desde, hasta, roomTypeId: tipoId || undefined });
      setTarifas(r.tarifas);
      setTruncado(r.truncado);
    } catch (err) {
      setError(mensajeDe(err, "No se pudieron cargar las tarifas."));
    }
  }, [apiBaseUrl, token, propertyId, desde, hasta, tipoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    let vigente = true;
    fetchRoomTypes(fetch, apiBaseUrl, token, propertyId)
      .then((t) => vigente && setTipos(t))
      .catch(() => vigente && setTipos([]));
    return () => {
      vigente = false;
    };
  }, [apiBaseUrl, token, propertyId]);

  function abrir(t: Tarifa) {
    setEditando(t);
    setPrecio(String(t.price));
    setMinima(String(t.minStay));
    setErrorGuardar(null);
  }

  const nuevoPrecio = numeroODefecto(precio);
  const nuevaMinima = numeroODefecto(minima);
  const valido = nuevoPrecio !== null && nuevoPrecio >= 0 && nuevaMinima !== null && Number.isInteger(nuevaMinima) && nuevaMinima >= 1 && nuevaMinima <= 365;

  async function guardar() {
    if (!editando || !valido || nuevoPrecio === null || nuevaMinima === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      await guardarPrecioTarifa(fetch, apiBaseUrl, token, propertyId, editando.id, { precio: nuevoPrecio, estanciaMinima: nuevaMinima });
      toast.success(`Tarifa del ${formatFechaSolo(editando.date)} guardada.`);
      setEditando(null);
      await cargar();
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudo guardar la tarifa."));
    } finally {
      setGuardando(false);
    }
  }

  const columnas: DataTableColumna<Tarifa>[] = [
    { id: "fecha", encabezado: "Noche", celda: (t) => formatFechaSolo(t.date), valorOrden: (t) => t.date, principal: true },
    { id: "tipo", encabezado: "Tipo de habitación", celda: (t) => t.roomTypeName, valorOrden: (t) => t.roomTypeName },
    { id: "precio", encabezado: "Precio", celda: (t) => dineroMx(t.price), valorOrden: (t) => t.price, alinear: "right" },
    { id: "minima", encabezado: "Noches mín.", celda: (t) => t.minStay, valorOrden: (t) => t.minStay, alinear: "right" },
    { id: "origen", encabezado: "Origen", celda: (t) => (t.manualPriceAt ? <StatusBadge tone="info">Precio manual</StatusBadge> : <span className="text-xs text-muted-foreground">Catálogo / motor</span>), ocultarEnTarjeta: false },
    ...(puedeEscribir
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            etiqueta: "Acciones",
            alinear: "right" as const,
            celda: (t: Tarifa) => (
              <Button type="button" variant="outline" size="sm" onClick={() => abrir(t)} aria-label={`Editar el precio del ${formatFechaSolo(t.date)} de ${t.roomTypeName}`}>
                <Pencil />
                Editar
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Desde">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-auto" />
        </FormField>
        <FormField label="Hasta">
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-auto" />
        </FormField>
        <FormField label="Tipo de habitación">
          <NativeSelect value={tipoId} onChange={(e) => setTipoId(e.target.value)} wrapperClassName="w-auto min-w-48">
            <option value="">Todos los tipos</option>
            {tipos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      {truncado && <Callout tone="warning" titulo="Rango muy grande">Se muestran las primeras 1000 noches: acota las fechas o el tipo de habitación para ver el resto.</Callout>}
      <DataTable
        etiqueta="Tarifas por noche"
        columnas={columnas}
        filas={tarifas ?? []}
        obtenerId={(t) => t.id}
        estado={error ? "error" : tarifas === null ? "loading" : undefined}
        error={{ mensaje: error ?? undefined, onReintentar: () => void cargar() }}
        vacio={{ mensaje: "No hay tarifas en este rango. Da de alta un rango de fechas en Catálogo." }}
        paginacion={{ tamano: 15 }}
        atributosFila={(t) => ({ "data-tarifa-id": t.id })}
      />
      <FormDialog
        open={editando !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !guardando) setEditando(null);
        }}
        titulo={editando ? `Tarifa del ${formatFechaSolo(editando.date)}` : "Tarifa"}
        subtitulo={editando ? `${editando.roomTypeName}. Un precio fijado a mano no lo sobreescribe la aplicación automática del motor de revenue.` : undefined}
        anchoClase="max-w-2xl"
        anchoRiel="200px"
        onGuardar={() => void guardar()}
        guardando={guardando}
        guardarDeshabilitado={!valido}
        bloquearCierre={guardando}
      >
        <div className="flex flex-col gap-3 p-4">
          <FormField label="Precio por noche (MXN)">
            <Input inputMode="decimal" value={precio} onChange={(e) => setPrecio(e.target.value)} />
          </FormField>
          <FormField label="Estancia mínima (noches)">
            <Input inputMode="numeric" value={minima} onChange={(e) => setMinima(e.target.value)} />
          </FormField>
          {errorGuardar && <p role="alert" className="m-0 text-sm text-destructive">{errorGuardar}</p>}
        </div>
      </FormDialog>
    </div>
  );
}
