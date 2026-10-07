// Escenario C (Rn-P3-14): reconciliacion completa con drift sembrado (por defecto 10 %) y el invariante H-018. Siembra U unidades x R
// reservas de canal (por crearReservaConfirmada), hace que el feed "deje de listar" un 10 % sin CANCEL, y mide:
//   1. reconciliarCompleto (funcion pura) sobre el volumen: debe detectar EXACTAMENTE el drift sembrado, sin falsos positivos ni negativos;
//   2. cancelarOcupacion end-to-end contra Postgres real para cada candidato;
//   3. H-018: cancelar una reserva "a la deriva" NUNCA reabre una noche que otra causa sigue cubriendo (a 1 de cada 3 candidatas se le
//      siembra un bloqueo de propietario solapado exacto).
import { cancelarOcupacion, crearBloqueo, crearReservaConfirmada, reconciliarCompleto, type UidActivoInterno } from "@atiende/domain-rentas";
import { invariante, resumenLatencias, type ResultadoEscenario } from "./comun.ts";
import { crearTenant, crearUnidades, enTransaccion, nuevaConexion } from "./entorno.ts";

interface Semilla {
  unidadId: string;
  ocupacionId: string;
  uid: string;
  rango: { inicio: string; fin: string };
  bloqueoId: string | null;
}

export async function escenarioC(unidades: number, reservasPorUnidad: number, pctDrift: number): Promise<ResultadoEscenario> {
  const cx = await nuevaConexion();
  const semillas: Semilla[] = [];
  let tenant: Awaited<ReturnType<typeof crearTenant>>;
  const canalId = (await cx.db.query<{ id: string }>(`select id from rentas.canal where codigo = 'airbnb'`)).rows[0]!.id;
  let duracionSemillaMs = 0;
  try {
    tenant = await crearTenant(cx.db, "c");
    const unidadIds = await crearUnidades(cx.db, tenant, unidades, "Unidad carga C");
    const t0 = Date.now();
    await cx.cliente.query("BEGIN"); // el dominio usa SAVEPOINT: exige un bloque transaccional
    for (const [u, unidadId] of unidadIds.entries()) {
      for (let r = 0; r < reservasPorUnidad; r++) {
        const inicio = new Date(Date.UTC(2031, 3, 1) + r * 10 * 86_400_000);
        const fin = new Date(inicio.getTime() + 3 * 86_400_000);
        const rango = { inicio: inicio.toISOString().slice(0, 10), fin: fin.toISOString().slice(0, 10) };
        const uid = `reconc-${u}-${r}@canal-externo.com`;
        const creado = await crearReservaConfirmada(cx.db, { organizationId: tenant.organizationId, propertyId: tenant.propertyId, unidadId, rango, estado: "confirmado", bloqueante: true, canalOrigenId: canalId, externalId: uid });
        semillas.push({ unidadId, ocupacionId: creado.ocupacionId, uid, rango, bloqueoId: null });
      }
    }
    duracionSemillaMs = Date.now() - t0;

    const totalActivos = semillas.length;
    const numDrift = Math.max(1, Math.round(totalActivos * pctDrift));
    const paso = Math.max(1, Math.floor(totalActivos / numDrift));
    const indicesDrift = new Set<number>();
    for (let i = 0; indicesDrift.size < numDrift && i < totalActivos; i += paso) indicesDrift.add(i);

    let k = 0;
    for (const i of indicesDrift) {
      if (k % 3 === 0) {
        const s = semillas[i]!;
        const b = await crearBloqueo(cx.db, { organizationId: tenant.organizationId, propertyId: tenant.propertyId, unidadId: s.unidadId, rango: s.rango, razon: "BLOQUEO_PROPIETARIO" });
        s.bloqueoId = b.ocupacionId;
      }
      k++;
    }

    await cx.cliente.query("COMMIT");

    const activos: UidActivoInterno[] = semillas.map((s) => ({ ocupacionId: s.ocupacionId, uidCanal: s.uid }));
    const presentes = new Set(semillas.filter((_, i) => !indicesDrift.has(i)).map((s) => s.uid));
    const tRec = performance.now();
    const rec = reconciliarCompleto(activos, presentes);
    const duracionRecMs = performance.now() - tRec;
    const esperados = new Set([...indicesDrift].map((i) => semillas[i]!.uid));
    const detectados = new Set(rec.candidatosACancelarPorAusencia.map((c) => c.uidCanal));
    const exacto = detectados.size === esperados.size && [...esperados].every((u) => detectados.has(u));

    const latCancel: number[] = [];
    let erroresCancel = 0;
    const tCancel = Date.now();
    for (const cand of rec.candidatosACancelarPorAusencia) {
      const inicio = performance.now();
      try {
        await enTransaccion((db) => cancelarOcupacion(db, cand.ocupacionId));
      } catch {
        erroresCancel++;
      }
      latCancel.push(performance.now() - inicio);
    }
    const duracionCancelMs = Date.now() - tCancel;

    // H-018: con bloqueo solapado, las noches siguen ocupadas (el bloqueo sigue confirmado); sin bloqueo, ninguna ocupacion activa las cubre.
    let reabiertasIndebidas = 0;
    let liberadasBien = 0;
    for (const cand of rec.candidatosACancelarPorAusencia) {
      const s = semillas.find((x) => x.ocupacionId === cand.ocupacionId)!;
      const activas = await cx.db.query<{ n: string }>(
        `select count(*)::text as n from rentas.ocupacion where unidad_id = $1 and estado <> 'cancelado' and bloqueante and rango && daterange($2::date, $3::date, '[)')`,
        [s.unidadId, s.rango.inicio, s.rango.fin],
      );
      const cubiertas = Number(activas.rows[0]!.n) > 0;
      if (s.bloqueoId !== null) {
        if (!cubiertas) reabiertasIndebidas++;
      } else if (!cubiertas) liberadasBien++;
    }
    const sinBloqueo = rec.candidatosACancelarPorAusencia.filter((c) => semillas.find((x) => x.ocupacionId === c.ocupacionId)!.bloqueoId === null).length;

    return {
      escenario: "C-reconciliacion-con-drift",
      parametros: { unidades, reservasPorUnidad, pctDrift, reservasSembradas: totalActivos, driftSembrado: numDrift },
      duracionTotalMs: duracionSemillaMs + Math.round(duracionRecMs) + duracionCancelMs,
      latencias: { cancelarPorCandidato: resumenLatencias(latCancel) },
      invariantes: [
        invariante("la reconciliacion detecta exactamente el drift sembrado (sin falsos positivos ni negativos)", exacto && rec.drift === numDrift, `detectado ${rec.drift}, sembrado ${numDrift}`),
        invariante("cancelar los candidatos no produce errores", erroresCancel === 0, `${erroresCancel} errores`),
        invariante("H-018: cancelar una reserva a la deriva nunca reabre una noche cubierta por un bloqueo", reabiertasIndebidas === 0, `${reabiertasIndebidas} noches reabiertas indebidamente`),
        invariante("las noches sin otra causa si quedan libres", liberadasBien === sinBloqueo, `${liberadasBien}/${sinBloqueo}`),
      ],
      datos: { reconciliarCompletoMs: Math.round(duracionRecMs * 100) / 100, semillaMs: duracionSemillaMs },
    };
  } finally {
    await cx.cliente.end();
  }
}
