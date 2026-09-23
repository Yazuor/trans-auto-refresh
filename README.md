# Trans Auto Refresh

Automatyczne odswiezanie ofert frachtowych w Trans.eu przez Tampermonkey.

Aktualna wersja: **2.45**

## Instalacja

1. Zainstaluj rozszerzenie **Tampermonkey** w przegladarce.
2. Otworz link instalacyjny:

   https://raw.githubusercontent.com/Yazuor/trans-auto-refresh/refs/heads/main/Trans%20Auto%20Refresh.user.js

3. Tampermonkey pokaze okno instalacji skryptu. Kliknij **Zainstaluj**.
4. Wejdz na:

   https://platform.trans.eu/freights/sent

Skrypt uruchomi sie automatycznie na stronie dodanych frachtow.

## Co robi skrypt

- pobiera oferty bezposrednio z API Trans.eu,
- odswieza oferty natywnym mechanizmem Trans.eu,
- pomija oferty w cooldownie,
- ogranicza duplikaty,
- odklada oferty z bledem 429 i nadaje im priorytet w kolejnym cyklu,
- pobiera strony listy pojedynczo i bezpiecznie ponawia strone po GET 401/403,
- pilnuje, aby skrypt nie pracowal podwojnie w kilku kartach,
- pokazuje dashboard z licznikami i statusem,
- zapisuje ostatnie bledy w panelu **Logi**.

## Ustawienia

Ustawienia sa dostepne pod ikona kola zebatego w dashboardzie.

Najwazniejsze opcje:

- start cyklu co ile minut,
- lokalny cooldown,
- limit ofert na cykl z rotacyjnym przechodzeniem listy,
- pauza po bledzie 429,
- pauza prewencyjna po okreslonej liczbie ofert,
- wlaczanie i wylaczanie autorow ofert.

Zmiany w ustawieniach zaczynaja dzialac od nastepnego cyklu.

## Logi bledow

Przycisk **Logi** w dashboardzie pokazuje ostatnie bledy.

Dostepne akcje:

- **Kopiuj** - kopiuje pelna liste bledow do schowka,
- **Wyczysc** - usuwa lokalna historie bledow.

Limit historii: **50 ostatnich bledow**. Wpisy 429 zawieraja dane potrzebne do
rozpoznania ograniczenia lub wyzwania Cloudflare.

## Zdalna konfiguracja

Skrypt pobiera plik:

https://raw.githubusercontent.com/Yazuor/trans-auto-refresh/refs/heads/main/config.json

Przykladowa konfiguracja:

```json
{
  "enabled": true,
  "latestVersion": "2.45",
  "message": ""
}
```

Znaczenie pol:

- `enabled: true` - skrypt dziala,
- `enabled: false` - skrypt zostaje zdalnie zatrzymany,
- `latestVersion` - najnowsza opublikowana wersja,
- `message` - komunikat wyswietlany w dashboardzie.

Konfiguracja jest pobierana przy starcie, a podczas pracy ponownie nie czesciej
niz raz na 2 godziny. Blad pobrania nie zatrzymuje skryptu.

## Aktualizacje

Tampermonkey sprawdza aktualizacje skryptow automatycznie.

Po opublikowaniu nowej wersji:

1. wrzuc nowy plik `Trans Auto Refresh.user.js`,
2. ustaw w `config.json` nowy numer `latestVersion`,
3. uzytkownicy zobacza komunikat o dostepnej aktualizacji.
