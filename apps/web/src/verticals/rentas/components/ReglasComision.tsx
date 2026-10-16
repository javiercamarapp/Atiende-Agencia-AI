// Rn-18 -- "Comisiones de canal" dentro de Finanzas: ver, agregar y editar las reglas de comisión por canal. Sin una regla,
// el movimiento financiero de una reserva de ese canal responde 409 (el servidor no asume un 0%); los tenants nuevos nacen
// con valores SUGERIDOS sin verificar que aquí se marcan para que la gestora los confirme contra su contrato.
//
// El gate de rol es solo UX (`puedeEscribir` = FINANZAS_ESCRITURA_ROLES): el servidor y la función SQL vuelven a exigirlo.
import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Sparkles } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, FormDialog, FormField, Input, NativeSelect, notify, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { basisPointsAPorcentaje, cargarReglasSugeridas, crearReglaComision, editarReglaComision, fetchReglasComision, porcentajeABasisPoints } from "../lib/reglas-comision-client.ts";
import type { ReglaComision, ReglasComisionRespuesta } from "../lib/reglas-comision-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

interface Borrador {
  readonly id: string | null; // null = regla nueva
  readonly canalCodigo: string;
  readonly alcance: "organizacion" | "propiedad";
  readonly yaNeto: boolean;
  readonly porcentaje: string;
  readonly fuente: string;
}

function borradorVacio(canalCodigo: string): Borrador {
  return { id: null, canalCodigo, alcance: "organizacion", yaNeto: false, porcentaje: "", fuente: "" };
}

function desdeRegla(r: ReglaComision): Borrador {
  return { id: r.id, canalCodigo: r.canalCodigo, alcance: r.alcance, yaNeto: r.yaNetoDeComision, porcentaje: r.yaNetoDeComision ? "" : String(r.comisionBasisPoints / 100), fuente: r.fuente };
}

export function ReglasComisionSection({ apiBaseUrl, token, propertyId, puedeEscribir }: Props) {
  const [datos, setDatos] = useState<ReglasComisionRespuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [sembrando, setSembrando] = useState(false);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    fetchReglasComision(fetch, apiBaseUrl, token, propertyId).then(
      (r) => {
        if (!cancelado) setDatos(r);
      },
      (err: unknown) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las comisiones de canal.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const guardar = useCallback(async () => {
    if (!borrador) return;
    setErrorForm(null);
    const bps = borrador.yaNeto ? 0 : porcentajeABasisPoints(borrador.porcentaje);
    if (bps === null) return setErrorForm("La comisión debe ser un porcentaje entre 0 y 100 (hasta 2 decimales).");
    if (borrador.fuente.trim().length < 3) return setErrorForm("Indica la fuente (por ejemplo, el contrato o la página oficial del canal): mínimo 3 caracteres.");
    setGuardando(true);
    try {
      if (borrador.id) {
        await editarReglaComision(fetch, apiBaseUrl, token, propertyId, borrador.id, { yaNetoDeComision: borrador.yaNeto, comisionBasisPoints: bps, fuente: borrador.fuente.trim() });
      } else {
        await crearReglaComision(fetch, apiBaseUrl, token, propertyId, { canalCodigo: borrador.canalCodigo, alcance: borrador.alcance, yaNetoDeComision: borrador.yaNeto, comisionBasisPoints: bps, fuente: borrador.fuente.trim() });
      }
      setBorrador(null);
      notify.success("Regla guardada.");
      setRecarga((n) => n + 1);
    } catch (err) {
      // El formulario queda abierto con el mensaje real del servidor (duplicado, sin permiso, base sin migrar...).
      setErrorForm(err instanceof Error ? err.message : "No se pudo guardar la regla.");
    } finally {
      setGuardando(false);
    }
  }, [borrador, apiBaseUrl, token, propertyId]);

  async function sembrar() {
    setSembrando(true);
    setError(null);
    setAviso(null);
    try {
      const { creadas } = await cargarReglasSugeridas(fetch, apiBaseUrl, token, propertyId);
      setAviso(creadas > 0 ? `Se cargaron ${creadas} comisión(es) sugerida(s). Revísalas y confírmalas con tu contrato.` : "Ya tenías una regla para todos los canales.");
      setRecarga((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las comisiones sugeridas.");
    } finally {
      setSembrando(false);
    }
  }

  const canalesParaAlta = datos?.canales ?? [];
  const sinRegla = datos?.canalesSinRegla ?? [];
  const nombreCanal = (codigo: string) => datos?.canales.find((c) => c.codigo === codigo)?.nombre ?? codigo;

  const columnas: readonly DataTableColumna<ReglaComision>[] = [
    { id: "canal", encabezado: "Canal", principal: true, valorOrden: (r) => r.canalNombre, celda: (r) => <span className="font-medium text-foreground">{r.canalNombre}</span> },
    { id: "alcance", encabezado: "Alcance", celda: (r) => (r.alcance === "organizacion" ? "Todas las propiedades" : "Solo esta propiedad") },
    {
      id: "comision",
      encabezado: "Comisión",
      celda: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {r.yaNetoDeComision ? <StatusBadge tone="info">Ya viene neta del canal</StatusBadge> : <span className="tabular-nums">{basisPointsAPorcentaje(r.comisionBasisPoints)}</span>}
          {r.sugerida && <StatusBadge tone="warning">Sugerida</StatusBadge>}
        </span>
      ),
    },
    { id: "fuente", encabezado: "Fuente", celda: (r) => <span className="block max-w-[28ch] truncate text-muted-foreground" title={r.fuente}>{r.fuente}</span> },
    ...(puedeEscribir
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            alinear: "right" as const,
            celda: (r: ReglaComision) => (
              <Button type="button" size="sm" variant="outline" aria-label={`Editar la comisión de ${r.canalNombre}`} onClick={() => { setErrorForm(null); setBorrador(desdeRegla(r)); }}>
                <Pencil /> Editar
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Comisiones de canal</CardTitle>
          <CardDescription>
            Cuánto cobra cada canal. Se usa al registrar el movimiento financiero de una reserva: sin regla para su canal, no se puede registrar. Las reservas directas no cobran comisión de canal.
          </CardDescription>
        </div>
        {puedeEscribir && datos && (
          <Button type="button" size="sm" onClick={() => { setErrorForm(null); setBorrador(borradorVacio(sinRegla[0] ?? canalesParaAlta[0]?.codigo ?? "booking")); }}>
            <Plus /> Agregar regla
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <EstadoError compacto mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
        {aviso && <Callout tone="success" onDismiss={() => setAviso(null)}>{aviso}</Callout>}
        {!datos && !error && <EstadoCargando etiqueta="Cargando comisiones…" />}

        {datos && sinRegla.length > 0 && (
          <Callout
            tone="warning"
            titulo="Faltan comisiones por configurar"
            accion={
              puedeEscribir ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void sembrar()} loading={sembrando} disabled={sembrando}>
                  <Sparkles /> Cargar valores sugeridos
                </Button>
              ) : undefined
            }
          >
            Sin regla para {sinRegla.map(nombreCanal).join(", ")}, el movimiento financiero de sus reservas se rechaza. {puedeEscribir ? "Carga los valores sugeridos y confírmalos, o agrega cada regla." : "Pídele a la administradora de la gestora que las configure."}
          </Callout>
        )}

        {datos && datos.reglas.some((r) => r.sugerida) && (
          <Callout tone="info" titulo="Hay comisiones sugeridas sin confirmar">
            Los porcentajes marcados como "Sugerida" son estimaciones, no verificadas con tu contrato. Edítalas con la fuente real para que los reportes y los statements sean correctos.
          </Callout>
        )}

        {datos && (datos.reglas.length > 0 || sinRegla.length === 0) && (
          <DataTable
            etiqueta="Comisiones de canal"
            columnas={columnas}
            filas={datos.reglas}
            obtenerId={(r) => r.id}
            paginacion={false}
            vacio={{ titulo: "Sin reglas de comisión", mensaje: "Todavía no hay reglas de comisión." }}
          />
        )}
      </CardContent>

      <FormDialog
        open={borrador !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !guardando) setBorrador(null);
        }}
        titulo={borrador?.id ? `Editar la comisión de ${nombreCanal(borrador.canalCodigo)}` : "Agregar una comisión de canal"}
        subtitulo="Cada canal puede tener una regla para toda la organización y otra específica de una propiedad; la de la propiedad gana."
        anchoClase="max-w-2xl"
        onGuardar={() => void guardar()}
        guardando={guardando}
        textoBotonGuardar="Guardar regla"
        bloquearCierre={guardando}
      >
        {borrador && (
          <div className="flex flex-col gap-3">
            {errorForm && <EstadoError compacto titulo="No se pudo guardar" mensaje={errorForm} />}
            <FormField label="Canal">
              <NativeSelect value={borrador.canalCodigo} disabled={borrador.id !== null} onChange={(e) => setBorrador({ ...borrador, canalCodigo: e.target.value })}>
                {canalesParaAlta.map((c) => (
                  <option key={c.codigo} value={c.codigo}>
                    {c.nombre}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Alcance">
              <NativeSelect value={borrador.alcance} disabled={borrador.id !== null} onChange={(e) => setBorrador({ ...borrador, alcance: e.target.value as Borrador["alcance"] })}>
                <option value="organizacion">Todas las propiedades de la organización</option>
                <option value="propiedad">Solo la propiedad activa</option>
              </NativeSelect>
            </FormField>
            <Checkbox
              label="El canal ya me entrega el monto neto de su comisión (como Airbnb)"
              checked={borrador.yaNeto}
              onChange={(e) => setBorrador({ ...borrador, yaNeto: e.target.checked, porcentaje: e.target.checked ? "" : borrador.porcentaje })}
            />
            <FormField label="Comisión del canal (%)">
              <Input inputMode="decimal" placeholder="15" value={borrador.porcentaje} disabled={borrador.yaNeto} onChange={(e) => setBorrador({ ...borrador, porcentaje: e.target.value })} />
            </FormField>
            <FormField label="Fuente" hint="Contrato o página oficial del canal.">
              <Input value={borrador.fuente} maxLength={200} placeholder="Contrato con Booking.com, vigente 2027" onChange={(e) => setBorrador({ ...borrador, fuente: e.target.value })} />
            </FormField>
          </div>
        )}
      </FormDialog>
    </Card>
  );
}
