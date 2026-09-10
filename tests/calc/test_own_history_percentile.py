from dashboard.calc.percentiles import own_history_percentile


def test_own_history_percentile_and_years() -> None:
    # Émetteur introduit en 2019 : six lectures annuelles (2019-2024), plus
    # une entrée 2010 hors plage -- ne doit pas gonfler le compte au-delà
    # de six ans, même si elle est présente dans les données fournies.
    historical_values = [
        (2010, 5.0),
        (2019, 10.0),
        (2020, 12.0),
        (2021, 15.0),
        (2022, 9.0),
        (2023, 11.0),
        (2024, 20.0),
    ]

    percentile, years_available = own_history_percentile(
        historical_values, t_year=2024, since_year=2011
    )

    assert years_available == 6

    # La valeur de 2024 (20.0) est la plus haute des six années retenues :
    # percentile de 100 %.
    assert percentile == 1.0
