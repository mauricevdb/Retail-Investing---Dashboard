_UNIVERSE_CAPTION = (
    "Univers défini par une règle interne de capitalisation boursière, "
    "après exclusion de la finance, de l'assurance, de l'immobilier, des "
    "fonds et des ETF. Ne réplique et ne mesure aucun indice publié."
)


def render_screen_text(retained_count: int) -> str:
    return f"{_UNIVERSE_CAPTION}\n{retained_count} titre(s) retenu(s) aujourd'hui."
