// Reglas de pedido de UNA sucursal (modelo PM, migración 023): horario (turnos / doble turno /
// cierre pasada la medianoche), pedido mínimo por canal, propina, zonas de reparto y número de
// WhatsApp propio. Solo owner/admin (el servidor, admin-modelo-pm.ts + RLS, es el enforcement
// real). Se monta bajo demanda desde Sucursales.tsx: no carga nada hasta que se abre.
import { useEffect, useState } from "react";
import { Button, Checkbox, EstadoCargando, EstadoError, Input, Label, NativeSelect, useConfirm } from "@atiende/ui";
import { fetchKnownZones } from "../lib/config-client.ts";
import { ColoniasAmbiguas } from "./ColoniasAmbiguas.tsx";
import type { KnownZone } from "../lib/config-client.ts";
import {
  NOMBRES_DIAS,
  createPuente,
  deletePuente,
  deleteWhatsappSucursal,
  fetchPuentes,
  describirTurno,
  fetchPoliticaSucursal,
  fetchWhatsappSucursal,
  fetchZonasReparto,
  parseMontoOpcional,
  updatePoliticaSucursal,
  updateWhatsappSucursal,
  updateZonasReparto,
} from "../lib/modelo-pm-client.ts";
import type { PropinaPolitica, Puente, TurnoHorario, TurnoPuente } from "../lib/modelo-pm-client.ts";
import { fetchInterruptorAgenteWhatsapp, updateInterruptorAgenteWhatsapp } from "../lib/conocimiento-client.ts";
import type { InterruptorAgenteWhatsapp } from "../lib/conocimiento-client.ts";


interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly branchId: string;
}

/** Un fallo de guardado se pinta DENTRO de su seccion (junto al boton que lo causo) y su "Reintentar" repite
 * exactamente esa escritura (QA-restaurantes-R1-botones-12). */
type Seccion = "reglas" | "puente" | "whatsapp" | "agente";
interface Fallo {
  readonly seccion: Seccion;
  readonly mensaje: string;
  readonly reintentar?: () => void;
}

export function ReglasSucursal({ apiBaseUrl, token, propertyId, branchId }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<Fallo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  const [turnos, setTurnos] = useState<TurnoHorario[]>([]);
  const [minDomicilio, setMinDomicilio] = useState("");
  const [minRecoger, setMinRecoger] = useState("");
  const [propina, setPropina] = useState<PropinaPolitica | "">("");
  const [zonas, setZonas] = useState<readonly KnownZone[]>([]);
  const [zonasElegidas, setZonasElegidas] = useState<ReadonlySet<string>>(new Set());
  const [whatsapp, setWhatsapp] = useState("");
  const [whatsappGuardado, setWhatsappGuardado] = useState<string | null>(null);
  // Interruptor DURO del agente de WhatsApp de esta sucursal (migracion 053): apagado, el agente no contesta (sin costo de IA) y los mensajes
  // llegan a la bandeja de Conversaciones. `null` = aun no se lee; `disponible: false` = la base no tiene la migracion (no se puede cambiar).
  const [agente, setAgente] = useState<InterruptorAgenteWhatsapp | null>(null);
  const [errorAgente, setErrorAgente] = useState<string | null>(null);
  // Puentes: excepciones de horario por fecha de ESTA sucursal. El API acepta varias sucursales a la vez; aqui se
  // crea para esta. Las horas de los turnos las define el negocio (no se asumen).
  const [puentes, setPuentes] = useState<readonly Puente[]>([]);
  const [puenteDesde, setPuenteDesde] = useState("");
  const [puenteHasta, setPuenteHasta] = useState("");
  const [puenteTurnos, setPuenteTurnos] = useState<TurnoPuente[]>([
    { abre: "", cierra: "" },
    { abre: "", cierra: "" },
  ]);
  const [puenteMotivo, setPuenteMotivo] = useState("");
  // Cierre de una fecha completa (feriado, imprevisto): el puente va sin turnos y con `cerrado: true`.
  const [puenteCerrado, setPuenteCerrado] = useState(false);

  async function load() {
    setError(null);
    try {
      const [politica, zoneIds, numero, known, todosLosPuentes] = await Promise.all([
        fetchPoliticaSucursal(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchZonasReparto(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId),
        fetchKnownZones(fetch, apiBaseUrl, token, propertyId),
        // Los puentes son accesorios: si el API aun no los expone, el resto de las reglas debe seguir cargando.
        fetchPuentes(fetch, apiBaseUrl, token, propertyId).catch(() => [] as readonly Puente[]),
      ]);
      setPuentes(todosLosPuentes.filter((p) => p.branchId === branchId));
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

  useEffect(() => {
    let cancelado = false;
    setAgente(null);
    setErrorAgente(null);
    fetchInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId)
      .then((v) => {
        if (!cancelado) setAgente(v);
      })
      .catch((err) => {
        if (!cancelado) setErrorAgente(err instanceof Error ? err.message : "No se pudo leer el estado del agente de WhatsApp.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, branchId]);

  async function handleCambiarAgente(activo: boolean) {
    if (!activo) {
      const ok = await confirmar({
        titulo: "Apagar el agente de WhatsApp de esta sucursal",
        descripcion: "El agente dejará de contestar los mensajes de esta sucursal: el cliente recibirá un aviso de que lo atenderá una persona y su conversación llegará a la bandeja de Conversaciones para que alguien del equipo la conteste. ¿Apagarlo?",
        tono: "danger",
        confirmar: "Apagar agente",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    setSaving(true);
    setFallo(null);
    setNotice(null);
    try {
      setAgente(await updateInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId, activo));
      setNotice(activo ? "Agente de WhatsApp encendido en esta sucursal." : "Agente de WhatsApp apagado: los mensajes de esta sucursal llegan a la bandeja de Conversaciones.");
    } catch (err) {
      setFallo({ seccion: "agente", mensaje: err instanceof Error ? err.message : "No se pudo cambiar el agente de WhatsApp.", reintentar: () => void handleCambiarAgente(activo) });
    } finally {
      setSaving(false);
    }
  }

  function updateTurno(index: number, patch: Partial<TurnoHorario>) {
    setTurnos((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function toggleDia(index: number, dia: number) {
    const actual = turnos[index]!;
    const dias = actual.dias.includes(dia) ? actual.dias.filter((d) => d !== dia) : [...actual.dias, dia].sort((a, b) => a - b);
    updateTurno(index, { dias });
  }

  async function handleGuardarReglas(soloZonas = false) {
    const domicilio = parseMontoOpcional(minDomicilio);
    const recoger = parseMontoOpcional(minRecoger);
    if (domicilio === undefined || recoger === undefined) {
      setFallo({ seccion: "reglas", mensaje: "Los pedidos mínimos deben ser un monto en pesos (o quedar vacíos para no exigir mínimo)." });
      return;
    }
    if (turnos.some((t) => t.dias.length === 0 || !t.abre || !t.cierra || t.abre === t.cierra)) {
      setFallo({ seccion: "reglas", mensaje: "Cada turno necesita al menos un día y una hora de apertura distinta a la de cierre." });
      return;
    }
    setSaving(true);
    setFallo(null);
    setNotice(null);
    // Son DOS escrituras (politica y zonas). Si la segunda falla, la primera ya quedo guardada: el aviso lo dice y
    // "Reintentar" repite solo las zonas (QA-restaurantes-R1-botones-13 / caos-19).
    let politicaGuardada = soloZonas;
    try {
      if (!soloZonas) {
        await updatePoliticaSucursal(fetch, apiBaseUrl, token, propertyId, branchId, {
          horario: turnos.length === 0 ? null : turnos,
          pedidoMinimoDomicilio: domicilio,
          pedidoMinimoRecoger: recoger,
          propinaPolitica: propina === "" ? null : propina,
        });
        politicaGuardada = true;
      }
      await updateZonasReparto(fetch, apiBaseUrl, token, propertyId, branchId, [...zonasElegidas]);
      setNotice("Reglas guardadas.");
    } catch (err) {
      const detalle = err instanceof Error ? err.message : "Error desconocido.";
      setFallo(
        politicaGuardada
          ? { seccion: "reglas", mensaje: `El horario, los mínimos y la propina sí se guardaron, pero NO se pudieron guardar las zonas de reparto: ${detalle}`, reintentar: () => void handleGuardarReglas(true) }
          : { seccion: "reglas", mensaje: err instanceof Error ? err.message : "No se pudieron guardar las reglas.", reintentar: () => void handleGuardarReglas(false) },
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleGuardarWhatsapp() {
    const vaciar = whatsapp.trim() === "";
    if (vaciar && whatsappGuardado) {
      const ok = await confirmar({
        titulo: "Desconectar el WhatsApp de la sucursal",
        descripcion: "La sucursal se quedará sin número propio y dejará de recibir mensajes por su agente de WhatsApp. ¿Desconectarlo?",
        tono: "danger",
        confirmar: "Desconectar número",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    setSaving(true);
    setFallo(null);
    setNotice(null);
    try {
      if (vaciar) {
        if (whatsappGuardado) await deleteWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId);
        setWhatsappGuardado(null);
        setNotice(whatsappGuardado ? "Número de WhatsApp desconectado." : "Número de WhatsApp guardado.");
      } else {
        setWhatsappGuardado(await updateWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId, whatsapp.trim()));
        setNotice("Número de WhatsApp guardado.");
      }
    } catch (err) {
      setFallo({ seccion: "whatsapp", mensaje: err instanceof Error ? err.message : "No se pudo guardar el número de WhatsApp.", reintentar: () => void handleGuardarWhatsapp() });
    } finally {
      setSaving(false);
    }
  }

  async function handleCrearPuente() {
    const turnos = puenteCerrado ? [] : puenteTurnos.filter((t) => t.abre && t.cierra);
    if (!puenteDesde || !puenteHasta || (!puenteCerrado && (turnos.length === 0 || turnos.some((t) => t.abre === t.cierra)))) {
      setFallo({ seccion: "puente", mensaje: "Un puente necesita fecha inicial y final y al menos un turno con apertura distinta al cierre (o marcar «Cerrado todo el día»)." });
      return;
    }
    if (puenteHasta < puenteDesde) {
      setFallo({ seccion: "puente", mensaje: "Un puente necesita que la fecha final no sea anterior a la inicial." });
      return;
    }
    setSaving(true);
    setFallo(null);
    setNotice(null);
    try {
      await createPuente(fetch, apiBaseUrl, token, propertyId, {
        branchIds: [branchId],
        fechaDesde: puenteDesde,
        fechaHasta: puenteHasta,
        ...(puenteCerrado ? { cerrado: true } : { turnos }),
        ...(puenteMotivo.trim() ? { motivo: puenteMotivo.trim() } : {}),
      });
      setPuentes((await fetchPuentes(fetch, apiBaseUrl, token, propertyId)).filter((p) => p.branchId === branchId));
      setNotice(puenteCerrado ? "Cierre de fecha guardado." : "Puente guardado.");
    } catch (err) {
      setFallo({ seccion: "puente", mensaje: err instanceof Error ? err.message : "No se pudo guardar el puente.", reintentar: () => void handleCrearPuente() });
    } finally {
      setSaving(false);
    }
  }

  async function handleBorrarPuente(puente: Puente) {
    const ok = await confirmar({
      titulo: "Quitar el puente",
      descripcion: `¿Quitar ${puente.horario.length === 0 ? "el cierre" : "el puente"} del ${puente.fechaDesde} al ${puente.fechaHasta}? Volverá a regir el horario semanal en esas fechas.`,
      tono: "danger",
      confirmar: "Quitar puente",
      cancelar: "Volver",
    });
    if (!ok) return;
    setSaving(true);
    setFallo(null);
    try {
      await deletePuente(fetch, apiBaseUrl, token, propertyId, puente.id);
      setPuentes((prev) => prev.filter((p) => p.id !== puente.id));
    } catch (err) {
      setFallo({ seccion: "puente", mensaje: err instanceof Error ? err.message : "No se pudo borrar el puente.", reintentar: () => void handleBorrarPuente(puente) });
    } finally {
      setSaving(false);
    }
  }

  const falloDe = (seccion: Seccion) =>
    fallo?.seccion === seccion ? <EstadoError titulo="No se pudo guardar" mensaje={fallo.mensaje} compacto className="w-full basis-full" onReintentar={fallo.reintentar ?? (() => setFallo(null))} /> : null;

  if (!loaded) {
    return error ? <EstadoError mensaje={error} onReintentar={() => void load()} /> : <EstadoCargando etiqueta="Cargando reglas de pedido…" />;
  }

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
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
                <Checkbox key={dia} label={nombre} wrapperClassName="text-xs" checked={turno.dias.includes(dia)} onChange={() => toggleDia(index, dia)} />
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`abre-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  Abre
                </Label>
                <Input id={`abre-${branchId}-${index}`} type="time" value={turno.abre} onChange={(e) => updateTurno(index, { abre: e.target.value })} className="w-[120px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cierra-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  Cierra
                </Label>
                <Input id={`cierra-${branchId}-${index}`} type="time" value={turno.cierra} onChange={(e) => updateTurno(index, { cierra: e.target.value })} className="w-[120px]" />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setTurnos((prev) => prev.filter((_, i) => i !== index))}>
                Quitar turno
              </Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">{turno.dias.length > 0 && turno.abre && turno.cierra ? describirTurno(turno) : "Turno incompleto"}</p>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setTurnos((prev) => [...prev, { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }])}>
            Agregar turno
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-dom-${branchId}`} className="text-xs text-muted-foreground">
            Pedido mínimo a domicilio ($)
          </Label>
          <Input id={`min-dom-${branchId}`} inputMode="decimal" placeholder="Sin mínimo" value={minDomicilio} onChange={(e) => setMinDomicilio(e.target.value)} className="w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-rec-${branchId}`} className="text-xs text-muted-foreground">
            Pedido mínimo para recoger ($)
          </Label>
          <Input id={`min-rec-${branchId}`} inputMode="decimal" placeholder="Sin mínimo" value={minRecoger} onChange={(e) => setMinRecoger(e.target.value)} className="w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`propina-${branchId}`} className="text-xs text-muted-foreground">
            Propina
          </Label>
          <NativeSelect id={`propina-${branchId}`} size="sm" value={propina} onChange={(e) => setPropina(e.target.value as PropinaPolitica | "")} wrapperClassName="w-auto min-w-48">
            <option value="">No preguntar</option>
            <option value="solo_tarjeta">Solo si paga con tarjeta</option>
            <option value="siempre">Siempre</option>
            <option value="nunca">Nunca</option>
          </NativeSelect>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-foreground">Zonas de reparto</h3>
        <p className="m-0 text-xs text-muted-foreground">
          Con zonas marcadas, los pedidos a domicilio fuera de ellas se rechazan. Sin zonas marcadas no se valida la colonia; en Los Taquitos de PM el agente entonces pide el pin de ubicación o pasa el pedido a una persona. Las zonas se dan de alta en Configuración.
        </p>
        {zonas.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">Todavía no hay zonas conocidas.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {zonas.map((zona) => (
              <Checkbox
                key={zona.id}
                label={zona.name}
                wrapperClassName="text-xs"
                checked={zonasElegidas.has(zona.id)}
                onChange={() =>
                  setZonasElegidas((prev) => {
                    const next = new Set(prev);
                    if (next.has(zona.id)) next.delete(zona.id);
                    else next.add(zona.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
      </section>

      <ColoniasAmbiguas apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />

      <div>
        <Button type="button" size="sm" onClick={() => void handleGuardarReglas()} loading={saving}>
          Guardar reglas
        </Button>
      </div>
      {falloDe("reglas")}

      <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid={`puentes-${branchId}`}>
        <h3 className="m-0 text-sm font-semibold text-foreground">Puentes (horario por fechas)</h3>
        <p className="m-0 text-xs text-muted-foreground">
          En las fechas indicadas rigen estos turnos en lugar del horario semanal (por ejemplo, abrir los dos turnos en un puente). Para un feriado o imprevisto marque «Cerrado todo el día»: la sucursal no recibe pedidos esas fechas.
        </p>
        {puentes.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs text-foreground">
            <span>
              {p.fechaDesde} → {p.fechaHasta}: {p.horario.length === 0 ? "Cerrado todo el día" : p.horario.map((t) => `${t.abre}–${t.cierra}`).filter((v, i, a) => a.indexOf(v) === i).join(" y ")}
              {p.motivo ? ` (${p.motivo})` : ""}
            </span>
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => void handleBorrarPuente(p)} disabled={saving}>
              Quitar
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-desde-${branchId}`} className="text-xs text-muted-foreground">
              Desde
            </Label>
            <Input id={`puente-desde-${branchId}`} type="date" value={puenteDesde} onChange={(e) => setPuenteDesde(e.target.value)} className="w-[150px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-hasta-${branchId}`} className="text-xs text-muted-foreground">
              Hasta
            </Label>
            <Input id={`puente-hasta-${branchId}`} type="date" value={puenteHasta} onChange={(e) => setPuenteHasta(e.target.value)} className="w-[150px]" />
          </div>
          <Checkbox label="Cerrado todo el día" wrapperClassName="text-xs" checked={puenteCerrado} onChange={() => setPuenteCerrado((v) => !v)} />
          {!puenteCerrado && puenteTurnos.map((t, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Label htmlFor={`puente-turno-${i}-${branchId}`} className="text-xs text-muted-foreground">
                Turno {i + 1} (abre / cierra)
              </Label>
              <div className="flex gap-1">
                <Input id={`puente-turno-${i}-${branchId}`} type="time" value={t.abre} onChange={(e) => setPuenteTurnos((prev) => prev.map((x, j) => (j === i ? { ...x, abre: e.target.value } : x)))} className="w-[110px]" />
                <Input type="time" aria-label={`Cierre del turno ${i + 1}`} value={t.cierra} onChange={(e) => setPuenteTurnos((prev) => prev.map((x, j) => (j === i ? { ...x, cierra: e.target.value } : x)))} className="w-[110px]" />
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-motivo-${branchId}`} className="text-xs text-muted-foreground">
              Motivo (opc.)
            </Label>
            <Input id={`puente-motivo-${branchId}`} value={puenteMotivo} onChange={(e) => setPuenteMotivo(e.target.value)} className="w-[180px]" />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void handleCrearPuente()} disabled={saving}>
            Guardar puente
          </Button>
        </div>
        {falloDe("puente")}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid={`agente-whatsapp-${branchId}`}>
        <h3 className="m-0 text-sm font-semibold text-foreground">Agente de WhatsApp</h3>
        {errorAgente ? (
          <EstadoError titulo="No se pudo leer el estado" mensaje={errorAgente} compacto className="w-full" />
        ) : agente === null ? (
          <EstadoCargando etiqueta="Leyendo el estado del agente…" />
        ) : !agente.disponible ? (
          <p role="status" className="m-0 text-xs text-muted-foreground">
            No disponible aún: apagar el agente por sucursal requiere aplicar la migración 053 en esta base. Mientras tanto el agente atiende normalmente.
          </p>
        ) : (
          <>
            <Checkbox
              label="El agente contesta los mensajes de WhatsApp de esta sucursal"
              wrapperClassName="text-xs"
              checked={agente.agenteActivo}
              disabled={saving}
              onChange={() => void handleCambiarAgente(!agente.agenteActivo)}
            />
            <p className="m-0 text-xs text-muted-foreground">
              {agente.agenteActivo
                ? "Si lo apaga, el cliente recibe un aviso de que lo atenderá una persona y la conversación queda en la bandeja de Conversaciones. Sin costo de IA."
                : "Apagado: el agente no contesta en esta sucursal. Cada conversación nueva llega a la bandeja de Conversaciones y debe atenderla una persona del equipo."}
            </p>
          </>
        )}
        {falloDe("agente")}
      </section>

      <section className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`wa-${branchId}`} className="text-xs text-muted-foreground">
            WhatsApp de esta sucursal (phone_number_id de Meta)
          </Label>
          <Input id={`wa-${branchId}`} inputMode="numeric" placeholder="Sin número propio" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className="w-[240px]" />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleGuardarWhatsapp()} disabled={saving}>
          Guardar número
        </Button>
        {falloDe("whatsapp")}
      </section>
      {dialogo}
    </div>
  );
}
