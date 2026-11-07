#!/usr/bin/env python3
"""Conciliacion del banco ciego C3 (80 escenarios) contra el catalogo REAL de PM (arnes/real-dump). Sin red, sin LLM, sin gasto.

Uso:
  python3 c3-conciliar.py [--fuente arnes/ciego-3.fuente.json] [--seco <c3-seco.json>] [--escribir]

  --fuente   banco original (copia literal de wt-medir21/scripts/medicion/escenarios/ciego-3.json)
  --seco     resultado de la corrida SECA del arnes (`QA_C3_SECO=1`, sin LLM): sucursal que asigna buscar_sucursal_cercana
             (/branches/nearest) por colonia y cotizacion real (/orders/quote) de lo esperado. Si se da, sus diferencias tambien se adaptan.
  --fixture  colonias con coordenadas (por omision arnes/c3-colonias.json, copia de colonias de wt-medir21 fixtures/menu-pm.json)
  --escribir escribe arnes/ciego-3.json (banco PORTADO) y C3-CONCILIACION.md; sin el flag solo imprime el reporte.

Reglas de adaptacion (cada una queda en `_port.adaptaciones` del JSON y en el reporte; nunca se relaja la CONDUCTA que se mide):
  A1 slug: chicxulub -> playa (T5 se llama `playa` en produccion).
  A2 precio: si el producto existe con el MISMO nombre en la sucursal esperada y solo cambia el precio, total_mxn se recalcula con la lista real.
  A3 sucursal de domicilio (solo con --seco): si la herramienta real asigna OTRA sucursal a la colonia del escenario, la esperada pasa a ser la
     que asigna la herramienta (es la verdad del sistema destino) y el total se recalcula con el catalogo de esa sucursal.
  A4 total por cotizacion (solo con --seco): si la cotizacion real del servidor difiere del total recalculado (p. ej. reglas de precio de
     renglones), se usa la cotizacion real y se anota.
  Lo que NO se adapta (queda como diferencia reportada y el escenario se marca `_port.riesgo`): producto inexistente o no disponible en la
  sucursal, colonia que la herramienta no reconoce o deja fuera de zona cuando el escenario espera domicilio.
"""
import json, math, os, sys, unicodedata, re, copy

AQUI = os.path.dirname(os.path.abspath(__file__))
ARNES = os.path.join(AQUI, "arnes")
DUMP = os.path.join(ARNES, "real-dump")
SLUG_MAP = {"chicxulub": "playa"}

def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]", "", s)

def hav(a, b, c, d):
    r = math.radians
    x = math.cos(r(a)) * math.cos(r(c)) * math.cos(r(d) - r(b)) + math.sin(r(a)) * math.sin(r(c))
    return 6371 * math.acos(max(-1, min(1, x)))

def arg(n, d=None):
    return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d

def main():
    fuente = arg("--fuente", os.path.join(ARNES, "ciego-3.fuente.json"))
    seco_p = arg("--seco")
    banco = json.load(open(fuente, encoding="utf-8"))
    E = banco["escenarios"]
    L = lambda f: json.load(open(os.path.join(DUMP, f + ".json"), encoding="utf-8"))
    prop = {p["id"]: p for p in L("property")}
    bd = {b["slug"]: b for b in L("branch_detail")}
    pid = {s: b["property_id"] for s, b in bd.items()}
    prods = L("products")
    por_nombre = {}
    for p in prods: por_nombre.setdefault(norm(p["name"]), []).append(p)
    bp = {(r["property_id"], r["product_id"]): r for r in L("branch_products")}
    fx = arg("--fixture", os.path.join(ARNES, "c3-colonias.json"))
    colonias = json.load(open(fx, encoding="utf-8"))
    colonias = colonias["colonias"] if isinstance(colonias, dict) else colonias
    seco = json.load(open(seco_p, encoding="utf-8")) if seco_p else {}
    seco_esc = {r["id"]: r for r in seco.get("escenarios", [])}

    lineas, adapt_total, riesgo_total = [], 0, 0
    lineas.append("## Sucursales del catalogo destino\n")
    for s, b in bd.items():
        p = prop[b["property_id"]]
        lineas.append(f"- `{s}` ({p['name']}): status={p['status']} coords={'si' if b['lat'] is not None else 'NO'}")
    lineas.append("")
    salida = copy.deepcopy(banco)
    adaptaciones_global = []
    detalle = []
    for e in salida["escenarios"]:
        esp = e.get("esperado") or {}
        ad, dif, riesgo = [], [], []
        slug = esp.get("sucursal")
        if slug in SLUG_MAP:
            esp["sucursal"] = SLUG_MAP[slug]; ad.append(f"A1 sucursal {slug} -> {SLUG_MAP[slug]}"); slug = esp["sucursal"]
        s = seco_esc.get(e["id"])
        # A3: sucursal que asigna la herramienta real (solo domicilio, solo si el escenario espera una sucursal concreta)
        pide_sucursal = bool(((e.get("persona") or {}).get("hechos") or {}).get("sucursal"))
        cot_q = (s or {}).get("cotizacion") or {}
        if s and slug and esp.get("entrega") == "domicilio":
            asig = s.get("cercana", {})
            if pide_sucursal and asig.get("slug") and asig["slug"] != slug:
                riesgo.append(f"el cliente PIDE la sucursal {slug} pero la herramienta real asigna {asig['slug']} a '{s.get('colonia')}' y el servidor rechaza el domicilio fuera de la zona de {slug}: "
                              f"la expectativa del origen (domicilio desde {slug}) es IMPOSIBLE en el destino; no se adapta (cambiaria la conducta medida)")
            elif asig.get("estado") == "asignada" and asig.get("slug") and asig["slug"] != slug:
                ad.append(f"A3 sucursal de domicilio {slug} -> {asig['slug']} (buscar_sucursal_cercana real con colonia '{s.get('colonia')}': {asig.get('km')} km)")
                esp["sucursal"] = asig["slug"]; slug = asig["slug"]; cot_q = s.get("cotizacion_asignada") or {}
            elif asig and asig.get("estado") != "asignada":
                riesgo.append(f"la herramienta real no asigna sucursal a la colonia '{s.get('colonia')}' (estado={asig.get('estado')}); el escenario espera domicilio en {slug}")
        if slug and slug not in pid:
            riesgo.append(f"sucursal esperada '{slug}' no existe en el destino")
        elif slug and prop[pid[slug]]["status"] != "active":
            riesgo.append(f"sucursal esperada '{slug}' esta INACTIVA en el destino")
        total = 0.0; completo = True
        for it in esp.get("items") or []:
            if it.get("producto_re"):
                completo = False; continue
            cand = por_nombre.get(norm(it["producto"]), [])
            if not cand:
                riesgo.append(f"producto inexistente en el catalogo destino: {it['producto']}"); completo = False; continue
            if not slug:
                continue
            fila = next((bp[(pid[slug], p["id"])] for p in cand if (pid[slug], p["id"]) in bp), None)
            if not fila:
                riesgo.append(f"{it['producto']} no esta en el menu de {slug}"); completo = False; continue
            if not fila.get("is_available", True):
                riesgo.append(f"{it['producto']} NO disponible en {slug}")
            total += float(fila["price"]) * it["cantidad"]
        total = round(total, 2)
        if esp.get("total_fijo") is True and isinstance(esp.get("total_mxn"), (int, float)) and completo and slug:
            if abs(total - esp["total_mxn"]) > 0.001:
                ad.append(f"A2 total_mxn {esp['total_mxn']} -> {total:g} (precios de la lista real de {slug})")
                esp["total_mxn"] = int(total) if total == int(total) else total
            if cot_q.get("total") is not None and abs(float(cot_q["total"]) - esp["total_mxn"]) > 0.001:
                q = float(cot_q["total"])
                ad.append(f"A4 total_mxn {esp['total_mxn']} -> {q:g} (cotizacion real del servidor en {slug})")
                esp["total_mxn"] = int(q) if q == int(q) else q
        if cot_q.get("error"):
            riesgo.append(f"la cotizacion real fallo en {slug}: {cot_q['error'][:200]}")
        if s and (s.get("cercana") or {}).get("estado") not in (None, "asignada"):
            c = s["cercana"]
            riesgo.append(f"buscar_sucursal_cercana real con '{s.get('colonia')}' -> {c.get('estado')}" + (" (el escenario espera fuera_de_zona; el agente vera no_reconocida y pedira otra referencia)" if (e.get("zona") or {}).get("fuera_de_zona") else ""))
        # pedidos previos sembrados: productos que no existen en el destino
        for pp in (e.get("cliente") or {}).get("pedidos_previos", []):
            for x in pp.get("items", []):
                if not por_nombre.get(norm(x["name"])): riesgo.append(f"pedido previo: producto inexistente {x['name']}")
        if s and s.get("semilla_error"):
            riesgo.append(f"semilla del pedido previo fallo: {s['semilla_error'][:160]}")
        if ad or riesgo:
            e["_port"] = {**({"adaptaciones": ad} if ad else {}), **({"riesgo": riesgo} if riesgo else {})}
        adapt_total += len(ad); riesgo_total += len(riesgo)
        if ad or riesgo: detalle.append((e["id"], ad, riesgo))
        for a in ad: adaptaciones_global.append(f"{e['id']}: {a}")

    # Numeros por sucursal (decision del dueno de PM, 2026-11-06): cada sucursal tiene SU numero de WhatsApp; cada escenario escribe al numero de
    # una sucursal (`sucursal_chat`). El esperado.sucursal NO cambia: con un domicilio de otra sucursal el agente toma el pedido para la que lo cubre.
    origen = {e["id"]: e for e in banco["escenarios"]}
    cruzados, conteo = [], {}
    for e in salida["escenarios"]:
        esp = e["esperado"].get("sucursal"); fu = origen[e["id"]]["esperado"].get("sucursal")
        sem = (seco_esc.get(e["id"]) or {}).get("semilla") or ""
        if e["id"].startswith("C3-PED-15-"): chat, regla = "garcia-lavin", "R2"
        elif esp and fu and fu != esp: chat, regla = fu, "R1"
        elif esp: chat, regla = esp, "R5"
        elif sem: chat, regla = sem.split()[0], "R3"
        else: chat, regla = "garcia-lavin", "R4"
        e["sucursal_chat"] = chat; conteo[regla] = conteo.get(regla, 0) + 1
        if esp and chat != esp: cruzados.append(f"{e['id']}: escribe a {chat}, entrega/recoge {esp} ({regla})")
    salida["_port"] = {
        "nota": "Banco C3 PORTADO al arnes de scripts/medicion-nube (API real + Postgres efimero + catalogo real-dump). Generado por c3-conciliar.py; "
                "el original es ciego-3.fuente.json. Cada adaptacion es de catalogo/nombre/sucursal, nunca de la conducta medida.",
        "fuente": os.path.basename(fuente), "seco": os.path.basename(seco_p) if seco_p else None,
        "adaptaciones": adaptaciones_global,
        # coordenadas de las 22 colonias del fixture de origen (menu-pm.json): solo para la comprobacion zona_8km, igual que verificar.mjs
        "colonias": colonias,
        "numeros_por_sucursal": {
            "decision": "2026-11-06, dueno de PM: cada sucursal tiene SU numero de WhatsApp (restaurantes.whatsapp_branch_channel). El banco deja de escribir al numero de la organizacion y cada escenario escribe al numero de una sucursal (campo sucursal_chat). Si el domicilio lo cubre otra sucursal, el agente toma el pedido y lo asigna a la que cubre (no rechaza), por eso el esperado.sucursal NO cambia.",
            "reglas": {"R1": "escenario adaptado A3 (la sucursal del origen no cubre el domicilio en el catalogo real): el cliente escribe a la sucursal que el origen creia (caso de sucursal cruzada)", "R2": "C3-PED-15: escribe a garcia-lavin y el domicilio (Chuburna) lo cubre fco-montejo: caso de sucursal cruzada que fallaba con «esta conversacion no toma pedidos para esa sucursal»", "R3": "cliente existente sin pedido nuevo: escribe a la sucursal de su pedido previo sembrado", "R4": "sin sucursal esperada ni pedido previo: garcia-lavin (numero T7 historico del arnes)", "R5": "escribe a la sucursal esperada (la que entrega o donde recoge)"},
            "conteo": conteo, "cruzados": cruzados,
        },
    }
    lineas.append("## Numero de WhatsApp por escenario (sucursal_chat)\n")
    lineas.append(f"Cada escenario escribe al numero de UNA sucursal (decision del dueno, 2026-11-06). Reglas y conteo: {conteo}. Sucursal cruzada (escribe a una, entrega otra):")
    for c in cruzados: lineas.append(f"- {c}")
    lineas.append("")
    lineas.append(f"## Escenarios con adaptaciones o riesgos ({len(detalle)} de {len(E)}; {adapt_total} adaptaciones, {riesgo_total} riesgos)\n")
    for i, ad, rg in detalle:
        lineas.append(f"- **{i}**")
        for a in ad: lineas.append(f"  - ADAPTADO: {a}")
        for r in rg: lineas.append(f"  - RIESGO (sin adaptar): {r}")
    if seco_esc:
        lineas.append("\n## Corrida seca (herramientas reales, sin LLM)\n")
        for r in seco.get("escenarios", []):
            c = r.get("cercana") or {}; q = r.get("cotizacion") or {}
            lineas.append(f"- {r['id']}: colonia='{r.get('colonia')}' -> {c.get('estado','-')} {c.get('slug','')} {c.get('km','')} km | cotiza={q.get('total', q.get('error','-'))}" + (f" | semilla={r.get('semilla')}" if r.get("semilla") else ""))
    rep = "\n".join(lineas)
    print(rep)
    if "--escribir" in sys.argv:
        json.dump(salida, open(os.path.join(ARNES, "ciego-3.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        open(os.path.join(AQUI, "C3-CONCILIACION.md"), "w", encoding="utf-8").write(
            "# Conciliacion C3 -> catalogo real de PM\n\nGenerado por `c3-conciliar.py` (sin red ni LLM). Fuente: `arnes/ciego-3.fuente.json`; "
            f"corrida seca: `{os.path.basename(seco_p) if seco_p else 'no'}`.\n\n" + rep + "\n")
        print("\nescrito: arnes/ciego-3.json y C3-CONCILIACION.md")

main()
