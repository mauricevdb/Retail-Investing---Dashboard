from dashboard.app.screen_view import render_screen_text


def test_no_index_label_in_ui() -> None:
    text = render_screen_text(retained_count=12)

    # Aucune occurrence de « S&P » -- ni comme mesure d'une statistique, ni
    # ailleurs : la mention d'univers défini par règle n'a pas besoin de
    # nommer un indice publié pour le nier.
    assert "S&P" not in text

    # La mention d'univers défini par règle est présente.
    assert "défini par" in text

    # La statistique elle-même (compteur de titres retenus) est bien
    # rendue, y compris quand elle vaut zéro.
    assert "12" in render_screen_text(retained_count=12)
    assert "0" in render_screen_text(retained_count=0)
