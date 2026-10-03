// Formulario "Registrar movimiento" de una reserva (solo admin_gestora; el servidor re-valida el rol).
import { useState } from "react";
import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
} from "@atiende/ui";
import { pesosACentavos, porcentajeABasisPoints, registrarMovimiento } from "../../lib/finanzas-client.ts";
import type { BaseComisionGestor, LineaGastoEntrada, LineaImpuestoEntrada, MovimientoDetalle } from "../../lib/finanzas-client.ts";
import { LABEL_CLASES, nuevaKey } from "./comunes.tsx";
import type { GastoRow, ImpuestoRow } from "./comunes.tsx";

export function RegistrarMovimientoForm({
  apiBaseUrl,
  token,
  propertyId,
  ocupacionId,
  onRegistrado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ocupacionId: string;
  onRegistrado: (m: MovimientoDetalle) => void;
}) {
  const [moneda, setMoneda] = useState("MXN");
  const [montoBruto, setMontoBruto] = useState("");
  const [comisionGestorPct, setComisionGestorPct] = useState("");
  const [comisionGestorBase, setComisionGestorBase] = useState<BaseComisionGestor>("bruto");
  const [gastos, setGastos] = useState<readonly GastoRow[]>([]);
  const [impuestos, setImpuestos] = useState<readonly ImpuestoRow[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function agregarGasto() {
    setGastos((prev) => [...prev, { key: nuevaKey(), tipo: "", descripcion: "", monto: "" }]);
  }
  function actualizarGasto(key: string, patch: Partial<GastoRow>) {
    setGastos((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function quitarGasto(key: string) {
    setGastos((prev) => prev.filter((g) => g.key !== key));
  }

  function agregarImpuesto() {
    setImpuestos((prev) => [...prev, { key: nuevaKey(), tipo: "", monto: "" }]);
  }
  function actualizarImpuesto(key: string, patch: Partial<ImpuestoRow>) {
    setImpuestos((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }
  function quitarImpuesto(key: string) {
    setImpuestos((prev) => prev.filter((i) => i.key !== key));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const brutoNum = Number(montoBruto);
    const pctNum = Number(comisionGestorPct);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!montoBruto || Number.isNaN(brutoNum) || brutoNum < 0) return setError("Monto bruto inválido.");
    if (!comisionGestorPct || Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) return setError("Comisión de gestor: 0 a 100%.");
    for (const g of gastos) {
      if (!g.tipo.trim()) return setError("Cada gasto necesita un tipo.");
      if (!g.monto || Number.isNaN(Number(g.monto)) || Number(g.monto) < 0) return setError(`Monto inválido en gasto "${g.tipo}".`);
    }
    for (const i of impuestos) {
      if (!i.tipo.trim()) return setError("Cada impuesto necesita un tipo.");
      if (!i.monto || Number.isNaN(Number(i.monto)) || Number(i.monto) < 0) return setError(`Monto inválido en impuesto "${i.tipo}".`);
    }

    const gastosPayload: LineaGastoEntrada[] = gastos.map((g) => ({ tipo: g.tipo.trim(), descripcion: g.descripcion.trim() || null, montoCentavos: pesosACentavos(Number(g.monto)) }));
    const impuestosPayload: LineaImpuestoEntrada[] = impuestos.map((i) => ({ tipo: i.tipo.trim(), montoCentavos: pesosACentavos(Number(i.monto)) }));

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
      setMontoBruto("");
      setComisionGestorPct("");
      setGastos([]);
      setImpuestos([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar el movimiento.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Registrar movimiento</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} w-[90px]`}>
              Moneda
              <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Monto bruto (por el canal)
              <Input type="number" min="0" step="0.01" value={montoBruto} onChange={(e) => setMontoBruto(e.target.value)} required placeholder="5000.00" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Comisión de gestor (%)
              <Input type="number" min="0" max="100" step="0.01" value={comisionGestorPct} onChange={(e) => setComisionGestorPct(e.target.value)} required placeholder="10" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[180px]`}>
              Base de la comisión de gestor
              <NativeSelect value={comisionGestorBase} onChange={(e) => setComisionGestorBase(e.target.value as BaseComisionGestor)}>
                <option value="bruto">Sobre el bruto</option>
                <option value="neto_de_canal">Sobre el neto de comisión de canal</option>
              </NativeSelect>
            </Label>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-sm text-foreground">Gastos (opcional)</p>
            {gastos.map((g) => (
              <div key={g.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input value={g.tipo} onChange={(e) => actualizarGasto(g.key, { tipo: e.target.value })} placeholder="Tipo (ej. limpieza)" className="flex-1 min-w-[140px]" />
                <Input
                  value={g.descripcion}
                  onChange={(e) => actualizarGasto(g.key, { descripcion: e.target.value })}
                  placeholder="Descripción (opcional)"
                  className="flex-1 min-w-[160px]"
                />
                <Input type="number" min="0" step="0.01" value={g.monto} onChange={(e) => actualizarGasto(g.key, { monto: e.target.value })} placeholder="Monto" className="w-[110px]" />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarGasto(g.key)}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarGasto}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar gasto
            </Button>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-sm text-foreground">Impuestos (opcional — siempre sujetos a revisión fiscal)</p>
            {impuestos.map((i) => (
              <div key={i.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input value={i.tipo} onChange={(e) => actualizarImpuesto(i.key, { tipo: e.target.value })} placeholder="Tipo (ej. ISR retenido)" className="flex-1 min-w-[160px]" />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={i.monto}
                  onChange={(e) => actualizarImpuesto(i.key, { monto: e.target.value })}
                  placeholder="Monto"
                  className="w-[110px]"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarImpuesto(i.key)}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarImpuesto}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar impuesto
            </Button>
          </div>

          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={guardando} className="self-start">
            {guardando ? "Registrando…" : "Registrar movimiento"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
