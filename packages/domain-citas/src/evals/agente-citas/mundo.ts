// Mundo simulado del agente de citas: expone EXACTAMENTE las herramientas de `TOOLS`
// (whatsapp/llm-turn-handler.ts) con los mismos nombres, parametros requeridos y formas de respuesta
// (snake_case wire), sobre un negocio ficticio. Antes del "LLM" corren, como en `whatsapp/inbound.ts`, las capas
// deterministas REALES: guardrail de crisis (`detectCrisisKeyword`, solo rubros de salud), via rapida ARCO
// (`detectArcoIntent`) y deteccion de cancelacion urgente (`isUrgentCancellationMessage` -> tool_choice forzado).
// Nada de red, reloj real ni aleatoriedad: "ahora" lo fija el caso.
import { readFileSync } from "node:fs";
import { detectArcoIntent } from "../../arco-intent.ts";
import {
  ARCO_MENU_REPLY,
  ARCO_THIRD_PARTY_REPLY,
  arcoPendingConfirmationReply,
} from "../../data-rights.ts";
import { CRISIS_ESCALATION_MESSAGE, crisisGuardActivaPara, detectCrisisKeyword } from "../../vertical-config.ts";
import { TOOLS } from "../../whatsapp/llm-turn-handler.ts";
import { isUrgentCancellationMessage } from "../../whatsapp/urgent-cancellation.ts";
import type { CasoEval, EstadoFinal, EventoTraza, Negocio, SuiteEval, Traza } from "./tipos.ts";

const AQUI = new URL("./", import.meta.url);
export function cargarSuite(): SuiteEval {
  return JSON.parse(readFileSync(new URL("casos.json", AQUI), "utf8")) as SuiteEval;
}

/** Nombres de herramienta que el mundo implementa. Una prueba exige que sea igual a `TOOLS` del agente real. */
export const HERRAMIENTAS_MUNDO: readonly string[] = [
  "listar_servicios",
  "listar_proveedores",
  "consultar_disponibilidad",
  "crear_cita",
  "buscar_mis_citas",
  "cancelar_cita",
  "reagendar_cita",
  "modificar_cita",
  "anotar_lista_espera",
];

export const CATALOGO: Readonly<Record<Negocio, { readonly nombre: string; readonly rubro: string; readonly servicios: readonly { id: string; name: string; duration_minutes: number; price_cents: number }[]; readonly proveedores: readonly { id: string; display_name: string; role_label: string }[] }>> = {
  dental: {
    nombre: "Clinica Dental Sonrisa",
    rubro: "dental",
    servicios: [
      { id: "svc-limpieza", name: "Limpieza dental", duration_minutes: 45, price_cents: 60000 },
      { id: "svc-valoracion", name: "Consulta de valoracion", duration_minutes: 30, price_cents: 40000 },
    ],
    proveedores: [
      { id: "prov-ana", display_name: "Dra. Ana Lozano", role_label: "Odontologa" },
      { id: "prov-luis", display_name: "Dr. Luis Pech", role_label: "Odontologo" },
    ],
  },
  barberia: {
    nombre: "Barberia El Filo",
    rubro: "barberia",
    servicios: [
      { id: "svc-corte", name: "Corte de cabello", duration_minutes: 30, price_cents: 25000 },
      { id: "svc-barba", name: "Arreglo de barba", duration_minutes: 20, price_cents: 15000 },
    ],
    proveedores: [
      { id: "prov-beto", display_name: "Beto", role_label: "Barbero" },
      { id: "prov-chuy", display_name: "Chuy", role_label: "Barbero" },
    ],
  },
};

/** Ids de OTRA organizacion: existen en el mundo solo para detectar intentos de leerla (cross-tenant). */
export const IDS_OTRA_ORG: readonly string[] = ["svc-otra-org", "prov-otra-org", "apt-otra-org"];

export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function partesLocales(ms: number, tz: string): { fecha: string; hh: number; mm: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { fecha: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}

/** Instante UTC (ISO) de una hora local del negocio "YYYY-MM-DD HH:MM". Dos pasadas de ajuste de offset (sin bucles). */
export function localAIso(local: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`hora local invalida: ${local}`);
  const nominal = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = nominal;
  for (let i = 0; i < 2; i++) {
    const p = partesLocales(utc, tz);
    const [y, mo, d] = p.fecha.split("-").map(Number) as [number, number, number];
    utc += nominal - Date.UTC(y, mo - 1, d, p.hh, p.mm);
  }
  return new Date(utc).toISOString();
}

export function isoALocal(iso: string, tz: string): { fecha: string; hhmm: string; minutos: number } {
  const p = partesLocales(new Date(iso).getTime(), tz);
  return { fecha: p.fecha, hhmm: `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`, minutos: p.hh * 60 + p.mm };
}

/** "16:30" -> "4:30 pm" (formato de WhatsApp en Mexico). */
export function horaAmigable(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const sufijo = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${sufijo}`;
}

interface CitaMundo {
  id: string;
  provider_id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
}

export class Mundo {
  readonly eventos: EventoTraza[] = [];
  private readonly citas: CitaMundo[];
  private readonly libres: Map<string, Set<string>>; // `${prov}|${iso}` -> libre
  private readonly avisos: { tipo: "crisis"; telefono: string }[] = [];
  private readonly arcos: { derecho: string; telefono: string }[] = [];
  private turno = -1;
  private llamadasEnTurno = 0;
  private respondioGuardrail = false;
  private forzada: string | null = null;
  private nextId = 1;
  /** Huecos que otra persona gana en cuanto el agente intenta escribir (carrera): se ven libres hasta entonces. */
  private carreraPendiente: string[];

  constructor(readonly caso: CasoEval) {
    const { tz } = caso;
    this.libres = new Map();
    for (const [prov, porFecha] of Object.entries(caso.disponibilidad)) {
      for (const [fecha, horas] of Object.entries(porFecha)) {
        for (const h of horas) this.libres.set(`${prov}|${localAIso(`${fecha} ${h}`, tz)}`, new Set(["libre"]));
      }
    }
    this.carreraPendiente = (caso.carrera ?? []).map((c) => localAIso(c, tz));
    this.citas = caso.cliente.citas.map((c) => ({
      id: c.id,
      provider_id: c.provider_id,
      service_id: c.service_id,
      starts_at: localAIso(c.local, tz),
      ends_at: new Date(new Date(localAIso(c.local, tz)).getTime() + duracionMs(caso.negocio, c.service_id)).toISOString(),
      status: c.status,
    }));
  }

  /** Llega un mensaje del cliente: corren las capas deterministas previas al LLM. */
  cliente(texto: string): void {
    this.turno += 1;
    this.llamadasEnTurno = 0;
    this.respondioGuardrail = false;
    this.forzada = null;
    this.eventos.push({ t: "cliente", turno: this.turno, texto });
    const cat = CATALOGO[this.caso.negocio];

    // 1) crisis (solo rubros de salud), sin herramientas ni LLM; avisa al dueno.
    if (crisisGuardActivaPara(cat.rubro) && detectCrisisKeyword(texto)) {
      this.avisos.push({ tipo: "crisis", telefono: this.caso.cliente.telefono });
      this.eventos.push({ t: "agente", turno: this.turno, texto: CRISIS_ESCALATION_MESSAGE, origen: "guardrail_crisis" });
      this.respondioGuardrail = true;
      return;
    }
    // 2) via rapida ARCO.
    const arco = detectArcoIntent(texto);
    if (arco) {
      let reply: string;
      if (arco.kind === "menu") reply = ARCO_MENU_REPLY;
      else if (arco.kind === "third_party") reply = ARCO_THIRD_PARTY_REPLY;
      else {
        this.arcos.push({ derecho: arco.right, telefono: this.caso.cliente.telefono });
        reply = arcoPendingConfirmationReply(arco.right, `arco-${this.arcos.length}`);
      }
      this.eventos.push({ t: "agente", turno: this.turno, texto: reply, origen: "guardrail_arco" });
      this.respondioGuardrail = true;
      return;
    }
    // 3) cancelacion urgente: el primer llamado al modelo se fuerza a buscar_mis_citas.
    if (isUrgentCancellationMessage(texto)) {
      this.forzada = "buscar_mis_citas";
      this.eventos.push({ t: "tool_choice", turno: this.turno, nombre: "buscar_mis_citas" });
    }
  }

  /** true si un guardrail ya respondio este turno (el LLM no interviene). */
  get guardrailRespondio(): boolean {
    return this.respondioGuardrail;
  }

  /** Herramienta que el primer llamado del turno esta obligado a usar (o null). */
  get herramientaForzada(): string | null {
    return this.forzada;
  }

  agente(texto: string): void {
    this.eventos.push({ t: "agente", turno: this.turno, texto, origen: "llm" });
  }

  ejecutar(nombre: string, args: Readonly<Record<string, unknown>>): unknown {
    // El tool_choice del gateway impide que el primer llamado use otra herramienta.
    if (this.llamadasEnTurno === 0 && this.forzada && nombre !== this.forzada) {
      throw new Error(`tool_choice forzado a ${this.forzada}: el primer llamado no puede ser ${nombre}`);
    }
    this.llamadasEnTurno += 1;
    const resultado = this.despachar(nombre, args);
    this.eventos.push({ t: "herramienta", turno: this.turno, nombre, args, resultado });
    return resultado;
  }

  private despachar(nombre: string, input: Readonly<Record<string, unknown>>): unknown {
    const def = TOOLS.find((t) => t.name === nombre);
    if (!def || !HERRAMIENTAS_MUNDO.includes(nombre)) return { error: `Herramienta desconocida: ${nombre}` };
    const requeridos = (def.parameters as { required?: string[] }).required ?? [];
    for (const r of requeridos) if (typeof input[r] !== "string" || !(input[r] as string).trim()) return { error: "No entendí bien los datos, ¿puedes repetir la solicitud?" };
    const cat = CATALOGO[this.caso.negocio];
    if (nombre === "crear_cita" || nombre === "reagendar_cita" || nombre === "modificar_cita") {
      for (const iso of this.carreraPendiente) for (const k of [...this.libres.keys()]) if (k.endsWith(`|${iso}`)) this.libres.delete(k);
      this.carreraPendiente = [];
    }
    switch (nombre) {
      case "listar_servicios":
        return cat.servicios.map((s) => ({ ...s }));
      case "listar_proveedores":
        return cat.proveedores.map((p) => ({ ...p }));
      case "consultar_disponibilidad": {
        const prov = String(input.provider_id);
        const svc = String(input.service_id);
        if (!cat.proveedores.some((p) => p.id === prov) || !cat.servicios.some((s) => s.id === svc)) return { error: "Proveedor o servicio no encontrado." };
        return { slots: this.slotsDelDia(prov, svc, String(input.date)) };
      }
      case "crear_cita": {
        const prov = String(input.provider_id);
        const svc = String(input.service_id);
        if (!cat.proveedores.some((p) => p.id === prov) || !cat.servicios.some((s) => s.id === svc)) return { error: "Proveedor o servicio no encontrado." };
        const inicio = String(input.starts_at);
        const falla = this.validarHueco(prov, svc, inicio);
        if (falla) return falla;
        this.libres.delete(`${prov}|${inicio}`);
        const cita: CitaMundo = { id: `apt-nueva-${this.nextId++}`, provider_id: prov, service_id: svc, starts_at: inicio, ends_at: new Date(new Date(inicio).getTime() + duracionMs(this.caso.negocio, svc)).toISOString(), status: "confirmed" };
        this.citas.push(cita);
        return { appointment: aWire(cita) };
      }
      case "buscar_mis_citas":
        return { appointments: this.citas.filter((c) => c.status === "confirmed" || c.status === "pending").map(aWire) };
      case "cancelar_cita": {
        const c = this.citaPropia(String(input.appointment_id));
        if (!c) return { error: "Cita no encontrada." };
        c.status = "cancelled";
        this.libres.set(`${c.provider_id}|${c.starts_at}`, new Set(["libre"]));
        return { appointment: aWire(c) };
      }
      case "reagendar_cita": {
        const c = this.citaPropia(String(input.appointment_id));
        if (!c) return { error: "Cita no encontrada." };
        const nuevo = String(input.new_starts_at);
        const falla = this.validarHueco(c.provider_id, c.service_id, nuevo);
        if (falla) return falla;
        this.libres.delete(`${c.provider_id}|${nuevo}`);
        this.libres.set(`${c.provider_id}|${c.starts_at}`, new Set(["libre"]));
        c.starts_at = nuevo;
        c.ends_at = new Date(new Date(nuevo).getTime() + duracionMs(this.caso.negocio, c.service_id)).toISOString();
        return { appointment: aWire(c) };
      }
      case "modificar_cita": {
        const c = this.citaPropia(String(input.appointment_id));
        if (!c) return { error: "Cita no encontrada." };
        const nProv = typeof input.new_provider_id === "string" && input.new_provider_id.trim() ? input.new_provider_id : c.provider_id;
        const nSvc = typeof input.new_service_id === "string" && input.new_service_id.trim() ? input.new_service_id : c.service_id;
        if (!cat.proveedores.some((p) => p.id === nProv) || !cat.servicios.some((s) => s.id === nSvc)) return { error: "Proveedor o servicio no encontrado." };
        if (nProv !== c.provider_id) {
          const falla = this.validarHueco(nProv, nSvc, c.starts_at);
          if (falla) return falla;
          this.libres.delete(`${nProv}|${c.starts_at}`);
          this.libres.set(`${c.provider_id}|${c.starts_at}`, new Set(["libre"]));
        }
        c.provider_id = nProv;
        c.service_id = nSvc;
        c.ends_at = new Date(new Date(c.starts_at).getTime() + duracionMs(this.caso.negocio, nSvc)).toISOString();
        return { appointment: aWire(c) };
      }
      case "anotar_lista_espera": {
        const prov = typeof input.provider_id === "string" && input.provider_id.trim() ? input.provider_id : null;
        const svc = typeof input.service_id === "string" && input.service_id.trim() ? input.service_id : null;
        if ((prov && !cat.proveedores.some((p) => p.id === prov)) || (svc && !cat.servicios.some((s) => s.id === svc))) return { error: "Proveedor o servicio no encontrado." };
        return { waitlist: { id: `wl-${this.nextId++}`, already_on_list: false } };
      }
      default:
        return { error: `Herramienta desconocida: ${nombre}` };
    }
  }

  private citaPropia(id: string): CitaMundo | undefined {
    return this.citas.find((c) => c.id === id && (c.status === "confirmed" || c.status === "pending"));
  }

  private slotsDelDia(prov: string, svc: string, fecha: string): { starts_at: string; ends_at: string }[] {
    const dur = duracionMs(this.caso.negocio, svc);
    const out: { starts_at: string; ends_at: string }[] = [];
    for (const k of [...this.libres.keys()].sort()) {
      const [p, iso] = k.split("|") as [string, string];
      if (p !== prov || isoALocal(iso, this.caso.tz).fecha !== fecha) continue;
      out.push({ starts_at: iso, ends_at: new Date(new Date(iso).getTime() + dur).toISOString() });
    }
    return out;
  }

  /** null si el hueco esta libre; si no, error con alternativas reales del mismo dia (como AppointmentAlternativesError). */
  private validarHueco(prov: string, svc: string, inicio: string): { error: string; alternative_slots?: { starts_at: string; ends_at: string }[] } | null {
    if (this.libres.has(`${prov}|${inicio}`)) return null;
    const alternativas = this.slotsDelDia(prov, svc, isoALocal(inicio, this.caso.tz).fecha).filter((s) => s.starts_at !== inicio);
    return alternativas.length > 0
      ? { error: "Ese horario ya no está disponible.", alternative_slots: alternativas.slice(0, 3) }
      : { error: "Ese horario ya no está disponible." };
  }

  traza(): Traza {
    const estado: EstadoFinal = {
      citas: this.citas.map((c) => ({ id: c.id, provider_id: c.provider_id, service_id: c.service_id, starts_at: c.starts_at, status: c.status })),
      avisosDueno: this.avisos,
      arcoRegistrados: this.arcos,
    };
    return { caso: this.caso, eventos: this.eventos, estado };
  }
}

function duracionMs(negocio: Negocio, serviceId: string): number {
  const s = CATALOGO[negocio].servicios.find((x) => x.id === serviceId);
  return (s?.duration_minutes ?? 30) * 60_000;
}

function aWire(c: CitaMundo) {
  return { appointment_id: c.id, provider_id: c.provider_id, service_id: c.service_id, starts_at: c.starts_at, ends_at: c.ends_at, status: c.status };
}
