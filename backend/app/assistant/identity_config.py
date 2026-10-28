"""Central RA-ONE identity — display vs spoken pronunciation."""

from __future__ import annotations

IDENTITY = {
    "display_name": "RA-ONE",
    "spoken_name": "Raw-One",
    "phonetic_spoken_name": "Rawwun",
    "canonical_id": "ra_one",
    "voice_phonetics": {
        "en_US-bryce-medium": "Raw-One",
        "en_US-joe-medium": "Raw-One",
        "en_GB-alan-medium": "Raw-One",
    },
}

WAKE_DICTIONARY = {
    "greetings": ["hey", "hi", "hello"],
    "name_aliases": [
        "ra-one",
        "ra one",
        "raone",
        "raw one",
        "raw-one",
        "rawone",
        "ray one",
        "ray-one",
        "r a one",
        "r-a-one",
        "are a one",
        "r one",
    ],
}

SLEEP_COMMANDS = [
    "go to sleep",
    "sleep now",
    "stop listening",
    "go sleep",
]
