// Reglas de pedido de UNA sucursal (modelo PM, migración 023): horario (turnos / doble turno /
// cierre pasada la medianoche), pedido mínimo por canal, propina, zonas de reparto y número de
// WhatsApp propio. Solo owner/admin (el servidor, admin-modelo-pm.ts + RLS, es el enforcement
// real). Se monta bajo demanda desde Sucursales.tsx: no carga nada hasta que se abre.
import { useEffect, useState } from "react";
import { Button, Checkbox, EstadoCargando, EstadoError, Input, Label, Selector, useConfirm, useT } from "@atiende/ui";
import { restaurantesReglas } from "@atiende/ui/i18n/restaurantes/reglas";
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
import { ConectarWhatsappMeta } from "../components/ConectarWhatsappMeta.tsx";
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
  const t = useT(restaurantesReglas);
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
      setError(err instanceof Error ? err.message : t("restaurantes.reglas.error.cargar"));
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
        if (!cancelado) setErrorAgente(err instanceof Error ? err.message : t("restaurantes.reglas.error.leerAgente"));
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, branchId]);

  async function handleCambiarAgente(activo: boolean) {
    if (!activo) {
      const ok = await confirmar({
        titulo: t("restaurantes.reglas.agente.apagarTitulo"),
        descripcion: t("restaurantes.reglas.agente.apagarDesc"),
        tono: "danger",
        confirmar: t("restaurantes.reglas.agente.apagar"),
        cancelar: t("restaurantes.reglas.volver"),
      });
      if (!ok) return;
    }
    setSaving(true);
    setFallo(null);
    setNotice(null);
    try {
      setAgente(await updateInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId, activo));
      setNotice(t(activo ? "restaurantes.reglas.agente.encendido" : "restaurantes.reglas.agente.apagado"));
    } catch (err) {
      setFallo({ seccion: "agente", mensaje: err instanceof Error ? err.message : t("restaurantes.reglas.agente.errorCambiar"), reintentar: () => void handleCambiarAgente(activo) });
    } finally {
      setSaving(false);
    }
  }

  function updateTurno(index: number, patch: Partial<TurnoHorario>) {
    setTurnos((prev) => prev.map((turno, i) => (i === index ? { ...turno, ...patch } : turno)));
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
      setFallo({ seccion: "reglas", mensaje: t("restaurantes.reglas.error.minimos") });
      return;
    }
    if (turnos.some((tu) => tu.dias.length === 0 || !tu.abre || !tu.cierra || tu.abre === tu.cierra)) {
      setFallo({ seccion: "reglas", mensaje: t("restaurantes.reglas.error.turnos") });
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
      setNotice(t("restaurantes.reglas.guardadas"));
    } catch (err) {
      const detalle = err instanceof Error ? err.message : t("restaurantes.reglas.error.desconocido");
      setFallo(
        politicaGuardada
          ? { seccion: "reglas", mensaje: t("restaurantes.reglas.error.zonas", { detalle }), reintentar: () => void handleGuardarReglas(true) }
          : { seccion: "reglas", mensaje: err instanceof Error ? err.message : t("restaurantes.reglas.error.guardar"), reintentar: () => void handleGuardarReglas(false) },
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleGuardarWhatsapp() {
    const vaciar = whatsapp.trim() === "";
    if (vaciar && whatsappGuardado) {
      const ok = await confirmar({
        titulo: t("restaurantes.reglas.wa.desconectarTitulo"),
        descripcion: t("restaurantes.reglas.wa.desconectarDesc"),
        tono: "danger",
        confirmar: t("restaurantes.reglas.wa.desconectar"),
        cancelar: t("restaurantes.reglas.volver"),
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
        setNotice(t(whatsappGuardado ? "restaurantes.reglas.wa.desconectado" : "restaurantes.reglas.wa.guardado"));
      } else {
        setWhatsappGuardado(await updateWhatsappSucursal(fetch, apiBaseUrl, token, propertyId, branchId, whatsapp.trim()));
        setNotice(t("restaurantes.reglas.wa.guardado"));
      }
    } catch (err) {
      setFallo({ seccion: "whatsapp", mensaje: err instanceof Error ? err.message : t("restaurantes.reglas.wa.error"), reintentar: () => void handleGuardarWhatsapp() });
    } finally {
      setSaving(false);
    }
  }

  async function handleCrearPuente() {
    const turnos = puenteCerrado ? [] : puenteTurnos.filter((tu) => tu.abre && tu.cierra);
    if (!puenteDesde || !puenteHasta || (!puenteCerrado && (turnos.length === 0 || turnos.some((tu) => tu.abre === tu.cierra)))) {
      setFallo({ seccion: "puente", mensaje: t("restaurantes.reglas.puente.errorDatos") });
      return;
    }
    if (puenteHasta < puenteDesde) {
      setFallo({ seccion: "puente", mensaje: t("restaurantes.reglas.puente.errorFechas") });
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
      setNotice(t(puenteCerrado ? "restaurantes.reglas.puente.cierreGuardado" : "restaurantes.reglas.puente.guardado"));
    } catch (err) {
      setFallo({ seccion: "puente", mensaje: err instanceof Error ? err.message : t("restaurantes.reglas.puente.errorGuardar"), reintentar: () => void handleCrearPuente() });
    } finally {
      setSaving(false);
    }
  }

  async function handleBorrarPuente(puente: Puente) {
    const ok = await confirmar({
      titulo: t("restaurantes.reglas.puente.quitarTitulo"),
      descripcion: t(puente.horario.length === 0 ? "restaurantes.reglas.puente.quitarCierre" : "restaurantes.reglas.puente.quitarPuente", { desde: puente.fechaDesde, hasta: puente.fechaHasta }),
      tono: "danger",
      confirmar: t("restaurantes.reglas.puente.quitar"),
      cancelar: t("restaurantes.reglas.volver"),
    });
    if (!ok) return;
    setSaving(true);
    setFallo(null);
    try {
      await deletePuente(fetch, apiBaseUrl, token, propertyId, puente.id);
      setPuentes((prev) => prev.filter((p) => p.id !== puente.id));
    } catch (err) {
      setFallo({ seccion: "puente", mensaje: err instanceof Error ? err.message : t("restaurantes.reglas.puente.errorBorrar"), reintentar: () => void handleBorrarPuente(puente) });
    } finally {
      setSaving(false);
    }
  }

  const falloDe = (seccion: Seccion) =>
    fallo?.seccion === seccion ? <EstadoError titulo={t("restaurantes.reglas.noSeGuardo")} mensaje={fallo.mensaje} compacto className="w-full basis-full" onReintentar={fallo.reintentar ?? (() => setFallo(null))} /> : null;

  if (!loaded) {
    return error ? <EstadoError mensaje={error} onReintentar={() => void load()} /> : <EstadoCargando etiqueta={t("restaurantes.reglas.cargando")} />;
  }

  return (
    <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {notice && <p className="m-0 text-xs text-muted-foreground">{notice}</p>}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.reglas.horario")}</h3>
        <p className="m-0 text-xs text-muted-foreground">
          {t("restaurantes.reglas.horarioAyuda")}
        </p>
        {turnos.map((turno, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("restaurantes.reglas.diasTurno", { n: index + 1 })}>
              {NOMBRES_DIAS.map((nombre, dia) => (
                <Checkbox key={dia} label={nombre} wrapperClassName="text-xs" checked={turno.dias.includes(dia)} onChange={() => toggleDia(index, dia)} />
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`abre-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  {t("restaurantes.reglas.abre")}
                </Label>
                <Input id={`abre-${branchId}-${index}`} type="time" value={turno.abre} onChange={(e) => updateTurno(index, { abre: e.target.value })} className="w-[120px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cierra-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  {t("restaurantes.reglas.cierra")}
                </Label>
                <Input id={`cierra-${branchId}-${index}`} type="time" value={turno.cierra} onChange={(e) => updateTurno(index, { cierra: e.target.value })} className="w-[120px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`ultimo-domicilio-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  {t("restaurantes.reglas.ultimoDomicilio")}
                </Label>
                <Input id={`ultimo-domicilio-${branchId}-${index}`} type="time" value={turno.ultimoPedidoDomicilio ?? ""} onChange={(e) => updateTurno(index, { ultimoPedidoDomicilio: e.target.value || undefined })} className="w-[120px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`ultimo-recoger-${branchId}-${index}`} className="text-xs text-muted-foreground">
                  {t("restaurantes.reglas.ultimoRecoger")}
                </Label>
                <Input id={`ultimo-recoger-${branchId}-${index}`} type="time" value={turno.ultimoPedidoRecoger ?? ""} onChange={(e) => updateTurno(index, { ultimoPedidoRecoger: e.target.value || undefined })} className="w-[120px]" />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setTurnos((prev) => prev.filter((_, i) => i !== index))}>
                {t("restaurantes.reglas.quitarTurno")}
              </Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">{turno.dias.length > 0 && turno.abre && turno.cierra ? describirTurno(turno) : t("restaurantes.reglas.turnoIncompleto")}</p>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setTurnos((prev) => [...prev, { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }])}>
            {t("restaurantes.reglas.agregarTurno")}
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-dom-${branchId}`} className="text-xs text-muted-foreground">
            {t("restaurantes.reglas.minDomicilio")}
          </Label>
          <Input id={`min-dom-${branchId}`} inputMode="decimal" placeholder={t("restaurantes.reglas.sinMinimo")} value={minDomicilio} onChange={(e) => setMinDomicilio(e.target.value)} className="w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`min-rec-${branchId}`} className="text-xs text-muted-foreground">
            {t("restaurantes.reglas.minRecoger")}
          </Label>
          <Input id={`min-rec-${branchId}`} inputMode="decimal" placeholder={t("restaurantes.reglas.sinMinimo")} value={minRecoger} onChange={(e) => setMinRecoger(e.target.value)} className="w-[140px]" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`propina-${branchId}`} className="text-xs text-muted-foreground">
            {t("restaurantes.reglas.propina")}
          </Label>
          <Selector id={`propina-${branchId}`} size="sm" value={propina} onChange={(e) => setPropina(e.target.value as PropinaPolitica | "")} wrapperClassName="w-auto min-w-48">
            <option value="">{t("restaurantes.reglas.propina.noPreguntar")}</option>
            <option value="solo_tarjeta">{t("restaurantes.reglas.propina.soloTarjeta")}</option>
            <option value="siempre">{t("restaurantes.reglas.propina.siempre")}</option>
            <option value="nunca">{t("restaurantes.reglas.propina.nunca")}</option>
          </Selector>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.reglas.zonas")}</h3>
        <p className="m-0 text-xs text-muted-foreground">
          {t("restaurantes.reglas.zonasAyuda")}
        </p>
        {zonas.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.reglas.sinZonas")}</p>
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
          {t("restaurantes.reglas.guardarReglas")}
        </Button>
      </div>
      {falloDe("reglas")}

      <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid={`puentes-${branchId}`}>
        <h3 className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.reglas.puentes")}</h3>
        <p className="m-0 text-xs text-muted-foreground">
          {t("restaurantes.reglas.puentesAyuda")}
        </p>
        {puentes.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs text-foreground">
            <span>
              {p.fechaDesde} → {p.fechaHasta}: {p.horario.length === 0 ? t("restaurantes.reglas.cerradoTodoElDia") : p.horario.map((tu) => `${tu.abre}–${tu.cierra}`).filter((v, i, a) => a.indexOf(v) === i).join(t("restaurantes.reglas.horarioY"))}
              {p.motivo ? ` (${p.motivo})` : ""}
            </span>
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => void handleBorrarPuente(p)} disabled={saving}>
              {t("restaurantes.reglas.quitar")}
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-desde-${branchId}`} className="text-xs text-muted-foreground">
              {t("restaurantes.reglas.desde")}
            </Label>
            <Input id={`puente-desde-${branchId}`} type="date" value={puenteDesde} onChange={(e) => setPuenteDesde(e.target.value)} className="w-[150px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-hasta-${branchId}`} className="text-xs text-muted-foreground">
              {t("restaurantes.reglas.hasta")}
            </Label>
            <Input id={`puente-hasta-${branchId}`} type="date" value={puenteHasta} onChange={(e) => setPuenteHasta(e.target.value)} className="w-[150px]" />
          </div>
          <Checkbox label={t("restaurantes.reglas.cerradoTodoElDia")} wrapperClassName="text-xs" checked={puenteCerrado} onChange={() => setPuenteCerrado((v) => !v)} />
          {!puenteCerrado && puenteTurnos.map((tu, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Label htmlFor={`puente-turno-${i}-${branchId}`} className="text-xs text-muted-foreground">
                {t("restaurantes.reglas.turnoN", { n: i + 1 })}
              </Label>
              <div className="flex gap-1">
                <Input id={`puente-turno-${i}-${branchId}`} type="time" value={tu.abre} onChange={(e) => setPuenteTurnos((prev) => prev.map((x, j) => (j === i ? { ...x, abre: e.target.value } : x)))} className="w-[110px]" />
                <Input type="time" aria-label={t("restaurantes.reglas.cierreTurno", { n: i + 1 })} value={tu.cierra} onChange={(e) => setPuenteTurnos((prev) => prev.map((x, j) => (j === i ? { ...x, cierra: e.target.value } : x)))} className="w-[110px]" />
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`puente-motivo-${branchId}`} className="text-xs text-muted-foreground">
              {t("restaurantes.reglas.motivo")}
            </Label>
            <Input id={`puente-motivo-${branchId}`} value={puenteMotivo} onChange={(e) => setPuenteMotivo(e.target.value)} className="w-[180px]" />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void handleCrearPuente()} disabled={saving}>
            {t("restaurantes.reglas.guardarPuente")}
          </Button>
        </div>
        {falloDe("puente")}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid={`agente-whatsapp-${branchId}`}>
        <h3 className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.reglas.agente")}</h3>
        {errorAgente ? (
          <EstadoError titulo={t("restaurantes.reglas.agente.noLeido")} mensaje={errorAgente} compacto className="w-full" />
        ) : agente === null ? (
          <EstadoCargando etiqueta={t("restaurantes.reglas.agente.leyendo")} />
        ) : !agente.disponible ? (
          <p role="status" className="m-0 text-xs text-muted-foreground">
            {t("restaurantes.reglas.agente.noDisponible")}
          </p>
        ) : (
          <>
            <Checkbox
              label={t("restaurantes.reglas.agente.contesta")}
              wrapperClassName="text-xs"
              checked={agente.agenteActivo}
              disabled={saving}
              onChange={() => void handleCambiarAgente(!agente.agenteActivo)}
            />
            <p className="m-0 text-xs text-muted-foreground">
              {t(agente.agenteActivo ? "restaurantes.reglas.agente.siApaga" : "restaurantes.reglas.agente.apagadoAyuda")}
            </p>
          </>
        )}
        {falloDe("agente")}
      </section>

      <section className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`wa-${branchId}`} className="text-xs text-muted-foreground">
            {t("restaurantes.reglas.wa.campo")}
          </Label>
          <Input id={`wa-${branchId}`} inputMode="numeric" placeholder={t("restaurantes.reglas.wa.sinNumero")} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} className="w-[240px]" />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleGuardarWhatsapp()} disabled={saving}>
          {t("restaurantes.reglas.wa.guardar")}

        </Button>
        {falloDe("whatsapp")}
      </section>
      <ConectarWhatsappMeta
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        branchId={branchId}
        onConectado={(numero) => {
          setWhatsappGuardado(numero);
          setWhatsapp(numero);
        }}
      />
      {dialogo}
    </div>
  );
}
