// Repositorio del login del REPARTIDOR por celular + codigo de WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md,
// migracion packages/db/migrations/0059_login_chofer_whatsapp.sql). La autoridad real vive en las funciones `security definer`
// de la base; esto solo las invoca. Contra la base SIN migrar (42883/42P01/42703) lanza `LoginChoferNoDisponibleError`, que la API traduce a
// "no disponible aun" (nunca a un 500) -- cada llamada va en un SAVEPOINT para que la transaccion compartida del request siga utilizable.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import type { MembershipRow, StaffUserRow } from "./core-repository.ts";

export class LoginChoferNoDisponibleError extends Error {
  constructor() {
    super("El acceso de repartidores por celular todavia no esta disponible en esta base (migracion 0059 pendiente).");
    this.name = "LoginChoferNoDisponibleError";
  }
}

/** Rechazo de negocio al registrar el telefono (SQLSTATE P0001): sin autoridad, objetivo no elegible o telefono no disponible. */
export class LoginChoferTelefonoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginChoferTelefonoError";
  }
}

export type LoginChoferEventoTipo =
  | "solicitud"
  | "solicitud_limitada"
  | "solicitud_bloqueada"
  | "cuenta_no_elegible"
  | "plantilla_no_disponible"
  | "codigo_encolado"
  | "verificacion_ok"
  | "verificacion_fallo"
  | "codigo_agotado"
  | "verificacion_limitada";

export type ResultadoLimite = "ok" | "limitado" | "bloqueado";

export interface LoginChoferCuenta {
  readonly userId: string;
  readonly organizationId: string;
  readonly fullName: string;
  readonly propertyIds: readonly string[] | null;
}

export interface LoginChoferCodigoReservado {
  readonly codigoId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly codeHash: string;
  readonly codeSalt: string;
  readonly intentos: number;
}

export interface LoginChoferLimites {
  readonly telefonoHash: string;
  readonly ipHash: string | null;
  readonly maxTelefono: number;
  readonly maxIp: number;
  readonly ventanaSegundos: number;
  readonly bloqueoSegundos: number;
}

export interface LoginChoferTelefonoListado {
  readonly userId: string;
  readonly telefonoEnmascarado: string;
}

export interface LoginChoferRepository {
  // ---- Solo sistema (`withAppSession({ userId: null })`) ----
  /** Hay al menos una organizacion con la plantilla `codigo_acceso` aprobada. No depende de ninguna cuenta. */
  plantillaDisponible(): Promise<boolean>;
  /** 'ok' (registra la solicitud), 'limitado' (telefono o IP superaron el limite) o 'bloqueado' (bloqueo temporal por abuso: no revelar). */
  puedeSolicitar(limites: LoginChoferLimites): Promise<ResultadoLimite>;
  registrarEvento(evento: { readonly tipo: LoginChoferEventoTipo; readonly telefonoHash: string; readonly ipHash: string | null; readonly userId?: string | null; readonly organizationId?: string | null }): Promise<void>;
  /** La cuenta de repartidor ELEGIBLE dueña de ese telefono E.164, o null. */
  resolver(telefonoE164: string): Promise<LoginChoferCuenta | null>;
  plantilla(organizationId: string): Promise<{ readonly nombre: string; readonly idioma: string } | null>;
  /** Emite un codigo (hash+sal) invalidando el pendiente anterior. Devuelve el id, o null si la cuenta ya no es elegible. */
  emitir(input: { readonly userId: string; readonly organizationId: string; readonly codeHash: string; readonly codeSalt: string; readonly expiresAt: string }): Promise<string | null>;
  /** Reserva UN intento (el contador sube antes de comparar). null si no hay codigo vigente con intentos disponibles. */
  reservarIntento(telefonoE164: string): Promise<LoginChoferCodigoReservado | null>;
  /** Tras una comparacion fallida: con el quinto intento gastado invalida el codigo. Devuelve true si lo invalido. */
  registrarFallo(codigoId: string): Promise<boolean>;
  /** Consumo atomico de un solo uso con la elegibilidad reevaluada. null si ya no se puede. */
  consumir(codigoId: string): Promise<StaffUserRow | null>;

  // ---- Gestion del telefono (sesion del caller autenticado) ----
  guardarTelefono(organizationId: string, targetUserId: string, telefonoE164: string): Promise<void>;
  quitarTelefono(organizationId: string, targetUserId: string): Promise<boolean>;
  listarTelefonos(organizationId: string): Promise<readonly LoginChoferTelefonoListado[]>;
}

interface StaffRawRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  created_via: StaffUserRow["createdVia"];
  email_verified_at: string | null;
  sessions_revoked_at: string | null;
}

export class PostgresLoginChoferRepository implements LoginChoferRepository {
  private readonly db: TenantDbSession;
  constructor(db: TenantDbSession) {
    this.db = db;
  }

  /** Corre `primary` en SAVEPOINT; una base sin migrar (42883/42P01/42703) o un `P0001` de negocio se traducen sin dejar abortada la transaccion. */
  private run<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: (err) => isMigrationPendingError(err) || codigo(err) === "P0001",
      fallback: async (err) => {
        if (isMigrationPendingError(err)) throw new LoginChoferNoDisponibleError();
        throw new LoginChoferTelefonoError(mensaje(err));
      },
    });
  }

  async plantillaDisponible(): Promise<boolean> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select core.chofer_login_plantilla_disponible() as ok;`);
      return rows[0]?.ok === true;
    });
  }

  async puedeSolicitar(l: LoginChoferLimites): Promise<ResultadoLimite> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ ok: ResultadoLimite }>(`select core.chofer_login_puede_solicitar($1, $2, $3, $4, $5, $6) as ok;`, [
        l.telefonoHash,
        l.ipHash,
        l.maxTelefono,
        l.maxIp,
        l.ventanaSegundos,
        l.bloqueoSegundos,
      ]);
      const r = rows[0]?.ok;
      return r === "ok" || r === "bloqueado" ? r : "limitado";
    });
  }

  async registrarEvento(e: { readonly tipo: LoginChoferEventoTipo; readonly telefonoHash: string; readonly ipHash: string | null; readonly userId?: string | null; readonly organizationId?: string | null }): Promise<void> {
    await this.run(async () => {
      await this.db.query(`select core.chofer_login_registrar_evento($1, $2, $3, $4, $5);`, [e.tipo, e.telefonoHash, e.ipHash, e.userId ?? null, e.organizationId ?? null]);
    });
  }

  async resolver(telefonoE164: string): Promise<LoginChoferCuenta | null> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ user_id: string; organization_id: string; full_name: string; property_ids: string[] | null }>(
        `select user_id, organization_id, full_name, property_ids from core.chofer_login_resolver($1);`,
        [telefonoE164],
      );
      const r = rows[0];
      return r ? { userId: r.user_id, organizationId: r.organization_id, fullName: r.full_name, propertyIds: r.property_ids } : null;
    });
  }

  async plantilla(organizationId: string): Promise<{ readonly nombre: string; readonly idioma: string } | null> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ nombre: string; idioma: string }>(`select nombre, idioma from core.chofer_login_plantilla($1);`, [organizationId]);
      return rows[0] ?? null;
    });
  }

  async emitir(input: { readonly userId: string; readonly organizationId: string; readonly codeHash: string; readonly codeSalt: string; readonly expiresAt: string }): Promise<string | null> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ id: string | null }>(`select core.chofer_login_emitir($1, $2, $3, $4, $5) as id;`, [input.userId, input.organizationId, input.codeHash, input.codeSalt, input.expiresAt]);
      return rows[0]?.id ?? null;
    });
  }

  async reservarIntento(telefonoE164: string): Promise<LoginChoferCodigoReservado | null> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ codigo_id: string; user_id: string; organization_id: string; code_hash: string; code_salt: string; intentos: number }>(
        `select codigo_id, user_id, organization_id, code_hash, code_salt, intentos from core.chofer_login_reservar_intento($1);`,
        [telefonoE164],
      );
      const r = rows[0];
      return r ? { codigoId: r.codigo_id, userId: r.user_id, organizationId: r.organization_id, codeHash: r.code_hash, codeSalt: r.code_salt, intentos: Number(r.intentos) } : null;
    });
  }

  async registrarFallo(codigoId: string): Promise<boolean> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ cerrado: boolean }>(`select core.chofer_login_fallo($1) as cerrado;`, [codigoId]);
      return rows[0]?.cerrado === true;
    });
  }

  async consumir(codigoId: string): Promise<StaffUserRow | null> {
    return this.run(async () => {
      const { rows } = await this.db.query<StaffRawRow>(`select id, email, full_name, password_hash, created_via, email_verified_at, sessions_revoked_at from core.chofer_login_consumir($1);`, [codigoId]);
      const r = rows[0];
      return r
        ? { id: r.id, email: r.email, fullName: r.full_name, passwordHash: r.password_hash, createdVia: r.created_via, emailVerifiedAt: r.email_verified_at, sessionsRevokedAt: r.sessions_revoked_at }
        : null;
    });
  }

  async guardarTelefono(organizationId: string, targetUserId: string, telefonoE164: string): Promise<void> {
    await this.run(async () => {
      await this.db.query(`select core.chofer_login_telefono_guardar($1, $2, $3);`, [organizationId, targetUserId, telefonoE164]);
    });
  }

  async quitarTelefono(organizationId: string, targetUserId: string): Promise<boolean> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ borrado: boolean }>(`select core.chofer_login_telefono_quitar($1, $2) as borrado;`, [organizationId, targetUserId]);
      return rows[0]?.borrado === true;
    });
  }

  async listarTelefonos(organizationId: string): Promise<readonly LoginChoferTelefonoListado[]> {
    return this.run(async () => {
      const { rows } = await this.db.query<{ user_id: string; telefono_enmascarado: string }>(`select user_id, telefono_enmascarado from core.chofer_login_telefono_listar($1);`, [organizationId]);
      return rows.map((r) => ({ userId: r.user_id, telefonoEnmascarado: r.telefono_enmascarado }));
    });
  }
}

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function mensaje(err: unknown): string {
  return err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "No se pudo completar la operacion.";
}

// ---------------------------------------------------------------------------------------------------------------
// En memoria (tests y e2e): mismas reglas que las funciones SQL, incluida la elegibilidad "solo repartidor".
// ---------------------------------------------------------------------------------------------------------------
export interface LoginChoferLecturaCore {
  findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]>;
  findStaffById(id: string): Promise<StaffUserRow | null>;
  isPlatformSuperadmin(staffId: string): Promise<boolean>;
}

interface CodigoMem {
  id: string;
  userId: string;
  organizationId: string;
  codeHash: string;
  codeSalt: string;
  intentos: number;
  estado: "pendiente" | "usado" | "invalidado" | "expirado";
  expiresAt: number;
}

export class InMemoryLoginChoferRepository implements LoginChoferRepository {
  private readonly telefonos = new Map<string, { userId: string; organizationId: string }>();
  private readonly codigos: CodigoMem[] = [];
  private readonly eventos: Array<{ tipo: LoginChoferEventoTipo; telefonoHash: string; ipHash: string | null; at: number }> = [];
  private readonly plantillas = new Set<string>();
  private plantillaGlobal = false;
  private secuencia = 0;

  constructor(
    private readonly core: LoginChoferLecturaCore,
    private readonly now: () => number = () => Date.now(),
    /** Autoridad del caller para gestionar telefonos (en la base real la decide `core.chofer_login_puede_gestionar`). */
    private readonly puedeGestionar: (organizationId: string) => boolean = () => true,
  ) {}

  /** Prueba: declara la plantilla `codigo_acceso` aprobada para una organizacion. */
  aprobarPlantilla(organizationId: string): void {
    this.plantillas.add(organizationId);
    this.plantillaGlobal = true;
  }
  /** Prueba: telefono registrado directamente (incluso para cuentas no elegibles, para probar que no entran). */
  sembrarTelefono(userId: string, organizationId: string, telefonoE164: string): void {
    this.telefonos.set(telefonoE164, { userId, organizationId });
  }
  eventosRegistrados(): ReadonlyArray<{ tipo: LoginChoferEventoTipo; telefonoHash: string; ipHash: string | null }> {
    return this.eventos;
  }
  codigosRegistrados(): ReadonlyArray<Readonly<CodigoMem>> {
    return this.codigos;
  }

  private async elegible(userId: string, organizationId: string): Promise<boolean> {
    if (await this.core.isPlatformSuperadmin(userId)) return false;
    const ms = await this.core.findMembershipsByUserId(userId);
    if (!ms.some((m) => m.organizationId === organizationId && m.vertical === "restaurantes" && m.verticalRole === "repartidor")) return false;
    return ms.every((m) => m.vertical === "restaurantes" && m.verticalRole === "repartidor");
  }

  async plantillaDisponible(): Promise<boolean> {
    return this.plantillaGlobal;
  }

  async puedeSolicitar(l: LoginChoferLimites): Promise<ResultadoLimite> {
    const t = this.now();
    const ventana = t - l.ventanaSegundos * 1000;
    const agotados = this.eventos.filter((e) => e.telefonoHash === l.telefonoHash && e.tipo === "codigo_agotado" && e.at > t - l.bloqueoSegundos * 1000).length;
    if (agotados >= 2) {
      this.eventos.push({ tipo: "solicitud_bloqueada", telefonoHash: l.telefonoHash, ipHash: l.ipHash, at: t });
      return "bloqueado";
    }
    const tel = this.eventos.filter((e) => e.telefonoHash === l.telefonoHash && e.tipo === "solicitud" && e.at > ventana).length;
    const ip = l.ipHash ? this.eventos.filter((e) => e.ipHash === l.ipHash && e.tipo === "solicitud" && e.at > ventana).length : 0;
    if (tel >= l.maxTelefono || ip >= l.maxIp) {
      this.eventos.push({ tipo: "solicitud_limitada", telefonoHash: l.telefonoHash, ipHash: l.ipHash, at: t });
      return "limitado";
    }
    this.eventos.push({ tipo: "solicitud", telefonoHash: l.telefonoHash, ipHash: l.ipHash, at: t });
    return "ok";
  }

  async registrarEvento(e: { readonly tipo: LoginChoferEventoTipo; readonly telefonoHash: string; readonly ipHash: string | null }): Promise<void> {
    this.eventos.push({ tipo: e.tipo, telefonoHash: e.telefonoHash, ipHash: e.ipHash, at: this.now() });
  }

  async resolver(telefonoE164: string): Promise<LoginChoferCuenta | null> {
    const fila = this.telefonos.get(telefonoE164);
    if (!fila || !(await this.elegible(fila.userId, fila.organizationId))) return null;
    const staff = await this.core.findStaffById(fila.userId);
    const m = (await this.core.findMembershipsByUserId(fila.userId)).find((x) => x.organizationId === fila.organizationId);
    if (!staff || !m) return null;
    return { userId: fila.userId, organizationId: fila.organizationId, fullName: staff.fullName, propertyIds: m.propertyIds };
  }

  async plantilla(organizationId: string): Promise<{ readonly nombre: string; readonly idioma: string } | null> {
    return this.plantillas.has(organizationId) ? { nombre: "codigo_acceso", idioma: "es_MX" } : null;
  }

  async emitir(input: { readonly userId: string; readonly organizationId: string; readonly codeHash: string; readonly codeSalt: string; readonly expiresAt: string }): Promise<string | null> {
    if (!(await this.elegible(input.userId, input.organizationId))) return null;
    for (const c of this.codigos) if (c.userId === input.userId && c.estado === "pendiente") c.estado = "invalidado";
    this.secuencia += 1;
    const id = `codigo-${this.secuencia}`;
    this.codigos.push({ id, userId: input.userId, organizationId: input.organizationId, codeHash: input.codeHash, codeSalt: input.codeSalt, intentos: 0, estado: "pendiente", expiresAt: Date.parse(input.expiresAt) });
    return id;
  }

  async reservarIntento(telefonoE164: string): Promise<LoginChoferCodigoReservado | null> {
    const cuenta = await this.resolver(telefonoE164);
    if (!cuenta) return null;
    const c = this.codigos.find((x) => x.userId === cuenta.userId && x.estado === "pendiente");
    if (!c) return null;
    if (c.expiresAt <= this.now()) {
      c.estado = "expirado";
      return null;
    }
    if (c.intentos >= 5) {
      c.estado = "invalidado";
      return null;
    }
    c.intentos += 1;
    return { codigoId: c.id, userId: c.userId, organizationId: c.organizationId, codeHash: c.codeHash, codeSalt: c.codeSalt, intentos: c.intentos };
  }

  async registrarFallo(codigoId: string): Promise<boolean> {
    const c = this.codigos.find((x) => x.id === codigoId);
    if (c && c.estado === "pendiente" && c.intentos >= 5) {
      c.estado = "invalidado";
      return true;
    }
    return false;
  }

  async consumir(codigoId: string): Promise<StaffUserRow | null> {
    const c = this.codigos.find((x) => x.id === codigoId);
    if (!c) return null;
    const elegible = await this.elegible(c.userId, c.organizationId);
    // Comprobar y marcar SIN await entre medio: con dos verificaciones simultaneas solo una gana (en SQL lo hace un UPDATE condicional).
    if (!elegible || c.estado !== "pendiente" || c.expiresAt <= this.now()) return null;
    c.estado = "usado";
    return this.core.findStaffById(c.userId);
  }

  async guardarTelefono(organizationId: string, targetUserId: string, telefonoE164: string): Promise<void> {
    if (!this.puedeGestionar(organizationId)) throw new LoginChoferTelefonoError("tu rol no alcanza para registrar el telefono de acceso de un repartidor");
    if (!(await this.elegible(targetUserId, organizationId))) throw new LoginChoferTelefonoError("el telefono de acceso solo aplica a cuentas de repartidor");
    const dueno = this.telefonos.get(telefonoE164);
    if (dueno && dueno.userId !== targetUserId) throw new LoginChoferTelefonoError("no se pudo registrar ese telefono");
    for (const [tel, v] of this.telefonos) if (v.userId === targetUserId && v.organizationId === organizationId) this.telefonos.delete(tel);
    this.telefonos.set(telefonoE164, { userId: targetUserId, organizationId });
    for (const c of this.codigos) if (c.userId === targetUserId && c.estado === "pendiente") c.estado = "invalidado";
  }

  async quitarTelefono(organizationId: string, targetUserId: string): Promise<boolean> {
    if (!this.puedeGestionar(organizationId)) throw new LoginChoferTelefonoError("tu rol no alcanza para quitar el telefono de acceso de un repartidor");
    let borrado = false;
    for (const [tel, v] of this.telefonos) {
      if (v.userId !== targetUserId || v.organizationId !== organizationId) continue;
      this.telefonos.delete(tel);
      borrado = true;
    }
    for (const c of this.codigos) if (c.userId === targetUserId && c.estado === "pendiente") c.estado = "invalidado";
    return borrado;
  }

  async listarTelefonos(organizationId: string): Promise<readonly LoginChoferTelefonoListado[]> {
    if (!this.puedeGestionar(organizationId)) throw new LoginChoferTelefonoError("tu rol no alcanza para ver los telefonos de acceso");
    return [...this.telefonos.entries()].filter(([, v]) => v.organizationId === organizationId).map(([tel, v]) => ({ userId: v.userId, telefonoEnmascarado: `******${tel.slice(-4)}` }));
  }
}
