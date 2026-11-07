#!/usr/bin/env python3
"""Agrega una corrida C3 (carpeta con rep*/c3-resultados.json, rep*/telemetria-turnos.jsonl, uso-inicial.txt/uso-final.txt).
Solo lectura de archivos; sin red ni llaves. Uso: agregar-c3.py <carpeta-de-la-corrida>

Imprime: pasan/total sobre conversaciones VALIDAS con intervalo de Wilson 95 %, invalidas por causa, fallas del proveedor
(turnos de telemetria error_proveedor/presupuesto_agotado), USD gastado (delta del uso de la llave), p50/p95 de latencia por turno
y, por escenario, k/n con las comprobaciones que mas fallan. Tambien el conteo ESTRICTO del arnes de origen (correr.mjs), donde una
falla del proveedor que llego al cliente cuenta como FALLA (no como invalida), para comparar con la referencia de 364/400."""
import collections, glob, json, math, os, sys

def wilson(k, n, z=1.959964):
    if n == 0: return (None, None)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - m), min(1, c + m))

def pct(x): return "n/d" if x is None else f"{x*100:.0f}%"

def percentil(v, q):
    if not v: return None
    v = sorted(v); return v[min(len(v) - 1, max(0, math.ceil(q * len(v)) - 1))]

def leer(p):
    try: return open(p, encoding="utf-8").read().strip()
    except OSError: return ""

def main():
    base = sys.argv[1]
    res = []
    for f in sorted(glob.glob(f"{base}/rep*/c3-resultados.json")):
        try: res += json.load(open(f, encoding="utf-8"))
        except Exception as e: print(f"no pude leer {f}: {e}")
    tel = []
    for f in glob.glob(f"{base}/rep*/telemetria-turnos.jsonl"):
        for l in open(f, encoding="utf-8", errors="replace"):
            try: tel.append(json.loads(l))
            except Exception: pass
    val = [r for r in res if r.get("valida")]
    k = sum(1 for r in val if r.get("veredicto") == "PASA"); n = len(val)
    lo, hi = wilson(k, n)
    inval = collections.Counter(r.get("causa_invalida") or "otra" for r in res if not r.get("valida"))
    prov_turnos = sum(1 for t in tel if t.get("resultado") in ("error_proveedor", "presupuesto_agotado"))
    # criterio estricto del origen: invalida solo cliente simulado / red local / excepcion del arnes; proveedor del AGENTE = FALLA
    es_prov = lambda c: c in ("error_proveedor", "presupuesto_agotado", "fetch_failed") or c.startswith("http_")
    prov_conv = [r for r in res if not r.get("valida") and es_prov(r.get("causa_invalida") or "")]
    n_est = n + len(prov_conv)
    u0, u1 = leer(f"{base}/uso-inicial.txt"), leer(f"{base}/uso-final.txt")
    try: usd = f"{float(u1) - float(u0):.4f}"
    except ValueError: usd = "n/d"
    ms = [m for r in res for m in (r.get("ms") or []) if isinstance(m, (int, float)) and m > 0]
    tl = [t.get("latenciaTotalMs") for t in tel if isinstance(t.get("latenciaTotalMs"), (int, float))]
    print(f"C3 {os.path.basename(base.rstrip('/'))}: {leer(base + '/flag.txt')}")
    print(f"PASAN {k}/{n} validas = {pct(k/n if n else None)}  (Wilson 95%: {pct(lo)} - {pct(hi)})")
    print(f"invalidas: {sum(inval.values())} {dict(inval)}")
    print(f"estricto (origen: falla del proveedor = FALLA): {k}/{n_est} = {pct(k/n_est if n_est else None)}")
    imp = [r for r in val if any("IMPOSIBLE" in x for x in (r.get("riesgo_port") or []))]
    if imp:
        k2 = k - sum(1 for r in imp if r.get("veredicto") == "PASA"); n2 = n - len(imp); lo2, hi2 = wilson(k2, n2)
        print(f"sin los escenarios IMPOSIBLES en el destino ({len(set(r['escenario'] for r in imp))}; ver C3-CONCILIACION.md): {k2}/{n2} = {pct(k2/n2 if n2 else None)} (Wilson {pct(lo2)} - {pct(hi2)})")
    print(f"turnos con falla de proveedor (telemetria): {prov_turnos} de {len(tel)} turnos")
    print(f"USD gastado (delta uso llave): {usd}{'  CORTADA POR TOPE' if os.path.exists(base + '/CORTADA') else ''}")
    print(f"latencia por turno (webhook, ms): p50={percentil(ms, .5)} p95={percentil(ms, .95)} n={len(ms)} | telemetria latenciaTotalMs p50={percentil(tl, .5)} p95={percentil(tl, .95)}")
    modelos = collections.Counter(m for r in res for m in (r.get("modelos") or []))
    if modelos: print(f"modelos que respondieron: {dict(modelos)}")
    por = collections.OrderedDict()
    for r in res:
        a = por.setdefault(r["escenario"], {"k": 0, "n": 0, "inv": 0, "f": collections.Counter()})
        if not r.get("valida"): a["inv"] += 1; continue
        a["n"] += 1
        if r.get("veredicto") == "PASA": a["k"] += 1
        for f in r.get("fallas") or []: a["f"][f.split(":")[0]] += 1
    print("\nescenario                                              k/n   inval  fallas mas frecuentes")
    for e, a in por.items():
        top = ", ".join(f"{c}x{m}" for c, m in a["f"].most_common(3))
        print(f"{e[:54]:54s} {a['k']}/{a['n']:<4d} {a['inv']:<6d} {top}")

main()
