// Diálogo "Importar payout" (solo admin_gestora): sube las líneas normalizadas del reporte de un canal y concilia. Importar crea
// registros de conciliación que este panel no puede deshacer: el envío pasa por una confirmación de dos pasos (cancelar nunca llama al servidor).
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, FormField, Input, NativeSelect, notify, useConfirm } from "@atiende/ui";
import { CANALES_PAYOUT, importarPayout, pesosACentavos } from "../../lib/finanzas-client.ts";
import type { PayoutCreado } from "../../lib/finanzas-client.ts";
import { aNumero, DialogoFinanzas, nuevaKey } from "./comunes.tsx";

interface LineaPayoutRow {
  readonly key: string;
  referencia: string;
  monto: string;
}

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onCerrar: () => void;
  readonly onCreado: (creado: PayoutCreado) => void;
}

export function ImportarPayoutForm({ apiBaseUrl, token, propertyId, onCerrar, onCreado }: Props) {
  const { confirmar, dialogo } = useConfirm();
  const [canalCodigo, setCanalCodigo] = useState(CANALES_PAYOUT[0]!.codigo);
  const [moneda, setMoneda] = useState("MXN");
  const [fechaPayout, setFechaPayout] = useState("");
  const [referenciaExterna, setReferenciaExterna] = useState("");
  const [lineas, setLineas] = useState<readonly LineaPayoutRow[]>([{ key: nuevaKey(), referencia: "", monto: "" }]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actualizarLinea = (key: string, patch: Partial<LineaPayoutRow>) => setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const quitarLinea = (key: string) => setLineas((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));

  async function enviar() {
    setError(null);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!fechaPayout) return setError("La fecha del payout es requerida.");
    if (lineas.length === 0) return setError("Se necesita al menos una línea.");
    for (const l of lineas) {
      if (Number.isNaN(aNumero(l.monto)) || aNumero(l.monto) < 0) return setError("Cada línea necesita un monto válido.");
    }
    const acepto = await confirmar({
      titulo: "Importar el payout y conciliar sus líneas",
      descripcion: `Se registran ${lineas.length} línea(s) del canal y se concilian contra las reservas. Este panel no permite deshacer la importación.`,
      confirmar: "Importar payout",
      cancelar: "Cancelar",
    });
    if (!acepto) return;

    setGuardando(true);
    try {
      const creado = await importarPayout(fetch, apiBaseUrl, token, propertyId, {
        canalCodigo,
        moneda: moneda.toUpperCase(),
        fechaPayout,
        referenciaExterna: referenciaExterna.trim() || null,
        lineas: lineas.map((l) => ({ referenciaExternaReserva: l.referencia.trim() || null, montoCentavos: pesosACentavos(Number(l.monto)) })),
      });
      onCreado(creado);
      notify.success(`Payout importado: ${creado.resumen.conciliadas} conciliadas · ${creado.resumen.pendientes} pendientes · ${creado.resumen.discrepancias} con discrepancia.`);
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el payout.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <DialogoFinanzas
        titulo="Importar payout"
        subtitulo="Líneas del reporte del canal, ya normalizadas."
        textoGuardar="Importar payout"
        guardando={guardando}
        error={error}
        onCerrar={onCerrar}
        onEnviar={() => void enviar()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Canal">
            <NativeSelect value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)}>
              {CANALES_PAYOUT.map((c) => (
                <option key={c.codigo} value={c.codigo}>
                  {c.nombre}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Moneda" hint="Código de 3 letras, ej. MXN.">
            <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} placeholder="MXN" />
          </FormField>
          <FormField label="Fecha de pago" required>
            <Input type="date" value={fechaPayout} onChange={(e) => setFechaPayout(e.target.value)} />
          </FormField>
          <FormField label="Referencia externa (opcional)">
            <Input value={referenciaExterna} onChange={(e) => setReferenciaExterna(e.target.value)} placeholder="Id del reporte del canal" />
          </FormField>
        </div>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm font-medium text-foreground">Líneas del payout</legend>
          {lineas.map((l) => (
            <div key={l.key} className="flex flex-wrap gap-2">
              <Input aria-label="Referencia externa de la reserva" value={l.referencia} onChange={(e) => actualizarLinea(l.key, { referencia: e.target.value })} placeholder="Referencia externa de la reserva (opcional)" className="min-w-[200px] flex-1" />
              <Input aria-label="Monto de la línea" type="number" inputMode="decimal" min="0" step="0.01" value={l.monto} onChange={(e) => actualizarLinea(l.key, { monto: e.target.value })} placeholder="Monto" className="w-[110px]" />
              <Button type="button" variant="outline" size="sm" onClick={() => quitarLinea(l.key)} disabled={lineas.length === 1}>
                Quitar
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setLineas((prev) => [...prev, { key: nuevaKey(), referencia: "", monto: "" }])}>
            <Plus /> Agregar línea
          </Button>
        </fieldset>
      </DialogoFinanzas>
      {dialogo}
    </>
  );
}
