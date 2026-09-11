import { describe, it, expect } from 'vitest';
import { clabeValida, referenciaDe, conciliar, ReferenciaBancoInvalida, type FacturaStore } from '../src/index.ts';

describe('clabeValida — dígito verificador 3-7-1', () => {
  it('rechaza una CLABE con longitud distinta a 18', () => {
    expect(clabeValida('123')).toBe(false);
    expect(clabeValida('1234567890123456789')).toBe(false);
  });
  it('rechaza una CLABE con el dígito verificador incorrecto', () => {
    // Se construye una CLABE válida, luego se le corrompe el último dígito.
    const base = '00218001234567890';
    // calcular DV real con el mismo algoritmo para tener un caso válido de control
    const pesos = [3, 7, 1] as const;
    let suma = 0;
    for (let i = 0; i < 17; i++) suma += (Number(base.charAt(i)) * pesos[i % 3]!) % 10;
    const dv = (10 - (suma % 10)) % 10;
    const valida = base + String(dv);
    expect(clabeValida(valida)).toBe(true);

    const dvMalo = (dv + 1) % 10;
    const invalida = base + String(dvMalo);
    expect(clabeValida(invalida)).toBe(false);
  });
});

describe('referenciaDe — determinista por tenant y periodo', () => {
  it('la misma factura del mismo periodo produce la misma referencia', () => {
    const r1 = referenciaDe('11112222-3333-4444-5555-666677778888', '2026-09-01');
    const r2 = referenciaDe('11112222-3333-4444-5555-666677778888', '2026-09-01');
    expect(r1).toBe(r2);
  });
  it('periodos distintos producen referencias distintas', () => {
    const r1 = referenciaDe('tenant-1', '2026-09-01');
    const r2 = referenciaDe('tenant-1', '2026-10-01');
    expect(r1).not.toBe(r2);
  });
});

describe('conciliar — compare-and-set, nunca dos timbrados de la misma mensualidad', () => {
  function storeQueSoloDejaGanarUnaVez(): FacturaStore & { llamadas: number } {
    let pagada = false;
    return {
      llamadas: 0,
      async marcarPagadaSiNoLoEstaba() {
        this.llamadas += 1;
        if (pagada) return false;
        pagada = true;
        return true;
      },
    };
  }

  it('la primera conciliación gana; la segunda (doble clic) NO dispara timbrado de nuevo', async () => {
    const store = storeQueSoloDejaGanarUnaVez();
    const r1 = await conciliar(store, 'f1', 'REF-BANCO-001', 'actor-1');
    const r2 = await conciliar(store, 'f1', 'REF-BANCO-001', 'actor-1');
    expect(r1).toBe('conciliada');
    expect(r2).toBe('ya_conciliada');
    expect(store.llamadas).toBe(2);
  });

  it('exige una referencia de banco con longitud mínima', async () => {
    const store = storeQueSoloDejaGanarUnaVez();
    await expect(conciliar(store, 'f1', 'ab', 'actor-1')).rejects.toBeInstanceOf(ReferenciaBancoInvalida);
  });
});
