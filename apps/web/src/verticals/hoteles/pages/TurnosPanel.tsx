// Turnos de camaristas (H-35) -- consulta del cumplimiento de la LFT y publicacion de la plantilla semanal. Consume
// `GET|POST /hoteles/:propertyId/housekeeping/turnos`. Publicar valida contra la Ley Federal del Trabajo EN EL SERVIDOR: con
// violaciones responde 422 con la cita legal y no guarda nada; aqui se muestran tal cual (nunca se "arreglan" en silencio).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, Checkbox, EstadoCargando, EstadoVacio, Input, Label, NativeSelect, StatusBadge } from "@atiende/ui";
import { DIAS_SEMANA, TURNOS_PUBLISH_ROLES, fetchTurnos, publicarTurnos, turnosDelRango, validarPlantilla } from "../lib/turnos-client.ts";
import type { TurnosConsulta, ViolacionLft } from "../lib/turnos-client.ts";
import type { Camarista } from "../lib/limpieza-client.ts";
import { formatFechaSolo, sumarDiasFechaSolo, parseFechaSolo } from "../../../lib/formato-fecha.ts";

export interface TurnosPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  /** Fecha de hoy de la property (la del tablero). El rango inicial es la semana (lunes a domingo) que la contiene. */
  readonly hoy: string;
  readonly camaristas: readonly Camarista[];
}

function semanaDe(hoy: string): { desde: string; hasta: string } {
  const dow = parseFechaSolo(hoy).getUTCDay();
  const desde = sumarDiasFechaSolo(hoy, -((dow + 6) % 7));
  return { desde, hasta: sumarDiasFechaSolo(desde, 6) };
}

function ListaViolaciones({ violaciones, nombre }: { violaciones: readonly ViolacionLft[]; nombre: (id: string) => string }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {violaciones.map((v, i) => (
        <li key={`${v.type}-${v.staffId}-${i}`} className="text-sm text-foreground">
          <span className="font-medium">{v.article}</span> · {nombre(v.staffId)}: {v.message}
        </li>
      ))}
    </ul>
  );
}

export function TurnosPanel({ apiBaseUrl, token, propertyId, role, hoy, camaristas }: TurnosPanelProps) {
  const semana = semanaDe(hoy);
  const [desde, setDesde] = useState(semana.desde);
  const [hasta, setHasta] = useState(semana.hasta);
  const [staffId, setStaffId] = useState("");
  const [consulta, setConsulta] = useState<TurnosConsulta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [pubStaff, setPubStaff] = useState("");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [dias, setDias] = useState<ReadonlySet<number>>(new Set([1, 2, 3, 4, 5]));
  const [busy, setBusy] = useState(false);
  const [rechazo, setRechazo] = useState<readonly ViolacionLft[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const puedePublicar = TURNOS_PUBLISH_ROLES.has(role);

  const nombre = (id: string) => camaristas.find((c) => c.id === id)?.nombre ?? "Otro responsable";

  const load = useCallback(async () => {
    setError(null);
    try {
      setConsulta(await fetchTurnos(fetch, apiBaseUrl, token, propertyId, desde, hasta, staffId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los turnos.");
    }
  }, [apiBaseUrl, token, propertyId, desde, hasta, staffId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleDia(d: number) {
    setDias((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function handlePublicar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalido = validarPlantilla(pubStaff, desde, hasta, inicio, fin, dias);
    if (invalido) return setError(invalido);
    setBusy(true);
    setError(null);
    setRechazo(null);
    setAviso(null);
    try {
      const r = await publicarTurnos(fetch, apiBaseUrl, token, propertyId, { staffId: pubStaff, fromDate: desde, toDate: hasta, shifts: turnosDelRango(desde, hasta, dias, inicio, fin) });
      if (r.publicado) {
        setAviso(`Plantilla publicada: ${r.turnos.length} turno(s) para ${nombre(pubStaff)}.`);
        await load();
      } else {
        setRechazo(r.violaciones);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo publicar la plantilla.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2 flex-wrap">
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          Desde
          <Input type="date" value={desde} onChange={(e) => e.target.value && setDesde(e.target.value)} className="h-11" />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          Hasta
          <Input type="date" value={hasta} onChange={(e) => e.target.value && setHasta(e.target.value)} className="h-11" />
        </label>
        <label className="text-xs text-muted-foreground flex flex-col gap-1">
          Camarista
          <NativeSelect value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Filtrar por camarista">
            <option value="">Todas</option>
            {camaristas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-sm text-foreground">
          {aviso}
        </p>
      )}
      {!consulta && !error && <EstadoCargando etiqueta="Cargando turnos…" />}

      {consulta && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Turnos publicados</h2>
              <StatusBadge tone={consulta.cumplimiento.valido ? "success" : "danger"}>{consulta.cumplimiento.valido ? "Cumple la LFT" : "Incumple la LFT"}</StatusBadge>
            </div>
            {consulta.turnos.length === 0 && <EstadoVacio mensaje="No hay turnos publicados en este rango." />}
            {consulta.turnos.map((t) => (
              <p key={t.id} className="text-sm text-foreground flex justify-between gap-2">
                <span>
                  {formatFechaSolo(t.fecha)} · {nombre(t.staffId)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {t.inicio} – {t.fin}
                </span>
              </p>
            ))}
            {!consulta.cumplimiento.valido && <ListaViolaciones violaciones={consulta.cumplimiento.violaciones} nombre={nombre} />}
          </CardContent>
        </Card>
      )}

      {puedePublicar && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={handlePublicar} className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-foreground">Publicar plantilla</h2>
              <p className="text-xs text-muted-foreground">
                Reemplaza los turnos de la camarista en el rango de arriba ({formatFechaSolo(desde)} – {formatFechaSolo(hasta)}). El servidor valida la LFT: si algo no cumple, no se guarda nada.
              </p>
              <div className="flex gap-2 flex-wrap items-end">
                <div>
                  <Label htmlFor="turno-camarista">Camarista</Label>
                  <NativeSelect id="turno-camarista" value={pubStaff} onChange={(e) => setPubStaff(e.target.value)}>
                    <option value="">Elegir…</option>
                    {camaristas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor="turno-inicio">Entrada</Label>
                  <Input id="turno-inicio" type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="turno-fin">Salida</Label>
                  <Input id="turno-fin" type="time" value={fin} onChange={(e) => setFin(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-3 flex-wrap">
                {DIAS_SEMANA.map((d) => (
                  <Checkbox key={d.valor} label={d.etiqueta} checked={dias.has(d.valor)} onChange={() => toggleDia(d.valor)} />
                ))}
              </div>
              <div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Publicando…" : "Publicar plantilla"}
                </Button>
              </div>
              {rechazo && (
                <div role="alert" className="flex flex-col gap-1.5 border-t border-border pt-3">
                  <p className="text-sm font-medium text-destructive">No se publicó: la plantilla incumple la LFT.</p>
                  <ListaViolaciones violaciones={rechazo} nombre={nombre} />
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
