// Simulador de un mes de un hotel (H-33). Ver README.md. Se invoca con run.sh (Postgres efimero ya migrado en SIM_DATABASE_URL).
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { RelojSimulado, instanteLocalIso, sumarDias } from "./reloj.ts";
import { instalarGuardaRed } from "./guarda-red.ts";
import { LlmGuionado } from "./llm-guionado.ts";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (nombre: string, def: string) => args.find((a) => a.startsWith(`--${nombre}=`))?.split("=")[1] ?? def;
const DIAS = Number(opt("dias", "3"));
const SALIDA = opt("salida", "");
// Por omision el mes simulado EMPIEZA hoy (hora de la property). El now() de Postgres es el real y varias restricciones lo comparan con la fecha
// de negocio: las de "no puede estar en el pasado" (llegada y corte de un grupo, vigencia) exigen un mes que arranque hoy y no antes; las de
// "no puede estar en el futuro" (fecha de recepcion de un ARCO) se resuelven mandando la fecha real. Ver el limite declarado en reloj.ts.
const hoyReal = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cancun", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const INICIO = opt("inicio", hoyReal);
if (!process.env.SIM_DATABASE_URL) throw new Error("falta SIM_DATABASE_URL: corre scripts/simular-mes-hoteles/run.sh");
if (!Number.isInteger(DIAS) || DIAS < 1 || DIAS > 60) throw new Error("--dias debe ser un entero entre 1 y 60");

// ---- entorno de la app: secretos generados aqui, nada real ----
process.env.DATABASE_URL = process.env.SIM_DATABASE_URL;
process.env.JWT_SECRET = randomBytes(24).toString("hex");
process.env.VOICE_TOOL_SECRET = randomBytes(16).toString("hex");
process.env.WHATSAPP_VERIFY_TOKEN = randomBytes(8).toString("hex");
process.env.WHATSAPP_APP_SECRET = randomBytes(16).toString("hex");
process.env.INTERNAL_SECRET = randomBytes(16).toString("hex");
process.env.WHATSAPP_ACCESS_TOKEN = "sim-sin-valor-real"; // el despachador exige un token para correr; su cliente Graph es el doble local
process.env.RENTAS_OWNER_JWT_SECRET = randomBytes(16).toString("hex");
process.env.HOTELES_IDENTITY_KEY = randomBytes(32).toString("base64");
process.env.ACCESS_TOKEN_TTL_SECONDS = String(60 * 60 * 24 * 3);
process.env.OPENROUTER_API_KEY = "sk-or-simulacion-sin-valor-real"; // el proveedor real se construye, pero su fetch lo atiende el doble local
for (const k of ["OPENAI_API_KEY", "STRIPE_SECRET_KEY", "RESEND_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];

// El Postgres efimero no habla TLS (el pool de produccion lo exige para el pooler de Supabase): se quita SOLO aqui.
const PoolOriginal = pg.Pool;
(pg as unknown as { Pool: unknown }).Pool = class extends PoolOriginal {
  constructor(cfg?: pg.PoolConfig) {
    super({ ...(cfg ?? {}), ssl: undefined });
  }
};

const llm = new LlmGuionado();
const guarda = instalarGuardaRed([{ host: "openrouter.ai", responder: (_url, cuerpo) => llm.responder(cuerpo) }]);
const reloj = new RelojSimulado(instanteLocalIso(sumarDias(INICIO, -1), "08:00", "America/Cancun"));

const { buildApp } = await import("../../apps/api/src/app.ts");
const { buildProductionDeps } = await import("../../apps/api/src/production/deps.ts");
const mundoMod = await import("./mundo.ts");
const { Simulador, diferenciaConteos } = await import("./sim.ts");

const db = new pg.Client({ connectionString: process.env.SIM_DATABASE_URL });
await db.connect();
reloj.instalar();
let codigoSalida = 0;
try {
  const base = await mundoMod.sembrarBase(db);
  // Dobles locales SOLO en los bordes de red (pagos, PAC, WhatsApp saliente): el resto de las dependencias son las de produccion.
  const { InMemoryPaymentsPort } = await import("@atiende/domain-hoteles");
  const { DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter } = await import("@atiende/mcp-cfdi");
  const { WhatsAppOutboundDispatcher, FakeWhatsAppGraphClient } = await import("@atiende/whatsapp-gateway");
  const uso = { timbres: 0, cobrosTarjeta: 0 };
  const pagos = new InMemoryPaymentsPort();
  const pacFalso = new DualPacCfdiPort(new FakeFinkokAdapter(), new FakeSwSapienAdapter());
  const graphFalso = new FakeWhatsAppGraphClient();
  const deps = {
    ...buildProductionDeps(),
    hotelesPaymentsPort: { charge: async (i: Parameters<typeof pagos.charge>[0]) => (uso.cobrosTarjeta++, pagos.charge(i)) },
    hotelesCfdiPort: {
      status: () => pacFalso.status(),
      timbrar: (i: Parameters<typeof pacFalso.timbrar>[0]) => (uso.timbres++, pacFalso.timbrar(i)),
      cancelar: (i: Parameters<typeof pacFalso.cancelar>[0]) => pacFalso.cancelar(i),
      consultarEstado: (u: string) => pacFalso.consultarEstado(u),
      verifyAndNormalizeWebhook: (b: string, h: string | undefined) => pacFalso.verifyAndNormalizeWebhook(b, h),
    },
    whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: graphFalso }),
  };
  const app = buildApp(deps);
  const sim = new Simulador(app, db);
  // App de produccion SIN dobles (mismas dependencias reales y sin credenciales): solo para sondear que los bordes sin credencial responden 503 honesto.
  const appSinCredenciales = buildApp(buildProductionDeps());
  const propertyId = base.propertyId;
  const P = `/hoteles/${propertyId}`;

  // ---- catalogo por la API real (owner) ----
  const tipos: Record<string, { id: string; habitaciones: { id: string; codigo: string }[] }> = {};
  for (const t of mundoMod.TIPOS) {
    const r = await sim.api("owner", "POST", `${P}/tipos-habitacion`, { nombre: t.nombre, capacidadMaxima: t.capacidad }, { tipo: "catalogo.tipo_habitacion", detalle: { tipo: t.clave } });
    tipos[t.clave] = { id: r.json.id, habitaciones: [] };
    for (let i = 0; i < t.cuartos; i++) {
      const codigo = String(t.primerCodigo + i);
      const h = await sim.api("owner", "POST", `${P}/tipos-habitacion/${r.json.id}/habitaciones`, { codigo }, { tipo: "catalogo.habitacion", detalle: { codigo } });
      tipos[t.clave]!.habitaciones.push({ id: h.json.id, codigo });
    }
    await mundoMod.sembrarInventario(db, base.organizationId, propertyId, r.json.id, t.cuartos, sumarDias(INICIO, -1), sumarDias(INICIO, DIAS + 60));
    // tarifas por la API: entre semana (dom-jue) y fin de semana (vie-sab), una llamada por tramo contiguo
    for (let d = sumarDias(INICIO, -1); d <= sumarDias(INICIO, DIAS + 60); d = sumarDias(d, 1)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      const finde = dow === 5 || dow === 6;
      await sim.api("owner", "POST", `${P}/tarifas`, { roomTypeId: r.json.id, fechaInicio: d, fechaFin: d, precio: finde ? t.precioFinDeSemana : t.precioSemana }, { tipo: "catalogo.tarifa", silencioso: true });
    }
  }
  sim.evento("catalogo.listo", "staff", true, 200, { habitaciones: Object.values(tipos).reduce((s, t) => s + t.habitaciones.length, 0), tipos: mundoMod.TIPOS.length });
  const mundo = { ...base, tipos: tipos as unknown as import("./mundo.ts").Mundo["tipos"] };

  const esc = await import("./escenarios.ts");
  const asertsMod = await import("./asserts.ts");
  const costos = await import("./costos.ts");
  const ledgerMod = await import("./ledger.ts");
  const ctx: import("./escenarios.ts").Contexto = { sim, reloj, mundo, hoyReal, rng: esc.prng(20261001), appSinCredenciales, reservas: new Map(), cerradas: new Set(), secretoInterno: process.env.INTERNAL_SECRET!, secretoWhatsApp: process.env.WHATSAPP_APP_SECRET!, phoneNumberId: mundoMod.PHONE_NUMBER_ID, ultimoBarridoSlaMs: null, dia: 0, fecha: sumarDias(INICIO, -1) };

  await (await import("./escenarios-agente.ts")).configurarAgente(ctx);
  await esc.precarga(ctx, 36);
  const preparacion = sim.cerrarDia();
  console.log(`preparacion: ${preparacion.eventos.length} eventos, ${preparacion.http.total} llamadas HTTP, 5xx=${preparacion.http.cincoXX}`);

  const dias: import("./ledger.ts").DiaLedger[] = [];
  let ultimaCerrada: string | null = null;
  const totalLlm = { llamadas: 0, tokensEntrada: 0, tokensSalida: 0, costoUsd: 0 };
  let correosPrevios = Number((await db.query<{ n: string }>(`select count(*)::text as n from hoteles.messaging_outbox where channel = 'email'`)).rows[0]!.n);
  let waPrevio = 0;
  let timbresPrevios = 0;
  for (let n = 1; n <= DIAS; n++) {
    ctx.dia = n;
    ctx.fecha = sumarDias(INICIO, n - 1);
    ctx.reloj.irA(instanteLocalIso(ctx.fecha, "00:30", mundoMod.ZONA));
    const antes = await sim.conteosTablas();
    await (await import("./dia.ts")).simularDia(ctx);
    const despues = await sim.conteosTablas();
    const { eventos, http } = sim.cerrarDia();
    const filasCreadas = diferenciaConteos(antes, despues);
    const correosTotal = Number((await db.query<{ n: string }>(`select count(*)::text as n from hoteles.messaging_outbox where channel = 'email'`)).rows[0]!.n);
    const correos = correosTotal - correosPrevios;
    correosPrevios = correosTotal;
    const { uso: usoLlm, herramientas } = llm.cerrarDia();
    totalLlm.llamadas += usoLlm.llamadas;
    totalLlm.tokensEntrada += usoLlm.tokensEntrada;
    totalLlm.tokensSalida += usoLlm.tokensSalida;
    const waDia = graphFalso.sent.length - waPrevio;
    waPrevio = graphFalso.sent.length;
    const timbresDia = uso.timbres - timbresPrevios;
    timbresPrevios = uso.timbres;
    const lineas = costos.lineasDeCosto({ llm: usoLlm, waSalientes: waDia, timbres: timbresDia, correos });
    if (usoLlm.llamadas > 0) eventos.push({ tipo: "llm.resumen_del_dia", actor: "agente", ok: true, status: null, detalle: { llamadas: usoLlm.llamadas, herramientas: JSON.stringify(herramientas) } });
    ultimaCerrada = [...ctx.cerradas].sort().at(-1) ?? null;
    const asserts = [
      { id: "cero-5xx", descripcion: "Ninguna respuesta 5xx del dia en la app con dobles (el sondeo sin credenciales no cuenta; su 503 esperado se lista aparte)", ok: http.cincoXX === 0, detalle: `${http.cincoXX} de ${http.total}` },
      ...(await asertsMod.assertsDeDatos(db, propertyId, ultimaCerrada, ctx.ultimoBarridoSlaMs === null ? null : new Date(ctx.ultimoBarridoSlaMs))),
    ];
    totalLlm.costoUsd += lineas.find((l) => l.concepto === "llm")?.costoUsd ?? 0;
    dias.push({ dia: n, fecha: ctx.fecha, eventos, filasCreadas, costos: lineas, costoTotalUsd: costos.totalDeLineas(lineas), http, asserts });
    const fallidos = asserts.filter((a) => !a.ok);
    console.log(`dia ${n} ${ctx.fecha}: ${eventos.length} eventos, ${http.total} HTTP (5xx=${http.cincoXX}), asserts ${asserts.length - fallidos.length}/${asserts.length}`);
    for (const f of fallidos) console.log(`  FALLA ${f.id}: ${f.detalle}`);
  }

  // ---- asserts globales ----
  // El gateway REAL registro cada llamada en core.llm_usage_daily: el uso medido en la base debe coincidir con lo que el doble le reporto.
  const { rows: usoBd } = await db.query<{ llamadas: string; tin: string; tout: string; micro: string }>(`select coalesce(sum(call_count),0)::text as llamadas, coalesce(sum(tokens_in),0)::text as tin, coalesce(sum(tokens_out),0)::text as tout, coalesce(sum(cost_micro_usd),0)::text as micro from core.llm_usage_daily where organization_id = $1`, [base.organizationId]);
  const bd = usoBd[0]!;
  const dentroDeRedondeo = Math.abs(Number(bd.micro) / 1e6 - totalLlm.costoUsd) <= Math.max(0.0001, totalLlm.llamadas * 2e-6);
  const llmCuadra = Number(bd.llamadas) === totalLlm.llamadas && Number(bd.tin) === totalLlm.tokensEntrada && Number(bd.tout) === totalLlm.tokensSalida && dentroDeRedondeo;
  const finales = [
    { id: "llm-uso-registrado-coincide", descripcion: "El uso LLM que registro el gateway real en core.llm_usage_daily (llamadas, tokens y costo) coincide con lo reportado por el proveedor doble", ok: llmCuadra, detalle: `base: ${bd.llamadas} llamadas, ${bd.tin}/${bd.tout} tokens, ${Number(bd.micro) / 1e6} USD; simulador: ${totalLlm.llamadas} llamadas, ${totalLlm.tokensEntrada}/${totalLlm.tokensSalida} tokens, ${totalLlm.costoUsd} USD` },
    { id: "cero-llamadas-externas", descripcion: "Ninguna llamada saliente real (Meta, PAC, Stripe, OpenRouter, Resend)", ok: guarda.bloqueadas.length === 0, detalle: guarda.bloqueadas.length === 0 ? "0 intentos" : JSON.stringify(guarda.bloqueadas.slice(0, 5)) },
    { id: "sin-rechazos-inesperados", descripcion: "Todo rechazo 4xx de la API era el esperado por el escenario", ok: sim.inesperados.length === 0, detalle: sim.inesperados.length === 0 ? "0 rechazos inesperados" : JSON.stringify(sim.inesperados.slice(0, 5)) },
  ];
  for (const f of finales.filter((x) => !x.ok)) console.log(`  FALLA ${f.id}: ${f.detalle}`);
  const ult = dias.at(-1)!;
  dias[dias.length - 1] = { ...ult, asserts: [...ult.asserts, ...finales] };

  const tarifas = costos.tarifasCitadas();
  const sinVerificar: Record<string, number> = {};
  for (const d of dias) for (const l of d.costos) if (l.estado === "sin_verificar") sinVerificar[l.concepto] = (sinVerificar[l.concepto] ?? 0) + l.unidades;
  const todosAsserts = dias.flatMap((d) => d.asserts);
  const ledger: import("./ledger.ts").Ledger = {
    version: ledgerMod.LEDGER_VERSION,
    corrida: SALIDA ? SALIDA.split("/").at(-1)! : `${INICIO}-simulacion-hoteles-corto`,
    modo: DIAS >= 28 ? "mes" : "corto",
    zonaHoraria: mundoMod.ZONA,
    propiedad: { habitaciones: Object.values(tipos).reduce((s, t) => s + t.habitaciones.length, 0), tipos: mundoMod.TIPOS.length },
    tarifas,
    dias,
    hallazgos: sim.hallazgos,
    resumen: {
      dias: dias.length,
      eventos: dias.reduce((s, d) => s + d.eventos.length, 0),
      costoTotalUsd: Math.round(dias.reduce((s, d) => s + d.costoTotalUsd, 0) * 1e8) / 1e8,
      costoSinVerificarUnidades: sinVerificar,
      asserts: { total: todosAsserts.length, fallidos: todosAsserts.filter((a) => !a.ok).length },
    },
  };
  const errores = ledgerMod.validarLedger(ledger);
  if (errores.length > 0) throw new Error(`ledger invalido: ${errores.slice(0, 5).join("; ")}`);
  if (SALIDA) {
    const dir = resolve(SALIDA);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`ledger escrito en ${dir}/ledger.json`);
  }
  const porTipo: Record<string, { ok: number; mal: number }> = {};
  for (const d of dias) for (const e of d.eventos) ((porTipo[e.tipo] ??= { ok: 0, mal: 0 })[e.ok ? "ok" : "mal"] += 1);
  console.log("EVENTOS POR TIPO:", Object.entries(porTipo).map(([t, v]) => `${t}=${v.ok}${v.mal ? `(+${v.mal} mal)` : ""}`).join(" "));
  console.log("FILAS CREADAS (total):", JSON.stringify(dias.reduce<Record<string, number>>((a, d) => { for (const [k, v] of Object.entries(d.filasCreadas)) a[k] = (a[k] ?? 0) + v; return a; }, {})));
  console.log(`RESUMEN: ${ledger.resumen.dias} dias, ${ledger.resumen.eventos} eventos, asserts ${ledger.resumen.asserts.total - ledger.resumen.asserts.fallidos}/${ledger.resumen.asserts.total}`);
  if (ledger.resumen.asserts.fallidos > 0) codigoSalida = 1;
} catch (err) {
  console.error("SIMULACION ABORTADA:", err);
  codigoSalida = 2;
} finally {
  reloj.desinstalar();
  guarda.desinstalar();
  await db.end().catch(() => undefined);
}
process.exit(codigoSalida);
