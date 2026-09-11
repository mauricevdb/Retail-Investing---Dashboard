_UNIVERSE_CAPTION = (
    "Univers défini par une règle interne de capitalisation boursière, "
    "après exclusion de la finance, de l'assurance, de l'immobilier, des "
    "fonds et des ETF. Ne réplique et ne mesure aucun indice publié."
)


def render_screen_text(retained_count: int, non_calculable_shares_count: int = 0) -> str:
    text = f"{_UNIVERSE_CAPTION}\n{retained_count} titre(s) retenu(s) aujourd'hui."
    if non_calculable_shares_count > 0:
        text += (
            f"\n{non_calculable_shares_count} titre(s) non calculable(s) pour le "
            "classement (actions en circulation introuvables)."
        )
    return text
