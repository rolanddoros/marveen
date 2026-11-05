#!/usr/bin/env python3
"""Kifli "Mentsd meg" + deal watcher helper.

Reads products seen on the Kifli pages from STDIN, one per line:
    <id>|<name>|<source>|<discount %>
where <source> is "mm" (https://www.kifli.hu/ne-pazaroljuk-az-elelmiszert)
or "sale" (a regular deal, e.g. from get_discounted_items). A product is
reported when it matches at least one of:
  - the household profile (favorite, or ordered at least MIN_ORDERS times),
  - an interest keyword (steak, chicken/turkey breast, fish, seafood; for
    "sale" lines also baby formula and diapers the household already buys),
  - an open item of the Todoist shopping list (passed with --list).
Only products with a discount of at least MIN_DISCOUNT percent are reported
(Roland, 2026-10-26); a line without a known discount is skipped.
Baby formula and diapers count only on "sale" lines and only for products the
household already buys.

Usage:
  kifli-mentsd-figyelo.py match [--list "item1;item2;..."] < products.txt
  kifli-mentsd-figyelo.py mark <id> [<id> ...]   # record ids as notified today
  kifli-mentsd-figyelo.py profile                # summary of the profile

Data files (store/kifli/):
  favorites.json      {"ids": [...]}             from get_all_user_favorites
  order-history.json  {"items": {id: {name, orders, last}}}  from fetch_orders
  mentsd-state.json   {id: "YYYY-MM-DD"}         last notification date
"""
import datetime
import json
import os
import re
import sys
import unicodedata

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "store", "kifli")
MIN_ORDERS = 2      # an item ordered at least this many times counts as "frequent"
RENOTIFY_DAYS = 3   # do not report the same id again within this many days
MIN_DISCOUNT = 25   # percent; below this a deal is not worth a ping

# Interest keywords, matched on the accent-stripped, lowercased name.
INTERESTS = {
    "steak": ["steak", "hatszin", "belszin", "rostelyos", "flank", "ribeye"],
    "csirke/pulyka": ["csirkemell", "pulykamell", "mellfile", "csirkecomb", "csirke comb", "egesz csirke"],
    "hal": ["lazac", "tokehal", "hekk", "branzino", "farkas suger", "pisztrang", "ponty",
            "harcsa", "tonhal", "makrela", "dorada", "orata", "aranydurbincs", "halfile", " hal "],
    "tenger": ["garnela", "kagylo", "tintahal", "polip", " rak ", "rakfarok", "scampi", "langusztin"],
}
BABY = {
    "tapszer": ["tapszer", "kendamil", "beba", "hipp", "aptamil", "gyermekital", "kisgyermekek reszere"],
    "pelenka": ["pelenka", "bugyipelenka", "pants"],
}
# A keyword hit is dropped when the name also contains one of these (e.g.
# "Steak Sütőtök" is a pumpkin, "szendvics csemege csirkemellből" is cold cut).
INTEREST_EXCLUDE = ["sutotok", "szendvics", "csemege", "sonka", "salata", "nuggets"]
# Words in a shopping-list item that name a shop or a quantity, not the product.
LIST_STOPWORDS = {"dm", "ikea", "decathlon", "kifli", "lidl", "aldi", "spar", "tesco",
                  "auchan", "rossmann", "bio", "vagy", "db", "darab", "csomag", "kg", "dkg", "gramm"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


def load(name, default):
    try:
        with open(os.path.join(BASE, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_state(state):
    path = os.path.join(BASE, "mentsd-state.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def list_tokens(item):
    item = re.sub(r"\(.*?\)", " ", item)
    toks = [t for t in norm(item).split() if len(t) >= 4 and not t.isdigit() and t not in LIST_STOPWORDS]
    return toks


def keyword_hits(name_n, groups, exclude=()):
    if any(x in name_n for x in exclude):
        return []
    return [label for label, words in groups.items() if any(w in name_n for w in words)]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    favs = {str(i) for i in load("favorites.json", {}).get("ids", [])}
    hist = load("order-history.json", {}).get("items", {})
    state = load("mentsd-state.json", {})
    today = datetime.date.today()

    if cmd == "profile":
        frequent = [i for i, v in hist.items() if v["orders"] >= MIN_ORDERS]
        print(json.dumps({"favorites": len(favs), "ordered_items": len(hist),
                          "frequent": len(frequent),
                          "watchlist": len(favs | set(frequent))}))
        return 0

    if cmd == "match":
        shop = []
        if "--list" in sys.argv:
            raw = sys.argv[sys.argv.index("--list") + 1]
            shop = [(i.strip(), list_tokens(i)) for i in raw.split(";") if i.strip()]
            shop = [(i, t) for i, t in shop if t]
        seen, matches = set(), []
        for line in sys.stdin:
            parts = [p.strip() for p in line.split("|")]
            if not parts or not parts[0].isdigit() or parts[0] in seen:
                continue
            pid = parts[0]
            name = parts[1] if len(parts) > 1 else ""
            source = parts[2] if len(parts) > 2 else "mm"
            disc = parts[3].lstrip("-").rstrip("%").strip() if len(parts) > 3 else ""
            seen.add(pid)
            if not disc.isdigit() or int(disc) < MIN_DISCOUNT:
                continue
            last = state.get(pid)
            if last and (today - datetime.date.fromisoformat(last)).days < RENOTIFY_DAYS:
                continue
            name_n = norm(name)
            reasons = []
            h = hist.get(pid)
            # With the MIN_DISCOUNT floor a favorite on sale is worth a ping too.
            if pid in favs:
                reasons.append("kedvenc")
            if h and h["orders"] >= MIN_ORDERS:
                reasons.append(f"{h['orders']}x rendelve")
            reasons += keyword_hits(name_n, INTERESTS, INTEREST_EXCLUDE)
            if source != "mm":
                # Formula/diapers: only the products the household already buys.
                if pid in favs or h:
                    reasons += keyword_hits(name_n, BABY)
            for item, toks in shop:
                if all(t in name_n for t in toks):
                    reasons.append(f"bevásárlólista: {item}")
            if reasons:
                matches.append({"id": pid, "name": name, "source": source, "discount": int(disc),
                                "reason": ", ".join(reasons),
                                "orders": h["orders"] if h else 0})
        matches.sort(key=lambda m: (m["source"] != "mm", -m["orders"]))
        print(json.dumps({"seen": len(seen), "new_matches": matches}, ensure_ascii=False, indent=1))
        return 0

    if cmd == "mark":
        for a in sys.argv[2:]:
            for i in a.replace(",", " ").split():
                if i.isdigit():
                    state[i] = today.isoformat()
        cutoff = today - datetime.timedelta(days=30)
        state = {k: v for k, v in state.items() if datetime.date.fromisoformat(v) >= cutoff}
        save_state(state)
        print("marked")
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
