// CFO-07 · captura de costos del estado de resultados: por sucursal o por organización («No asignado»), mes y concepto; monto o % objetivo,
// nota e historial de versiones. Escribe con `PUT .../admin/cfo/costos` (cada guardado crea una versión nueva; la anterior queda en el historial).
// Solo owner o admin; un admin acotado a sus sucursales NO ve la opción «Organización» (el API también la rechaza con 403).
import { useEffect, useState } from "react";
import type { ConceptoCosto, CostoHistorialItem, SucursalApi } from "@atiende/domain-restaurantes/cfo";
import { CONCEPTOS_COSTO } from "@atiende/domain-restaurantes/cfo";
import { Callout, EstadoCargando, FormDialog, FormField, Input, NativeSelect, Textarea, notify } from "@atiende/ui";
import { fetchCostoHistorial, guardarCostos, type ContextoCfo } from "./cfo-client.ts";
import { etiquetaFecha } from "./filtros-url.ts";
import { SIN_DATO, etiquetaMes, pesosExactos, porcentaje } from "./formato.ts";

export const ETIQUETA_CONCEPTO: Readonly<Record<ConceptoCosto, string>> = {
  insumos: "Insumos (costo de ventas del mes)",
  food_cost_objetivo_pct: "Food cost objetivo (% de las ventas)",
  nomina: "Nómina",
  renta: "Renta",
  servicios: "Servicios (luz, agua, gas, internet)",
  comision_terminal: "Comisiones de terminal",
  marketing: "Marketing",
  mantenimiento: "Mantenimiento",
  otros: "Otros gastos",
};

export const ORGANIZACION = "organizacion";

/** Pesos escritos por la persona -> centavos enteros (0 es válido: un gasto que sí es cero). `undefined` = texto inválido; null = vacío. */
export function pesosAMontoCentavos(texto: string): number | null | undefined {
  const t = texto.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}

export function parsePct(texto: string): number | null | undefined {
  const t = texto.trim();
  if (t === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : undefined;
}

export interface CapturaCostosDialogoProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly api: ContextoCfo;
  /** Sucursales a las que el actor puede capturar (de `GET /costos`). */
  readonly sucursales: readonly SucursalApi[];
  /** Puede capturar a nivel organización. false para un admin acotado: la opción ni se muestra. */
  readonly puedeOrganizacion: boolean;
  /** `YYYY-MM-01` con el que abre. */
  readonly mesInicial: string;
  readonly conceptoInicial?: ConceptoCosto;
  /** `ORGANIZACION` o un propertyId. */
  readonly ambitoInicial?: string;
  readonly onGuardado: () => void;
}

const ahoraMes = (m: string): string => m.slice(0, 7);

export function CapturaCostosDialogo({ abierto, onCerrar, api, sucursales, puedeOrganizacion, mesInicial, conceptoInicial = "insumos", ambitoInicial, onGuardado }: CapturaCostosDialogoProps) {
  const ambitoPorDefecto = ambitoInicial && (ambitoInicial !== ORGANIZACION || puedeOrganizacion) ? ambitoInicial : (sucursales[0]?.propertyId ?? (puedeOrganizacion ? ORGANIZACION : ""));
  const [ambito, setAmbito] = useState(ambitoPorDefecto);
  const [mes, setMes] = useState(ahoraMes(mesInicial));
  const [concepto, setConcepto] = useState<ConceptoCosto>(conceptoInicial);
  const [valor, setValor] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historial, setHistorial] = useState<{ readonly estado: "cargando" } | { readonly estado: "listo"; readonly items: readonly CostoHistorialItem[] } | { readonly estado: "error"; readonly mensaje: string }>({ estado: "cargando" });

  // Al abrir, parte de los valores pedidos (el diálogo conserva su estado entre aperturas).
  useEffect(() => {
    if (!abierto) return;
    setAmbito(ambitoPorDefecto);
    setMes(ahoraMes(mesInicial));
    setConcepto(conceptoInicial);
    setValor("");
    setNota("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, mesInicial, conceptoInicial, ambitoInicial]);

  const mesValido = /^\d{4}-(0[1-9]|1[0-2])$/.test(mes);
  useEffect(() => {
    if (!abierto || !mesValido || ambito === "") return;
    let cancelado = false;
    setHistorial({ estado: "cargando" });
    fetchCostoHistorial(api, ambito === ORGANIZACION ? null : ambito, `${mes}-01`, concepto)
      .then((r) => !cancelado && setHistorial({ estado: "listo", items: r.historial }))
      .catch((err) => !cancelado && setHistorial({ estado: "error", mensaje: err instanceof Error ? err.message : "No se pudo cargar el historial." }));
    return () => {
      cancelado = true;
    };
  }, [abierto, api, ambito, mes, mesValido, concepto]);

  const esPct = concepto === "food_cost_objetivo_pct";
  const interpretado = esPct ? parsePct(valor) : pesosAMontoCentavos(valor);
  const valorError = valor.trim() === "" ? undefined : interpretado === undefined ? (esPct ? "Escribe un porcentaje entre 0 y 100 (máximo 2 decimales)." : "Escribe un monto en pesos, por ejemplo 12500 o 12500.50.") : undefined;
  const puedeGuardar = mesValido && ambito !== "" && interpretado !== undefined && interpretado !== null && !guardando;

  async function guardar() {
    if (!puedeGuardar || interpretado === undefined || interpretado === null) return;
    setGuardando(true);
    setError(null);
    try {
      await guardarCostos(api, [
        {
          propertyId: ambito === ORGANIZACION ? null : ambito,
          mes: `${mes}-01`,
          concepto,
          montoCentavos: esPct ? null : interpretado,
          pct: esPct ? interpretado : null,
          nota: nota.trim() === "" ? null : nota.trim(),
        },
      ]);
      notify.success(`Se guardó ${ETIQUETA_CONCEPTO[concepto].toLowerCase()} de ${etiquetaMes(`${mes}-01`)}.`);
      onGuardado();
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el costo.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <FormDialog
      open={abierto}
      onOpenChange={(o) => !o && onCerrar()}
      titulo="Capturar costos"
      subtitulo="Lo que captures aquí completa el estado de resultados. Cada cambio crea una versión nueva y la anterior queda en el historial."
      anchoClase="max-w-3xl"
      anchoRiel="200px"
      onGuardar={() => void guardar()}
      guardando={guardando}
      guardarDeshabilitado={!puedeGuardar}
      textoBotonGuardar="Guardar costo"
      bloquearCierre={guardando}
    >
      <div className="space-y-3 pr-1" data-testid="captura-costos">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Sucursal" required>
            <NativeSelect value={ambito} onChange={(e) => setAmbito(e.target.value)} data-testid="captura-ambito">
              {sucursales.map((s) => (
                <option key={s.propertyId} value={s.propertyId}>
                  {s.nombre}
                </option>
              ))}
              {puedeOrganizacion && <option value={ORGANIZACION}>Organización (costo sin sucursal)</option>}
            </NativeSelect>
          </FormField>
          <FormField label="Mes" required error={mesValido ? undefined : "Elige un mes."}>
            <Input type="month" value={mes} onChange={(e) => setMes(e.target.value)} data-testid="captura-mes" />
          </FormField>
        </div>
        <FormField label="Concepto" required>
          <NativeSelect value={concepto} onChange={(e) => { setConcepto(e.target.value as ConceptoCosto); setValor(""); }} data-testid="captura-concepto">
            {CONCEPTOS_COSTO.map((c) => (
              <option key={c} value={c}>
                {ETIQUETA_CONCEPTO[c]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label={esPct ? "% objetivo sobre ventas netas sin IVA" : "Monto del mes en pesos"} required hint={esPct ? "Se aplica a las ventas netas sin IVA de cada periodo (estimado)." : "Escríbelo sin signo de pesos. El mes completo; si ves un periodo parcial se prorratea."} {...(valorError ? { error: valorError } : {})}>
          <Input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder={esPct ? "32" : "12500.00"} data-testid="captura-valor" />
        </FormField>
        <FormField label="Nota (opcional)" hint="Hasta 300 caracteres. Por ejemplo, de qué factura sale el monto.">
          <Textarea value={nota} maxLength={300} rows={2} onChange={(e) => setNota(e.target.value)} />
        </FormField>

        <section aria-label="Historial de versiones" data-testid="captura-historial" className="rounded-lg border border-border p-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historial de versiones</h3>
          {historial.estado === "cargando" ? (
            <EstadoCargando lineas={1} etiqueta="Cargando el historial…" />
          ) : historial.estado === "error" ? (
            <p className="text-xs text-muted-foreground">{historial.mensaje}</p>
          ) : historial.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">Todavía no hay una captura de este concepto en este mes.</p>
          ) : (
            <ol className="space-y-1 text-xs">
              {historial.items.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="captura-version">
                  <span className="font-medium">Versión {h.version}</span>
                  <span className="tabular-nums">{h.pct !== null ? porcentaje(h.pct) : h.montoCentavos !== null ? pesosExactos(h.montoCentavos) : SIN_DATO}</span>
                  <span className="text-muted-foreground">{etiquetaFecha(h.creadoEn.slice(0, 10))}</span>
                  {h.vigente && <span className="rounded-full bg-success-tint px-1.5 py-0.5 text-2xs font-medium text-success">Vigente</span>}
                  {h.nota && <span className="text-muted-foreground">· {h.nota}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </FormDialog>
  );
}
