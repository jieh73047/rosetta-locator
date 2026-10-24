(() => {
  "use strict";

  const GREEK_KEYS = [..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"];
  const LATIN_LOOKALIKES = {
    A: "Α", B: "Β", E: "Ε", H: "Η", I: "Ι", K: "Κ", M: "Μ",
    N: "Ν", O: "Ο", P: "Ρ", T: "Τ", X: "Χ", Y: "Υ", Z: "Ζ"
  };
  const BUILTIN_LINES = Object.freeze([...window.ROSETTA_LINES]);

  let lines = [...BUILTIN_LINES];
  let matches = [];
  let activeMatch = 0;
  let imageUrl = null;

  const el = {
    form: document.querySelector("#search-form"),
    query: document.querySelector("#query"),
    count: document.querySelector("#letter-count"),
    keyboard: document.querySelector("#keyboard"),
    message: document.querySelector("#message"),
    workspace: document.querySelector("#workspace"),
    resultCount: document.querySelector("#result-count"),
    results: document.querySelector("#results"),
    stage: document.querySelector("#stone-stage"),
    greekZone: document.querySelector("#greek-zone"),
    image: document.querySelector("#reference-image"),
    imageUpload: document.querySelector("#image-upload"),
    layer: document.querySelector("#highlight-layer"),
    transcript: document.querySelector("#transcript"),
    compactText: document.querySelector("#compact-text"),
    textUpload: document.querySelector("#text-upload"),
    resetText: document.querySelector("#reset-text"),
    installButton: document.querySelector("#install-button"),
    installDialog: document.querySelector("#install-dialog"),
    calibration: ["x", "y", "w", "h"].map(key => document.querySelector(`#cal-${key}`))
  };

  let deferredInstallPrompt = null;

  function normalizeCharacter(char) {
    const upper = char.toLocaleUpperCase("el");
    const latinMapped = LATIN_LOOKALIKES[upper] || upper;
    const bare = latinMapped.normalize("NFD").replace(/\p{M}/gu, "");
    const canonical = bare.replace(/[ςϹϲ]/g, "Σ");
    return /\p{Script=Greek}/u.test(canonical) && /\p{L}/u.test(canonical)
      ? canonical
      : "";
  }

  function normalizeWithMap(text, preserveGaps = false) {
    let normalized = "";
    const map = [];
    for (let index = 0; index < text.length;) {
      const char = String.fromCodePoint(text.codePointAt(index));
      const nextIndex = index + char.length;

      // A lacuna is not ordinary punctuation: matches must never jump across
      // letters that are missing from the surviving inscription.
      if (preserveGaps && char === "[") {
        const closingBracket = text.indexOf("]", nextIndex);
        if (closingBracket >= 0) {
          const inside = text.slice(nextIndex, closingBracket);
          if (!normalizeWithMap(inside).normalized) {
            normalized += "\u0000";
            map.push({ start: index, end: closingBracket + 1 });
            index = closingBracket + 1;
            continue;
          }
        }
      }
      if (preserveGaps && (char === "…" || text.slice(index, index + 3) === "...")) {
        normalized += "\u0000";
        map.push({ start: index, end: char === "…" ? nextIndex : index + 3 });
        index = char === "…" ? nextIndex : index + 3;
        continue;
      }

      const result = normalizeCharacter(char);
      for (const normalizedChar of result) {
        normalized += normalizedChar;
        map.push({ start: index, end: nextIndex });
      }
      index = nextIndex;
    }
    return { normalized, map };
  }

  function normalizedQuery() {
    return normalizeWithMap(el.query.value).normalized;
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
    })[char]);
  }

  function updateLetterCount() {
    const length = normalizedQuery().length;
    el.count.textContent = `${length} 个字母`;
    el.count.classList.toggle("is-ready", length >= 4);
    if (length >= 4) runSearch();
    else el.message.textContent = "";
  }

  function findMatches(query) {
    const found = [];
    lines.forEach((line, lineIndex) => {
      const indexed = normalizeWithMap(line, true);
      let from = 0;
      while (from <= indexed.normalized.length - query.length) {
        const normalizedIndex = indexed.normalized.indexOf(query, from);
        if (normalizedIndex < 0) break;
        const first = indexed.map[normalizedIndex];
        const last = indexed.map[normalizedIndex + query.length - 1];
        const letterIndex = indexed.normalized.slice(0, normalizedIndex).replace(/\u0000/g, "").length;
        found.push({
          lineIndex,
          line,
          normalizedLine: indexed.normalized,
          normalizedIndex,
          letterIndex,
          letterCount: indexed.normalized.replace(/\u0000/g, "").length,
          queryLength: query.length,
          sourceStart: first.start,
          sourceEnd: last.end
        });
        from = normalizedIndex + 1;
      }
    });
    return found;
  }

  function runSearch(event) {
    if (event) event.preventDefault();
    const query = normalizedQuery();
    if (query.length < 4) {
      el.message.textContent = `还需要 ${4 - query.length} 个希腊字母。`;
      el.query.focus();
      return;
    }

    matches = findMatches(query);
    activeMatch = 0;
    el.workspace.classList.remove("is-empty");
    el.message.textContent = matches.length
      ? `找到 ${matches.length} 处匹配；若有多处，请用拼片边缘或相邻字母继续核对。`
      : "没有找到匹配。请检查字母方向，也可以尝试导入该拼图版本的转录。";
    renderResults(query);
    renderMarkers();
    renderTranscript(query);
    if (event && window.innerWidth < 700) {
      el.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function contextMarkup(match) {
    const padding = 11;
    const start = Math.max(0, match.sourceStart - padding);
    const end = Math.min(match.line.length, match.sourceEnd + padding);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < match.line.length ? "…" : "";
    return `${prefix}${escapeHtml(match.line.slice(start, match.sourceStart))}` +
      `<mark>${escapeHtml(match.line.slice(match.sourceStart, match.sourceEnd))}</mark>` +
      `${escapeHtml(match.line.slice(match.sourceEnd, end))}${suffix}`;
  }

  function renderResults() {
    el.resultCount.textContent = `${matches.length} 处`;
    if (!matches.length) {
      el.results.innerHTML = `<div class="results-empty"><p>未找到</p><span>检查字母，或换一组清晰的连续字母。</span></div>`;
      return;
    }

    el.results.innerHTML = matches.map((match, index) => {
      const column = match.letterIndex + 1;
      const percentage = Math.round((column / match.letterCount) * 100);
      return `<button class="result-card${index === activeMatch ? " is-active" : ""}" data-index="${index}" type="button">
        <span class="result-meta"><b>匹配 ${String(index + 1).padStart(2, "0")}</b><span>第 ${match.lineIndex + 1} / ${lines.length} 行</span></span>
        <span class="result-context">${contextMarkup(match)}</span>
        <span class="result-position">本行第 ${column}–${column + match.queryLength - 1} 个字母 · 距行首约 ${percentage}%</span>
      </button>`;
    }).join("");

    el.results.querySelectorAll(".result-card").forEach(card => {
      card.addEventListener("click", () => selectMatch(Number(card.dataset.index)));
    });
  }

  function selectMatch(index) {
    activeMatch = index;
    el.results.querySelectorAll(".result-card").forEach((card, cardIndex) => {
      card.classList.toggle("is-active", cardIndex === index);
    });
    el.transcript.querySelectorAll("li").forEach((line, lineIndex) => {
      line.classList.toggle("is-match", lineIndex === matches[index].lineIndex);
    });
    renderMarkers();
  }

  function displayedImageRegion() {
    const stageRect = el.stage.getBoundingClientRect();
    if (el.stage.classList.contains("has-image")) {
      const imageRect = el.image.getBoundingClientRect();
      const [x, y, w, h] = el.calibration.map(input => Number(input.value) / 100);
      return {
        x: imageRect.left - stageRect.left + imageRect.width * x,
        y: imageRect.top - stageRect.top + imageRect.height * y,
        width: imageRect.width * w,
        height: imageRect.height * h
      };
    }
    const zoneRect = el.greekZone.getBoundingClientRect();
    return {
      x: zoneRect.left - stageRect.left,
      y: zoneRect.top - stageRect.top,
      width: zoneRect.width,
      height: zoneRect.height
    };
  }

  function renderMarkers() {
    el.layer.innerHTML = "";
    if (!matches.length) return;
    const region = displayedImageRegion();
    const shownMatches = matches.length > 20 ? [matches[activeMatch]] : matches;
    shownMatches.forEach(match => {
      const originalIndex = matches.indexOf(match);
      const horizontalRatio = (match.letterIndex + 2) / match.letterCount;
      const verticalRatio = (match.lineIndex + 0.5) / lines.length;
      const marker = document.createElement("div");
      marker.className = "marker";
      marker.style.left = `${region.x + region.width * horizontalRatio}px`;
      marker.style.top = `${region.y + region.height * verticalRatio}px`;
      marker.style.zIndex = originalIndex === activeMatch ? "2" : "1";
      marker.style.opacity = originalIndex === activeMatch ? "1" : ".62";
      marker.innerHTML = `<span class="marker-dot"></span><span class="marker-label">第 ${match.lineIndex + 1} 行</span>`;
      el.layer.appendChild(marker);
    });
  }

  function renderTranscript(query = normalizedQuery()) {
    const compact = el.compactText.checked;
    el.transcript.innerHTML = lines.map((line, lineIndex) => {
      let content = escapeHtml(compact ? line.replace(/\s+/g, "") : line);
      if (query.length >= 4) {
        const lineMatches = matches.filter(match => match.lineIndex === lineIndex);
        if (lineMatches.length && !compact) {
          let cursor = 0;
          content = lineMatches.map(match => {
            const part = escapeHtml(line.slice(cursor, match.sourceStart));
            const marked = `<mark>${escapeHtml(line.slice(match.sourceStart, match.sourceEnd))}</mark>`;
            cursor = match.sourceEnd;
            return part + marked;
          }).join("") + escapeHtml(line.slice(cursor));
        }
      }
      const matched = matches.some(match => match.lineIndex === lineIndex);
      return `<li class="${matched ? "is-match" : ""}">${content}</li>`;
    }).join("");
  }

  function buildKeyboard() {
    GREEK_KEYS.forEach(letter => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = letter;
      button.setAttribute("aria-label", `输入 ${letter}`);
      button.addEventListener("click", () => {
        el.query.value += letter;
        el.query.focus();
        updateLetterCount();
      });
      el.keyboard.appendChild(button);
    });
  }

  function loadReferenceImage(file) {
    if (!file || !file.type.startsWith("image/")) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(file);
    el.image.onload = () => {
      el.stage.classList.add("has-image");
      renderMarkers();
    };
    el.image.src = imageUrl;
    el.image.alt = `参考图：${file.name}`;
    document.querySelector("#calibration").open = true;
  }

  async function loadTranscript(file) {
    if (!file) return;
    const text = await file.text();
    const imported = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!imported.length) {
      el.message.textContent = "这个文本文件没有可用内容。请让每一行对应石碑上的一行。";
      return;
    }
    lines = imported;
    matches = [];
    el.workspace.classList.add("is-empty");
    el.resultCount.textContent = "0 处";
    el.results.innerHTML = `<div class="results-empty"><p>已导入 ${lines.length} 行</p><span>重新输入至少四个字母即可搜索。</span></div>`;
    el.message.textContent = `已导入 ${lines.length} 行自定义转录。`;
    renderTranscript("");
    renderMarkers();
  }

  function showInstallInstructions() {
    if (typeof el.installDialog.showModal === "function") {
      el.installDialog.showModal();
    } else {
      window.alert("iPad：点击 Safari 的分享按钮，再选择“添加到主屏幕”。\nAndroid：打开 Chrome 菜单，选择“安装应用”。");
    }
  }

  async function installApp() {
    if (!deferredInstallPrompt) {
      showInstallInstructions();
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice.outcome === "accepted") el.installButton.hidden = true;
  }

  el.form.addEventListener("submit", runSearch);
  el.query.addEventListener("input", updateLetterCount);
  el.imageUpload.addEventListener("change", event => loadReferenceImage(event.target.files[0]));
  el.textUpload.addEventListener("change", event => loadTranscript(event.target.files[0]));
  el.compactText.addEventListener("change", () => renderTranscript());
  el.resetText.addEventListener("click", () => {
    lines = [...BUILTIN_LINES];
    matches = [];
    el.query.value = "";
    updateLetterCount();
    el.workspace.classList.add("is-empty");
    el.resultCount.textContent = "0 处";
    el.results.innerHTML = `<div class="results-empty"><p>已恢复 54 行内置转录</p><span>输入至少四个字母开始定位。</span></div>`;
    renderTranscript("");
    renderMarkers();
  });
  el.installButton.addEventListener("click", installApp);
  el.calibration.forEach(input => input.addEventListener("input", renderMarkers));
  window.addEventListener("resize", renderMarkers);
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    el.installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    el.installButton.hidden = true;
  });

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isTabletLike = window.matchMedia("(pointer: coarse)").matches;
  if (!isStandalone && isTabletLike) el.installButton.hidden = false;

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(error => {
      console.warn("离线缓存注册失败：", error);
    });
  }

  buildKeyboard();
  renderTranscript("");
  const sharedQuery = new URLSearchParams(window.location.search).get("q");
  if (sharedQuery) el.query.value = sharedQuery;
  updateLetterCount();
})();
