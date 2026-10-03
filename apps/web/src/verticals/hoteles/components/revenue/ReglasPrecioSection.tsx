// Reglas de precio por tipo de habitacion (UNI-C gestion: extraida de Revenue.tsx). Formulario de configuracion en linea:
// cada campo con FormField; errores y guardado con Callout/notify. Mismas llamadas: fetchPricingRule / savePricingRule.
import { useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, FormField, Input, NativeSelect, notify } from "@atiende/ui";
import { fetchPricingRule, savePricingRule } from "../../lib/revenue-client.ts";
import type { PricingRule } from "../../lib/revenue-client.ts";
import type { RoomTypeOption } from "../../lib/reservas-client.ts";

const DOW_LABELS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

interface PricingForm {
  floorPrice: string;
  ceilingPrice: string;
  multipliers: string[];
  minStayDefault: string;
  minStayOnHighDemand: string;
}

export interface ReglasPrecioSectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly roomTypes: readonly RoomTypeOption[] | null;
  readonly busy: boolean;
  /** Corre una accion con el `busy` global de la pagina (los errores van al banner de la pagina). */
  readonly withBusy: (fn: () => Promise<void>) => Promise<void>;
}

export function ReglasPrecioSection({ apiBaseUrl, token, propertyId, roomTypes, busy, withBusy }: ReglasPrecioSectionProps) {
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState("");
  const [pricingRule, setPricingRule] = useState<PricingRule | null>(null);
  const [pricingForm, setPricingForm] = useState<PricingForm | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);

  // Primer tipo de habitacion por defecto, una vez que la pagina los trae.
  useEffect(() => {
    if (roomTypes && roomTypes.length > 0 && !selectedRoomTypeId) setSelectedRoomTypeId(roomTypes[0]!.id);
  }, [roomTypes, selectedRoomTypeId]);

  useEffect(() => {
    if (!selectedRoomTypeId) return;
    setPricingError(null);
    void (async () => {
      const rule = await fetchPricingRule(fetch, apiBaseUrl, token, propertyId, selectedRoomTypeId);
      setPricingRule(rule);
      setPricingForm({
        floorPrice: String(rule.floorPrice),
        ceilingPrice: rule.ceilingPrice != null && Number.isFinite(rule.ceilingPrice) ? String(rule.ceilingPrice) : "",
        multipliers: rule.dayOfWeekMultiplier.map((m) => String(m)),
        minStayDefault: String(rule.minStayDefault),
        minStayOnHighDemand: String(rule.minStayOnHighDemand),
      });
    })().catch((err) => setPricingError(err instanceof Error ? err.message : "No se pudo cargar la regla de precio."));
  }, [apiBaseUrl, token, propertyId, selectedRoomTypeId]);

  async function handleSave() {
    setPricingError(null);
    if (!pricingForm || !selectedRoomTypeId) return;
    const floorPrice = Number(pricingForm.floorPrice);
    const ceilingPrice = Number(pricingForm.ceilingPrice);
    const multipliers = pricingForm.multipliers.map(Number);
    const minStayDefault = Number(pricingForm.minStayDefault);
    const minStayOnHighDemand = Number(pricingForm.minStayOnHighDemand);
    if (!Number.isFinite(floorPrice) || !Number.isFinite(ceilingPrice) || multipliers.some((m) => !Number.isFinite(m)) || multipliers.length !== 7) {
      setPricingError("Revisa que floor/ceiling y los 7 multiplicadores sean números válidos.");
      return;
    }
    await withBusy(async () => {
      const saved = await savePricingRule(fetch, apiBaseUrl, token, propertyId, selectedRoomTypeId, { floorPrice, ceilingPrice, dayOfWeekMultiplier: multipliers, minStayDefault, minStayOnHighDemand });
      setPricingRule(saved);
      notify.success("Reglas de precio guardadas.");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reglas de precio por tipo de habitación</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormField label="Tipo de habitación" className="max-w-sm">
          <NativeSelect id="pricing-room-type" value={selectedRoomTypeId} onChange={(e) => setSelectedRoomTypeId(e.target.value)}>
            {(roomTypes ?? []).map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.nombre}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {pricingRule?.esDefault && <p className="text-xs text-muted-foreground">Sin configurar todavía — mostrando el default razonable del motor.</p>}
        {pricingForm && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <FormField label="Tarifa mínima (floor)">
                <Input id="floor-price" type="number" value={pricingForm.floorPrice} onChange={(e) => setPricingForm({ ...pricingForm, floorPrice: e.target.value })} />
              </FormField>
              <FormField label="Tarifa máxima (ceiling)">
                <Input id="ceiling-price" type="number" value={pricingForm.ceilingPrice} onChange={(e) => setPricingForm({ ...pricingForm, ceilingPrice: e.target.value })} />
              </FormField>
            </div>
            <p className="text-xs text-muted-foreground">Multiplicador por día de la semana (1.0 = sin cambio)</p>
            <div className="grid grid-cols-7 gap-2 max-w-lg">
              {DOW_LABELS.map((label, i) => (
                <FormField key={label} label={label}>
                  <Input
                    type="number"
                    step="0.05"
                    className="px-1 text-center"
                    value={pricingForm.multipliers[i]}
                    onChange={(e) => {
                      const next = [...pricingForm.multipliers];
                      next[i] = e.target.value;
                      setPricingForm({ ...pricingForm, multipliers: next });
                    }}
                  />
                </FormField>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <FormField label="Estancia mínima (default)">
                <Input id="min-stay-default" type="number" value={pricingForm.minStayDefault} onChange={(e) => setPricingForm({ ...pricingForm, minStayDefault: e.target.value })} />
              </FormField>
              <FormField label="Estancia mínima (alta demanda)">
                <Input id="min-stay-high-demand" type="number" value={pricingForm.minStayOnHighDemand} onChange={(e) => setPricingForm({ ...pricingForm, minStayOnHighDemand: e.target.value })} />
              </FormField>
            </div>
            {pricingError && <Callout tone="danger">{pricingError}</Callout>}
            <Button type="submit" loading={busy} loadingText className="self-start">
              Guardar reglas
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
