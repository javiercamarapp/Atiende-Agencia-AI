import { describe, it, expect } from 'vitest';
import { LedgerEnMemoria, aplicarConLedger } from '../src/index.ts';

describe('aplicarConLedger — el ledger nunca permite un cobro duplicado por reordenamiento de eventos', () => {
  it('un evento reintentado (mismo id de evento) NO se vuelve a aplicar', async () => {
    const store = new LedgerEnMemoria();
    let vecesCobrado = 0;

    const cobrar = () => {
      vecesCobrado += 1;
      return Promise.resolve('cobrado');
    };

    const r1 = await aplicarConLedger(store, {
      eventId: 'evt_1', entidadId: 'sub_123', creadoUnix: 1000, aplicar: cobrar,
    });
    expect(r1.estado).toBe('aplicado');

    // Stripe reintenta el MISMO evento (at-least-once delivery).
    const r2 = await aplicarConLedger(store, {
      eventId: 'evt_1', entidadId: 'sub_123', creadoUnix: 1000, aplicar: cobrar,
    });
    expect(r2.estado).toBe('duplicado');
    expect(vecesCobrado).toBe(1); // el segundo NUNCA llamó a `aplicar`
  });

  it('un evento .updated viejo que llega DESPUÉS de un .deleted más nuevo no revive la entidad', async () => {
    // El caso real de producción (proyecto origen, RES-11): se cancela HOY y el
    // reintento de un .updated de anteayer (backoff largo del proveedor)
    // NO debe volver a dejarla "activa" — el último en LLEGAR no es el
    // último en OCURRIR.
    const store = new LedgerEnMemoria();
    const estados: string[] = [];

    await aplicarConLedger(store, {
      eventId: 'evt_cancel', entidadId: 'sub_1', creadoUnix: 2_000_000,
      aplicar: async () => { estados.push('cancelada'); },
    });

    const r = await aplicarConLedger(store, {
      eventId: 'evt_viejo_reintento', entidadId: 'sub_1', creadoUnix: 1_000_000, // más viejo
      aplicar: async () => { estados.push('activa'); },
    });

    expect(r.estado).toBe('fuera_de_orden');
    expect(estados).toEqual(['cancelada']); // 'activa' NUNCA se aplicó
  });

  it('un evento más nuevo sí se aplica después de uno viejo (la protección no congela la entidad)', async () => {
    const store = new LedgerEnMemoria();
    const estados: string[] = [];

    await aplicarConLedger(store, {
      eventId: 'evt_a', entidadId: 'sub_2', creadoUnix: 1000,
      aplicar: async () => { estados.push('activa'); },
    });
    const r = await aplicarConLedger(store, {
      eventId: 'evt_b', entidadId: 'sub_2', creadoUnix: 2000,
      aplicar: async () => { estados.push('cancelada'); },
    });

    expect(r.estado).toBe('aplicado');
    expect(estados).toEqual(['activa', 'cancelada']);
  });

  it('entidades distintas no se pisan el orden entre sí', async () => {
    const store = new LedgerEnMemoria();
    const r1 = await aplicarConLedger(store, {
      eventId: 'evt_x', entidadId: 'sub_A', creadoUnix: 5000, aplicar: async () => 'A',
    });
    const r2 = await aplicarConLedger(store, {
      eventId: 'evt_y', entidadId: 'sub_B', creadoUnix: 100, aplicar: async () => 'B',
    });
    expect(r1.estado).toBe('aplicado');
    expect(r2.estado).toBe('aplicado'); // sub_B nunca ha visto un evento: 100 no es "viejo" para ELLA
  });

  it('sin sello previo, un evento cualquiera se aplica (no hay orden que violar)', async () => {
    const store = new LedgerEnMemoria();
    const r = await aplicarConLedger(store, {
      eventId: 'evt_primero', entidadId: 'sub_nueva', creadoUnix: 1, aplicar: async () => 'ok',
    });
    expect(r.estado).toBe('aplicado');
  });

  it('carrera: dos aplicaciones concurrentes del MISMO evento — una gana, la otra es duplicado', async () => {
    const store = new LedgerEnMemoria();
    let cobros = 0;
    const aplicar = async () => {
      cobros += 1;
      return 'cobrado';
    };
    const [r1, r2] = await Promise.all([
      aplicarConLedger(store, { eventId: 'evt_carrera', entidadId: 'sub_carrera', creadoUnix: 1, aplicar }),
      aplicarConLedger(store, { eventId: 'evt_carrera', entidadId: 'sub_carrera', creadoUnix: 1, aplicar }),
    ]);
    const estados = [r1.estado, r2.estado].sort();
    expect(estados).toEqual(['aplicado', 'duplicado']);
    expect(cobros).toBe(1);
  });
});

describe('aplicarConLedger — un fallo transitorio NO consume el evento (el reintento del proveedor sí se aplica)', () => {
  it('si aplicar() lanza, la marca de "visto" se libera y el reintento con el MISMO id se aplica', async () => {
    const store = new LedgerEnMemoria();
    let intentos = 0;
    const aplicar = async () => {
      intentos += 1;
      if (intentos === 1) throw new Error('postgres: conexión reiniciada');
      return 'aplicado-en-reintento';
    };

    await expect(aplicarConLedger(store, { eventId: 'evt_transitorio', entidadId: 'sub_t', creadoUnix: 1000, aplicar })).rejects.toThrow(/conexión reiniciada/);
    const r = await aplicarConLedger(store, { eventId: 'evt_transitorio', entidadId: 'sub_t', creadoUnix: 1000, aplicar });

    expect(r).toEqual({ estado: 'aplicado', resultado: 'aplicado-en-reintento' });
    expect(intentos).toBe(2);
    expect(await store.ordenAplicado('sub_t')).toBe(1000);
  });

  it('si el sello de orden lanza después de aplicar, el evento tampoco queda marcado: el reintento lo vuelve a aplicar y sella', async () => {
    const store = new LedgerEnMemoria();
    const sellarReal = store.sellarOrden.bind(store);
    let sellos = 0;
    store.sellarOrden = async (entidadId, creadoUnix) => {
      sellos += 1;
      if (sellos === 1) throw new Error('timeout al sellar');
      return sellarReal(entidadId, creadoUnix);
    };
    let aplicaciones = 0;
    const aplicar = async () => { aplicaciones += 1; };

    await expect(aplicarConLedger(store, { eventId: 'evt_sello', entidadId: 'sub_s', creadoUnix: 7, aplicar })).rejects.toThrow(/timeout al sellar/);
    const r = await aplicarConLedger(store, { eventId: 'evt_sello', entidadId: 'sub_s', creadoUnix: 7, aplicar });

    expect(r.estado).toBe('aplicado');
    expect(aplicaciones).toBe(2);
    expect(await store.ordenAplicado('sub_s')).toBe(7);
  });

  it('un duplicado real (ya aplicado con éxito) sigue siendo duplicado: liberar la marca solo ocurre ante un fallo', async () => {
    const store = new LedgerEnMemoria();
    await aplicarConLedger(store, { eventId: 'evt_ok', entidadId: 'sub_ok', creadoUnix: 1, aplicar: async () => 'ok' });
    const r = await aplicarConLedger(store, { eventId: 'evt_ok', entidadId: 'sub_ok', creadoUnix: 1, aplicar: async () => 'otra vez' });
    expect(r.estado).toBe('duplicado');
  });
});
