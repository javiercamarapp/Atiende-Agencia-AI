// Maquina de estados de la CITA por voz (defensa en profundidad: el servidor y la base vuelven a aplicar todo). Impide, por llamada, las acciones
// sin el paso previo que las justifica:
//   * ningun id de servicio o proveedor sale de la imaginacion del modelo: solo los que devolvieron `listar_servicios` / `listar_proveedores`;
//   * `crear_cita` solo con un horario EXACTO que devolvio `consultar_disponibilidad` para ese proveedor y servicio, una sola cita por llamada
//     (otra cita pasa a una persona con `derivar_a_humano`);
//   * `cancelar_cita`, `reagendar_cita` y `modificar_cita` solo de una cita que se vio con `buscar_mis_citas` (o se creo en esta llamada);
//     `reagendar_cita` ademas solo a un horario que `consultar_disponibilidad` ofrecio para el proveedor y servicio de ESA cita;
//   * toda accion que escribe exige `confirmado_por_cliente: true` (el cliente dijo que si en voz alta): sin eso se rechaza ANTES de tocar el servidor.
// Estados: sin_horario -> horario_ofrecido -> cita_creada. La maquina no sabe si el cliente de verdad dijo que si: eso lo declara el modelo en
// `confirmado_por_cliente` y lo vigilan los graders del simulador; lo que SI impide es que el modelo actue sin el paso previo.
export type EstadoCitaVoz = "sin_horario" | "horario_ofrecido" | "cita_creada";

export interface RechazoMaquinaCita {
  readonly error: string;
  readonly mensaje: string;
}

type Args = Readonly<Record<string, unknown>>;

/** Tools que escriben (y por tanto exigen confirmacion del cliente). */
export const TOOLS_ESCRITURA_CITAS: readonly string[] = ["crear_cita", "cancelar_cita", "reagendar_cita", "modificar_cita"];

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const texto = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export class MaquinaCitaVoz {
  private readonly servicios = new Set<string>();
  private readonly proveedores = new Set<string>();
  /** `${proveedor}|${servicio}|${starts_at}` de cada horario que ofrecio `consultar_disponibilidad`. */
  private readonly horarios = new Set<string>();
  private readonly citasVistas = new Map<string, { providerId: string; serviceId: string }>();
  private citaCreadaId: string | null = null;

  get estado(): EstadoCitaVoz {
    return this.citaCreadaId ? "cita_creada" : this.horarios.size > 0 ? "horario_ofrecido" : "sin_horario";
  }

  /** Rechazo si la herramienta no procede todavia; null si puede correr. */
  guardia(nombre: string, args: Args): RechazoMaquinaCita | null {
    if (TOOLS_ESCRITURA_CITAS.includes(nombre) && args.confirmado_por_cliente !== true) {
      return { error: "falta_confirmacion", mensaje: "Antes de esta acción diga al cliente exactamente qué va a hacer y espere a que responda que sí; entonces repita la herramienta con confirmado_por_cliente en true." };
    }
    switch (nombre) {
      case "consultar_disponibilidad":
        return this.idsResueltos(args.provider_id, args.service_id);
      case "crear_cita": {
        if (this.citaCreadaId) {
          return { error: "una_cita_por_llamada", mensaje: "Ya hay una cita creada en esta llamada. Para otra cita use derivar_a_humano." };
        }
        const ids = this.idsResueltos(args.provider_id, args.service_id);
        if (ids) return ids;
        if (!this.horarios.has(`${String(args.provider_id)}|${String(args.service_id)}|${String(args.starts_at)}`)) {
          return { error: "horario_no_ofrecido", mensaje: "Ese horario no salió de consultar_disponibilidad para ese proveedor y servicio. Consulte la disponibilidad y use un starts_at EXACTO de la respuesta." };
        }
        return null;
      }
      case "cancelar_cita":
        return this.citaVista(args.appointment_id);
      case "reagendar_cita": {
        const cita = this.citaVista(args.appointment_id);
        if (cita) return cita;
        const vista = this.citasVistas.get(String(args.appointment_id))!;
        if (!this.horarios.has(`${vista.providerId}|${vista.serviceId}|${String(args.new_starts_at)}`)) {
          return { error: "horario_no_ofrecido", mensaje: "El horario nuevo no salió de consultar_disponibilidad para el proveedor y servicio de esa cita. Consulte la disponibilidad y use un starts_at EXACTO." };
        }
        return null;
      }
      case "modificar_cita": {
        const cita = this.citaVista(args.appointment_id);
        if (cita) return cita;
        if (args.new_provider_id !== undefined && !this.proveedores.has(String(args.new_provider_id))) return this.idsNoResueltos();
        if (args.new_service_id !== undefined && !this.servicios.has(String(args.new_service_id))) return this.idsNoResueltos();
        return null;
      }
      default:
        return null;
    }
  }

  /** La herramienta corrio (`ok` = el servidor no devolvio un error): avanza el estado. */
  alResultado(nombre: string, args: Args, resultado: unknown, ok: boolean): void {
    if (!ok) return;
    const r = obj(resultado);
    switch (nombre) {
      case "listar_servicios":
        for (const s of lista(r.servicios)) {
          const id = texto(s.id);
          if (id) this.servicios.add(id);
        }
        return;
      case "listar_proveedores":
        for (const p of lista(r.proveedores)) {
          const id = texto(p.id);
          if (id) this.proveedores.add(id);
        }
        return;
      case "consultar_disponibilidad":
        for (const s of lista(r.slots)) {
          const inicio = texto(s.starts_at);
          if (inicio) this.horarios.add(`${String(args.provider_id)}|${String(args.service_id)}|${inicio}`);
        }
        return;
      case "buscar_mis_citas":
        for (const a of lista(r.appointments)) {
          const id = texto(a.appointment_id);
          const providerId = texto(a.provider_id);
          const serviceId = texto(a.service_id);
          if (id && providerId && serviceId) this.citasVistas.set(id, { providerId, serviceId });
        }
        return;
      case "crear_cita": {
        const a = obj(r.appointment);
        const id = texto(a.appointment_id);
        if (!id) return;
        this.citaCreadaId = id;
        this.horarios.delete(`${String(args.provider_id)}|${String(args.service_id)}|${String(args.starts_at)}`);
        const providerId = texto(a.provider_id);
        const serviceId = texto(a.service_id);
        if (providerId && serviceId) this.citasVistas.set(id, { providerId, serviceId });
        return;
      }
      case "cancelar_cita": {
        const id = texto(obj(r.appointment).appointment_id) ?? texto(args.appointment_id);
        if (!id) return;
        this.citasVistas.delete(id);
        if (this.citaCreadaId === id) this.citaCreadaId = null;
        return;
      }
      case "modificar_cita": {
        const a = obj(r.appointment);
        const id = texto(a.appointment_id);
        const providerId = texto(a.provider_id);
        const serviceId = texto(a.service_id);
        if (id && providerId && serviceId) this.citasVistas.set(id, { providerId, serviceId });
        return;
      }
      default:
        return;
    }
  }

  private idsNoResueltos(): RechazoMaquinaCita {
    return { error: "ids_no_resueltos", mensaje: "Resuelva el servicio y el proveedor con listar_servicios y listar_proveedores; nunca invente un id." };
  }

  private idsResueltos(proveedor: unknown, servicio: unknown): RechazoMaquinaCita | null {
    return typeof proveedor === "string" && this.proveedores.has(proveedor) && typeof servicio === "string" && this.servicios.has(servicio) ? null : this.idsNoResueltos();
  }

  private citaVista(id: unknown): RechazoMaquinaCita | null {
    return typeof id === "string" && this.citasVistas.has(id)
      ? null
      : { error: "falta_buscar_citas", mensaje: "Busque primero las citas del cliente con buscar_mis_citas y use el appointment_id que devolvió; confirme con el cliente cuál cita es." };
  }
}
