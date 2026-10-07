// Pestana Sobreventa: maximo de habitaciones de sobreventa por tipo (0 = sin sobreventa) y umbral de ocupacion a partir del cual aplica. Es
// el limite que usa `book_availability`. Editar abre un FormDialog; Cancelar/Escape solo cierran y nunca escriben.
import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, DataTable, FormDialog, FormField, Input, toast } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchSobreventa, guardarSobreventa } from "../../lib/configuracion-client.ts";
import type { SobreventaTipo } from "../../lib/configuracion-client.ts";
import { mensajeDe, numeroODefecto } from "./comun.ts";
import type { PestanaProps } from "./comun.ts";

export function SobreventaTab({ apiBaseUrl, token, propertyId, puedeEscribir }: PestanaProps) {
  const [tipos, setTipos] = useState<readonly SobreventaTipo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<SobreventaTipo | null>(null);
  const [maximo, setMaximo] = useState("");
  const [umbral, setUmbral] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setTipos(await fetchSobreventa(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(mensajeDe(err, "No se pudo cargar la sobreventa."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function abrir(t: SobreventaTipo) {
    setEditando(t);
    setMaximo(String(t.maxOverbookRooms));
    setUmbral(String(t.thresholdPct));
    setErrorGuardar(null);
  }

  const max = numeroODefecto(maximo);
  const umb = numeroODefecto(umbral);
  const valido = max !== null && Number.isInteger(max) && max >= 0 && max <= 100 && umb !== null && umb >= 0 && umb <= 100;

  async function guardar() {
    if (!editando || !valido || max === null || umb === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      await guardarSobreventa(fetch, apiBaseUrl, token, propertyId, editando.roomTypeId, { maxOverbookRooms: max, thresholdPct: umb });
      toast.success(`Sobreventa de ${editando.name} guardada.`);
      setEditando(null);
      await cargar();
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudo guardar la sobreventa."));
    } finally {
      setGuardando(false);
    }
  }

  const columnas: DataTableColumna<SobreventaTipo>[] = [
    { id: "tipo", encabezado: "Tipo de habitación", celda: (t) => t.name, valorOrden: (t) => t.name, principal: true },
    { id: "max", encabezado: "Sobreventa máxima", celda: (t) => (t.maxOverbookRooms === 0 ? "Sin sobreventa" : `${t.maxOverbookRooms} hab.`), valorOrden: (t) => t.maxOverbookRooms, alinear: "right" },
    { id: "umbral", encabezado: "Aplica desde ocupación", celda: (t) => `${t.thresholdPct} %`, valorOrden: (t) => t.thresholdPct, alinear: "right" },
    ...(puedeEscribir
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            etiqueta: "Acciones",
            alinear: "right" as const,
            celda: (t: SobreventaTipo) => (
              <Button type="button" variant="outline" size="sm" onClick={() => abrir(t)} aria-label={`Editar la sobreventa de ${t.name}`}>
                <Pencil />
                Editar
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        etiqueta="Sobreventa por tipo de habitación"
        columnas={columnas}
        filas={tipos ?? []}
        obtenerId={(t) => t.roomTypeId}
        estado={error ? "error" : tipos === null ? "loading" : undefined}
        error={{ mensaje: error ?? undefined, onReintentar: () => void cargar() }}
        vacio={{ mensaje: "Aún no hay tipos de habitación. Créalos en Catálogo." }}
        paginacion={false}
      />
      <FormDialog
        open={editando !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !guardando) setEditando(null);
        }}
        titulo={editando ? `Sobreventa: ${editando.name}` : "Sobreventa"}
        subtitulo="Cuántas habitaciones de más se pueden vender cuando la ocupación ya alcanzó el umbral."
        anchoClase="max-w-2xl"
        anchoRiel="200px"
        onGuardar={() => void guardar()}
        guardando={guardando}
        guardarDeshabilitado={!valido}
        bloquearCierre={guardando}
      >
        <div className="flex flex-col gap-3 p-4">
          <FormField label="Habitaciones de sobreventa (0 a 100)" hint="0 = sin sobreventa.">
            <Input inputMode="numeric" value={maximo} onChange={(e) => setMaximo(e.target.value)} />
          </FormField>
          <FormField label="Umbral de ocupación (%)" hint="La sobreventa solo aplica con la ocupación en este porcentaje o más.">
            <Input inputMode="decimal" value={umbral} onChange={(e) => setUmbral(e.target.value)} />
          </FormField>
          {errorGuardar && <p role="alert" className="m-0 text-sm text-destructive">{errorGuardar}</p>}
        </div>
      </FormDialog>
    </>
  );
}
