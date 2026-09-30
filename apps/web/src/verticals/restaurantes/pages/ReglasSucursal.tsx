// Reglas de pedido de UNA sucursal (modelo PM, migración 023): horario (turnos / doble turno /
// cierre pasada la medianoche), pedido mínimo por canal, propina, zonas de reparto y número de
// WhatsApp propio. Solo owner/admin (el servidor, admin-modelo-pm.ts + RLS, es el enforcement
// real). Se monta bajo demanda desde Sucursales.tsx: no carga nada hasta que se abre.
import { useEffect, useState } from "react";
import { Button, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { fetchKnownZones } from "../lib/config-client.ts";
import type { KnownZone } from "../lib/config-client.ts";
import {
  NOMBRES_DIAS,
  deleteWhatsappSucursal,
  describirTurno,
  fetchPoliticaSucursal,
  fetchWhatsappSucursal,
  fetchZonasReparto,
  parseMontoOpcional,
  updatePoliticaSucursal,
  updateWhatsappSucursal,
  updateZonasReparto,
} from "../lib/modelo-pm-client.ts";
import type { PropinaPolitica, TurnoHorario } from "../lib/modelo-pm-client.ts";

const SELECT_CLASES = "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly branchId: string;
}

export function ReglasSucursal({ apiBaseUrl, token, propertyId, branchId }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [turnos, setTurnos] = useState<TurnoHorario[]>([]);
  const [minDomicilio, setMinDomicilio] = useState("");
  const [minRecoger, setMinRecoger] = useState("");
  const [propina, setPropina] = useState<PropinaPolitica | "">("");
  const [zonas, setZonas] = useState<readonly KnownZone[]>([]);
  const [zonasElegidas, setZonasElegidas] = useState<ReadonlySet<string>>(new Set());
  const [whatsapp, setWhatsapp] = useState("");
  const [whatsappGuardado, setWhatsappGuardado] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [politica, zoneIds, numero, known] = await Promise.all([
        fetchPoliticaSucursal(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchZonasReparto(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchKnownZones(fetch, apiBaseUrl, token, propertyId),
      ]);
      setTurnos(politica.horario ? politica.horario.map((t) => ({ ...t })) : []);
      setMinDomicilio(politica.pedidoMinimoDomicilio === null ? "" : String(politica.pedidoMinimoDomicilio));
      setMinRecoger(politica.pedidoMinimoRecoger === null ? "" : String(politica.pedidoMinimoRecoger));
      setPropina(politica.propinaPolitica ?? "");
      setZonas(known);
      setZonasElegidas(new Set(zoneIds));
      setWhatsappGuardado(numero);
      setWhatsapp(numero ?? "");
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reglas de la sucursal.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, branchId]);

  function updateTurno(index: number, patch: Partial<TurnoHorario>) {
    setTurnos((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function toggleDia(index: number, dia: number) {
    const actual = turnos[index]!;
    const dias = actual.dias.includes(dia) ? actual.dias.filter((d) => d !== dia) : [...actual.dias, dia].sort((a, b) => a - b);
    updateTurno(index, { dias });
  }

  async function handleGuardarReglas() {
    const domicilio = parseMontoOpcional(minDomicilio);
    const recoger = parseMontoOpcional(minRecoger);
    if (domicilio === undefined || recoger === undefined) {
      setError("Los pedidos mínimos deben ser un monto en pesos (o quedar vacíos para no exigir mínimo).");
      return;
    }
    if (turnos.some((t) => t.dias.length === 0 || !t.abre || !t.cierra || t.abre === t.cierra)) {
      setError("Cada turno necesita al menos un día y una hora de apertura distinta a la de cierre.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await updatePoliticaSucursal(fetch, apiBaseUrl, token, propertyId, branchId, {
        horario: turnos.length === 0 ? null : turnos,
        pedidoMinimoDomicilio: domicilio,
        pedidoMinimoRecoger: recoger,
        propinaPolitica: propina === "" ? null : propina,
      });
      await updateZonasReparto(fetch, apiBaseUrl, token, propertyId, branchId, [...zonasElegidas]);
      setNotice("Reglas guardadas.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar las reglas.");
    } finally {
      setSaving(false);
    }
  }

  async function handleGuardarWhatsapp() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (whatsapp.trim() === "") {
        if (whatsappGuardado) await deleteWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId);
        setWhatsappGuardado(null);
      } else {
        setWhatsappGuardado(await updateWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId, whatsapp.trim()));
      }
      setNotice("Número de WhatsApp guardado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el número de WhatsApp.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return error ? <EstadoError mensaje={error} onReintentar={() => void load()} /> : <EstadoCargando etiqueta="Cargando reglas de pedido…" />;
  }

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
      {error && <EstadoError mensaje={error} onReintentar={() => setError(null)} />}
      {notice && <p className="m-0 text-xs text-muted-foreground">{notice}</p>}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-foreground">Horario</h3>
        <p className="m-0 text-xs text-muted-foreground">
          Sin turnos = sin límite de horario. Si la hora de cierre es menor que la de apertura, el turno termina pasada la medianoche (ej. 12:00 a 01:00). Para doble turno agregue dos.
        </p>
        {turnos.map((turno, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Días del turno ${index + 1}`}>
              {NOMBRES_DIAS.map((nombre, dia) => (
                <label key={dia} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={turno.dias.includes(dia)} onChange={() => toggleDia(index, dia)} className="h-4 w-4 accent-primary" />
                  {nombre}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`abre-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  Abre
                </Label>
                <Input id={`abre-${branchId}-${index}`} type="time" value={turno.abre} onChange={(e) => updateTurno(index, { abre: e.target.value })} className="h-9 w-[120px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cierra-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  Cierra
                </Label>
                <Input id={`cierra-${branchId}-${index}`} type="time" value={turno.cierra} onChange={(e) => updateTurno(index, { cierra: e.target.value })} className="h-9 w-[120px]" />
              </div>
              <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => setTurnos((prev) => prev.filter((_, i) => i !== index))}>
                Quitar turno
              </Button>
            </div>
            <p className="m-0 text-[11px] text-muted-foreground">{turno.dias.length > 0 && turno.abre && turno.cierra ? describirTurno(turno) : "Turno incompleto"}</p>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => setTurnos((prev) => [...prev, { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }])}>
            Agregar turno
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-dom-${branchId}`} className="text-xs text-muted-foreground">
            Pedido mínimo a domicilio ($)
          </Label>
          <Input id={`min-dom-${branchId}`} inputMode="decimal" placeholder="Sin mínimo" value={minDomicilio} onChange={(e) => setMinDomicilio(e.target.value)} className="h-9 w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-rec-${branchId}`} className="text-xs text-muted-foreground">
            Pedido mínimo para recoger ($)
          </Label>
          <Input id={`min-rec-${branchId}`} inputMode="decimal" placeholder="Sin mínimo" value={minRecoger} onChange={(e) => setMinRecoger(e.target.value)} className="h-9 w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`propina-${branchId}`} className="text-xs text-muted-foreground">
            Propina
          </Label>
          <select id={`propina-${branchId}`} value={propina} onChange={(e) => setPropina(e.target.value as PropinaPolitica | "")} className={SELECT_CLASES}>
            <option value="">No preguntar</option>
            <option value="solo_tarjeta">Solo si paga con tarjeta</option>
            <option value="siempre">Siempre</option>
            <option value="nunca">Nunca</option>
          </select>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-foreground">Zonas de reparto</h3>
        <p className="m-0 text-xs text-muted-foreground">
          Sin zonas marcadas = sin restricción. Con zonas marcadas, los pedidos a domicilio fuera de ellas se rechazan. Las zonas se dan de alta en Configuración.
        </p>
        {zonas.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">Todavía no hay zonas conocidas.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {zonas.map((zona) => (
              <label key={zona.id} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={zonasElegidas.has(zona.id)}
                  onChange={() =>
                    setZonasElegidas((prev) => {
                      const next = new Set(prev);
                      if (next.has(zona.id)) next.delete(zona.id);
                      else next.add(zona.id);
                      return next;
                    })
                  }
                  className="h-4 w-4 accent-primary"
                />
                {zona.name}
              </label>
            ))}
          </div>
        )}
      </section>

      <div>
        <Button type="button" size="sm" className="h-9 text-xs" onClick={() => void handleGuardarReglas()} disabled={saving}>
          {saving ? "Guardando…" : "Guardar reglas"}
        </Button>
      </div>

      <section className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`wa-${branchId}`} className="text-xs text-muted-foreground">
            WhatsApp de esta sucursal (phone_number_id de Meta)
          </Label>
          <Input id={`wa-${branchId}`} inputMode="numeric" placeholder="Sin número propio" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className="h-9 w-[240px]" />
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => void handleGuardarWhatsapp()} disabled={saving}>
          Guardar número
        </Button>
      </section>
    </div>
  );
}
