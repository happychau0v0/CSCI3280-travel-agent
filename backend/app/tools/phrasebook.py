"""Tiny travel phrasebook keyed by language.

Round 17 — lookup helper that returns a handful of essential phrases
for common destinations. The LLM can call this tool to surface useful
local language bits the user sees in the DAYS panel.

This is intentionally a hand-curated static table, not a translation
API — it's enough for "hello / thank you / where's the bathroom"
tourist phrases without an external dependency.
"""
from __future__ import annotations


PHRASEBOOKS: dict[str, dict] = {
    "ja": {
        "language": "Japanese",
        "hello": ("Konnichiwa", "こんにちは"),
        "thank_you": ("Arigatou gozaimasu", "ありがとうございます"),
        "please": ("Onegaishimasu", "お願いします"),
        "excuse_me": ("Sumimasen", "すみません"),
        "yes": ("Hai", "はい"),
        "no": ("Iie", "いいえ"),
        "where_is_bathroom": ("Toire wa doko desu ka?", "トイレはどこですか？"),
        "how_much": ("Ikura desu ka?", "いくらですか？"),
        "delicious": ("Oishii!", "美味しい！"),
        "goodbye": ("Sayonara", "さようなら"),
    },
    "ko": {
        "language": "Korean",
        "hello": ("Annyeonghaseyo", "안녕하세요"),
        "thank_you": ("Gamsahamnida", "감사합니다"),
        "please": ("Juseyo", "주세요"),
        "excuse_me": ("Sillyehamnida", "실례합니다"),
        "yes": ("Ne", "네"),
        "no": ("Aniyo", "아니요"),
        "where_is_bathroom": ("Hwajangsil-i eodiye isseoyo?", "화장실이 어디에 있어요?"),
        "how_much": ("Eolmayeyo?", "얼마예요?"),
        "delicious": ("Masisseoyo!", "맛있어요!"),
        "goodbye": ("Annyeonghi gaseyo", "안녕히 가세요"),
    },
    "zh": {
        "language": "Mandarin",
        "hello": ("Nǐ hǎo", "你好"),
        "thank_you": ("Xièxiè", "谢谢"),
        "please": ("Qǐng", "请"),
        "excuse_me": ("Duìbùqǐ", "对不起"),
        "yes": ("Shì", "是"),
        "no": ("Bù", "不"),
        "where_is_bathroom": ("Cèsuǒ zài nǎlǐ?", "厕所在哪里？"),
        "how_much": ("Duōshǎo qián?", "多少钱？"),
        "delicious": ("Hǎo chī!", "好吃！"),
        "goodbye": ("Zàijiàn", "再见"),
    },
    "fr": {
        "language": "French",
        "hello": ("Bonjour", "Bonjour"),
        "thank_you": ("Merci", "Merci"),
        "please": ("S'il vous plaît", "S'il vous plaît"),
        "excuse_me": ("Excusez-moi", "Excusez-moi"),
        "yes": ("Oui", "Oui"),
        "no": ("Non", "Non"),
        "where_is_bathroom": ("Où sont les toilettes?", "Où sont les toilettes?"),
        "how_much": ("Combien ça coûte?", "Combien ça coûte?"),
        "delicious": ("Délicieux!", "Délicieux!"),
        "goodbye": ("Au revoir", "Au revoir"),
    },
    "es": {
        "language": "Spanish",
        "hello": ("Hola", "Hola"),
        "thank_you": ("Gracias", "Gracias"),
        "please": ("Por favor", "Por favor"),
        "excuse_me": ("Disculpe", "Disculpe"),
        "yes": ("Sí", "Sí"),
        "no": ("No", "No"),
        "where_is_bathroom": ("¿Dónde está el baño?", "¿Dónde está el baño?"),
        "how_much": ("¿Cuánto cuesta?", "¿Cuánto cuesta?"),
        "delicious": ("¡Delicioso!", "¡Delicioso!"),
        "goodbye": ("Adiós", "Adiós"),
    },
    "de": {
        "language": "German",
        "hello": ("Hallo", "Hallo"),
        "thank_you": ("Danke", "Danke"),
        "please": ("Bitte", "Bitte"),
        "excuse_me": ("Entschuldigung", "Entschuldigung"),
        "yes": ("Ja", "Ja"),
        "no": ("Nein", "Nein"),
        "where_is_bathroom": ("Wo ist die Toilette?", "Wo ist die Toilette?"),
        "how_much": ("Wie viel kostet das?", "Wie viel kostet das?"),
        "delicious": ("Lecker!", "Lecker!"),
        "goodbye": ("Auf Wiedersehen", "Auf Wiedersehen"),
    },
    "it": {
        "language": "Italian",
        "hello": ("Ciao", "Ciao"),
        "thank_you": ("Grazie", "Grazie"),
        "please": ("Per favore", "Per favore"),
        "excuse_me": ("Mi scusi", "Mi scusi"),
        "yes": ("Sì", "Sì"),
        "no": ("No", "No"),
        "where_is_bathroom": ("Dov'è il bagno?", "Dov'è il bagno?"),
        "how_much": ("Quanto costa?", "Quanto costa?"),
        "delicious": ("Delizioso!", "Delizioso!"),
        "goodbye": ("Arrivederci", "Arrivederci"),
    },
    "th": {
        "language": "Thai",
        "hello": ("Sawadee-krub/ka", "สวัสดี"),
        "thank_you": ("Khob khun", "ขอบคุณ"),
        "please": ("Ga ru na", "กรุณา"),
        "excuse_me": ("Khor thot", "ขอโทษ"),
        "yes": ("Chai", "ใช่"),
        "no": ("Mai", "ไม่"),
        "where_is_bathroom": ("Hong nam yoo tee nai?", "ห้องน้ำอยู่ที่ไหน?"),
        "how_much": ("Tao rai?", "เท่าไร?"),
        "delicious": ("Aroi!", "อร่อย!"),
        "goodbye": ("La gon", "ลาก่อน"),
    },
}


# Country → language code. Used when the LLM calls the tool with a
# country or city name rather than a language.
COUNTRY_TO_LANG: dict[str, str] = {
    "japan": "ja",
    "tokyo": "ja",
    "osaka": "ja",
    "kyoto": "ja",
    "korea": "ko",
    "south korea": "ko",
    "seoul": "ko",
    "china": "zh",
    "shanghai": "zh",
    "beijing": "zh",
    "taiwan": "zh",
    "taipei": "zh",
    "france": "fr",
    "paris": "fr",
    "spain": "es",
    "madrid": "es",
    "barcelona": "es",
    "mexico": "es",
    "germany": "de",
    "berlin": "de",
    "munich": "de",
    "italy": "it",
    "rome": "it",
    "milan": "it",
    "thailand": "th",
    "bangkok": "th",
    "phuket": "th",
}


async def get_phrasebook(destination: str) -> dict:
    """Return a phrasebook for the destination's local language.

    Args:
        destination: city, country, or language name. Case-insensitive.

    Returns:
        {language: "Japanese", phrases: [{key, romanized, native}, ...]}
        or {error: "..."} when the destination doesn't map to a
        supported language.
    """
    key = (destination or "").strip().lower()
    # Strip "," suffix
    if "," in key:
        key = key.split(",", 1)[0].strip()
    lang = COUNTRY_TO_LANG.get(key)
    if not lang and key in PHRASEBOOKS:
        lang = key
    if not lang:
        return {"error": f"No phrasebook for {destination}"}
    book = PHRASEBOOKS[lang]
    phrases = []
    for phrase_key, value in book.items():
        if phrase_key == "language":
            continue
        romanized, native = value
        phrases.append({
            "key": phrase_key,
            "english": phrase_key.replace("_", " ").capitalize() + "?"
            if phrase_key.startswith("where") or phrase_key == "how_much"
            else phrase_key.replace("_", " ").capitalize(),
            "romanized": romanized,
            "native": native,
        })
    return {
        "language": book["language"],
        "language_code": lang,
        "phrases": phrases,
    }
