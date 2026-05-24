# /// script
# requires-python = ">=3.12"
# dependencies = ["pycountry"]
# ///
"""
Stage 3 - Classify each station by category / country / language.

Strategy: the facet lives mostly in the source FILENAME (zeno.fm/Arabic_(Egypt),
radio_spinner/Germany, radio.menu/lang-en, rcast.net/ambient). So we classify the
bounded token vocabulary ONCE against gazetteers (pycountry for countries +
languages, a curated genre/decade list), then apply per-station with fallbacks:
  - country  : token-country  -> ccTLD of host
  - language : token-language  -> script detection on name -> country's main lang
  - category : token-genre/decade -> genre keyword in station name

Tokens that match nothing (alphabetical station-name files, "other", "local")
simply contribute nothing and fall through to the fallbacks. Each station gets at
most one value per facet plus a *_src provenance tag, written to table `facets`.
"""
import os
import re
import sqlite3
import time
import unicodedata
import pycountry

DB = os.path.join(os.path.dirname(__file__), ".cache", "stations.db")


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


# ---------------------------------------------------------------- gazetteers
COUNTRY_ALIASES = {
    "usa": "United States", "us": "United States", "unitedstates": "United States",
    "unitedstatesofamerica": "United States", "america": "United States",
    "uk": "United Kingdom", "greatbritain": "United Kingdom",
    "britain": "United Kingdom", "england": "United Kingdom",
    "scotland": "United Kingdom", "wales": "United Kingdom",
    "uae": "United Arab Emirates", "car": "Central African Republic",
    "capeverde": "Cabo Verde", "russia": "Russian Federation",
    "iran": "Iran", "syria": "Syrian Arab Republic", "vietnam": "Viet Nam",
    "laos": "Lao People's Democratic Republic", "southkorea": "Korea, Republic of",
    "korea": "Korea, Republic of", "northkorea": "Korea, Democratic People's Republic of",
    "moldova": "Moldova, Republic of", "tanzania": "Tanzania, United Republic of",
    "venezuela": "Venezuela, Bolivarian Republic of",
    "bolivia": "Bolivia, Plurinational State of", "czech": "Czechia",
    "czechrepublic": "Czechia", "czechia": "Czechia", "macedonia": "North Macedonia",
    "swaziland": "Eswatini", "ivorycoast": "Côte d'Ivoire", "drc": "Congo",
    "taiwan": "Taiwan, Province of China", "palestine": "Palestine, State of",
    "brunei": "Brunei Darussalam", "turkey": "Türkiye", "turkiye": "Türkiye",
}

# country main language (compact, major countries) for last-ditch language guess
COUNTRY_MAIN_LANG = {
    "Germany": "German", "Austria": "German", "France": "French", "Italy": "Italian",
    "Spain": "Spanish", "Mexico": "Spanish", "Argentina": "Spanish", "Peru": "Spanish",
    "Colombia": "Spanish", "Chile": "Spanish", "Brazil": "Portuguese",
    "Portugal": "Portuguese", "Russian Federation": "Russian", "Greece": "Greek",
    "Türkiye": "Turkish", "Poland": "Polish", "Netherlands": "Dutch",
    "Japan": "Japanese", "China": "Chinese", "Korea, Republic of": "Korean",
    "Saudi Arabia": "Arabic", "Egypt": "Arabic", "Iran": "Persian",
    "India": "Hindi", "Sweden": "Swedish", "Norway": "Norwegian",
    "Finland": "Finnish", "Denmark": "Danish", "Romania": "Romanian",
    "Hungary": "Hungarian", "Czechia": "Czech", "Ukraine": "Ukrainian",
    "Israel": "Hebrew", "Thailand": "Thai", "Indonesia": "Indonesian",
    "United States": "English", "United Kingdom": "English",
}

LANG_ALIASES = {  # token (normed) -> canonical language label
    "deutsch": "German", "espanol": "Spanish", "francais": "French",
    "castellano": "Spanish", "brasil": "Portuguese", "mandarin": "Chinese",
    "cantonese": "Chinese", "farsi": "Persian", "azeri": "Azerbaijani",
}

GENRES = {  # normalized token -> canonical category label
    "60s": "60s", "70s": "70s", "80s": "80s", "90s": "90s", "00s": "00s",
    "10s": "10s", "20s": "20s", "30s": "30s", "40s": "40s", "50s": "50s",
    "2000s": "00s", "2010s": "10s", "8080s": "80s",
    "acidjazz": "acid_jazz", "acid": "acid", "acoustic": "acoustic",
    "alternative": "alternative", "alternativerock": "alternative", "ambient": "ambient",
    "americana": "americana", "anime": "anime", "bachata": "latin", "bigband": "big_band",
    "blues": "blues", "bluesrock": "blues", "bluegrass": "bluegrass",
    "breakbeat": "breakbeat", "chillout": "chillout", "chill": "chillout",
    "christian": "christian", "christmas": "christmas", "classic": "classical",
    "classical": "classical", "classicrock": "rock", "club": "club", "comedy": "comedy",
    "country": "country", "culture": "culture", "dance": "dance", "disco": "disco",
    "discofox": "discofox", "downtempo": "downtempo", "drama": "drama",
    "drumandbass": "drum_and_bass", "dnb": "drum_and_bass", "dubstep": "dubstep",
    "easylistening": "easy_listening", "ebm": "ebm", "edm": "electronic",
    "electronic": "electronic", "electro": "electronic", "eurodance": "eurodance",
    "film": "film", "folk": "folk", "funk": "funk", "goa": "goa", "gospel": "gospel",
    "gothic": "gothic", "grime": "grime", "hardcore": "hardcore", "hardrock": "hardrock",
    "hiphop": "hip_hop", "hip": "hip_hop", "rap": "rap", "house": "house",
    "indie": "indie", "industrial": "industrial", "instrumental": "instrumental",
    "jazz": "jazz", "smoothjazz": "smooth_jazz", "jpop": "jpop", "kpop": "kpop",
    "jungle": "jungle", "latin": "latin", "lounge": "lounge", "metal": "metal",
    "blackmetal": "metal", "musical": "musical", "news": "news", "oldies": "oldies",
    "opera": "opera", "pop": "pop", "progressive": "progressive", "punk": "punk",
    "quran": "quran", "azan": "religious", "bible": "religious", "rnb": "rnb",
    "reggae": "reggae", "reggaeton": "latin", "retro": "retro", "rock": "rock",
    "salsa": "salsa", "schlager": "schlager", "ska": "ska", "soul": "soul",
    "soundtrack": "soundtrack", "spiritual": "spiritual", "sport": "sport",
    "sports": "sport", "swing": "swing", "symphonic": "symphonic", "talk": "talk",
    "techno": "techno", "top40": "top_40", "trance": "trance", "trap": "trap",
    "urban": "urban", "wave": "wave", "children": "children", "kids": "children",
    "baroque": "classical", "afrobeat": "african", "afrobeats": "african",
    "afro": "african", "salsa": "salsa", "world": "world",
}

# regex-able genre keywords to scan inside station names (high-precision subset)
NAME_GENRE = [
    ("jazz", "jazz"), ("classical", "classical"), ("classic rock", "rock"),
    ("rock", "rock"), ("metal", "metal"), ("reggae", "reggae"), ("blues", "blues"),
    ("country", "country"), ("gospel", "gospel"), ("christian", "christian"),
    ("quran", "quran"), ("dance", "dance"), ("techno", "techno"), ("trance", "trance"),
    ("house", "house"), ("hip hop", "hip_hop"), ("hip-hop", "hip_hop"),
    ("oldies", "oldies"), ("lounge", "lounge"), ("chill", "chillout"),
    ("salsa", "salsa"), ("schlager", "schlager"), ("news", "news"),
    ("talk", "talk"), ("sport", "sport"), ("disco", "disco"), ("folk", "folk"),
    ("electro", "electronic"), ("ambient", "ambient"), ("opera", "opera"),
]

JUNK_TOKENS = {
    "other", "others", "local", "music", "radio", "fm", "am", "na", "various",
    "varios", "mixed", "mix", "misc", "all", "top", "hits", "hit", "best",
    "favorites", "favourite", "autodj", "stream", "online", "live", "web",
    "default", "undefined", "unknown", "none", "test", "new", "more", "extra",
    "general", "station", "channel", "audio", "http", "www", "com", "the",
    "and", "for", "loca", "loy", "aaa", "abc", "fmradio", "internet", "digital",
}


def build_lookups():
    country = dict(COUNTRY_ALIASES)
    for c in pycountry.countries:
        for attr in ("name", "official_name", "common_name"):
            v = getattr(c, attr, None)
            if v:
                country[norm(v)] = c.name
    # languages with an ISO 639-1 alpha_2 (the ~180 major ones) — precise enough
    lang = dict(LANG_ALIASES)
    alpha2_lang = {}
    for lg in pycountry.languages:
        a2 = getattr(lg, "alpha_2", None)
        if a2:
            lang[norm(lg.name)] = lg.name
            alpha2_lang[a2.lower()] = lg.name
    # ccTLD -> country (alpha_2 lowercased), with the usual exceptions
    tld = {}
    for c in pycountry.countries:
        tld[c.alpha_2.lower()] = c.name
    tld["uk"] = "United Kingdom"
    return country, lang, alpha2_lang, tld


COUNTRY, LANG, ALPHA2_LANG, TLD = build_lookups()
# vanity ccTLDs widely used by streaming services, not a real country signal
TLD_BLACKLIST = {"fm", "am", "tv", "io", "cc", "me", "ws", "to", "ly", "gg",
                 "sh", "ai", "st", "mu", "dj", "fx"}
PAREN_RE = re.compile(r"^(.*?)[ _]*\((.+)\)\s*$")


def classify_token(token: str):
    """Return dict with optional category/country/language for one filename token."""
    out = {}
    raw = token
    # zeno-style "Language_(Country)"
    m = PAREN_RE.match(token)
    if m:
        left, right = m.group(1), m.group(2)
        if norm(left) in LANG:
            out["language"] = LANG[norm(left)]
        if norm(right) in COUNTRY:
            out["country"] = COUNTRY[norm(right)]
        token = left  # continue classifying the left part for category etc.
    nt = norm(token)
    if not nt or nt in JUNK_TOKENS or nt.isdigit():
        return out
    # radio.menu "lang-XX" ISO codes
    lm = re.match(r"^lang[-_]?([a-z]{2,3})$", token.lower())
    if lm and lm.group(1) in ALPHA2_LANG:
        out.setdefault("language", ALPHA2_LANG[lm.group(1)])
        return out
    # genre / decade (curated)
    if nt in GENRES:
        out.setdefault("category", GENRES[nt])
    # language (full name, major langs only)
    if "language" not in out and nt in LANG:
        out["language"] = LANG[nt]
    # country (full names + aliases)
    if "country" not in out and nt in COUNTRY:
        out["country"] = COUNTRY[nt]
    return out


# script-block -> language for name-based detection
SCRIPT_LANG = [
    ("ARABIC", "Arabic"), ("CYRILLIC", "Russian"), ("GREEK", "Greek"),
    ("HEBREW", "Hebrew"), ("HIRAGANA", "Japanese"), ("KATAKANA", "Japanese"),
    ("HANGUL", "Korean"), ("THAI", "Thai"), ("DEVANAGARI", "Hindi"),
    ("CJK", "Chinese"),
]


def detect_script_lang(name: str):
    counts = {}
    letters = 0
    for ch in name:
        if not ch.isalpha():
            continue
        letters += 1
        try:
            blk = unicodedata.name(ch).split(" ")[0]
        except ValueError:
            continue
        for key, lang in SCRIPT_LANG:
            if blk.startswith(key) or (key == "CJK" and "CJK" in unicodedata.name(ch)):
                counts[lang] = counts.get(lang, 0) + 1
                break
    if letters and counts:
        lang, c = max(counts.items(), key=lambda kv: kv[1])
        if c / letters >= 0.3:
            return lang
    return None


NAME_GENRE_RE = [(re.compile(r"\b" + re.escape(k) + r"\b", re.I), v)
                 for k, v in NAME_GENRE]


def name_genre(name: str):
    for rx, v in NAME_GENRE_RE:
        if rx.search(name):
            return v
    return None


def host_tld(url_norm: str):
    host = url_norm.split("/", 1)[0].split(":", 1)[0]
    if re.match(r"^[0-9.]+$", host):  # bare IP
        return None
    parts = host.rsplit(".", 1)
    return parts[-1].lower() if len(parts) == 2 else None


def main():
    con = sqlite3.connect(DB)
    t0 = time.time()

    # 1) classify the bounded token vocabulary once
    tokens = {}
    for (sf,) in con.execute("SELECT DISTINCT source_file FROM stations_dedup"):
        tk = os.path.basename(sf)[:-4]
        if tk not in tokens:
            tokens[tk] = classify_token(tk)
    print(f"classified {len(tokens)} distinct tokens in {time.time()-t0:.1f}s", flush=True)

    # 2) apply per station
    con.execute("DROP TABLE IF EXISTS facets")
    con.execute(
        """CREATE TABLE facets(
            url_norm TEXT PRIMARY KEY, category TEXT, country TEXT, language TEXT,
            cat_src TEXT, country_src TEXT, lang_src TEXT)"""
    )
    rows = con.execute(
        "SELECT url_norm, name, source_file, url FROM stations_dedup"
    )
    batch, n = [], 0
    for url_norm, name, sf, url in rows:
        name = name or ""
        tk = os.path.basename(sf)[:-4]
        tf = tokens.get(tk, {})
        # category
        cat, cat_src = tf.get("category"), "token" if tf.get("category") else None
        if not cat:
            g = name_genre(name)
            if g:
                cat, cat_src = g, "name"
        # country
        country, country_src = tf.get("country"), "token" if tf.get("country") else None
        if not country:
            tld = host_tld(url_norm)
            if tld and tld in TLD and tld not in TLD_BLACKLIST:
                country, country_src = TLD[tld], "tld"
        # language
        lang, lang_src = tf.get("language"), "token" if tf.get("language") else None
        if not lang:
            sl = detect_script_lang(name)
            if sl:
                lang, lang_src = sl, "script"
            elif country and country in COUNTRY_MAIN_LANG:
                lang, lang_src = COUNTRY_MAIN_LANG[country], "country"
        batch.append((url_norm, cat, country, lang, cat_src, country_src, lang_src))
        if len(batch) >= 20000:
            con.executemany("INSERT OR REPLACE INTO facets VALUES(?,?,?,?,?,?,?)", batch)
            n += len(batch); batch.clear()
    if batch:
        con.executemany("INSERT OR REPLACE INTO facets VALUES(?,?,?,?,?,?,?)", batch)
        n += len(batch)
    con.commit()

    # 3) coverage report
    def cnt(q):
        return con.execute(q).fetchone()[0]
    total = cnt("SELECT COUNT(*) FROM facets")
    print(f"\nclassified {n} stations in {time.time()-t0:.1f}s")
    for facet in ("category", "country", "language"):
        have = cnt(f"SELECT COUNT(*) FROM facets WHERE {facet} IS NOT NULL")
        print(f"  {facet:9}: {have:>9} ({100*have/total:.1f}%)")
    none = cnt("SELECT COUNT(*) FROM facets WHERE category IS NULL "
               "AND country IS NULL AND language IS NULL")
    print(f"  unclassified (no facet at all): {none} ({100*none/total:.1f}%)")
    print("\n  top categories:")
    for v, c in con.execute("SELECT category,COUNT(*) FROM facets WHERE category IS NOT NULL GROUP BY category ORDER BY 2 DESC LIMIT 12"):
        print(f"    {c:>8}  {v}")
    print("  top countries:")
    for v, c in con.execute("SELECT country,COUNT(*) FROM facets WHERE country IS NOT NULL GROUP BY country ORDER BY 2 DESC LIMIT 12"):
        print(f"    {c:>8}  {v}")
    print("  top languages:")
    for v, c in con.execute("SELECT language,COUNT(*) FROM facets WHERE language IS NOT NULL GROUP BY language ORDER BY 2 DESC LIMIT 12"):
        print(f"    {c:>8}  {v}")
    con.executemany("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)",
                    [("classify_secs", f"{time.time()-t0:.1f}")])
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
