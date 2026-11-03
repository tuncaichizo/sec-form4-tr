# sec-form4-tr

SEC Form 4 içeriden alım-satımları (P/S kodlu, ≥1M $), Türkçe alanlarla JSON.

`son-islemler.json`: non-derivative purchases (code P) and sales (code S) from SEC Form 4 filings, aggregated per filing; a filing is listed when its dominant side totals at least $1,000,000. Source: SEC EDGAR (latest filings Atom feed + filing XML), refreshed by a GitHub Action every 10 minutes.

Schema: `{ guncellendi, kayitlar: [ { tarih, dosyalama, ticker, sirket, kisi, unvan, tur ("alim"|"satim"), adet, fiyat, toplam_usd, sec_link } ] }`, at most 50 records, newest filing first. Processing state lives in the Actions cache, not in the repo.

Not investment advice.
