_DIVISIONS = (
    ("A", 100, 999),
    ("B", 1000, 1499),
    ("C", 1500, 1799),
    ("D", 2000, 3999),
    ("E", 4000, 4999),
    ("F", 5000, 5199),
    ("G", 5200, 5999),
    ("I", 7000, 8999),
    ("J", 9100, 9999),
)


def classify(sic: str) -> str | None:
    sic_numeric = int(sic)
    for division, low, high in _DIVISIONS:
        if low <= sic_numeric <= high:
            return division

    return None
