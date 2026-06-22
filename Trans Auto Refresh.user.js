// ==UserScript==
// @name         Trans Auto Refresh
// @namespace    Trans
// @version      2.19
// @description  Automatyczne odświeżanie frachtów z panelem ustawień
// @match        https://platform.trans.eu/freights/sent*
// @updateURL    https://raw.githubusercontent.com/Yazuor/trans-auto-refresh/refs/heads/main/Trans%20Auto%20Refresh.user.js
// @downloadURL  https://raw.githubusercontent.com/Yazuor/trans-auto-refresh/refs/heads/main/Trans%20Auto%20Refresh.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Wersja produkcyjna sprawdzana przez GitHub Remote Config.
    // Trzymaj tę numerację spójnie z polem latestVersion w config.json.
    const SCRIPT_VERSION = "2.19";

    // Wklej tu pełny link RAW do config.json z GitHuba.
    // Przykład: https://raw.githubusercontent.com/user/repo/main/config.json
    // Pusty adres oznacza: Remote Config pominięty, skrypt działa normalnie.
    const REMOTE_CONFIG_URL = "https://raw.githubusercontent.com/Yazuor/trans-auto-refresh/refs/heads/main/config.json";

    // Maksymalny czas oczekiwania na GitHub config. Po timeout skrypt działa dalej.
    const REMOTE_CONFIG_TIMEOUT = 5000;

    // Co ile startuje pełny cykl po zakończeniu poprzedniego cyklu.
    // Przy limicie duplikatów krótki cykl dawkuje podobne oferty zamiast wrzucać całą paczkę naraz.
    const REFRESH_INTERVAL = 1 * 60 * 1000;

    // Jak długo skrypt pamięta oferty odświeżone poprawnie albo zablokowane przez 422.
    // Dzięki temu po odświeżeniu karty nie pyta ponownie o te same oferty.
    const LOCAL_REFRESH_COOLDOWN = 15 * 60 * 1000;

    // Jak długo pomija oferty świeżo dodane według publication.publish_date / created_at.
    // Chroni przed odświeżaniem frachtów dodanych chwilę wcześniej.
    const FRESH_PUBLICATION_COOLDOWN = 15 * 60 * 1000;

    // Jeśli API przy 422 poda "available from" w przeszłości, dokładamy krótki bufor.
    // Z obserwacji wynika, że przesunięcie bywa małe, zwykle około 1-2 minut.
    const STALE_422_COOLDOWN = 2 * 60 * 1000;

    // Ten sam bufor stosujemy przed wysłaniem refresh, gdy czas wyliczamy z danych listy.
    // Dzięki temu nie pytamy API dokładnie na granicy 15 minut, gdzie Trans czasem zwraca jeszcze 422.
    const PRE_REFRESH_COOLDOWN_BUFFER = 2 * 60 * 1000;

    // Jeśli API przy 422 nie poda "available from", zostaje bezpieczny cooldown awaryjny.
    const MISSING_422_COOLDOWN = 15 * 60 * 1000;

    // Oferta zakończona/skasowana nie wróci szybko do aktywnych,
    // więc po takim 422 nie pytamy o nią ponownie przez dłuższy czas.
    const INACTIVE_PUBLICATION_COOLDOWN = 24 * 60 * 60 * 1000;

    // Ile stron listy ofert pobiera równolegle.
    // Dotyczy tylko GET /freights, nie przyspiesza requestów PUT /refresh.
    const PAGE_FETCH_BATCH_SIZE = 5;

    // Ile ofert pobiera jedna strona API freights.
    const FREIGHTS_PER_PAGE = 30;

    // Ile takich samych ofert od jednego autora może wejść do odświeżenia w jednym cyklu.
    // Reszta duplikatów jest tylko odłożona do następnego krótkiego cyklu, bez zapisu 15 min cooldownu.
    const DUPLICATE_GROUP_LIMIT_PER_CYCLE = 1;

    // Klucz localStorage z listą ofert w lokalnym cooldownie.
    const REFRESH_COOLDOWN_CACHE_KEY =
        "transAutoRefreshCooldownCache";

    // Klucz localStorage z miejscem, od którego skrypt ma wznowić przechodzenie listy.
    const REFRESH_CURSOR_KEY =
        "transAutoRefreshCursor";

    // Normalna przerwa między kolejnymi requestami refresh.
    const NORMAL_REFRESH_DELAY = 500;

    // Przerwa między requestami po pierwszym 429 w danym cyklu.
    const RATE_LIMITED_REFRESH_DELAY = 1500;

    // Domyślna pauza po 429, jeśli API nie poda nagłówka Retry-After.
    const RATE_LIMIT_PAUSE = 60 * 1000;

    // Liczba ofert po której skrypt robi pauzę prewencyjną.
    // Obecnie: po 150 ofertach robi pauzę określoną w PREVENTIVE_BATCH_PAUSE.
    const OFFERS_BEFORE_PREVENTIVE_PAUSE = 150;

    // Długość pauzy prewencyjnej.
    const PREVENTIVE_BATCH_PAUSE = 60 * 1000;

    // Nazwa blokady Web Locks API, żeby skrypt działał tylko w jednej karcie.
    const CROSS_TAB_LOCK_NAME = "trans-auto-refresh-active";

    // Awaryjna blokada między kartami dla przeglądarek bez Web Locks API.
    const FALLBACK_LOCK_KEY = "transAutoRefreshActiveTab";

    // Po jakim czasie awaryjna blokada karty jest uznawana za martwą.
    const FALLBACK_LOCK_TTL = 2 * 60 * 1000;

    // Jak często aktywna karta odnawia awaryjną blokadę.
    const FALLBACK_HEARTBEAT_INTERVAL = 10 * 1000;

    // Klucz localStorage z ustawieniami edytowanymi z dashboardu.
    const SETTINGS_KEY =
        "transAutoRefreshSettings";

    // Klucz localStorage z autorami wykrytymi w pobranych ofertach.
    const KNOWN_AUTHORS_KEY =
        "transAutoRefreshKnownAuthors";

    // Klucz localStorage z historią realnych błędów widoczną z dashboardu.
    const ERROR_LOG_KEY =
        "transAutoRefreshErrorLog";

    // Ile ostatnich błędów trzymamy do szybkiej diagnostyki.
    const ERROR_LOG_LIMIT = 50;

    // Domyślne ustawienia. Panel ustawień zapisuje tylko wartości użytkownika,
    // a kod nadal ma tu czytelne fabryczne wartości awaryjne.
    const SETTINGS_DEFAULTS = {
        refreshIntervalMinutes: REFRESH_INTERVAL / 60 / 1000,
        localCooldownMinutes: LOCAL_REFRESH_COOLDOWN / 60 / 1000,
        freshPublicationCooldownMinutes:
            FRESH_PUBLICATION_COOLDOWN / 60 / 1000,
        pageFetchBatchSize: PAGE_FETCH_BATCH_SIZE,
        duplicateGroupLimitPerCycle: DUPLICATE_GROUP_LIMIT_PER_CYCLE,
        normalRefreshDelayMs: NORMAL_REFRESH_DELAY,
        rateLimitedRefreshDelayMs: RATE_LIMITED_REFRESH_DELAY,
        rateLimitPauseSeconds: RATE_LIMIT_PAUSE / 1000,
        preventiveBatchSize: OFFERS_BEFORE_PREVENTIVE_PAUSE,
        preventiveBatchPauseSeconds: PREVENTIVE_BATCH_PAUSE / 1000,
        allowedAuthors: ""
    };

    // Unikalny identyfikator tej konkretnej karty przeglądarki.
    const tabId =
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let cycleCounter = 0;
    let dashboardMinimized = false;
    let scriptSettings =
        readScriptSettings();

    if (window.transRefreshRunning) {
        console.log("Trans Auto Refresh już działa");
        return;
    }

    window.transRefreshRunning = true;

    let dashboard = null;

    try {
        dashboard = createDashboard();
    } catch (e) {
        console.error("Błąd tworzenia dashboardu:", e);
    }

    function createDashboard() {
        const panel = document.createElement("div");

        panel.id = "trans-auto-refresh-dashboard";

        Object.assign(panel.style, {
            position: "fixed",
            left: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            width: "230px",
            padding: "14px 16px",
            boxSizing: "border-box",
            color: "#e5e7eb",
            background: "rgba(61, 66, 74, 0.97)",
            border: "2px solid #4ade80",
            borderRadius: "12px",
            boxShadow:
                "0 10px 30px rgba(0, 0, 0, 0.4), 0 0 18px rgba(74, 222, 128, 0.55), 0 0 4px rgba(74, 222, 128, 0.9)",
            fontFamily: "Arial, sans-serif",
            fontSize: "12px",
            lineHeight: "1.45",
            pointerEvents: "none"
        });

        panel.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 20px; margin: -5px -7px 2px -2px; pointer-events: auto;">
                    <button data-dashboard-action="logs" title="Historia błędów" type="button">Logi</button>
                <div style="display: flex; gap: 3px;">
                    <button data-dashboard-action="settings" title="Ustawienia skryptu" type="button">⚙</button>
                    <button data-dashboard-action="minimize" title="Minimalizuj dashboard" type="button">−</button>
                    <button data-dashboard-action="close" title="Zamknij dashboard" type="button">×</button>
                </div>
            </div>
            <div style="margin-bottom: 9px; color: #d1d5db; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; line-height: 19px; text-align: center;">
                TRANS AUTO REFRESH
            </div>
            <div data-remote-config-notice style="display: none;"></div>
            <div data-dashboard-content></div>
        `;

        const minimizeButton =
            panel.querySelector('[data-dashboard-action="minimize"]');

        const closeButton =
            panel.querySelector('[data-dashboard-action="close"]');

        const logsButton =
            panel.querySelector('[data-dashboard-action="logs"]');

        const settingsButton =
            panel.querySelector('[data-dashboard-action="settings"]');

        [logsButton, settingsButton, minimizeButton, closeButton]
            .forEach(button => {
            if (!button) {
                return;
            }

            Object.assign(button.style, {
                width: "20px",
                height: "20px",
                padding: "0",
                color: "#d1d5db",
                background: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.14)",
                borderRadius: "5px",
                fontFamily: "Arial, sans-serif",
                fontSize: "14px",
                lineHeight: "17px",
                cursor: "pointer"
            });
        });

        if (logsButton) {
            logsButton.style.width = "38px";
            logsButton.style.fontSize = "11px";
            logsButton.style.fontWeight = "700";
        }

        minimizeButton?.addEventListener(
            "click",
            toggleDashboardMinimized
        );

        closeButton?.addEventListener("click", () => {
            panel.style.display = "none";
        });

        settingsButton?.addEventListener(
            "click",
            openSettingsPanel
        );

        logsButton?.addEventListener(
            "click",
            openErrorLogPanel
        );

        (document.body || document.documentElement).appendChild(panel);

        setDashboardContent(`
            <div style="display: grid; grid-template-columns: 1fr auto; gap: 4px 12px;">
                <span>Oferty:</span><strong data-value="offers">0</strong>
                <span>Odświeżono:</span><strong data-value="refreshed">0</strong>
                <span>Pominięto:</span><strong data-value="skipped">0</strong>
                <span title="razem / odłożone do kolejnego cyklu">Duplikaty:</span><strong data-value="duplicates">0 / 0</strong>
                <span>Błędy:</span><strong data-value="errors" style="color: #4ade80;">0</strong>
                <span>Czas cyklu:</span><strong data-value="duration">-- min -- s</strong>
                <span data-next-start-label>Następny start:</span><strong data-value="nextStart">--:--:--</strong>
            </div>
        `, panel);

        return panel;
    }

    function setDashboardContent(html, panel = dashboard) {
        const content =
            panel?.querySelector("[data-dashboard-content]");

        if (content) {
            content.innerHTML = html;
        }
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function readKnownAuthors() {
        const authors =
            readJsonFromLocalStorage(
                KNOWN_AUTHORS_KEY,
                []
            );

        if (!Array.isArray(authors)) {
            return [];
        }

        return authors
            .filter(author =>
                author &&
                author.label &&
                author.normalized
            )
            .sort((a, b) =>
                a.label.localeCompare(
                    b.label,
                    "pl-PL"
                )
            );
    }

    function rememberKnownAuthors(authorLabels) {
        const authorsByKey =
            new Map(
                readKnownAuthors().map(author => [
                    author.normalized,
                    author
                ])
            );

        authorLabels.forEach(label => {
            const cleanLabel =
                String(label || "").trim();
            const normalized =
                normalizeDuplicateText(cleanLabel);

            if (!cleanLabel || !normalized) {
                return;
            }

            authorsByKey.set(
                normalized,
                {
                    label: cleanLabel,
                    normalized,
                    lastSeenAt: Date.now()
                }
            );
        });

        writeJsonToLocalStorage(
            KNOWN_AUTHORS_KEY,
            Array.from(authorsByKey.values())
                .sort((a, b) =>
                    b.lastSeenAt - a.lastSeenAt
                )
                .slice(0, 80)
        );
    }

    function splitAllowedAuthors(value) {
        return String(value || "")
            .split(/\r?\n/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    function getSelectedAuthorSet(settings) {
        return new Set(
            splitAllowedAuthors(settings.allowedAuthors)
                .map(normalizeDuplicateText)
                .filter(Boolean)
        );
    }

    function getAuthorToggleStyle(enabled) {
        return [
            "min-width: 44px",
            "padding: 4px 7px",
            "color: #ffffff",
            `background: ${enabled ? "#16a34a" : "#dc2626"}`,
            `border: 1px solid ${enabled ? "#86efac" : "#fca5a5"}`,
            "border-radius: 999px",
            "font-size: 11px",
            "font-weight: 700",
            "cursor: pointer"
        ].join("; ");
    }

    function renderAuthorToggleRows(settings) {
        const knownAuthors =
            readKnownAuthors();

        if (!knownAuthors.length) {
            return `
                <div style="padding: 8px; color: #cbd5e1; background: rgba(17,24,39,0.45); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px;">
                    Lista autorów pojawi się po pierwszym cyklu pobierania ofert.
                </div>
            `;
        }

        const selectedAuthors =
            getSelectedAuthorSet(settings);

        return knownAuthors.map(author => {
            const enabled =
                selectedAuthors.has(author.normalized);

            return `
                <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">
                    <span title="${escapeHtml(author.label)}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(author.label)}</span>
                    <button type="button" data-author-toggle data-author-label="${escapeHtml(author.label)}" data-enabled="${enabled}" style="${getAuthorToggleStyle(enabled)}">
                        ${enabled ? "TAK" : "NIE"}
                    </button>
                </div>
            `;
        }).join("");
    }

    function setAuthorToggleState(button, enabled) {
        button.dataset.enabled =
            String(enabled);
        button.textContent =
            enabled
                ? "TAK"
                : "NIE";
        button.setAttribute(
            "style",
            getAuthorToggleStyle(enabled)
        );
    }

    function wireAuthorToggles(panel) {
        panel
            .querySelectorAll("[data-author-toggle]")
            .forEach(button => {
                button.addEventListener("click", () => {
                    setAuthorToggleState(
                        button,
                        button.dataset.enabled !== "true"
                    );
                });
            });
    }

    function getSelectedAuthorsFromPanel(panel) {
        return Array.from(
            panel.querySelectorAll(
                '[data-author-toggle][data-enabled="true"]'
            )
        )
            .map(button => button.dataset.authorLabel)
            .filter(Boolean)
            .join("\n");
    }

    function closeSettingsPanel() {
        document
            .getElementById("trans-auto-refresh-settings")
            ?.remove();
    }

    function closeErrorLogPanel() {
        document
            .getElementById("trans-auto-refresh-error-log")
            ?.remove();
    }

    function formatErrorLogDate(timestamp) {
        return Number.isFinite(timestamp)
            ? new Date(timestamp).toLocaleString(
                "pl-PL",
                { hour12: false }
            )
            : "";
    }

    function renderErrorLogRows() {
        const entries =
            readErrorLog();

        if (!entries.length) {
            return `
                <div style="padding: 10px; color: #cbd5e1; background: rgba(17,24,39,0.45); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px;">
                    Brak zapisanych błędów.
                </div>
            `;
        }

        return entries.map(entry => `
            <div style="display: grid; grid-template-columns: 64px 1fr 126px; gap: 8px; align-items: start; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">
                <strong style="color: #fecaca;">${escapeHtml(entry.code)}</strong>
                <span style="color: #f3f4f6;">${escapeHtml(entry.description)}</span>
                <span style="color: #cbd5e1; text-align: right;">${escapeHtml(formatErrorLogDate(entry.at))}</span>
            </div>
        `).join("");
    }

    function openErrorLogPanel() {
        closeSettingsPanel();
        closeErrorLogPanel();

        const panel =
            document.createElement("div");

        panel.id = "trans-auto-refresh-error-log";

        Object.assign(panel.style, {
            position: "fixed",
            left: "262px",
            bottom: "16px",
            zIndex: "2147483647",
            width: "520px",
            maxHeight: "78vh",
            overflow: "auto",
            padding: "14px 16px",
            boxSizing: "border-box",
            color: "#e5e7eb",
            background: "rgba(61, 66, 74, 0.98)",
            border: "2px solid #ff5c68",
            borderRadius: "12px",
            boxShadow:
                "0 12px 34px rgba(0, 0, 0, 0.45), 0 0 20px rgba(255, 92, 104, 0.55)",
            fontFamily: "Arial, sans-serif",
            fontSize: "12px",
            lineHeight: "1.4",
            pointerEvents: "auto"
        });

        panel.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px;">
                <strong style="color: #fecaca; font-size: 13px;">LOGI BŁĘDÓW</strong>
                <div style="display: flex; gap: 6px;">
                    <button data-error-log-action="clear" type="button" style="padding: 4px 8px; color: #e5e7eb; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; cursor: pointer;">Wyczyść</button>
                    <button data-error-log-action="close" type="button" style="width: 22px; height: 22px; color: #d1d5db; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); border-radius: 5px; cursor: pointer;">×</button>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 64px 1fr 126px; gap: 8px; padding: 5px 0; color: #d1d5db; border-bottom: 1px solid rgba(255,255,255,0.18); font-weight: 700;">
                <span>Kod</span>
                <span>Opis</span>
                <span style="text-align: right;">Data</span>
            </div>
            <div data-error-log-rows style="max-height: 360px; overflow: auto;">
                ${renderErrorLogRows()}
            </div>
        `;

        panel
            .querySelector('[data-error-log-action="close"]')
            ?.addEventListener(
                "click",
                closeErrorLogPanel
            );

        panel
            .querySelector('[data-error-log-action="clear"]')
            ?.addEventListener("click", () => {
                writeErrorLog([]);

                const rows =
                    panel.querySelector("[data-error-log-rows]");

                if (rows) {
                    rows.innerHTML =
                        renderErrorLogRows();
                }
            });

        (document.body || document.documentElement).appendChild(panel);
    }

    function openSettingsPanel() {
        closeErrorLogPanel();
        closeSettingsPanel();

        const settings =
            readScriptSettings();

        const panel =
            document.createElement("div");

        panel.id = "trans-auto-refresh-settings";

        Object.assign(panel.style, {
            position: "fixed",
            left: "262px",
            bottom: "16px",
            zIndex: "2147483647",
            width: "390px",
            maxHeight: "78vh",
            overflow: "auto",
            padding: "14px 16px",
            boxSizing: "border-box",
            color: "#e5e7eb",
            background: "rgba(61, 66, 74, 0.98)",
            border: "2px solid #93c5fd",
            borderRadius: "12px",
            boxShadow:
                "0 12px 34px rgba(0, 0, 0, 0.45), 0 0 20px rgba(147, 197, 253, 0.5)",
            fontFamily: "Arial, sans-serif",
            fontSize: "12px",
            lineHeight: "1.4",
            pointerEvents: "auto"
        });

        const inputStyle =
            "width: 78px; box-sizing: border-box; padding: 4px 6px; color: #f9fafb; background: rgba(17, 24, 39, 0.72); border: 1px solid rgba(255,255,255,0.18); border-radius: 6px;";

        const authorToggleRows =
            renderAuthorToggleRows(settings);

        panel.innerHTML = `
            <form>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                    <strong style="color: #d1d5db; font-size: 13px;">USTAWIENIA AUTO REFRESH</strong>
                    <button data-settings-action="close" type="button" style="width: 22px; height: 22px; color: #d1d5db; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); border-radius: 5px; cursor: pointer;">×</button>
                </div>

                <div style="display: grid; grid-template-columns: 1fr auto; gap: 7px 10px; align-items: center;">
                    <label>Start cyklu co ile (min)</label>
                    <input name="refreshIntervalMinutes" type="number" min="0.5" step="0.5" value="${settings.refreshIntervalMinutes}" style="${inputStyle}">

                    <label>Lokalny cooldown (min)</label>
                    <input name="localCooldownMinutes" type="number" min="1" step="1" value="${settings.localCooldownMinutes}" style="${inputStyle}">

                    <label>Świeża oferta (min)</label>
                    <input name="freshPublicationCooldownMinutes" type="number" min="1" step="1" value="${settings.freshPublicationCooldownMinutes}" style="${inputStyle}">

                    <label>Strony pobierane równolegle</label>
                    <input name="pageFetchBatchSize" type="number" min="1" max="10" step="1" value="${settings.pageFetchBatchSize}" style="${inputStyle}">

                    <label>Duplikaty na grupę / cykl</label>
                    <input name="duplicateGroupLimitPerCycle" type="number" min="1" step="1" value="${settings.duplicateGroupLimitPerCycle}" style="${inputStyle}">

                    <label>Przerwa między odświeżeniami (ms)</label>
                    <input name="normalRefreshDelayMs" type="number" min="100" step="100" value="${settings.normalRefreshDelayMs}" style="${inputStyle}">

                    <label>Przerwa między odświeżeniami po błędzie 429 (ms)</label>
                    <input name="rateLimitedRefreshDelayMs" type="number" min="100" step="100" value="${settings.rateLimitedRefreshDelayMs}" style="${inputStyle}">

                    <label>Pauza po błędzie 429 (sek)</label>
                    <input name="rateLimitPauseSeconds" type="number" min="5" step="5" value="${settings.rateLimitPauseSeconds}" style="${inputStyle}">

                    <label>Pauza prewencyjna po ilu ofertach</label>
                    <input name="preventiveBatchSize" type="number" min="1" step="1" value="${settings.preventiveBatchSize}" style="${inputStyle}">

                    <label>Długość pauzy prewencyjnej (sek)</label>
                    <input name="preventiveBatchPauseSeconds" type="number" min="5" step="5" value="${settings.preventiveBatchPauseSeconds}" style="${inputStyle}">
                </div>

                <div style="height: 1px; margin: 12px 0; background: rgba(255,255,255,0.12);"></div>

                <div style="max-height: 160px; overflow: auto; padding: 3px 8px 3px 8px; background: rgba(17, 24, 39, 0.55); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;">
                    ${authorToggleRows}
                </div>

                <div style="margin-top: 6px; color: #cbd5e1;">
                    Zielony = odświeżaj, czerwony = pomiń. Zmiany wchodzą od następnego cyklu.
                </div>

                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;">
                    <button data-settings-action="reset" type="button" style="padding: 6px 10px; color: #e5e7eb; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.16); border-radius: 7px; cursor: pointer;">Domyślne</button>
                    <button type="submit" style="padding: 6px 12px; color: #ffffff; background: #2563eb; border: 1px solid #60a5fa; border-radius: 7px; cursor: pointer;">Zapisz</button>
                </div>
            </form>
        `;

        wireAuthorToggles(panel);

        panel
            .querySelector('[data-settings-action="close"]')
            ?.addEventListener(
                "click",
                closeSettingsPanel
            );

        panel
            .querySelector('[data-settings-action="reset"]')
            ?.addEventListener("click", () => {
                saveScriptSettings(SETTINGS_DEFAULTS);
                closeSettingsPanel();
                openSettingsPanel();
                console.log(
                    "Trans Auto Refresh - przywrócono ustawienia domyślne",
                    scriptSettings
                );
            });

        panel
            .querySelector("form")
            ?.addEventListener("submit", event => {
                event.preventDefault();

                const form =
                    event.currentTarget;

                saveScriptSettings({
                    refreshIntervalMinutes:
                        form.elements.refreshIntervalMinutes.value,
                    localCooldownMinutes:
                        form.elements.localCooldownMinutes.value,
                    freshPublicationCooldownMinutes:
                        form.elements.freshPublicationCooldownMinutes.value,
                    pageFetchBatchSize:
                        form.elements.pageFetchBatchSize.value,
                    duplicateGroupLimitPerCycle:
                        form.elements.duplicateGroupLimitPerCycle.value,
                    normalRefreshDelayMs:
                        form.elements.normalRefreshDelayMs.value,
                    rateLimitedRefreshDelayMs:
                        form.elements.rateLimitedRefreshDelayMs.value,
                    rateLimitPauseSeconds:
                        form.elements.rateLimitPauseSeconds.value,
                    preventiveBatchSize:
                        form.elements.preventiveBatchSize.value,
                    preventiveBatchPauseSeconds:
                        form.elements.preventiveBatchPauseSeconds.value,
                    allowedAuthors:
                        getSelectedAuthorsFromPanel(panel)
                });

                console.log(
                    "Trans Auto Refresh - zapisano ustawienia",
                    scriptSettings
                );

                closeSettingsPanel();
            });

        (document.body || document.documentElement).appendChild(panel);
    }

    function toggleDashboardMinimized() {
        if (!dashboard) {
            return;
        }

        dashboardMinimized = !dashboardMinimized;

        const content =
            dashboard.querySelector("[data-dashboard-content]");
        const remoteNotice =
            dashboard.querySelector("[data-remote-config-notice]");

        const minimizeButton =
            dashboard.querySelector(
                '[data-dashboard-action="minimize"]'
            );

        if (content) {
            content.style.display =
                dashboardMinimized
                    ? "none"
                    : "block";
        }

        if (
            remoteNotice &&
            remoteNotice.innerHTML.trim()
        ) {
            remoteNotice.style.display =
                dashboardMinimized
                    ? "none"
                    : "block";
        }

        if (minimizeButton) {
            minimizeButton.textContent =
                dashboardMinimized
                    ? "+"
                    : "−";

            minimizeButton.title =
                dashboardMinimized
                    ? "Rozwiń dashboard"
                    : "Minimalizuj dashboard";
        }

        dashboard.style.width =
            dashboardMinimized
                ? "190px"
                : "230px";

        dashboard.style.padding =
            dashboardMinimized
                ? "10px 12px"
                : "14px 16px";
    }

    function setDashboardValue(name, value) {
        if (!dashboard) {
            return;
        }

        const element = dashboard.querySelector(`[data-value="${name}"]`);

        if (element) {
            element.textContent = value;
        }
    }

    function setDashboardNextStart(value) {
        if (!dashboard) {
            return;
        }

        const label =
            dashboard.querySelector("[data-next-start-label]");
        const element =
            dashboard.querySelector('[data-value="nextStart"]');

        if (label) {
            label.textContent = "Następny start:";
            label.style.display = "";
        }

        if (element) {
            element.textContent = value;
            element.style.display = "";
            element.style.minWidth = "";
            element.style.width = "";
            element.style.height = "";
            element.style.gridColumn = "";
        }
    }

    function updateDashboardRefreshProgress(done, total) {
        if (!dashboard || total <= 0) {
            return;
        }

        const label =
            dashboard.querySelector("[data-next-start-label]");
        const element =
            dashboard.querySelector('[data-value="nextStart"]');

        if (!element) {
            return;
        }

        const safeDone =
            Math.min(
                Math.max(0, done),
                total
            );
        const percent =
            Math.round((safeDone / total) * 100);

        if (label) {
            label.style.display = "none";
        }

        element.style.display = "block";
        element.style.gridColumn = "1 / -1";
        element.style.width = "100%";
        element.style.minWidth = "100%";
        element.style.height = "15px";
        element.innerHTML = `
            <span style="position: relative; display: block; width: 100%; height: 15px; overflow: hidden; background: rgba(17, 24, 39, 0.72); border: 1px solid rgba(134, 239, 172, 0.75); border-radius: 999px; box-shadow: inset 0 0 2px rgba(0,0,0,0.25), 0 0 3px rgba(74, 222, 128, 0.25);">
                <span style="display: block; width: ${percent}%; height: 100%; background: linear-gradient(90deg, #22c55e, #86efac); transition: width 0.25s ease;"></span>
                <span style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #f0fdf4; font-size: 10px; font-weight: 700; text-shadow: 0 1px 1px rgba(0,0,0,0.65);">${safeDone}/${total}</span>
            </span>
        `;
    }

    function updateDashboard(result) {
        if (!dashboard) {
            return;
        }

        const statusColor =
            result.errors > 0 ||
            result.rateLimitPauses > 0 ||
            (
                result.offers > 0 &&
                result.refreshed === 0
            )
                ? "#ff5c68"
                : "#4ade80";

        dashboard.style.background = "rgba(61, 66, 74, 0.97)";
        dashboard.style.borderColor = statusColor;
        dashboard.style.boxShadow =
            `0 10px 30px rgba(0, 0, 0, 0.4), 0 0 18px ${statusColor}8c, 0 0 4px ${statusColor}e6`;

        setDashboardValue("offers", result.offers);
        setDashboardValue("refreshed", result.refreshed);
        setDashboardValue("skipped", result.skipped);
        setDashboardValue(
            "duplicates",
            `${result.duplicates} / ${result.duplicatesDeferred}`
        );
        setDashboardValue("errors", result.errors);
        setDashboardValue("duration", result.duration);
        setDashboardNextStart(result.nextStart);

        const errorsElement =
            dashboard.querySelector('[data-value="errors"]');

        if (errorsElement) {
            errorsElement.style.color = statusColor;
        }

        const refreshedElement =
            dashboard.querySelector('[data-value="refreshed"]');

        if (refreshedElement) {
            refreshedElement.style.color =
                result.offers > 0 && result.refreshed === 0
                    ? "#ff5c68"
            : "#e5e7eb";
        }
    }

    function setRemoteConfigNotice(html) {
        if (!dashboard) {
            return;
        }

        const notice =
            dashboard.querySelector("[data-remote-config-notice]");

        if (!notice) {
            return;
        }

        if (!html) {
            notice.innerHTML = "";
            notice.style.display = "none";
            return;
        }

        Object.assign(notice.style, {
            display: "block",
            margin: "0 0 8px 0",
            padding: "7px 8px",
            color: "#e5e7eb",
            background: "rgba(17, 24, 39, 0.62)",
            border: "1px solid rgba(147, 197, 253, 0.55)",
            borderRadius: "8px",
            fontSize: "11px",
            lineHeight: "1.35",
            pointerEvents: "auto"
        });

        notice.innerHTML = html;
    }

    function showRemoteDisabledDashboard(message) {
        if (!dashboard) {
            return;
        }

        dashboard.style.background = "rgba(72, 38, 42, 0.98)";
        dashboard.style.borderColor = "#ff5c68";
        dashboard.style.boxShadow =
            "0 10px 30px rgba(0, 0, 0, 0.45), 0 0 22px rgba(255, 92, 104, 0.65), 0 0 5px rgba(255, 92, 104, 0.95)";

        setRemoteConfigNotice("");

        setDashboardContent(`
            <div style="color: #fecaca; font-size: 13px; font-weight: 700; text-align: center;">
                SKRYPT WYŁĄCZONY PRZEZ ADMINISTRATORA
            </div>
            ${message
                ? `<div style="margin-top: 8px; color: #ffffff; font-size: 12px; text-align: center;">${escapeHtml(message)}</div>`
                : ""}
        `);
    }

    function getVersionParts(version) {
        const parts =
            String(version || "")
                .match(/\d+/g);

        if (!parts) {
            return [0];
        }

        return parts.map(part =>
            Number(part)
        );
    }

    function compareVersions(left, right) {
        const leftParts =
            getVersionParts(left);
        const rightParts =
            getVersionParts(right);
        const maxLength =
            Math.max(
                leftParts.length,
                rightParts.length
            );

        for (let i = 0; i < maxLength; i++) {
            const leftPart =
                leftParts[i] || 0;
            const rightPart =
                rightParts[i] || 0;

            if (leftPart > rightPart) {
                return 1;
            }

            if (leftPart < rightPart) {
                return -1;
            }
        }

        return 0;
    }

    function isRemoteVersionNewer(latestVersion) {
        return compareVersions(
            latestVersion,
            SCRIPT_VERSION
        ) > 0;
    }

    function getRemoteConfigUrl() {
        const cleanUrl =
            String(REMOTE_CONFIG_URL || "").trim();

        if (!cleanUrl) {
            return "";
        }

        const separator =
            cleanUrl.includes("?")
                ? "&"
                : "?";

        return `${cleanUrl}${separator}t=${Date.now()}`;
    }

    function normalizeRemoteConfig(data) {
        if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data)
        ) {
            throw new Error("config.json musi być obiektem JSON");
        }

        return {
            enabled:
                data.enabled !== false,
            latestVersion:
                String(data.latestVersion || "").trim(),
            message:
                String(data.message || "").trim()
        };
    }

    async function fetchRemoteConfig() {
        const url =
            getRemoteConfigUrl();

        if (!url) {
            console.warn(
                "Remote Config: nie ustawiono REMOTE_CONFIG_URL - skrypt działa dalej."
            );
            return null;
        }

        const controller =
            typeof AbortController !== "undefined"
                ? new AbortController()
                : null;
        const timeout =
            controller
                ? setTimeout(
                    () => controller.abort(),
                    REMOTE_CONFIG_TIMEOUT
                )
                : null;

        try {
            const res =
                await fetch(
                    url,
                    {
                        cache: "no-store",
                        headers: {
                            Accept: "application/json"
                        },
                        signal:
                            controller
                                ? controller.signal
                                : undefined
                    }
                );

            if (!res.ok) {
                throw new Error(
                    `GitHub zwrócił HTTP ${res.status}`
                );
            }

            const text =
                await res.text();

            try {
                return normalizeRemoteConfig(
                    JSON.parse(text)
                );
            } catch (e) {
                throw new Error(
                    `Niepoprawny JSON: ${e.message}`
                );
            }
        } catch (e) {
            const reason =
                e.name === "AbortError"
                    ? `timeout po ${REMOTE_CONFIG_TIMEOUT / 1000} s`
                    : e.message;

            console.warn(
                `Remote Config: nie udało się pobrać config.json (${reason}) - skrypt działa dalej.`
            );

            return null;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    function applyRemoteConfig(config) {
        if (!config) {
            return true;
        }

        if (config.message) {
            console.info(
                "Remote Config - wiadomość administratora:",
                config.message
            );
        }

        const notices = [];

        if (
            config.latestVersion &&
            isRemoteVersionNewer(config.latestVersion)
        ) {
            console.warn(
                `Remote Config - dostępna nowa wersja. Aktualna: ${SCRIPT_VERSION}, najnowsza: ${config.latestVersion}`
            );

            notices.push(`
                <div style="color: #fde68a; font-weight: 700;">
                    DOSTĘPNA NOWA WERSJA
                </div>
                <div style="color: #fef3c7;">
                    Aktualna: ${escapeHtml(SCRIPT_VERSION)}<br>
                    Najnowsza: ${escapeHtml(config.latestVersion)}
                </div>
            `);
        }

        if (notices.length) {
            setRemoteConfigNotice(
                notices.join("")
            );
        }

        if (config.enabled === false) {
            console.warn(
                "Remote Config - skrypt wyłączony przez administratora."
            );

            showRemoteDisabledDashboard(config.message);

            return false;
        }

        return true;
    }

    function showTokenExpiredDashboard() {
        if (!dashboard) {
            return;
        }

        dashboard.style.background = "rgba(72, 38, 42, 0.98)";
        dashboard.style.borderColor = "#ff5c68";
        dashboard.style.boxShadow =
            "0 10px 30px rgba(0, 0, 0, 0.45), 0 0 22px rgba(255, 92, 104, 0.65), 0 0 5px rgba(255, 92, 104, 0.95)";

        setDashboardContent(`
            <div style="color: #fecaca; font-size: 14px; font-weight: 700; text-align: center;">
                TOKEN WYGASŁ
            </div>
            <div style="margin-top: 6px; color: #ffffff; font-size: 12px; text-align: center;">
                Odśwież stronę
            </div>
        `);
    }

    function showOtherTabDashboard() {
        if (!dashboard) {
            return;
        }

        dashboard.style.background = "rgba(61, 66, 74, 0.98)";
        dashboard.style.borderColor = "#ff5c68";
        dashboard.style.boxShadow =
            "0 10px 30px rgba(0, 0, 0, 0.4), 0 0 18px rgba(255, 92, 104, 0.55), 0 0 4px rgba(255, 92, 104, 0.9)";

        setDashboardContent(`
            <div style="color: #f3f4f6; font-size: 13px; font-weight: 700; line-height: 1.5; text-align: center;">
                SKRYPT DZIAŁA<br>W INNEJ KARCIE
            </div>

        `);
    }

    function readFallbackLock() {
        try {
            return JSON.parse(
                localStorage.getItem(FALLBACK_LOCK_KEY)
            );
        } catch {
            return null;
        }
    }

    async function acquireFallbackLock() {
        const currentLock = readFallbackLock();

        if (
            currentLock &&
            currentLock.tabId !== tabId &&
            Date.now() - currentLock.updatedAt < FALLBACK_LOCK_TTL
        ) {
            return false;
        }

        localStorage.setItem(
            FALLBACK_LOCK_KEY,
            JSON.stringify({
                tabId,
                updatedAt: Date.now()
            })
        );

        await new Promise(
            r => setTimeout(r, 500)
        );

        return readFallbackLock()?.tabId === tabId;
    }

    function refreshFallbackLock() {
        if (readFallbackLock()?.tabId !== tabId) {
            return false;
        }

        localStorage.setItem(
            FALLBACK_LOCK_KEY,
            JSON.stringify({
                tabId,
                updatedAt: Date.now()
            })
        );

        return true;
    }

    function releaseFallbackLock() {
        if (readFallbackLock()?.tabId === tabId) {
            localStorage.removeItem(FALLBACK_LOCK_KEY);
        }
    }

    function sleep(ms) {
        return new Promise(
            r => setTimeout(r, ms)
        );
    }

    function readJsonFromLocalStorage(key, fallbackValue) {
        try {
            return JSON.parse(
                localStorage.getItem(key)
            ) || fallbackValue;
        } catch {
            return fallbackValue;
        }
    }

    function writeJsonToLocalStorage(key, value) {
        localStorage.setItem(
            key,
            JSON.stringify(value)
        );
    }

    function readErrorLog() {
        const entries =
            readJsonFromLocalStorage(
                ERROR_LOG_KEY,
                []
            );

        if (!Array.isArray(entries)) {
            return [];
        }

        return entries
            .filter(entry =>
                entry &&
                entry.at &&
                entry.code
            )
            .sort((a, b) =>
                b.at - a.at
            )
            .slice(0, ERROR_LOG_LIMIT);
    }

    function writeErrorLog(entries) {
        writeJsonToLocalStorage(
            ERROR_LOG_KEY,
            entries
                .sort((a, b) =>
                    b.at - a.at
                )
                .slice(0, ERROR_LOG_LIMIT)
        );
    }

    function appendErrorLog(code, description, details = {}) {
        const entry = {
            at: Date.now(),
            code: String(code || "BŁĄD"),
            description: String(description || ""),
            publicationId: details.publicationId || "",
            cycle: cycleCounter
        };

        writeErrorLog([
            entry,
            ...readErrorLog()
        ]);
    }

    function toNumber(value, fallback, min, max) {
        const number =
            Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(
            max,
            Math.max(
                min,
                number
            )
        );
    }

    function sanitizeSettings(rawSettings = {}) {
        return {
            refreshIntervalMinutes:
                toNumber(
                    rawSettings.refreshIntervalMinutes,
                    SETTINGS_DEFAULTS.refreshIntervalMinutes,
                    0.5,
                    60
                ),
            localCooldownMinutes:
                toNumber(
                    rawSettings.localCooldownMinutes,
                    SETTINGS_DEFAULTS.localCooldownMinutes,
                    1,
                    120
                ),
            freshPublicationCooldownMinutes:
                toNumber(
                    rawSettings.freshPublicationCooldownMinutes,
                    SETTINGS_DEFAULTS.freshPublicationCooldownMinutes,
                    1,
                    120
                ),
            pageFetchBatchSize:
                Math.round(
                    toNumber(
                        rawSettings.pageFetchBatchSize,
                        SETTINGS_DEFAULTS.pageFetchBatchSize,
                        1,
                        10
                    )
                ),
            duplicateGroupLimitPerCycle:
                Math.round(
                    toNumber(
                        rawSettings.duplicateGroupLimitPerCycle,
                        SETTINGS_DEFAULTS.duplicateGroupLimitPerCycle,
                        1,
                        20
                    )
                ),
            normalRefreshDelayMs:
                Math.round(
                    toNumber(
                        rawSettings.normalRefreshDelayMs,
                        SETTINGS_DEFAULTS.normalRefreshDelayMs,
                        100,
                        10000
                    )
                ),
            rateLimitedRefreshDelayMs:
                Math.round(
                    toNumber(
                        rawSettings.rateLimitedRefreshDelayMs,
                        SETTINGS_DEFAULTS.rateLimitedRefreshDelayMs,
                        100,
                        30000
                    )
                ),
            rateLimitPauseSeconds:
                toNumber(
                    rawSettings.rateLimitPauseSeconds,
                    SETTINGS_DEFAULTS.rateLimitPauseSeconds,
                    5,
                    600
                ),
            preventiveBatchSize:
                Math.round(
                    toNumber(
                        rawSettings.preventiveBatchSize,
                        SETTINGS_DEFAULTS.preventiveBatchSize,
                        1,
                        1000
                    )
                ),
            preventiveBatchPauseSeconds:
                toNumber(
                    rawSettings.preventiveBatchPauseSeconds,
                    SETTINGS_DEFAULTS.preventiveBatchPauseSeconds,
                    5,
                    600
                ),
            allowedAuthors:
                String(rawSettings.allowedAuthors || "")
        };
    }

    function readScriptSettings() {
        return sanitizeSettings(
            readJsonFromLocalStorage(
                SETTINGS_KEY,
                SETTINGS_DEFAULTS
            )
        );
    }

    function saveScriptSettings(settings) {
        scriptSettings =
            sanitizeSettings(settings);

        writeJsonToLocalStorage(
            SETTINGS_KEY,
            scriptSettings
        );

        return scriptSettings;
    }

    function getRefreshInterval() {
        return Math.round(
            scriptSettings.refreshIntervalMinutes * 60 * 1000
        );
    }

    function getLocalRefreshCooldown() {
        return Math.round(
            scriptSettings.localCooldownMinutes * 60 * 1000
        );
    }

    function getFreshPublicationCooldown() {
        return Math.round(
            scriptSettings.freshPublicationCooldownMinutes * 60 * 1000
        );
    }

    function getRateLimitPauseMs() {
        return Math.round(
            scriptSettings.rateLimitPauseSeconds * 1000
        );
    }

    function getPreventiveBatchPauseMs() {
        return Math.round(
            scriptSettings.preventiveBatchPauseSeconds * 1000
        );
    }

    function getAuthorFilterTerms() {
        return scriptSettings.allowedAuthors
            .split(/\r?\n/)
            .map(normalizeDuplicateText)
            .filter(Boolean);
    }

    function getCooldownAvailableAt(cacheEntry) {
        if (typeof cacheEntry === "number") {
            return cacheEntry + getLocalRefreshCooldown();
        }

        if (
            cacheEntry &&
            typeof cacheEntry === "object" &&
            Number.isFinite(cacheEntry.availableAt)
        ) {
            return cacheEntry.availableAt;
        }

        return 0;
    }

    function readRefreshCooldownCache() {
        const cache =
            readJsonFromLocalStorage(
                REFRESH_COOLDOWN_CACHE_KEY,
                {}
            );

        let changed = false;

        Object.keys(cache).forEach(publicationId => {
            if (getCooldownAvailableAt(cache[publicationId]) <= Date.now()) {
                delete cache[publicationId];
                changed = true;
            }
        });

        if (changed) {
            writeJsonToLocalStorage(
                REFRESH_COOLDOWN_CACHE_KEY,
                cache
            );
        }

        return cache;
    }

    function isInLocalRefreshCooldown(cache, publicationId) {
        const availableAt =
            getCooldownAvailableAt(cache[publicationId]);

        return Boolean(
            availableAt &&
            availableAt > Date.now()
        );
    }

    function isLongLocalRefreshCooldown(cache, publicationId) {
        const availableAt =
            getCooldownAvailableAt(cache[publicationId]);

        return Boolean(
            availableAt &&
            availableAt - Date.now() > getLocalRefreshCooldown() * 2
        );
    }

    function clearLocalRefreshCooldown(cache, publicationId) {
        if (!cache[publicationId]) {
            return;
        }

        delete cache[publicationId];

        writeJsonToLocalStorage(
            REFRESH_COOLDOWN_CACHE_KEY,
            cache
        );
    }

    function getRefreshAvailableAtFromReason(reason) {
        const match =
            String(reason || "").match(
                /available from:\s*['"]?([^'",\s]+)['"]?/i
            );

        if (!match) {
            return null;
        }

        const timestamp =
            Date.parse(match[1]);

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    function getInactivePublicationStatusFromReason(reason) {
        const text =
            String(reason || "");

        if (!/must be\s*['"]?active['"]?/i.test(text)) {
            return "";
        }

        const match =
            text.match(
                /current status:\s*['"]?([^'",\s)]+)['"]?/i
            );

        const status =
            match?.[1] || "";

        return status && status !== "active"
            ? status
            : "";
    }

    function getFreightPublicationStatus(freight) {
        const statusCandidates = [
            freight?.publication?.status,
            freight?.publication_status,
            freight?.publication?.state,
            freight?.publication_state
        ];

        for (const statusCandidate of statusCandidates) {
            const status =
                String(statusCandidate || "")
                    .trim()
                    .toLowerCase();

            if (status) {
                return status;
            }
        }

        return "";
    }

    function classifyPublicationStatus(status) {
        const normalized =
            String(status || "")
                .trim()
                .toLowerCase();

        if (!normalized || normalized === "active") {
            return null;
        }

        if (
            [
                "finished",
                "deleted",
                "cancelled",
                "canceled",
                "archived",
                "expired"
            ].includes(normalized)
        ) {
            return {
                type: "terminal",
                label: "zakończone/skasowane",
                cooldownMs: INACTIVE_PUBLICATION_COOLDOWN
            };
        }

        if (
            [
                "waiting_for_publication",
                "waiting_for_publish",
                "pending_publication",
                "scheduled",
                "draft",
                "pending"
            ].includes(normalized)
        ) {
            return {
                type: "pending",
                label: "czeka na publikację",
                cooldownMs: 0
            };
        }

        return {
            type: "other",
            label: "inny nieaktywny status",
            cooldownMs: 0
        };
    }

    function resolve422CooldownAvailableAt(apiAvailableAt, checkedAt) {
        if (
            Number.isFinite(apiAvailableAt) &&
            apiAvailableAt > checkedAt
        ) {
            return apiAvailableAt;
        }

        if (Number.isFinite(apiAvailableAt)) {
            return checkedAt + STALE_422_COOLDOWN;
        }

        return checkedAt + MISSING_422_COOLDOWN;
    }

    function parseTimestamp(value) {
        if (!value) {
            return null;
        }

        const timestamp =
            Date.parse(value);

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    function resolvePreRefreshCooldownAvailableAt(
        availableAt,
        checkedAt
    ) {
        if (!Number.isFinite(availableAt)) {
            return null;
        }

        if (availableAt > checkedAt) {
            return availableAt;
        }

        if (checkedAt - availableAt <= PRE_REFRESH_COOLDOWN_BUFFER) {
            return checkedAt + PRE_REFRESH_COOLDOWN_BUFFER;
        }

        return null;
    }

    function isRefreshAvailabilityPath(path) {
        const normalized =
            String(path || "")
                .replace(/[_-]/g, " ")
                .toLowerCase();

        return (
            /refresh|cooldown/.test(normalized) &&
            /available|next|until|from|at/.test(normalized)
        ) || (
            /publication/.test(normalized) &&
            /refresh|cooldown|available|next/.test(normalized)
        );
    }

    function findRefreshAvailability(value, path = "", depth = 0) {
        if (!value || typeof value !== "object" || depth > 5) {
            return null;
        }

        for (const [key, childValue] of Object.entries(value)) {
            const childPath =
                path
                    ? `${path}.${key}`
                    : key;

            if (
                typeof childValue === "string" &&
                isRefreshAvailabilityPath(childPath)
            ) {
                const timestamp =
                    parseTimestamp(childValue);

                if (Number.isFinite(timestamp)) {
                    return {
                        availableAt: timestamp,
                        path: childPath
                    };
                }
            }

            if (childValue && typeof childValue === "object") {
                const nestedAvailability =
                    findRefreshAvailability(
                        childValue,
                        childPath,
                        depth + 1
                    );

                if (nestedAvailability) {
                    return nestedAvailability;
                }
            }
        }

        return null;
    }

    function getPreRefreshCooldown(publication, checkedAt) {
        const apiAvailableAt =
            resolvePreRefreshCooldownAvailableAt(
                publication.listRefreshAvailableAt,
                checkedAt
            );

        if (apiAvailableAt) {
            return {
                availableAt: apiAvailableAt,
                source:
                    publication.listRefreshAvailableAtPath
                        ? `czas z listy API: ${publication.listRefreshAvailableAtPath}`
                        : "czas z listy API"
            };
        }

        if (!publication.publishedAt) {
            return null;
        }

        const publishDateAvailableAt =
            resolvePreRefreshCooldownAvailableAt(
                publication.publishedAt + getFreshPublicationCooldown(),
                checkedAt
            );

        if (!publishDateAvailableAt) {
            return null;
        }

        return {
            availableAt: publishDateAvailableAt,
            source: "publication.publish_date + 15 min"
        };
    }

    function formatDateTime(timestamp) {
        return Number.isFinite(timestamp)
            ? new Date(timestamp).toLocaleString("pl-PL")
            : "";
    }

    function formatSecondsToAvailable(availableAt, checkedAt) {
        if (!Number.isFinite(availableAt)) {
            return "";
        }

        const seconds =
            Math.ceil((availableAt - checkedAt) / 1000);

        return `${seconds} s`;
    }

    function getFreightPublicationTime(freight) {
        const dateCandidates = [
            freight?.publication?.publish_date,
            freight?.created_at,
            freight?.updated_at
        ];

        for (const dateCandidate of dateCandidates) {
            const timestamp =
                parseTimestamp(dateCandidate);

            if (Number.isFinite(timestamp)) {
                return timestamp;
            }
        }

        return null;
    }

    function normalizeDuplicateText(value) {
        return String(value ?? "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ");
    }

    function getSpotLocality(freight, index) {
        return freight?.spots?.[index]?.place?.address?.locality || "";
    }

    function getSpotPostalCode(freight, index) {
        return freight?.spots?.[index]?.place?.address?.postal_code || "";
    }

    function getSpotLabel(freight, index) {
        return [
            getSpotPostalCode(freight, index),
            getSpotLocality(freight, index)
        ].filter(Boolean).join(" ");
    }

    function getAuthorLabel(freight) {
        const author =
            freight?.created_by || {};

        const name =
            [
                author.given_name,
                author.family_name
            ].filter(Boolean).join(" ");

        return (
            name ||
            author.email ||
            author.id ||
            author.account_id ||
            author.trans_id ||
            ""
        );
    }

    function isAuthorAllowed(publication, authorFilterTerms) {
        const authorText =
            normalizeDuplicateText(
                publication.authorLabel ||
                publication.authorId ||
                ""
            );

        return authorFilterTerms.some(term =>
            authorText.includes(term)
        );
    }

    function buildPublicationDiagnostic(freight) {
        const publishedAt =
            getFreightPublicationTime(freight);

        return {
            route:
                `${getSpotLabel(freight, 0)} -> ${getSpotLabel(freight, 1)}`,
            author:
                getAuthorLabel(freight),
            publishDate:
                publishedAt
                    ? new Date(publishedAt).toLocaleString("pl-PL")
                    : ""
        };
    }

    function getDateDay(value) {
        if (!value) {
            return "";
        }

        return String(value).slice(0, 10);
    }

    function buildDuplicateGroupKey(freight) {
        const authorId =
            freight?.created_by?.id ||
            freight?.created_by?.account_id ||
            freight?.created_by?.trans_id ||
            "BRAK_AUTORA";

        const loadingPlace =
            normalizeDuplicateText(
                getSpotPostalCode(freight, 0) ||
                getSpotLocality(freight, 0)
            );

        const unloadingPlace =
            normalizeDuplicateText(
                getSpotPostalCode(freight, 1) ||
                getSpotLocality(freight, 1)
            );

        if (!loadingPlace || !unloadingPlace) {
            return null;
        }

        const truckBodies =
            (freight?.requirements?.required_truck_bodies || [])
                .slice()
                .sort()
                .join(",");

        return [
            authorId,
            getDateDay(freight?.loading_date),
            getDateDay(freight?.unloading_date),
            loadingPlace,
            unloadingPlace,
            freight?.requirements?.vehicle_size_id || "",
            truckBodies,
            freight?.capacity?.value || ""
        ].join("|");
    }

    function markLocalRefreshCooldown(
        cache,
        publicationId,
        availableAt = null
    ) {
        cache[publicationId] = {
            refreshedAt: Date.now(),
            availableAt:
                Number.isFinite(availableAt)
                    ? availableAt
                    : Date.now() + getLocalRefreshCooldown()
        };

        writeJsonToLocalStorage(
            REFRESH_COOLDOWN_CACHE_KEY,
            cache
        );
    }

    function getRefreshCursor(totalCount) {
        const cursor =
            Number(localStorage.getItem(REFRESH_CURSOR_KEY));

        if (
            !Number.isFinite(cursor) ||
            cursor < 0 ||
            cursor >= totalCount
        ) {
            return 0;
        }

        return cursor;
    }

    function setRefreshCursor(totalCount, nextIndex) {
        if (!totalCount) {
            localStorage.removeItem(REFRESH_CURSOR_KEY);
            return;
        }

        localStorage.setItem(
            REFRESH_CURSOR_KEY,
            String(nextIndex % totalCount)
        );
    }

    function getRateLimitPause(res) {
        const defaultPause =
            getRateLimitPauseMs();

        const retryAfter =
            res.headers?.get?.("Retry-After");

        if (!retryAfter) {
            return defaultPause;
        }

        const retryAfterSeconds =
            Number(retryAfter);

        if (Number.isFinite(retryAfterSeconds)) {
            return Math.max(
                defaultPause,
                retryAfterSeconds * 1000
            );
        }

        const retryAfterDate =
            Date.parse(retryAfter);

        if (Number.isFinite(retryAfterDate)) {
            return Math.max(
                defaultPause,
                retryAfterDate - Date.now()
            );
        }

        return defaultPause;
    }

    async function startWithCrossTabLock() {
        if (navigator.locks?.request) {
            await navigator.locks.request(
                CROSS_TAB_LOCK_NAME,
                {
                    mode: "exclusive",
                    ifAvailable: true
                },
                async lock => {
                    if (!lock) {
                        console.log(
                            "Trans Auto Refresh działa w innej karcie"
                        );

                        showOtherTabDashboard();

                        return;
                    }

                    await startRefreshLoop();
                }
            );

            return;
        }

        if (!await acquireFallbackLock()) {
            console.log(
                "Trans Auto Refresh działa w innej karcie"
            );

            showOtherTabDashboard();

            return;
        }

        const heartbeat = setInterval(
            refreshFallbackLock,
            FALLBACK_HEARTBEAT_INTERVAL
        );

        window.addEventListener(
            "pagehide",
            releaseFallbackLock,
            { once: true }
        );

        try {
            await startRefreshLoop();
        } finally {
            clearInterval(heartbeat);
            releaseFallbackLock();
        }
    }

    console.log("Trans Auto Refresh uruchomiony");

    async function fetchFreightPage(page, token) {
        const res = await fetch(
            `https://cdn-api2.platform.trans.eu/app/freights/api/rest/v3/freights?context=TFS&filter=%7B%22negotiation_status%22:[%22choose_carrier%22,%22waiting_for_offers%22,%22waiting_for_chain_accept%22,%22choose_carrier%22,%22waiting_for_chain_accept%22]%7D&order=desc&page=${page}&perPage=${FREIGHTS_PER_PAGE}&sortBy=publishDate`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        if (res.status === 409) {
            return {
                page,
                done: true,
                freights: []
            };
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error(
                "TOKEN_WYGASL"
            );
        }

        if (!res.ok) {
            return {
                page,
                error: true,
                status: res.status,
                freights: []
            };
        }

        const data = await res.json();

        return {
            page,
            freights:
                data?._embedded?.freights || []
        };
    }

    async function run() {

        scriptSettings =
            readScriptSettings();

        const token = localStorage.getItem("transFrameToken");
        const pageFetchBatchSize =
            scriptSettings.pageFetchBatchSize;
        const duplicateGroupLimit =
            scriptSettings.duplicateGroupLimitPerCycle;
        const normalRefreshDelay =
            scriptSettings.normalRefreshDelayMs;
        const rateLimitedRefreshDelay =
            scriptSettings.rateLimitedRefreshDelayMs;
        const preventiveBatchSize =
            scriptSettings.preventiveBatchSize;
        const preventiveBatchPause =
            getPreventiveBatchPauseMs();
        const authorFilterTerms =
            getAuthorFilterTerms();

        const publicationIds = [];
        const publicationMetaById = new Map();
        const authorsSeenThisCycle = new Set();

        let refreshed = 0;
        let alreadyRefreshed = 0;
        let blockedBy422 = 0;
        let inactiveDuringRefresh = 0;
        let pendingDuringRefresh = 0;
        let terminalDuringRefresh = 0;
        let otherStatusDuringRefresh = 0;
        let realErrors = 0;

        const blocked422Details = [];
        const failures = [];

        for (let page = 1; ;) {

            try {

                const pages =
                    Array.from(
                        { length: pageFetchBatchSize },
                        (_, index) => page + index
                    );

                const pageResults =
                    await Promise.all(
                        pages.map(pageNumber =>
                            fetchFreightPage(pageNumber, token)
                        )
                    );

                let shouldStopFetching = false;

                for (const pageResult of pageResults) {

                    if (pageResult.done) {

                        console.log(
                            `Koniec listy ofert na stronie ${pageResult.page}`
                        );

                        shouldStopFetching = true;
                        break;
                    }

                    if (pageResult.error) {

                        console.error(
                            `Błąd pobierania strony ${pageResult.page}`,
                            pageResult.status
                        );

                        realErrors++;

                        failures.push({
                            id: "",
                            status: pageResult.status,
                            reason:
                                `Błąd pobierania strony ${pageResult.page}`
                        });

                        appendErrorLog(
                            pageResult.status,
                            `Błąd pobierania strony ${pageResult.page}`
                        );

                        shouldStopFetching = true;
                        break;
                    }

                    const pubs =
                        pageResult.freights.map(x => {
                            const refreshAvailability =
                                findRefreshAvailability(x);
                            const authorLabel =
                                getAuthorLabel(x);

                            if (authorLabel) {
                                authorsSeenThisCycle.add(authorLabel);
                            }

                            publicationMetaById.set(
                                x.publication_id,
                                {
                                    publishedAt:
                                        getFreightPublicationTime(x),
                                    listRefreshAvailableAt:
                                        refreshAvailability?.availableAt ||
                                        null,
                                    listRefreshAvailableAtPath:
                                        refreshAvailability?.path || "",
                                    publicationStatus:
                                        getFreightPublicationStatus(x),
                                    authorLabel,
                                    authorId:
                                        x?.created_by?.id ||
                                        x?.created_by?.account_id ||
                                        x?.created_by?.trans_id ||
                                        "",
                                    duplicateGroupKey:
                                        buildDuplicateGroupKey(x),
                                    diagnostic:
                                        buildPublicationDiagnostic(x)
                                }
                            );

                            return x.publication_id;
                        }).filter(Boolean) || [];

                    console.log(
                        `Strona ${pageResult.page}: ${pubs.length} ofert`
                    );

                    if (!pubs.length) {

                        console.log(
                            `Pusta strona ${pageResult.page}`
                        );

                        shouldStopFetching = true;
                        break;
                    }

                    publicationIds.push(...pubs);

                    if (pubs.length < FREIGHTS_PER_PAGE) {

                        console.log(
                            `Koniec listy ofert po niepełnej stronie ${pageResult.page}`
                        );

                        shouldStopFetching = true;
                        break;
                    }
                }

                if (shouldStopFetching) {
                    break;
                }

                page += pageFetchBatchSize;

            } catch (e) {

                if (
                    e.message === "TOKEN_WYGASL"
                ) {

                    throw e;
                }

                console.error(
                    `Błąd pobierania stron od ${page}`,
                    e
                );

                realErrors++;

                failures.push({
                    id: "",
                    status: "GET_JS_ERROR",
                    reason:
                        `Błąd pobierania stron od ${page}: ${e.message}`
                });

                appendErrorLog(
                    "GET_JS_ERROR",
                    `Błąd pobierania stron od ${page}: ${e.message}`
                );

                break;
            }
        }

        if (authorsSeenThisCycle.size) {
            rememberKnownAuthors(authorsSeenThisCycle);
        }

        console.log("");
        console.log("================================");
        console.log(
            `Znaleziono ${publicationIds.length} publikacji`
        );
        console.log("================================");
        console.log("");

        const cooldownCache = readRefreshCooldownCache();

        const startIndex =
            getRefreshCursor(publicationIds.length);

        const orderedPublicationIds =
            publicationIds.map((publicationId, offset) => {
                const originalIndex =
                    (startIndex + offset) % publicationIds.length;
                const meta =
                    publicationMetaById.get(
                        publicationIds[originalIndex]
                    ) || {};

                return {
                    id: publicationIds[originalIndex],
                    originalIndex,
                    publishedAt:
                        meta.publishedAt || null,
                    listRefreshAvailableAt:
                        meta.listRefreshAvailableAt || null,
                    listRefreshAvailableAtPath:
                        meta.listRefreshAvailableAtPath || "",
                    publicationStatus:
                        meta.publicationStatus || "",
                    authorLabel:
                        meta.authorLabel || "",
                    authorId:
                        meta.authorId || "",
                    duplicateGroupKey:
                        meta.duplicateGroupKey || null
                };
            });

        const refreshQueue = [];
        const eligiblePublications = [];
        let skippedByLocalCooldown = 0;
        let skippedByFreshPublication = 0;
        let skippedByInactivePublication = 0;
        let skippedByPendingPublication = 0;
        let skippedByTerminalPublication = 0;
        let skippedByOtherPublicationStatus = 0;
        let skippedByAuthorFilter = 0;
        let skippedByDuplicateLimit = 0;
        const preRefreshCooldownDetails = [];
        const inactivePublicationDetails = [];

        orderedPublicationIds.forEach(publication => {
            const publicationStatusInfo =
                classifyPublicationStatus(
                    publication.publicationStatus
                );

            if (publicationStatusInfo) {
                const diagnostic =
                    publicationMetaById.get(publication.id)?.diagnostic || {};

                skippedByInactivePublication++;

                if (publicationStatusInfo.type === "pending") {
                    skippedByPendingPublication++;
                } else if (publicationStatusInfo.type === "terminal") {
                    skippedByTerminalPublication++;
                } else {
                    skippedByOtherPublicationStatus++;
                }

                inactivePublicationDetails.push({
                    id: publication.id,
                    trasa: diagnostic.route || "",
                    autor: diagnostic.author || "",
                    publikacja: diagnostic.publishDate || "",
                    kategoria: publicationStatusInfo.label,
                    status: publication.publicationStatus,
                    zrodlo: "lista ofert"
                });

                if (publicationStatusInfo.cooldownMs) {
                    markLocalRefreshCooldown(
                        cooldownCache,
                        publication.id,
                        Date.now() + publicationStatusInfo.cooldownMs
                    );
                }

                return;
            }

            if (
                isInLocalRefreshCooldown(
                    cooldownCache,
                    publication.id
                )
            ) {
                if (
                    isLongLocalRefreshCooldown(
                        cooldownCache,
                        publication.id
                    )
                ) {
                    clearLocalRefreshCooldown(
                        cooldownCache,
                        publication.id
                    );
                } else {
                    skippedByLocalCooldown++;
                    return;
                }
            }

            if (!isAuthorAllowed(publication, authorFilterTerms)) {
                skippedByAuthorFilter++;
                return;
            }

            const preRefreshCooldown =
                getPreRefreshCooldown(
                    publication,
                    Date.now()
                );

            if (preRefreshCooldown) {
                const diagnostic =
                    publicationMetaById.get(publication.id)?.diagnostic || {};

                skippedByFreshPublication++;

                preRefreshCooldownDetails.push({
                    id: publication.id,
                    trasa: diagnostic.route || "",
                    autor: diagnostic.author || "",
                    publikacja: diagnostic.publishDate || "",
                    zrodlo: preRefreshCooldown.source,
                    cooldownDo: formatDateTime(
                        preRefreshCooldown.availableAt
                    )
                });

                markLocalRefreshCooldown(
                    cooldownCache,
                    publication.id,
                    preRefreshCooldown.availableAt
                );

                return;
            }

            eligiblePublications.push(publication);
        });

        const duplicateGroupTotals = new Map();

        eligiblePublications.forEach(publication => {
            const groupKey =
                publication.duplicateGroupKey || publication.id;

            duplicateGroupTotals.set(
                groupKey,
                (duplicateGroupTotals.get(groupKey) || 0) + 1
            );
        });

        const duplicateTotal =
            Array.from(duplicateGroupTotals.values())
                .reduce((sum, groupTotal) => {
                    if (groupTotal <= 1) {
                        return sum;
                    }

                    return sum + groupTotal;
                }, 0);

        const duplicateGroupUsed = new Map();
        const limitedDuplicateGroups = new Set();

        eligiblePublications.forEach(publication => {
            const groupKey =
                publication.duplicateGroupKey || publication.id;

            const groupTotal =
                duplicateGroupTotals.get(groupKey) || 0;

            const alreadyUsed =
                duplicateGroupUsed.get(groupKey) || 0;

            if (
                groupTotal > duplicateGroupLimit &&
                alreadyUsed >= duplicateGroupLimit
            ) {
                skippedByDuplicateLimit++;
                limitedDuplicateGroups.add(groupKey);
                return;
            }

            duplicateGroupUsed.set(
                groupKey,
                alreadyUsed + 1
            );

            refreshQueue.push(publication);
        });

        const skippedBeforeRefresh =
            skippedByLocalCooldown +
            skippedByFreshPublication +
            skippedByInactivePublication +
            skippedByAuthorFilter +
            skippedByDuplicateLimit;

        alreadyRefreshed +=
            skippedByLocalCooldown +
            skippedByFreshPublication +
            skippedByInactivePublication;

        if (skippedByLocalCooldown) {
            console.log(
                `Pominięto lokalny cooldown: ${skippedByLocalCooldown}`
            );
        }

        console.log(
            `Pominięto cooldown refresh: ${skippedByFreshPublication}`
        );

        console.log(
            `Pominięto czekające na publikację: ${skippedByPendingPublication}`
        );

        console.log(
            `Pominięto zakończone/skasowane: ${skippedByTerminalPublication}`
        );

        console.log(
            `Pominięto inne nieaktywne statusy: ${skippedByOtherPublicationStatus}`
        );

        if (inactivePublicationDetails.length) {
            const inactiveBeforeRefreshDetails =
                inactivePublicationDetails.filter(detail =>
                    detail.zrodlo === "lista ofert"
                );

            if (inactiveBeforeRefreshDetails.length) {
                console.log("");
                console.log(
                    "POMINIĘTE PRZED REFRESH (nieaktywne/niegotowe statusy):"
                );
                console.table(
                    inactiveBeforeRefreshDetails.slice(0, 50)
                );

                if (inactiveBeforeRefreshDetails.length > 50) {
                    console.log(
                        `Pokazano 50 z ${inactiveBeforeRefreshDetails.length} nieaktywnych/niegotowych statusów.`
                    );
                }
            }
        }

        if (skippedByAuthorFilter) {
            console.log(
                `Pominięto filtr autora: ${skippedByAuthorFilter}`
            );
        }

        if (preRefreshCooldownDetails.length) {
            console.log("");
            console.log(
                "POMINIĘTE PRZED REFRESH (cooldown refresh z listy API/publish_date):"
            );
            console.table(
                preRefreshCooldownDetails.slice(0, 50)
            );

            if (preRefreshCooldownDetails.length > 50) {
                console.log(
                    `Pokazano 50 z ${preRefreshCooldownDetails.length} pominiętych.`
                );
            }
        }

        console.log(
            `Znalezione duplikaty: ${duplicateTotal}`
        );

        console.log(
            `Odłożono duplikaty do kolejnego cyklu: ${skippedByDuplicateLimit} (limit ${duplicateGroupLimit} na grupę, grup z nadwyżką: ${limitedDuplicateGroups.size})`
        );

        console.log(
            `Do sprawdzenia refresh: ${refreshQueue.length}`
        );

        if (refreshQueue.length) {
            updateDashboardRefreshProgress(
                0,
                refreshQueue.length
            );
        }

        let rateLimitPauses = 0;
        let refreshDelay = normalRefreshDelay;
        let processedSincePreventivePause = 0;

        for (let i = 0; i < refreshQueue.length; i++) {

            const currentPublication = refreshQueue[i];
            const pubId = currentPublication.id;
            const nextCursor =
                (currentPublication.originalIndex + 1) %
                publicationIds.length;

            try {

                const res = await fetch(
                    `https://cdn-api2.platform.trans.eu/app/freights/api/rest/v2/freight-publications/${pubId}/refresh`,
                    {
                        method: "PUT",
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "x-app-version": "29.69.1",
                            "x-config-version": "2.3049.0",
                            "Content-Type": "application/json"
                        },
                        body: "{}"
                    }
                );

                const text = await res.text();
                const checkedAt = Date.now();

                console.log(
                    `[${i + 1}/${refreshQueue.length}]`,
                    pubId,
                    `status=${res.status}`
                );

                if (res.status === 429) {
                    rateLimitPauses++;

                    const pauseMs =
                        getRateLimitPause(res);

                    realErrors++;

                    failures.push({
                        id: pubId,
                        status: 429,
                        reason:
                            `Too Many Requests -> pauza ${Math.round(pauseMs / 1000)} s i ponowienie tego samego rekordu`
                    });

                    appendErrorLog(
                        429,
                        `Refresh ${pubId}: Too Many Requests -> pauza ${Math.round(pauseMs / 1000)} s i ponowienie`,
                        { publicationId: pubId }
                    );

                    refreshDelay =
                        Math.max(
                            refreshDelay,
                            rateLimitedRefreshDelay
                        );

                    setRefreshCursor(
                        publicationIds.length,
                        currentPublication.originalIndex
                    );

                    console.warn(
                        `429 Too Many Requests -> pauza ${Math.round(pauseMs / 1000)} s i kontynuacja tego samego cyklu`
                    );

                    await sleep(pauseMs);

                    i--;

                    continue;
                }

                if (res.ok) {

                    refreshed++;

                    markLocalRefreshCooldown(
                        cooldownCache,
                        pubId
                    );

                    setRefreshCursor(
                        publicationIds.length,
                        nextCursor
                    );

                } else {

                    let reason = text;

                    try {

                        const parsed =
                            JSON.parse(text);

                        reason =
                            parsed.detail ||
                            parsed.title ||
                            text;

                    } catch {}

                    if (res.status === 422) {

                        alreadyRefreshed++;

                        const diagnostic =
                            publicationMetaById.get(pubId)?.diagnostic || {};

                        const inactiveStatus =
                            getInactivePublicationStatusFromReason(reason);
                        const publicationStatusInfo =
                            classifyPublicationStatus(inactiveStatus);

                        if (publicationStatusInfo) {
                            inactiveDuringRefresh++;

                            if (publicationStatusInfo.type === "pending") {
                                pendingDuringRefresh++;
                            } else if (publicationStatusInfo.type === "terminal") {
                                terminalDuringRefresh++;
                            } else {
                                otherStatusDuringRefresh++;
                            }

                            inactivePublicationDetails.push({
                                id: pubId,
                                trasa: diagnostic.route || "",
                                autor: diagnostic.author || "",
                                publikacja: diagnostic.publishDate || "",
                                kategoria: publicationStatusInfo.label,
                                status: inactiveStatus,
                                zrodlo: "odpowiedź 422",
                                sprawdzoneO: formatDateTime(checkedAt),
                                powod: reason
                            });

                            if (publicationStatusInfo.cooldownMs) {
                                markLocalRefreshCooldown(
                                    cooldownCache,
                                    pubId,
                                    checkedAt + publicationStatusInfo.cooldownMs
                                );
                            }

                            setRefreshCursor(
                                publicationIds.length,
                                nextCursor
                            );

                        } else {

                            blockedBy422++;

                            const refreshAvailableAt =
                                getRefreshAvailableAtFromReason(reason);

                            const cooldownAvailableAt =
                                resolve422CooldownAvailableAt(
                                    refreshAvailableAt,
                                    checkedAt
                                );

                            blocked422Details.push({
                                id: pubId,
                                trasa: diagnostic.route || "",
                                autor: diagnostic.author || "",
                                publikacja: diagnostic.publishDate || "",
                                sprawdzoneO: formatDateTime(checkedAt),
                                apiDostepneOd: formatDateTime(refreshAvailableAt),
                                apiDostepneZa: formatSecondsToAvailable(
                                    refreshAvailableAt,
                                    checkedAt
                                ),
                                cooldownDo: formatDateTime(cooldownAvailableAt),
                                powod: reason
                            });

                            markLocalRefreshCooldown(
                                cooldownCache,
                                pubId,
                                cooldownAvailableAt
                            );

                            setRefreshCursor(
                                publicationIds.length,
                                nextCursor
                            );
                        }

                    } else {

                        realErrors++;

                        failures.push({
                            id: pubId,
                            status: res.status,
                            reason
                        });

                        appendErrorLog(
                            res.status,
                            `Refresh ${pubId}: ${reason}`,
                            { publicationId: pubId }
                        );

                        setRefreshCursor(
                            publicationIds.length,
                            nextCursor
                        );
                    }
                }

            } catch (e) {

                realErrors++;

                failures.push({
                    id: pubId,
                    status: "JS_ERROR",
                    reason: e.message
                });

                appendErrorLog(
                    "JS_ERROR",
                    `Refresh ${pubId}: ${e.message}`,
                    { publicationId: pubId }
                );

                console.error(
                    `Błąd refresh ${pubId}`,
                    e
                );

                setRefreshCursor(
                    publicationIds.length,
                    nextCursor
                );
            }

            updateDashboardRefreshProgress(
                i + 1,
                refreshQueue.length
            );

            processedSincePreventivePause++;

            await sleep(refreshDelay); //"Prędkość wysyłania zapytań"//

            if (
                processedSincePreventivePause >=
                preventiveBatchSize &&
                i < refreshQueue.length - 1
            ) {
                console.warn(
                    `Pauza prewencyjna ${Math.round(preventiveBatchPause / 1000)} s po ${processedSincePreventivePause} ofertach`
                );

                await sleep(preventiveBatchPause);

                processedSincePreventivePause = 0;
            }
        }

        console.log("");
        console.log("================================");
        console.log("PODSUMOWANIE");
        console.log("================================");

        console.log(
            `Odświeżono: ${refreshed}`
        );

        console.log(
            `Zablokowane 422: ${blockedBy422}`
        );

        console.log(
            `Nieaktywne/niegotowe razem: ${skippedByInactivePublication + inactiveDuringRefresh}`
        );

        console.log(
            `Czeka na publikację: ${skippedByPendingPublication + pendingDuringRefresh}`
        );

        console.log(
            `Zakończone/skasowane: ${skippedByTerminalPublication + terminalDuringRefresh}`
        );

        console.log(
            `Inne nieaktywne statusy: ${skippedByOtherPublicationStatus + otherStatusDuringRefresh}`
        );

        console.log(
            `Błędy: ${realErrors}`
        );

        console.log(
            `Limity 429: ${rateLimitPauses}`
        );

        if (inactivePublicationDetails.length) {

            console.log("");
            console.log("NIEAKTYWNE / NIEGOTOWE STATUSY:");

            console.table(inactivePublicationDetails);
        }

        if (blocked422Details.length) {

            console.log("");
            console.log("ZABLOKOWANE 422:");

            console.table(blocked422Details);
        }

        if (failures.length) {

            console.log("");
            console.log("SZCZEGÓŁY BŁĘDÓW:");

            console.table(failures);

        }

        return {
            offers: publicationIds.length,
            refreshed,
            cooldown: alreadyRefreshed,
            skipped: skippedBeforeRefresh,
            duplicates: duplicateTotal,
            duplicatesDeferred: skippedByDuplicateLimit,
            rateLimitPauses,
            errors: realErrors
        };
    }

    async function startRefreshLoop() {

        await new Promise(
            r => setTimeout(r, 5000)
        );

        while (true) {

            cycleCounter++;

            if (cycleCounter % 10 === 0) {
                console.clear();
            }

            console.log("");
            console.log("========================");
            console.log(
                `START CYKLU ${new Date().toLocaleString()}`
            );
            console.log("========================");

            const cycleStartedAt = Date.now();

            let cycleResult = {
                offers: 0,
                refreshed: 0,
                cooldown: 0,
                skipped: 0,
                duplicates: 0,
                duplicatesDeferred: 0,
                rateLimitPauses: 0,
                errors: 1
            };

            try {

                cycleResult = await run();

            } catch (e) {

                if (
                    e.message === "TOKEN_WYGASL"
                ) {

                    console.error("");
                    console.error(
                        "================================"
                    );
                    console.error(
                        "TOKEN WYGASŁ - SKRYPT ZATRZYMANY"
                    );
                    console.error(
                        "Odśwież stronę i uruchom ponownie"
                    );
                    console.error(
                        "================================"
                    );

                    appendErrorLog(
                        "TOKEN",
                        "Token wygasł - odśwież stronę i uruchom ponownie"
                    );

                    showTokenExpiredDashboard();

                    break;
                }

                console.error(
                    "Błąd głównego cyklu:",
                    e
                );

                appendErrorLog(
                    "MAIN_LOOP",
                    e.message || "Błąd głównego cyklu"
                );
            }

            const cycleDurationSeconds = Math.floor(
                (Date.now() - cycleStartedAt) / 1000
            );

            const cycleDurationMinutes = Math.floor(
                cycleDurationSeconds / 60
            );

            const remainingSeconds =
                cycleDurationSeconds % 60;

            console.log("");
            console.log(
                `Czas odświeżania wszystkich ofert: ${cycleDurationMinutes} min ${remainingSeconds} s`
            );

            const refreshInterval =
                getRefreshInterval();

            const nextRun = new Date(
                Date.now() + refreshInterval
            );

            console.log("");
            console.log(
                `Kolejny cykl o ${nextRun.toLocaleTimeString()}`
            );

            updateDashboard({
                offers: cycleResult.offers,
                refreshed: cycleResult.refreshed,
                cooldown: cycleResult.cooldown,
                skipped: cycleResult.skipped,
                duplicates: cycleResult.duplicates,
                duplicatesDeferred: cycleResult.duplicatesDeferred,
                rateLimitPauses: cycleResult.rateLimitPauses || 0,
                errors: cycleResult.errors,
                duration:
                    `${cycleDurationMinutes} min ${String(remainingSeconds).padStart(2, "0")} s`,
                nextStart: nextRun.toLocaleTimeString(
                    "pl-PL",
                    { hour12: false }
                )
            });

            await new Promise(
                r => setTimeout(
                    r,
                    refreshInterval
                )
            );
        }

    }

    async function bootstrap() {
        const remoteConfig =
            await fetchRemoteConfig();

        if (!applyRemoteConfig(remoteConfig)) {
            return;
        }

        await startWithCrossTabLock();
    }

    bootstrap().catch(e => {
        console.error(
            "Błąd uruchamiania skryptu:",
            e
        );

        appendErrorLog(
            "START",
            e.message || "Błąd uruchamiania skryptu"
        );
    });
})();
