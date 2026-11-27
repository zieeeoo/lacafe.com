#!/usr/bin/env python3
"""
Konversi file Excel "DATA BASE CUSTOMER LACAFE" -> data/seed.json

Pemakaian:
    python3 tools/import_excel.py path/ke/DATA_CUSTOMER.xlsx [data/seed.json]

Butuh: pip install openpyxl
Sheet yang dibaca: DASHBOARD (customer), TRANSAKSI, DATABASE (menu & parameter).
Kolom hitungan (kunjungan, total belanja, level, poin, status) TIDAK diimpor:
server menghitung ulang semuanya dari transaksi, sama seperti rumus di Excel.
"""
import json
import re
import sys
from datetime import datetime, date

import openpyxl


def sheet(wb, name):
    for ws in wb.worksheets:
        if ws.title.strip().upper() == name:
            return ws
    raise SystemExit(f"Sheet '{name}' tidak ditemukan. Sheet yang ada: {wb.sheetnames}")


def clean(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


def iso(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return None


def phone(v):
    """85899017510.0 -> '085899017510' ; '+62 858-99' -> '085899...'"""
    if v is None or v == "":
        return None
    if isinstance(v, float):
        v = str(int(v))
    digits = re.sub(r"\D", "", str(v))
    if not digits:
        return None
    if digits.startswith("62"):
        digits = "0" + digits[2:]
    elif not digits.startswith("0"):
        digits = "0" + digits
    return digits


def title(s):
    if not s:
        return s
    small = {"V60", "LA", "C"}
    out = []
    for w in s.split(" "):
        out.append(w if w in small else w.capitalize())
    return " ".join(out)


def category_of(name):
    n = name.upper()
    food = ["TOAST", "CROISSANT", "FRIES", "PLATTER", "SAUSAGE", "CAKE", "BREAD"]
    tea = ["TEA", "YUZU ORANGE", "WATER", "LYCHEE"]
    noncoffee = ["CHOCO", "TARO", "MATCHA", "MILO", "BERRY", "MILKSHAKE"]
    if any(k in n for k in food):
        return "makanan"
    if "COFFEE" in n or "KOPI" in n or "AMERICANO" in n:
        return "kopi"
    if any(k in n for k in tea):
        return "teh"
    if any(k in n for k in noncoffee):
        return "non-kopi"
    return "kopi"


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else "data/seed.json"
    wb = openpyxl.load_workbook(src, data_only=True)

    # ---------- DATABASE: menu, opsi, parameter ----------
    db = sheet(wb, "DATABASE")
    menu, genders, sources, payments, params = [], [], [], [], {}
    for row in db.iter_rows(min_row=3, values_only=True):
        g, s, p, m, h = (clean(x) for x in row[1:6])
        if g: genders.append(g)
        if s: sources.append(s)
        if p: payments.append(p)
        if m and h is not None:
            temp = "hot" if m.upper().endswith(" HOT") else ("cold" if m.upper().endswith(" COLD") else None)
            menu.append({
                "code": m.upper(),
                "name": title(m),
                "price": int(h),
                "category": category_of(m),
                "temp": temp,
            })
        k, v = clean(row[7]) if len(row) > 7 else None, row[8] if len(row) > 8 else None
        if isinstance(k, str) and isinstance(v, (int, float)):
            params[k.upper()] = v

    settings = {
        "rupiahPerPoint": int(params.get("RUPIAH BELANJA PER 1 POIN", 10000)),
        "inactiveDays": int(params.get("TIDAK AKTIF SETELAH (HARI)", 30)),
        "tiers": [
            {"key": "reguler", "name": "Reguler", "minSpend": 0},
            {"key": "silver", "name": "Silver", "minSpend": int(params.get("MIN. TOTAL BELANJA SILVER", 500000))},
            {"key": "gold", "name": "Gold", "minSpend": int(params.get("MIN. TOTAL BELANJA GOLD", 1500000))},
        ],
    }

    # ---------- DASHBOARD: customer (kolom manual saja) ----------
    dash = sheet(wb, "DASHBOARD")
    header_row = None
    for i, row in enumerate(dash.iter_rows(min_row=1, max_row=20, values_only=True), start=1):
        if row and clean(row[0]) == "ID":
            header_row = i
            break
    if not header_row:
        raise SystemExit("Header 'ID' di sheet DASHBOARD tidak ditemukan")
    customers = []
    for row in dash.iter_rows(min_row=header_row + 1, values_only=True):
        cid = clean(row[0])
        if not cid:
            continue
        customers.append({
            "memberCode": cid,
            "name": title(clean(row[1])),
            "phone": phone(row[2]),
            "joinedAt": iso(row[3]),
            "gender": (clean(row[4]) or "").lower() or None,
            "source": clean(row[5]),
            "favoriteNote": clean(row[6]),
            "note": clean(row[8]),
        })

    # ---------- TRANSAKSI ----------
    trx = sheet(wb, "TRANSAKSI")
    transactions = []
    for row in trx.iter_rows(min_row=5, values_only=True):
        tid, tgl, cid = clean(row[0]), row[1], clean(row[2])
        if not tid or not cid:
            continue
        transactions.append({
            "code": tid,
            "date": iso(tgl),
            "memberCode": cid,
            "items": [{"code": (clean(row[4]) or "").upper(), "qty": int(row[5] or 1)}],
            "total": int(row[6] or 0),
            "payment": clean(row[7]),
        })

    out = {
        "source": src.split("/")[-1],
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "settings": settings,
        "options": {"genders": genders, "sources": sources, "payments": payments},
        "menu": menu,
        "customers": customers,
        "transactions": transactions,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"OK -> {dst}: {len(customers)} customer, {len(transactions)} transaksi, {len(menu)} menu")


if __name__ == "__main__":
    main()
