// Diálogo "Registrar movimiento" de una reserva (solo admin_gestora; el servidor re-valida el rol). Registrar es irreversible desde
// este panel (no hay endpoint para borrar un movimiento), así que el envío pasa por una confirmación de dos pasos: cancelar nunca llama al servidor.
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, FormField, Input, NativeSelect, notify, useConfirm } from "@atiende/ui";
import { pesosACentavos, porcentajeABasisPoints, registrarMovimiento } from "../../lib/finanzas-client.ts";
import type { BaseComisionGestor, LineaGastoEntrada, LineaImpuestoEntrada, MovimientoDetalle } from "../../lib/finanzas-client.ts";
import { aNumero, DialogoFinanzas, nuevaKey } from "./comunes.tsx";
import type { GastoRow, ImpuestoRow } from "./comunes.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly ocupacionId: string;
  readonly onCerrar: () => void;
  readonly onRegistrado: (m: MovimientoDetalle) => void;
}

export function RegistrarMovimientoForm({ apiBaseUrl, token, propertyId, ocupacionId, onCerrar, onRegistrado }: Props) {
  const { confirmar, dialogo } = useConfirm();
  const [moneda, setMoneda] = useState("MXN");
  const [montoBruto, setMontoBruto] = useState("");
  const [comisionGestorPct, setComisionGestorPct] = useState("");
  const [comisionGestorBase, setComisionGestorBase] = useState<BaseComisionGestor>("bruto");
  const [gastos, setGastos] = useState<readonly GastoRow[]>([]);
  const [impuestos, setImpuestos] = useState<readonly ImpuestoRow[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actualizarGasto = (key: string, patch: Partial<GastoRow>) => setGastos((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const actualizarImpuesto = (key: string, patch: Partial<ImpuestoRow>) => setImpuestos((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  async function enviar() {
    setError(null);
    const brutoNum = aNumero(montoBruto);
    const pctNum = aNumero(comisionGestorPct);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (Number.isNaN(brutoNum) || brutoNum < 0) return setError("Monto bruto inválido.");
    if (Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) return setError("Comisión de gestor: 0 a 100%.");
    for (const g of gastos) {
      if (!g.tipo.trim()) return setError("Cada gasto necesita un tipo.");
      if (Number.isNaN(aNumero(g.monto)) || aNumero(g.monto) < 0) return setError(`Monto inválido en gasto "${g.tipo}".`);
    }
    for (const i of impuestos) {
      if (!i.tipo.trim()) return setError("Cada impuesto necesita un tipo.");
      if (Number.isNaN(aNumero(i.monto)) || aNumero(i.monto) < 0) return setError(`Monto inválido en impuesto "${i.tipo}".`);
    }

    const gastosPayload: LineaGastoEntrada[] = gastos.map((g) => ({ tipo: g.tipo.trim(), descripcion: g.descripcion.trim() || null, montoCentavos: pesosACentavos(Number(g.monto)) }));
    const impuestosPayload: LineaImpuestoEntrada[] = impuestos.map((i) => ({ tipo: i.tipo.trim(), montoCentavos: pesosACentavos(Number(i.monto)) }));

    const acepto = await confirmar({
      titulo: "Registrar el movimiento financiero de esta reserva",
      descripcion: "Queda registrado con estos montos y este panel no permite borrarlo después. Revisa el ingreso bruto, la comisión y los gastos antes de continuar.",
      confirmar: "Registrar movimiento",
      cancelar: "Cancelar",
    });
    if (!acepto) return;

    setGuardando(true);
    try {
      const creado = await registrarMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId, {
        moneda: moneda.toUpperCase(),
        montoBrutoCentavos: pesosACentavos(brutoNum),
        comisionGestorBasisPoints: porcentajeABasisPoints(pctNum),
        comisionGestorBase,
        gastos: gastosPayload,
        impuestos: impuestosPayload,
      });
      onRegistrado(creado);
      notify.success("Movimiento registrado.");
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar el movimiento.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <DialogoFinanzas
        titulo="Registrar movimiento"
        subtitulo="Ingreso bruto, comisión de gestor, gastos e impuestos de la reserva seleccionada."
        textoGuardar="Registrar movimiento"
        guardando={guardando}
        error={error}
        onCerrar={onCerrar}
        onEnviar={() => void enviar()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Moneda" hint="Código de 3 letras, ej. MXN.">
            <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} placeholder="MXN" />
          </FormField>
          <FormField label="Monto bruto (por el canal)" required>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={montoBruto} onChange={(e) => setMontoBruto(e.target.value)} placeholder="5000.00" />
          </FormField>
          <FormField label="Comisión de gestor (%)" required>
            <Input type="number" inputMode="decimal" min="0" max="100" step="0.01" value={comisionGestorPct} onChange={(e) => setComisionGestorPct(e.target.value)} placeholder="10" />
          </FormField>
          <FormField label="Base de la comisión de gestor">
            <NativeSelect value={comisionGestorBase} onChange={(e) => setComisionGestorBase(e.target.value as BaseComisionGestor)}>
              <option value="bruto">Sobre el bruto</option>
              <option value="neto_de_canal">Sobre el neto de comisión de canal</option>
            </NativeSelect>
          </FormField>
        </div>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm font-medium text-foreground">Gastos (opcional)</legend>
          {gastos.map((g) => (
            <div key={g.key} className="flex flex-wrap gap-2">
              <Input aria-label="Tipo de gasto" value={g.tipo} onChange={(e) => actualizarGasto(g.key, { tipo: e.target.value })} placeholder="Tipo (ej. limpieza)" className="min-w-[140px] flex-1" />
              <Input aria-label="Descripción del gasto" value={g.descripcion} onChange={(e) => actualizarGasto(g.key, { descripcion: e.target.value })} placeholder="Descripción (opcional)" className="min-w-[160px] flex-1" />
              <Input aria-label="Monto del gasto" type="number" inputMode="decimal" min="0" step="0.01" value={g.monto} onChange={(e) => actualizarGasto(g.key, { monto: e.target.value })} placeholder="Monto" className="w-[110px]" />
              <Button type="button" variant="outline" size="sm" onClick={() => setGastos((prev) => prev.filter((x) => x.key !== g.key))}>
                Quitar
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setGastos((prev) => [...prev, { key: nuevaKey(), tipo: "", descripcion: "", monto: "" }])}>
            <Plus /> Agregar gasto
          </Button>
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm font-medium text-foreground">Impuestos (opcional — siempre sujetos a revisión fiscal)</legend>
          {impuestos.map((i) => (
            <div key={i.key} className="flex flex-wrap gap-2">
              <Input aria-label="Tipo de impuesto" value={i.tipo} onChange={(e) => actualizarImpuesto(i.key, { tipo: e.target.value })} placeholder="Tipo (ej. ISR retenido)" className="min-w-[160px] flex-1" />
              <Input aria-label="Monto del impuesto" type="number" inputMode="decimal" min="0" step="0.01" value={i.monto} onChange={(e) => actualizarImpuesto(i.key, { monto: e.target.value })} placeholder="Monto" className="w-[110px]" />
              <Button type="button" variant="outline" size="sm" onClick={() => setImpuestos((prev) => prev.filter((x) => x.key !== i.key))}>
                Quitar
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setImpuestos((prev) => [...prev, { key: nuevaKey(), tipo: "", monto: "" }])}>
            <Plus /> Agregar impuesto
          </Button>
        </fieldset>
      </DialogoFinanzas>
      {dialogo}
    </>
  );
}
