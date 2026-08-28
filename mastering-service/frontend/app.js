(function () {
  "use strict";

  const form = document.getElementById("intake-form");
  const urlInput = document.getElementById("url-input");
  const submitBtn = document.getElementById("submit-btn");

  const strip = document.getElementById("strip");
  const trackTitle = document.getElementById("track-title");
  const statusText = document.getElementById("status-text");
  const meterFill = document.getElementById("meter-fill");
  const liveDot = document.getElementById("live-dot");

  const resultBox = document.getElementById("result");
  const readoutLufs = document.getElementById("readout-lufs");
  const readoutTp = document.getElementById("readout-tp");
  const downloadLink = document.getElementById("download-link");

  const errorBox = document.getElementById("error-box");

  const channels = Array.from(document.querySelectorAll(".channel"));

  let pollTimer = null;
  let lastSubmittedUrl = null;

  // ---- Мост с нативной iOS-обёрткой (Bridge/JSBridge.swift) ----
  // Если приложение запущено внутри WKWebView с нашим message handler'ом,
  // используем нативные возможности вместо веб-заглушек: скачивание файла
  // через share sheet (обычный <a download> в WKWebView ненадёжен) и показ
  // нативного paywall вместо веб-сообщения об исчерпанном лимите.
  const nativeBridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nativeBridge
    ? window.webkit.messageHandlers.nativeBridge
    : null;

  function getDeviceId() {
    // Нативное приложение подставляет window.DEVICE_ID до загрузки страницы
    // (см. WebViewContainer.swift - WKUserScript). В обычном браузере такого
    // нет - генерируем свой, чтобы у сервиса был стабильный идентификатор
    // для лимитов бесплатного тарифа при тестировании через браузер.
    if (window.DEVICE_ID) return window.DEVICE_ID;
    let id = localStorage.getItem("device_id");
    if (!id) {
      id = "web-" + crypto.randomUUID();
      localStorage.setItem("device_id", id);
    }
    return id;
  }

  const DEVICE_ID = getDeviceId();

  function apiFetch(path, options) {
    options = options || {};
    options.headers = Object.assign({ "X-Device-Id": DEVICE_ID }, options.headers || {});
    return fetch(path, options);
  }

  // Нативная сторона зовёт это после успешной покупки (evaluateJavaScript),
  // чтобы автоматически повторить последнюю попытку без лишнего тапа.
  window.onEntitlementUpdated = function () {
    if (lastSubmittedUrl) {
      urlInput.value = lastSubmittedUrl;
      form.requestSubmit();
    }
  };

  function resetStrip() {
    channels.forEach((c) => c.classList.remove("channel--active", "channel--done"));
    meterFill.classList.remove("is-active", "is-done");
    meterFill.style.width = "4%";
    resultBox.hidden = true;
    errorBox.hidden = true;
    liveDot.style.background = "var(--copper)";
  }

  function applyStage(stageIndex, isDone) {
    channels.forEach((c) => {
      const idx = Number(c.dataset.stage);
      c.classList.remove("channel--active", "channel--done");
      if (idx < stageIndex || (isDone && idx <= stageIndex)) {
        c.classList.add("channel--done");
      } else if (idx === stageIndex && !isDone) {
        c.classList.add("channel--active");
      }
    });

    const pct = Math.max(4, (stageIndex / 4) * 100);
    meterFill.style.width = pct + "%";
    meterFill.classList.toggle("is-active", !isDone && stageIndex > 0);
    meterFill.classList.toggle("is-done", isDone);
  }

  function showError(message) {
    stopPolling();
    errorBox.textContent = message;
    errorBox.hidden = false;
    statusText.textContent = "Обработка остановлена";
    liveDot.style.background = "var(--error)";
    setSubmitEnabled(true);
  }

  function showResult(job) {
    stopPolling();
    resultBox.hidden = false;
    readoutLufs.textContent = job.final_lufs !== null ? job.final_lufs.toFixed(1) + " LUFS" : "—";
    readoutTp.textContent = job.final_true_peak_db !== null ? job.final_true_peak_db.toFixed(2) + " dBTP" : "—";
    downloadLink.href = `/api/jobs/${job.id}/download`;
    downloadLink.dataset.jobId = job.id;
    liveDot.style.background = "var(--teal)";
    setSubmitEnabled(true);
  }

  function setSubmitEnabled(enabled) {
    submitBtn.disabled = !enabled;
    submitBtn.querySelector("span").textContent = enabled ? "Смастерить" : "Обрабатываем…";
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollJob(jobId) {
    try {
      const res = await apiFetch(`/api/jobs/${jobId}`);
      if (!res.ok) {
        showError("Не удалось получить статус задачи");
        return;
      }
      const job = await res.json();

      trackTitle.textContent = job.title || "…";
      statusText.textContent = job.status_label;
      applyStage(job.stage_index, job.status === "done");

      if (job.status === "error") {
        showError(job.error || "Что-то пошло не так");
      } else if (job.status === "done") {
        showResult(job);
      }
    } catch (err) {
      showError("Потеряна связь с сервером");
    }
  }

  // Скачивание: в обычном браузере - штатная ссылка. Внутри нативной
  // обёртки WKWebView download-ссылки ненадёжны, поэтому просим нативную
  // сторону скачать файл сама и показать системный share sheet.
  downloadLink.addEventListener("click", (e) => {
    if (!nativeBridge) return; // обычный браузер - пусть работает <a download>
    e.preventDefault();
    nativeBridge.postMessage({
      type: "download",
      url: downloadLink.href,
      filename: (trackTitle.textContent || "master").trim() + ".wav",
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    lastSubmittedUrl = url;
    resetStrip();
    strip.hidden = false;
    trackTitle.textContent = "Отправляем ссылку…";
    statusText.textContent = "В очереди…";
    setSubmitEnabled(false);

    try {
      const res = await apiFetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtube_url: url }),
      });

      if (res.status === 402) {
        // Дневной лимит бесплатного тарифа исчерпан - в приложении это
        // повод показать нативный paywall, а не текстовую ошибку.
        setSubmitEnabled(true);
        strip.hidden = true;
        if (nativeBridge) {
          nativeBridge.postMessage({ type: "show_paywall" });
        } else {
          showError("Дневной лимит бесплатной версии исчерпан. В приложении здесь откроется подписка Pro.");
          strip.hidden = false;
        }
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.detail || "Не удалось создать задачу");
        return;
      }

      const job = await res.json();
      pollTimer = setInterval(() => pollJob(job.id), 1500);
      pollJob(job.id);
    } catch (err) {
      showError("Не удалось связаться с сервером");
    }
  });
})();

