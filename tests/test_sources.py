from datetime import date

from ridash.sources.eodhd import parse_history, parse_quotes
from ridash.sources.finra import parse_short_interest
from ridash.sources.sec import html_to_text, parse_form4, parse_frame, pick_exhibit


def test_parse_frame_normalises_values_and_dates():
    raw = {
        "data": [
            {"accn": "0001-26-1", "cik": 1800, "end": "2025-12-31", "val": 8053000000},
            {"accn": "0002-26-1", "cik": 1750, "end": "2025-05-31", "val": 1.5},
        ]
    }
    frame = parse_frame(raw, "OperatingIncomeLoss")
    assert frame.row(0) == (1800, "OperatingIncomeLoss", date(2025, 12, 31), 8.053e9, "0001-26-1")
    assert frame["value"].to_list()[1] == 1.5


def test_parse_history_keeps_adjusted_close():
    raw = [{"date": "2026-10-16", "close": 230.0, "adjusted_close": 229.5, "volume": 1}]
    assert parse_history(raw, "AAPL").row(0) == ("AAPL", date(2026, 10, 16), 229.5)
    assert parse_history(None, "GONE").is_empty()


def test_missing_frame_is_empty():
    assert parse_frame(None, "OperatingIncomeLoss").is_empty()


def test_parse_quotes_attaches_exchange_and_currency():
    bulk = [
        {
            "code": "AAPL",
            "date": "2026-09-23",
            "type": "Common Stock",
            "close": 230.1,
            "MarketCapitalization": 3_400_000_000_000,
            "avgvol_50d": 5e7,
        }
    ]
    listings = [{"Code": "AAPL", "Exchange": "NASDAQ", "Currency": "USD"}]
    quote = parse_quotes(bulk, listings).row(0, named=True)
    assert (quote["exchange"], quote["currency"], quote["market_cap"]) == ("NASDAQ", "USD", 3.4e12)
    assert quote["date"] == date(2026, 9, 23)


FORM4 = b"""<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <aff10b5One>1</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-09-16</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>25.5</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-09-16</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>5000</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>"""


def test_parse_form4_keeps_open_market_trades_only():
    assert parse_form4(FORM4) == [
        {
            "date": "2026-09-16",
            "insider": "Doe Jane",
            "title": "CEO",
            "code": "S",
            "shares": 10000.0,
            "value": 255000.0,
            "planned": True,
        }
    ]


def test_pick_exhibit_prefers_the_press_release():
    names = ["x-8k.htm", "x-ex99d2.htm", "x-ex99d1.htm", "x-ex99d1001.jpg", "R1.htm"]
    assert pick_exhibit(names) == "x-ex99d1.htm"
    assert pick_exhibit(["a.htm", "exhibit991.htm"]) == "exhibit991.htm"
    assert pick_exhibit(["a.htm"]) is None


def test_html_to_text_keeps_words_and_line_breaks():
    markup = (
        "<html><style>p{}</style><p>Revenue&nbsp;up <b>12%</b></p>"
        "<table><tr><td>Q2</td><td>$5</td></tr></table>"
    )
    assert html_to_text(markup) == "Revenue up 12%\nQ2 $5"


def test_parse_short_interest_reads_finra_file():
    body = (
        b'"accountingYearMonthNumber"|"symbolCode"|"issueName"|"issuerServicesGroupExchangeCode"|'
        b'"marketClassCode"|"currentShortPositionQuantity"|"previousShortPositionQuantity"|'
        b'"stockSplitFlag"|"averageDailyVolumeQuantity"|"daysToCoverQuantity"|"revisionFlag"|'
        b'"changePercent"|"changePreviousNumber"|"settlementDate"\n'
        b'"20260930"|"HRMY"|"Harmony"|"R"|"NNM"|"5532301"|"4628716"||"1108114"|"4.99"||"19.52"|'
        b'"903585"|"2026-09-30"\n'
    )
    row = parse_short_interest(body).row(0, named=True)
    assert row == {
        "ticker": "HRMY",
        "short_date": date(2026, 9, 30),
        "short_shares": 5532301.0,
        "short_shares_prev": 4628716.0,
        "days_to_cover": 4.99,
    }
