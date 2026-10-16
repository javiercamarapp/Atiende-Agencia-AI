// Alta de una cotizacion de grupo (UNI-C gestion: antes una pestana con un formulario de ~20 campos dentro de
// Grupos.tsx). Mismas validaciones y mismo cuerpo hacia crearCotizacion; ahora vive en un FormDialog con FormField.
// Errores de validacion o del servidor se ven DENTRO del dialogo, que sigue abierto hasta que la cotizacion se crea.
import { useMemo, useState } from "react";
import { Button, Callout, FormDialog, FormField, Input, NativeSelect } from "@atiende/ui";
import { brutoCentavos, formatearCentavos, nochesEntre, pesosACentavos, porcentajeABps, totalConDescuento } from "../../lib/grupos-client.ts";
import type { RoomTypeOption } from "../../lib/reservas-client.ts";

export interface NuevaCotizacionInput {
  readonly nombreGrupo: string;
  readonly contacto?: string;
  readonly correoContacto?: string;
  readonly llegada: string;
  readonly salida: string;
  readonly fechaLiberacion: string;
  readonly vigenteHasta: string;
  readonly descuentoBps: number;
  readonly anticipoRequeridoCentavos: number;
  readonly renglones: readonly { tipoHabitacionId: string; cuartos: number; tarifaCentavos: number }[];
}

interface RenglonForm {
  readonly tipoHabitacionId: string;
  readonly cuartos: string;
  readonly tarifa: string;
}
const FORM_VACIO = { nombreGrupo: "", contacto: "", correoContacto: "", llegada: "", salida: "", fechaLiberacion: "", vigencia: "", descuento: "0", anticipo: "0" };
const RENGLON_VACIO: RenglonForm = { tipoHabitacionId: "", cuartos: "", tarifa: "" };

export interface NuevaCotizacionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly tipos: readonly RoomTypeOption[];
  /** Crea la cotizacion; debe lanzar si falla (el dialogo muestra el mensaje y sigue abierto). */
  readonly crear: (input: NuevaCotizacionInput) => Promise<void>;
}

export function NuevaCotizacionDialog({ open, onClose, tipos, crear }: NuevaCotizacionDialogProps) {
  const [form, setForm] = useState(FORM_VACIO);
  const [renglones, setRenglones] = useState<RenglonForm[]>([RENGLON_VACIO]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const preview = useMemo(() => {
    const noches = nochesEntre(form.llegada, form.salida);
    const filas = renglones.map((r) => ({ cuartos: Number(r.cuartos), tarifa: pesosACentavos(r.tarifa) }));
    const completos = filas.every((r) => Number.isInteger(r.cuartos) && r.cuartos > 0 && r.tarifa !== null);
    const bps = porcentajeABps(form.descuento);
    if (noches < 1 || !completos || bps === null) return null;
    const bruto = brutoCentavos(filas.map((r) => ({ cuartos: r.cuartos, tarifaCentavos: r.tarifa! })), noches);
    return { noches, bruto, total: totalConDescuento(bruto, bps) };
  }, [form.llegada, form.salida, form.descuento, renglones]);

  async function handleCrear() {
    const bps = porcentajeABps(form.descuento);
    const anticipo = pesosACentavos(form.anticipo || "0");
    const filas = renglones.map((r) => ({ tipoHabitacionId: r.tipoHabitacionId, cuartos: Number(r.cuartos), tarifaCentavos: pesosACentavos(r.tarifa) }));
    if (form.nombreGrupo.trim().length < 2 || !form.llegada || !form.salida || !form.fechaLiberacion || !form.vigencia) {
      setError("Completa el nombre del grupo, las fechas, la fecha de liberación y la vigencia.");
      return;
    }
    if (bps === null || anticipo === null) {
      setError("El descuento es un porcentaje de 0 a 100 y el anticipo un importe en pesos, ambos con hasta 2 decimales.");
      return;
    }
    if (filas.some((r) => !r.tipoHabitacionId || !Number.isInteger(r.cuartos) || r.cuartos < 1 || r.tarifaCentavos === null)) {
      setError("Cada renglón necesita tipo de habitación, cuartos enteros y una tarifa en pesos (hasta 2 decimales).");
      return;
    }
    const vigenteHasta = new Date(`${form.vigencia}T23:59:00`).toISOString();
    setError(null);
    setEnviando(true);
    try {
      await crear({
        nombreGrupo: form.nombreGrupo.trim(),
        ...(form.contacto.trim() ? { contacto: form.contacto.trim() } : {}),
        ...(form.correoContacto.trim() ? { correoContacto: form.correoContacto.trim() } : {}),
        llegada: form.llegada,
        salida: form.salida,
        fechaLiberacion: form.fechaLiberacion,
        vigenteHasta,
        descuentoBps: bps,
        anticipoRequeridoCentavos: anticipo,
        renglones: filas.map((r) => ({ tipoHabitacionId: r.tipoHabitacionId, cuartos: r.cuartos, tarifaCentavos: r.tarifaCentavos! })),
      });
      setForm(FORM_VACIO);
      setRenglones([RENGLON_VACIO]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la cotización.");
    } finally {
      setEnviando(false);
    }
  }

  const setRenglon = (i: number, patch: Partial<RenglonForm>) => setRenglones(renglones.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <FormDialog
      open={open}
      onOpenChange={(abierto) => {
        if (!abierto && !enviando) {
          setError(null);
          onClose();
        }
      }}
      titulo="Nueva cotización de grupo"
      subtitulo="Importes en pesos con hasta 2 decimales (se guardan en centavos enteros). La fecha de liberación es el primer día en que se devuelven al inventario los cuartos sin confirmar, a las 00:00 en la zona horaria del hotel. Un descuento por encima del tope vigente solo lo autoriza dirección o gerencia."
      anchoClase="max-w-4xl"
      onGuardar={() => void handleCrear()}
      guardando={enviando}
      textoBotonGuardar="Crear cotización"
      bloquearCierre={enviando}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && <Callout tone="danger" className="sm:col-span-2">{error}</Callout>}
        <FormField label="Nombre del grupo" required className="sm:col-span-2">
          <Input value={form.nombreGrupo} maxLength={120} onChange={(e) => setForm({ ...form, nombreGrupo: e.target.value })} placeholder="Ej. Boda García-López" />
        </FormField>
        <FormField label="Contacto (opcional)">
          <Input value={form.contacto} maxLength={120} onChange={(e) => setForm({ ...form, contacto: e.target.value })} />
        </FormField>
        <FormField label="Correo del contacto (opcional)">
          <Input type="email" value={form.correoContacto} maxLength={200} onChange={(e) => setForm({ ...form, correoContacto: e.target.value })} />
        </FormField>
        <FormField label="Llegada" required>
          <Input type="date" value={form.llegada} onChange={(e) => setForm({ ...form, llegada: e.target.value })} />
        </FormField>
        <FormField label="Salida" required>
          <Input type="date" value={form.salida} onChange={(e) => setForm({ ...form, salida: e.target.value })} />
        </FormField>
        <FormField label="Fecha de liberación (cutoff)" required>
          <Input type="date" value={form.fechaLiberacion} max={form.llegada || undefined} onChange={(e) => setForm({ ...form, fechaLiberacion: e.target.value })} />
        </FormField>
        <FormField label="Propuesta vigente hasta" required>
          <Input type="date" value={form.vigencia} onChange={(e) => setForm({ ...form, vigencia: e.target.value })} />
        </FormField>
        <FormField label="Descuento (%)">
          <Input inputMode="decimal" value={form.descuento} onChange={(e) => setForm({ ...form, descuento: e.target.value })} />
        </FormField>
        <FormField label="Anticipo requerido (MXN, solo se registra)">
          <Input inputMode="decimal" value={form.anticipo} onChange={(e) => setForm({ ...form, anticipo: e.target.value })} />
        </FormField>

        <div className="sm:col-span-2 flex flex-col gap-2">
          <span className="text-ui font-medium text-foreground">Cuartos por tipo de habitación</span>
          {renglones.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] items-end">
              <NativeSelect aria-label={`Tipo de habitación ${i + 1}`} value={r.tipoHabitacionId} onChange={(e) => setRenglon(i, { tipoHabitacionId: e.target.value })}>
                <option value="">Tipo de habitación…</option>
                {tipos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </NativeSelect>
              <Input aria-label={`Cuartos ${i + 1}`} inputMode="numeric" placeholder="Cuartos" value={r.cuartos} onChange={(e) => setRenglon(i, { cuartos: e.target.value })} />
              <Input aria-label={`Tarifa por noche ${i + 1}`} inputMode="decimal" placeholder="Tarifa por noche (MXN)" value={r.tarifa} onChange={(e) => setRenglon(i, { tarifa: e.target.value })} />
              {renglones.length > 1 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenglones(renglones.filter((_, j) => j !== i))}>
                  Quitar
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => setRenglones([...renglones, RENGLON_VACIO])}>
              Agregar tipo de habitación
            </Button>
          </div>
        </div>

        <p className="sm:col-span-2 text-sm text-foreground" aria-live="polite">
          {preview ? `Total estimado: ${formatearCentavos(preview.total)} (${preview.noches} noches; bruto ${formatearCentavos(preview.bruto)}). El servidor recalcula el importe final.` : "Completa fechas, cuartos y tarifas para ver el total estimado."}
        </p>
      </div>
    </FormDialog>
  );
}
