/* Sources catalog: search-led shelves + shared cards + pagination */
(function () {
  "use strict";

  var PAGE_SIZE = 20;
  var CORPUS_URL = "data/corpus-index.json";
  var SEARCH_URL = "data/authority-search-index.json";
  var CHAPTER_INDEX_URL = "data/sources-index.json";
  // Temporary: hide card summary, book_role, and chapter-list expand chevrons
  // on the public site while those fields are still being reviewed. Local
  // preview (localhost / 127.0.0.1) still shows them for review.
  var SHOW_CARD_COPY =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

  var listEl = document.getElementById("chapter-list");
  var chapterSelectEl = document.getElementById("chapter-select");
  var chapterTriggerEl = document.getElementById("chapter-custom-trigger");
  var chapterTriggerLabelEl = document.getElementById("chapter-custom-trigger-label");
  var chapterMenuEl = document.getElementById("chapter-custom-list");
  var exploreEl = document.getElementById("explore-keywords");
  var outEl = document.getElementById("sources-output");
  var headingEl = document.getElementById("sources-heading");
  var pagerEl = document.getElementById("catalog-pager");
  var notesEl = document.getElementById("catalog-notes");
  var backEl = document.getElementById("back-to-top");
  var inputEl = document.getElementById("authority-search-input");
  var suggestEl = document.getElementById("authority-search-suggestions");
  var clearEl = document.getElementById("authority-search-clear");
  var shelvesEl = document.getElementById("catalog-shelves");

  var corpus = null;
  var searchIndex = null;
  var miniSearch = null;
  var titleSearch = null;
  var chapterMeta = [];
  var activeSuggestion = -1;
  var currentSuggestions = [];
  var view = {
    mode: "idle", // idle | chapter | keyword | explore | source
    chapter: null,
    // true = stripped chapter permalink entry; false = in-page filter via Chapters selector
    chapterEntry: false,
    keyword: null,
    sourceKey: null,
    page: 1,
  };
  // When true, view changes must not push/replace the URL (popstate / boot restore).
  var applyingHistory = false;
  // Desktop chapter-list hover preview (popover).
  var sourcePreviewEl = null;
  var sourcePreviewShowTimer = null;
  var sourcePreviewHideTimer = null;
  var sourcePreviewKey = null;
  // Last pointer position over a bibliography link (viewport coords).
  var sourcePreviewPointer = { x: 0, y: 0, hasPoint: false };
  var SOURCE_PREVIEW_SHOW_MS = 380;
  var SOURCE_PREVIEW_HIDE_MS = 180;

  function escapeHtml(value) {
    if (value === undefined || value === null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function chapterLabel(n) {
    return n === 0 ? "Prologue" : "Chapter " + n;
  }

  function sortByChapterThenId(rows) {
    return rows.slice().sort(function (a, b) {
      if (a.chapter !== b.chapter) return a.chapter - b.chapter;
      return (a.id || 0) - (b.id || 0);
    });
  }

  function sourcesForView() {
    if (!corpus) return [];
    if (view.mode === "source" && view.sourceKey) {
      return sortByChapterThenId(corpus.sources.filter(function (s) {
        return s.source_key === view.sourceKey;
      }));
    }
    if (view.mode === "keyword" && view.keyword && searchIndex) {
      var keys = searchIndex.keywordSources[view.keyword.id] || [];
      var wanted = {};
      keys.forEach(function (k) { wanted[k] = true; });
      return sortByChapterThenId(corpus.sources.filter(function (s) {
        return wanted[s.source_key];
      }));
    }
    if (view.mode === "explore" && view.keyword && searchIndex) {
      var keys2 = searchIndex.keywordSources[view.keyword.id] || [];
      var wanted2 = {};
      keys2.forEach(function (k) { wanted2[k] = true; });
      return sortByChapterThenId(corpus.sources.filter(function (s) {
        return wanted2[s.source_key];
      }));
    }
    if (view.chapter != null) {
      return sortByChapterThenId(corpus.sources.filter(function (s) {
        return s.chapter === view.chapter && (s.section || "main") === "main";
      }));
    }
    return [];
  }

  function youtubeStartSeconds(url) {
    var raw = (url.match(/[?&#](?:t|start)=([^&#]+)/) || [])[1];
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10) || 0;
    var hours = parseInt((raw.match(/(\d+)h/) || [])[1] || "0", 10);
    var mins = parseInt((raw.match(/(\d+)m/) || [])[1] || "0", 10);
    var secs = parseInt((raw.match(/(\d+)s/) || [])[1] || "0", 10);
    return hours * 3600 + mins * 60 + secs;
  }

  function youtubeEmbedFromUrl(url) {
    if (!url) return null;
    var m =
      url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ||
      url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ||
      url.match(/youtube\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
    if (!m) return null;
    var src = "https://www.youtube.com/embed/" + encodeURIComponent(m[1]);
    var start = youtubeStartSeconds(url);
    if (start > 0) src += "?start=" + start;
    return src;
  }

  function tweetStatusUrl(url) {
    if (!url) return null;
    var m = url.match(
      /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i
    );
    if (!m) return null;
    return "https://twitter.com/i/status/" + m[1];
  }

  function hostEmbed(s) {
    var url = (s && s.url) || "";
    var yt = youtubeEmbedFromUrl(url);
    if (yt) {
      return (
        '<div class="catalog-card-embed catalog-card-embed--youtube">' +
          '<iframe src="' + escapeHtml(yt) + '" title="' + escapeHtml(s.title || "YouTube video") + '" ' +
            'loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
            "allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe>" +
        "</div>"
      );
    }
    var tweet = tweetStatusUrl(url);
    if (tweet) {
      return (
        '<div class="catalog-card-embed catalog-card-embed--tweet">' +
          '<blockquote class="twitter-tweet" data-dnt="true" data-conversation="none">' +
            '<a href="' + escapeHtml(tweet) + '">View post on X</a>' +
          "</blockquote>" +
        "</div>"
      );
    }
    return "";
  }

  function ensureTwitterWidgets(root) {
    if (!root || !root.querySelector || !root.querySelector(".twitter-tweet")) return;
    function load() {
      if (window.twttr && window.twttr.widgets && typeof window.twttr.widgets.load === "function") {
        window.twttr.widgets.load(root);
        return;
      }
      if (document.getElementById("twitter-wjs")) return;
      var s = document.createElement("script");
      s.id = "twitter-wjs";
      s.async = true;
      s.src = "https://platform.twitter.com/widgets.js";
      s.charset = "utf-8";
      document.head.appendChild(s);
    }
    load();
  }

  function cardMedia(s) {
    // Prefer live embed over a static thumbnail when the host is YouTube/X.
    if (hostEmbed(s) || !s.image_url) return "";
    return (
      '<div class="catalog-card-media">' +
        '<img src="' + escapeHtml(s.image_url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="catalog-card-image">' +
      "</div>"
    );
  }

  function cardCopyParts(s) {
    var chips = [];
    if (s.content_kind && s.content_kind !== "html_article" && s.content_kind_label) {
      chips.push(s.content_kind_label);
    }
    (s.topics || []).slice(0, 4).forEach(function (topic) {
      if (topic) chips.push(topic);
    });
    var topicLine = chips.length
      ? '<ul class="catalog-card-topics" aria-label="Topics">' +
          chips
            .map(function (chip) {
              return '<li class="catalog-card-topic">' + escapeHtml(chip) + "</li>";
            })
            .join("") +
        "</ul>"
      : "";
    var role = SHOW_CARD_COPY && s.book_role
      ? '<p class="catalog-card-role"><span>In the book</span> ' + escapeHtml(s.book_role) + "</p>"
      : "";
    var embed = hostEmbed(s);
    var statusNote = "";
    if (s.status === "paywall") {
      statusNote =
        '<p class="catalog-card-status">Source access note: Full text may be paywalled.</p>';
    } else if (s.status === "skipped" && embed) {
      statusNote = "";
    } else if (s.status && s.status !== "ok") {
      statusNote =
        '<p class="catalog-card-status">Access note: ' + escapeHtml(s.status) + "</p>";
    }
    var summary =
      SHOW_CARD_COPY && s.summary
        ? '<p class="catalog-card-summary">' + escapeHtml(s.summary) + "</p>"
        : "";
    return {
      summary: summary,
      role: role,
      topicLine: topicLine,
      statusNote: statusNote,
      embed: embed,
      hasCopy: !!(summary || role || topicLine || statusNote),
    };
  }

  function enrichmentBlock(s) {
    // Chapter expand panel: left text + right thumb (desktop); stacked on mobile.
    var parts = cardCopyParts(s);
    var media = cardMedia(s);
    if (!parts.hasCopy && !media && !parts.embed) return "";
    var text = parts.hasCopy
      ? '<div class="catalog-card-copy">' +
          parts.summary +
          parts.role +
          parts.topicLine +
          parts.statusNote +
        "</div>"
      : "";
    return (
      '<div class="catalog-card-enrichment">' +
        (text || media
          ? '<div class="catalog-card-layout catalog-card-layout--detail' +
              (media ? " catalog-card-layout--media" : "") +
            '">' +
              media +
              '<div class="catalog-card-rest">' + text + "</div>" +
            "</div>"
          : "") +
        parts.embed +
      "</div>"
    );
  }

  function sourceHasDetail(s) {
    return !!(
      s.image_url ||
      (SHOW_CARD_COPY && s.summary) ||
      (SHOW_CARD_COPY && s.book_role) ||
      (s.topics && s.topics.length) ||
      (s.status && s.status !== "ok") ||
      hostEmbed(s)
    );
  }

  function renderCard(s, opts) {
    opts = opts || {};
    var biblio = [s.author, s.publication, s.date].filter(Boolean).map(escapeHtml).join(" · ");
    var url = s.url || "#";
    // Hover previews: image/copy only — no YouTube/X embeds (avoids autoplay / heavy widgets).
    var media = opts.preview
      ? s.image_url
        ? '<div class="catalog-card-media">' +
            '<img src="' + escapeHtml(s.image_url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="catalog-card-image">' +
          "</div>"
        : ""
      : cardMedia(s);
    var parts = cardCopyParts(s);
    var restInner =
      (biblio ? '<p class="catalog-card-biblio">' + biblio + "</p>" : "") +
      (parts.hasCopy
        ? '<div class="catalog-card-copy">' +
            parts.summary +
            parts.role +
            parts.topicLine +
            parts.statusNote +
          "</div>"
        : "");
    return (
      '<article class="catalog-card' + (opts.preview ? " catalog-card--preview" : "") + '">' +
        '<div class="catalog-card-layout' + (media ? " catalog-card-layout--media" : "") + '">' +
          '<h3 class="catalog-card-title">' +
            '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(s.title || "Untitled source") +
            "</a>" +
          "</h3>" +
          media +
          (restInner
            ? '<div class="catalog-card-rest">' + restInner + "</div>"
            : "") +
        "</div>" +
        (opts.preview ? "" : parts.embed) +
      "</article>"
    );
  }

  function renderChapterSourceList(rows) {
    if (!rows.length) {
      return '<p class="status">No sources listed for this chapter.</p>';
    }
    var items = rows.map(function (s) {
      var id = escapeHtml(s.id != null ? s.id : "?");
      var url = (typeof s.url === "string" && s.url) ? s.url : "#";
      var author = escapeHtml(s.author || "");
      var title = escapeHtml(s.title || "");
      var publication = escapeHtml(s.publication || "");
      var date = escapeHtml(s.date || "");
      var key = escapeHtml(s.source_key || ("ch" + s.chapter + "-s" + s.id));
      var detail = enrichmentBlock(s);
      // Expand chevron + detail panel: local review only (same gate as summary/book_role).
      var hasDetail = SHOW_CARD_COPY && sourceHasDetail(s);
      return (
        '<li class="source-item' + (hasDetail ? " source-item-expandable" : "") + '" data-source-key="' + key + '">' +
          '<div class="source-item-main">' +
            '<span class="source-id" aria-hidden="true">' + id + ".</span>" +
            '<span class="source-ref">' +
              '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
                (author ? author + ", " : "") +
                "<em>" + title + "</em>" +
                (publication ? ", " + publication : "") +
                (date ? ", " + date : "") +
              "</a>" +
            "</span>" +
            (hasDetail
              ? '<button type="button" class="source-expand-btn" aria-expanded="false" aria-controls="detail-' + key + '" title="Show source details" aria-label="Show details for source ' + id + '">' +
                  '<span class="source-expand-icon" aria-hidden="true"></span>' +
                "</button>"
              : "") +
          "</div>" +
          (hasDetail
            ? '<div class="source-item-detail" id="detail-' + key + '" hidden>' + detail + "</div>"
            : "") +
        "</li>"
      );
    }).join("\n");
    return '<ol class="sources-list">' + items + "</ol>";
  }

  function isDesktopSourcePreview() {
    return window.matchMedia("(min-width: 640px)").matches;
  }

  function clearSourcePreviewTimers() {
    if (sourcePreviewShowTimer) {
      clearTimeout(sourcePreviewShowTimer);
      sourcePreviewShowTimer = null;
    }
    if (sourcePreviewHideTimer) {
      clearTimeout(sourcePreviewHideTimer);
      sourcePreviewHideTimer = null;
    }
  }

  function hideSourcePreview() {
    clearSourcePreviewTimers();
    sourcePreviewKey = null;
    sourcePreviewPointer.hasPoint = false;
    if (!sourcePreviewEl) return;
    sourcePreviewEl.hidden = true;
    sourcePreviewEl.innerHTML = "";
    sourcePreviewEl.setAttribute("aria-hidden", "true");
  }

  function ensureSourcePreviewEl() {
    if (sourcePreviewEl) return sourcePreviewEl;
    sourcePreviewEl = document.createElement("div");
    sourcePreviewEl.id = "source-hover-preview";
    sourcePreviewEl.className = "source-hover-preview";
    sourcePreviewEl.hidden = true;
    sourcePreviewEl.setAttribute("aria-hidden", "true");
    sourcePreviewEl.addEventListener("mouseenter", function () {
      if (sourcePreviewHideTimer) {
        clearTimeout(sourcePreviewHideTimer);
        sourcePreviewHideTimer = null;
      }
    });
    sourcePreviewEl.addEventListener("mouseleave", function () {
      scheduleHideSourcePreview();
    });
    document.body.appendChild(sourcePreviewEl);
    return sourcePreviewEl;
  }

  function rememberSourcePreviewPointer(e) {
    if (!e) return;
    sourcePreviewPointer.x = e.clientX;
    sourcePreviewPointer.y = e.clientY;
    sourcePreviewPointer.hasPoint = true;
  }

  function positionSourcePreview(anchorEl) {
    if (!sourcePreviewEl) return;
    var gapX = 14;
    var gapY = 18;
    var pad = 12;
    var pop = sourcePreviewEl.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var px;
    var py;
    if (sourcePreviewPointer.hasPoint) {
      px = sourcePreviewPointer.x;
      py = sourcePreviewPointer.y;
    } else if (anchorEl) {
      // Fallback if we somehow lack a pointer sample (keyboard / synthetic).
      var rect = anchorEl.getBoundingClientRect();
      px = rect.left + Math.min(24, rect.width / 2);
      py = rect.top + rect.height / 2;
    } else {
      return;
    }
    // Prefer below-right of the cursor so the pointer isn't covering the card.
    var left = px + gapX;
    var top = py + gapY;
    if (left + pop.width > vw - pad) left = px - gapX - pop.width;
    if (left < pad) left = pad;
    if (left + pop.width > vw - pad) left = Math.max(pad, vw - pad - pop.width);
    if (top + pop.height > vh - pad) top = py - gapY - pop.height;
    if (top < pad) top = pad;
    if (top + pop.height > vh - pad) top = Math.max(pad, vh - pad - pop.height);
    sourcePreviewEl.style.left = Math.round(left) + "px";
    sourcePreviewEl.style.top = Math.round(top) + "px";
  }

  function showSourcePreview(anchorEl, sourceKey) {
    if (!isDesktopSourcePreview() || !corpus || !anchorEl || !sourceKey) return;
    var row = (corpus.sources || []).find(function (s) {
      return s.source_key === sourceKey;
    });
    if (!row) return;
    var el = ensureSourcePreviewEl();
    sourcePreviewKey = sourceKey;
    el.innerHTML = renderCard(row, { preview: true });
    el.hidden = false;
    el.removeAttribute("aria-hidden");
    // Place from the latest pointer sample; remeasure after layout.
    positionSourcePreview(anchorEl);
    requestAnimationFrame(function () {
      positionSourcePreview(anchorEl);
    });
  }

  function scheduleShowSourcePreview(anchorEl, sourceKey) {
    if (!isDesktopSourcePreview()) return;
    clearSourcePreviewTimers();
    // Same card already open: leave it put so it doesn't run away from the cursor.
    if (sourcePreviewKey === sourceKey && sourcePreviewEl && !sourcePreviewEl.hidden) {
      return;
    }
    sourcePreviewShowTimer = setTimeout(function () {
      sourcePreviewShowTimer = null;
      showSourcePreview(anchorEl, sourceKey);
    }, SOURCE_PREVIEW_SHOW_MS);
  }

  function scheduleHideSourcePreview() {
    if (sourcePreviewHideTimer) clearTimeout(sourcePreviewHideTimer);
    sourcePreviewHideTimer = setTimeout(function () {
      sourcePreviewHideTimer = null;
      hideSourcePreview();
    }, SOURCE_PREVIEW_HIDE_MS);
  }

  function renderPager(total) {
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (view.page > pages) view.page = pages;
    if (total <= PAGE_SIZE) {
      pagerEl.hidden = true;
      pagerEl.innerHTML = "";
      return;
    }
    pagerEl.hidden = false;
    var prevDisabled = view.page <= 1 ? " disabled" : "";
    var nextDisabled = view.page >= pages ? " disabled" : "";
    pagerEl.innerHTML =
      '<button type="button" class="catalog-page-btn" data-page="prev"' + prevDisabled + ">Previous</button>" +
      '<span class="catalog-page-status">Page ' + view.page + " of " + pages + "</span>" +
      '<button type="button" class="catalog-page-btn" data-page="next"' + nextDisabled + ">Next</button>";
  }

  function syncClearButton() {
    var show =
      inputEl.value.trim().length > 0 ||
      view.mode === "keyword" ||
      view.mode === "explore" ||
      view.mode === "source";
    clearEl.hidden = !show;
  }

  function sourceCountLabel(n) {
    return n + (n === 1 ? " source" : " sources");
  }

  function renderEntryNav() {
    var base = location.pathname || "/origins/sources/";
    return (
      '<nav class="source-entry-nav" aria-label="Continue browsing the catalog">' +
        '<a class="source-entry-nav-link" href="' + escapeHtml(base) + '#sources-search" data-source-exit="search">Search all sources</a>' +
        '<a class="source-entry-nav-link" href="' + escapeHtml(base) + '#sources-chapters" data-source-exit="chapters">Browse by chapter</a>' +
      "</nav>"
    );
  }

  function catalogFocusFromHash() {
    var hash = (location.hash || "").replace(/^#/, "");
    if (hash === "sources-search") return "search";
    if (hash === "sources-chapters" || hash === "chapter-list") return "chapters";
    return null;
  }

  function focusWithoutScroll(el) {
    if (!el || typeof el.focus !== "function") return;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  }

  function activateCatalogTarget(target) {
    if (target === "search") {
      focusWithoutScroll(inputEl);
      return;
    }
    if (target !== "chapters") return;
    // Focus only — do not auto-open the list (avoids below-fold / scroll confusion).
    if (isDesktopChapterPicker()) {
      focusWithoutScroll(chapterTriggerEl);
      return;
    }
    focusWithoutScroll(chapterSelectEl);
  }

  function exitEntryTo(target) {
    showIdle();
    // Stay at page top; activate search/chapters without scroll-into-view from focus().
    window.scrollTo(0, 0);
    requestAnimationFrame(function () {
      activateCatalogTarget(target);
      window.scrollTo(0, 0);
    });
  }

  function renderResults() {
    hideSourcePreview();
    var rows = sourcesForView();
    var total = rows.length;

    // Chapter entry keeps Back to top (long notes); source entry hides it.
    backEl.hidden = view.mode === "source";
    headingEl.hidden = false;
    syncClearButton();

    if (view.mode === "keyword" || view.mode === "explore" || view.mode === "source") {
      var label;
      var sourceChapterHtml = "";
      if (view.mode === "source") {
        // Title appears on the card only; heading is "Sources · Chapter N".
        var sourceRow = rows[0];
        label = "Sources";
        if (sourceRow && sourceRow.chapter != null && !Number.isNaN(Number(sourceRow.chapter))) {
          var chNum = Number(sourceRow.chapter);
          var chHref =
            (location.pathname || "/origins/sources/") +
            "?chapter=" +
            encodeURIComponent(String(chNum));
          sourceChapterHtml =
            '<span class="sources-heading-count"> · ' +
              '<a class="sources-heading-chapter" href="' + escapeHtml(chHref) + '" data-open-chapter="' + escapeHtml(String(chNum)) + '">' +
                escapeHtml(chapterLabel(chNum)) +
              "</a>" +
            "</span>";
        }
      } else {
        label = (view.keyword && view.keyword.label) || "Sources";
      }
      headingEl.innerHTML =
        '<span class="sources-heading-label">' + escapeHtml(label) + "</span>" +
        (view.mode === "source"
          ? sourceChapterHtml
          : '<span class="sources-heading-count"> · ' + escapeHtml(sourceCountLabel(total)) + "</span>");
      notesEl.hidden = true;
      notesEl.innerHTML = "";

      var start = (view.page - 1) * PAGE_SIZE;
      var pageRows = rows.slice(start, start + PAGE_SIZE);
      var entryNav = view.mode === "source" ? renderEntryNav() : "";
      if (!pageRows.length) {
        outEl.innerHTML =
          '<div class="catalog-empty" role="status">' +
            "<p>" +
              (view.mode === "source"
                ? "No matching source found."
                : "No sources tagged with “" + escapeHtml(label) + "”.") +
            "</p>" +
            (view.mode === "source"
              ? ""
              : '<button type="button" class="catalog-empty-clear">Clear search</button>') +
          "</div>" +
          entryNav;
        renderPager(0);
        return;
      }
      outEl.innerHTML =
        '<div class="catalog-card-list">' +
        pageRows.map(renderCard).join("") +
        "</div>" +
        entryNav;
      ensureTwitterWidgets(outEl);
      renderPager(total);
      return;
    }

    var chName = chapterLabel(view.chapter);
    var meta = (corpus.chapters || []).find(function (c) { return c.number === view.chapter; });
    // Prologue title already includes "Prologue:"; avoid "Prologue — Prologue: …"
    if (meta && meta.title) {
      var titleStartsWithName = meta.name && meta.title.indexOf(meta.name) === 0;
      headingEl.textContent = titleStartsWithName ? meta.title : (meta.name + " — " + meta.title);
    } else {
      headingEl.textContent = chName;
    }
    pagerEl.hidden = true;
    pagerEl.innerHTML = "";
    outEl.innerHTML =
      renderChapterSourceList(rows) +
      (view.chapterEntry ? renderEntryNav() : "");
    return loadNotes(view.chapter);
  }

  function sourceKeyFromHref(href) {
    if (!href) return "";
    try {
      return new URL(href, location.href).searchParams.get("source") || "";
    } catch (err) {
      var m = String(href).match(/[?&]source=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    }
  }

  function normalizeSourceUrl(url) {
    if (!url) return "";
    try {
      var u = new URL(url, location.href);
      var host = String(u.hostname || "").replace(/^www\./i, "").toLowerCase();
      var path = String(u.pathname || "").replace(/\/+$/, "");
      return host + path;
    } catch (err) {
      return String(url).toLowerCase();
    }
  }

  function sourceKeyByNormalizedUrl() {
    var map = Object.create(null);
    (corpus.sources || []).forEach(function (s) {
      var n = normalizeSourceUrl(s.url);
      if (!n) return;
      if (Object.prototype.hasOwnProperty.call(map, n) && map[n] !== s.source_key) {
        map[n] = ""; // ambiguous URL → skip preview wiring
        return;
      }
      map[n] = s.source_key;
    });
    return map;
  }

  function enhanceNotesSourceLinks(root) {
    // Notes HTML: (1) stable ?source= cross-refs → external URL + preview key;
    // (2) existing Notes source hyperlinks → same preview key when URL matches corpus.
    if (!root || !corpus) return;
    Array.prototype.forEach.call(root.querySelectorAll('a[href^="?source="]'), function (a) {
      var key = sourceKeyFromHref(a.getAttribute("href") || "");
      if (!key) return;
      var row = (corpus.sources || []).find(function (s) {
        return s.source_key === key;
      });
      a.setAttribute("data-source-key", key);
      a.classList.add("notes-source-ref");
      if (row && row.url) {
        a.setAttribute("href", row.url);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
    var byUrl = sourceKeyByNormalizedUrl();
    Array.prototype.forEach.call(root.querySelectorAll('a[href^="http"]'), function (a) {
      if (a.getAttribute("data-source-key")) return;
      var key = byUrl[normalizeSourceUrl(a.getAttribute("href") || "")];
      if (!key) return;
      a.setAttribute("data-source-key", key);
      a.classList.add("notes-source-ref");
      if (!a.getAttribute("target")) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  function loadNotes(chapterNumber) {
    notesEl.hidden = false;
    notesEl.innerHTML = '<p class="status">Loading notes…</p>';
    return fetch("data/notes/" + String(chapterNumber).padStart(2, "0") + ".html", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        // Repeat exit nav after notes so long chapter pages still offer a way out.
        notesEl.innerHTML =
          '<hr class="notes-divider">' +
          html +
          (view.chapterEntry ? renderEntryNav() : "");
        enhanceNotesSourceLinks(notesEl);
        // Notes inject can nudge scroll; keep Chapters pinned for in-page browse.
        if (view.mode === "chapter" && !view.chapterEntry) pinChaptersShelf();
        return true;
      })
      .catch(function () {
        notesEl.innerHTML = view.chapterEntry ? renderEntryNav() : "";
        notesEl.hidden = !view.chapterEntry;
        return false;
      });
  }

  function isDesktopChapterPicker() {
    return window.matchMedia("(min-width: 640px)").matches;
  }

  function chapterOptionLabel(value) {
    if (!chapterSelectEl) return "Select a chapter…";
    if (value === "" || value == null) return "Select a chapter…";
    var opt = chapterSelectEl.querySelector('option[value="' + String(value).replace(/"/g, '\\"') + '"]');
    return (opt && opt.textContent) || "Select a chapter…";
  }

  function syncChapterCustomUi(value) {
    if (!chapterTriggerLabelEl || !chapterMenuEl) return;
    var next = value == null || value === "" ? "" : String(value);
    chapterTriggerLabelEl.textContent = chapterOptionLabel(next);
    Array.prototype.forEach.call(chapterMenuEl.querySelectorAll("[role='option']"), function (opt) {
      var selected = opt.getAttribute("data-value") === next;
      opt.setAttribute("aria-selected", selected ? "true" : "false");
      opt.classList.toggle("is-selected", selected);
    });
  }

  function setChapterMenuOpen(open) {
    if (!chapterMenuEl || !chapterTriggerEl) return;
    chapterMenuEl.hidden = !open;
    chapterTriggerEl.setAttribute("aria-expanded", open ? "true" : "false");
    // Keep closed options out of the accessibility tree (hidden alone is not enough everywhere).
    if (open) {
      chapterMenuEl.removeAttribute("aria-hidden");
      chapterMenuEl.inert = false;
    } else {
      chapterMenuEl.setAttribute("aria-hidden", "true");
      chapterMenuEl.inert = true;
    }
  }

  function syncChapterPickerA11y() {
    var desktop = isDesktopChapterPicker();
    var customWrap = document.querySelector(".catalog-chapter-custom");
    if (chapterSelectEl) {
      if (desktop) {
        chapterSelectEl.setAttribute("aria-hidden", "true");
        chapterSelectEl.tabIndex = -1;
      } else {
        chapterSelectEl.removeAttribute("aria-hidden");
        chapterSelectEl.removeAttribute("tabindex");
      }
    }
    if (customWrap) {
      if (desktop) {
        customWrap.removeAttribute("aria-hidden");
        customWrap.inert = false;
      } else {
        customWrap.setAttribute("aria-hidden", "true");
        customWrap.inert = true;
        setChapterMenuOpen(false);
      }
    }
  }

  function closeChapterMenu() {
    if (!chapterMenuEl || !chapterTriggerEl || chapterMenuEl.hidden) return;
    setChapterMenuOpen(false);
  }

  function scrollChaptersLabelIntoView() {
    // Desktop: pin the "Chapters" shelf at the top (below the sticky header).
    if (!isDesktopChapterPicker()) return;
    var target =
      document.getElementById("sources-chapters") ||
      document.getElementById("chapters-label");
    if (!target) return;
    var header = document.querySelector(".site-header");
    var headerH = header ? header.getBoundingClientRect().height : 0;
    var gap = 8;
    var top = target.getBoundingClientRect().top + window.scrollY - headerH - gap;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  function openChapterMenu(opts) {
    opts = opts || {};
    if (!chapterMenuEl || !chapterTriggerEl || chapterTriggerEl.disabled) return;
    if (!isDesktopChapterPicker()) return;
    hideSuggestions();
    setChapterMenuOpen(true);
    if (opts.pinChapters !== false) {
      pinChaptersShelf();
    }
    // Do not scrollIntoView a selected option here: that jumps the page so the
    // trigger sits above the viewport and the list looks like it opened above it.
    if (opts.focusOption === false) return;
    var selected = chapterMenuEl.querySelector('[role="option"][aria-selected="true"]');
    var focusOpt = selected || chapterMenuEl.querySelector('[role="option"]');
    focusWithoutScroll(focusOpt);
  }

  function toggleChapterMenu(opts) {
    if (!chapterMenuEl) return;
    if (chapterMenuEl.hidden) openChapterMenu(opts);
    else closeChapterMenu();
  }

  function setChapterActive(number) {
    if (!chapterSelectEl) return;
    var value = number == null || number === "" ? "" : String(number);
    if (chapterSelectEl.value !== value) chapterSelectEl.value = value;
    syncChapterCustomUi(value);
    closeChapterMenu();
  }

  function clearExploreActive() {
    Array.prototype.forEach.call(exploreEl.querySelectorAll("button"), function (b) {
      b.classList.remove("active");
    });
  }

  function catalogHistoryState() {
    if (view.mode === "source" && view.sourceKey) {
      return { mode: "source", source: view.sourceKey };
    }
    if (view.mode === "chapter" && view.chapter != null) {
      return {
        mode: "chapter",
        chapter: view.chapter,
        entry: !!view.chapterEntry,
      };
    }
    if ((view.mode === "keyword" || view.mode === "explore") && view.keyword && view.keyword.id) {
      return { mode: view.mode, keyword: view.keyword.id };
    }
    return { mode: "idle" };
  }

  function catalogUrlFromState(state) {
    var params = new URLSearchParams();
    if (state.mode === "source" && state.source) {
      params.set("source", state.source);
    } else if (
      state.mode === "chapter" &&
      state.chapter != null &&
      state.chapter !== "" &&
      state.entry
    ) {
      // Permalinks / stripped entry only. In-page selector browse keeps a clean URL.
      params.set("chapter", String(state.chapter));
    } else if ((state.mode === "keyword" || state.mode === "explore") && state.keyword) {
      params.set("keyword", state.keyword);
      if (state.mode === "explore") params.set("via", "explore");
    }
    var qs = params.toString();
    return location.pathname + (qs ? "?" + qs : "");
  }

  function historyStatesEqual(a, b) {
    if (!a || !b) return false;
    return (
      a.mode === b.mode &&
      a.chapter === b.chapter &&
      !!a.entry === !!b.entry &&
      a.source === b.source &&
      a.keyword === b.keyword
    );
  }

  function syncCatalogUrl(opts) {
    opts = opts || {};
    if (applyingHistory) return;
    if (!window.history || typeof window.history.pushState !== "function") return;
    var state = catalogHistoryState();
    var url = catalogUrlFromState(state);
    var current = location.pathname + location.search;
    // Inline chapter shares the bare pathname with idle — compare state, not only URL.
    if (opts.replace || (current === url && historyStatesEqual(history.state, state))) {
      history.replaceState(state, "", url);
    } else {
      history.pushState(state, "", url);
    }
  }

  function parseLocationState() {
    var params = new URLSearchParams(location.search);
    var source = params.get("source");
    if (source) return { mode: "source", source: source };
    var chapterRaw = params.get("chapter");
    if (chapterRaw != null && chapterRaw !== "") {
      var chapter = Number(chapterRaw);
      // ?chapter=N is always the stripped chapter permalink entry.
      if (!Number.isNaN(chapter)) return { mode: "chapter", chapter: chapter, entry: true };
    }
    var keyword = params.get("keyword");
    if (keyword) {
      return {
        mode: params.get("via") === "explore" ? "explore" : "keyword",
        keyword: keyword,
      };
    }
    return { mode: "idle" };
  }

  function applyCatalogState(state, opts) {
    opts = opts || {};
    state = state || { mode: "idle" };
    var navOpts = {
      history: false,
      scroll: opts.scroll !== false,
      replace: true,
    };
    applyingHistory = true;
    try {
      if (state.mode === "source" && state.source && corpus) {
        var row = (corpus.sources || []).find(function (s) {
          return s.source_key === state.source;
        });
        if (row) {
          openSource({ id: row.source_key, label: row.title || row.source_key }, navOpts);
          return;
        }
      }
      if (state.mode === "chapter" && state.chapter != null && !Number.isNaN(Number(state.chapter))) {
        openChapter(Number(state.chapter), Object.assign({}, navOpts, {
          // History may restore in-page browse (entry:false); ?chapter= URLs are entry.
          entry: state.entry === true,
        }));
        return;
      }
      if ((state.mode === "keyword" || state.mode === "explore") && state.keyword && searchIndex) {
        var hit = (searchIndex.keywords || []).find(function (k) {
          return k.id === state.keyword;
        });
        if (hit) {
          openKeyword(hit, state.mode === "explore" ? "explore" : "keyword", navOpts);
          return;
        }
      }
      showIdle(navOpts);
    } finally {
      applyingHistory = false;
    }
  }

  function syncEntryLayout() {
    // Source entry + chapter permalink entry: keep banner + page title; hide intro/search/shelves.
    // Chapters selector browse stays on the main catalog page (chapterEntry false).
    var isSourceEntry = view.mode === "source";
    var isChapterEntry = view.mode === "chapter" && !!view.chapterEntry;
    document.body.classList.toggle("sources-entry-source", isSourceEntry);
    document.body.classList.toggle("sources-entry-chapter", isChapterEntry);
    // Match visual hide for AT: display:none chrome should also be inert / aria-hidden.
    var hideChrome = isSourceEntry || isChapterEntry;
    var intro = document.querySelector(".sources-intro");
    [intro, document.getElementById("sources-search"), shelvesEl].forEach(function (el) {
      if (!el) return;
      if (hideChrome) {
        el.setAttribute("aria-hidden", "true");
        el.inert = true;
      } else {
        el.removeAttribute("aria-hidden");
        el.inert = false;
      }
    });
  }

  function showIdle(opts) {
    opts = opts || {};
    view.mode = "idle";
    view.chapter = null;
    view.chapterEntry = false;
    view.keyword = null;
    view.sourceKey = null;
    view.page = 1;
    inputEl.value = "";
    hideSuggestions();
    hideSourcePreview();
    clearChapterActive();
    clearExploreActive();
    if (shelvesEl) shelvesEl.classList.remove("is-filtered");
    headingEl.hidden = true;
    headingEl.textContent = "";
    outEl.innerHTML = "";
    pagerEl.hidden = true;
    pagerEl.innerHTML = "";
    notesEl.hidden = true;
    notesEl.innerHTML = "";
    backEl.hidden = true;
    syncClearButton();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
  }

  function dismissMobileKeyboard() {
    // Blur the search field so iOS/Android hide the keyboard over results.
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    if (inputEl && typeof inputEl.blur === "function") inputEl.blur();
  }

  function openChapter(number, opts) {
    opts = opts || {};
    view.mode = "chapter";
    view.chapter = number;
    // Default: in-page Chapters selector (chrome stays). Pass entry:true for permalinks.
    view.chapterEntry = !!opts.entry;
    view.keyword = null;
    view.sourceKey = null;
    view.page = 1;
    inputEl.value = "";
    hideSuggestions();
    setChapterActive(number);
    clearExploreActive();
    if (shelvesEl) shelvesEl.classList.remove("is-filtered");
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    if (opts.scroll !== false) {
      if (view.chapterEntry) {
        // Chapter permalink entry: stay at page top.
        window.scrollTo(0, 0);
      } else {
        // In-page selector: re-pin Chapters after layout (menu close + new results).
        pinChaptersShelf();
      }
    }
  }

  function pinChaptersShelf() {
    // Re-run after layout settles — closing the in-flow menu can adjust scrollY.
    requestAnimationFrame(function () {
      scrollChaptersLabelIntoView();
      requestAnimationFrame(scrollChaptersLabelIntoView);
    });
  }

  function openKeyword(hit, mode, opts) {
    if (mode && typeof mode === "object") {
      opts = mode;
      mode = "keyword";
    }
    opts = opts || {};
    mode = mode || "keyword";
    view.mode = mode;
    view.keyword = hit;
    view.sourceKey = null;
    view.chapter = null;
    view.chapterEntry = false;
    view.page = 1;
    inputEl.value = hit.label;
    hideSuggestions();
    clearChapterActive();
    clearExploreActive();
    if (mode === "explore") {
      var btn = exploreEl.querySelector('[data-id="' + hit.id + '"]');
      if (btn) btn.classList.add("active");
    }
    if (shelvesEl) shelvesEl.classList.add("is-filtered");
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    if (opts.scroll !== false) {
      headingEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function openSource(hit, opts) {
    opts = opts || {};
    view.mode = "source";
    view.sourceKey = hit.id;
    view.keyword = null;
    view.chapter = null;
    view.chapterEntry = false;
    view.page = 1;
    // Don't mirror the title into the search field — it already shows on the card.
    inputEl.value = "";
    hideSuggestions();
    clearChapterActive();
    clearExploreActive();
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    // Source entry: stay at the normal page top (banner), not scrolled to the heading.
    if (opts.scroll !== false) {
      window.scrollTo(0, 0);
    }
  }

  function openSuggestion(hit) {
    if (!hit) return;
    if (hit.kind === "source") openSource(hit);
    else openKeyword(hit, "keyword");
  }

  function clearKeywordFilter() {
    hideSuggestions();
    inputEl.value = "";
    view.keyword = null;
    view.sourceKey = null;
    if (shelvesEl) shelvesEl.classList.remove("is-filtered");
    clearExploreActive();
    if (view.chapter != null) {
      openChapter(view.chapter, { entry: view.chapterEntry });
    } else {
      showIdle();
    }
    inputEl.focus();
  }

  function hideSuggestions() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    currentSuggestions = [];
    activeSuggestion = -1;
    inputEl.setAttribute("aria-expanded", "false");
  }

  function suggestionLimit() {
    // Desktop can show more; keep mobile compact (matches styles.css 640px break).
    return window.matchMedia("(min-width: 640px)").matches ? 12 : 8;
  }

  function syncSearchPlaceholder() {
    if (inputEl.disabled) return;
    inputEl.placeholder = window.matchMedia("(min-width: 640px)").matches
      ? "Search people, organizations, topics, titles…"
      : "Search…";
  }

  function renderSuggestions(results) {
    currentSuggestions = results.slice(0, suggestionLimit());
    activeSuggestion = currentSuggestions.length ? 0 : -1;
    if (!currentSuggestions.length) {
      hideSuggestions();
      return;
    }
    suggestEl.innerHTML = currentSuggestions.map(function (hit, idx) {
      var metaCount =
        hit.kind === "source"
          ? chapterLabel(hit.chapter)
          : hit.sourceCount + (hit.sourceCount === 1 ? " source" : " sources");
      return (
        '<li role="option">' +
          '<button type="button" class="sources-search-suggestion' + (idx === 0 ? " is-active" : "") + '" data-index="' + idx + '" aria-selected="' + (idx === 0 ? "true" : "false") + '">' +
            '<span class="sources-search-suggestion-label">' + escapeHtml(hit.label) + "</span>" +
            '<span class="sources-search-suggestion-meta">' +
              '<span class="sources-search-suggestion-type">' + escapeHtml(hit.typeLabel || "") + "</span>" +
              '<span class="sources-search-suggestion-count">' +
                escapeHtml(String(metaCount)) +
              "</span>" +
            "</span>" +
          "</button>" +
        "</li>"
      );
    }).join("");
    suggestEl.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
  }

  function setActiveSuggestion(index) {
    var buttons = suggestEl.querySelectorAll(".sources-search-suggestion");
    if (!buttons.length) return;
    activeSuggestion = (index + buttons.length) % buttons.length;
    Array.prototype.forEach.call(buttons, function (btn, i) {
      var on = i === activeSuggestion;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function runPredictiveSearch() {
    if (!miniSearch) return;
    var q = inputEl.value.trim();
    if (q.length < 1) {
      hideSuggestions();
      return;
    }
    var qLower = q.toLowerCase();
    var keywordHits = miniSearch.search(q, {
      prefix: true,
      fuzzy: q.length > 3 ? 0.15 : false,
      boost: { label: 4, searchText: 2, typeLabel: 1 },
      boostDocument: function (id) {
        var row = (searchIndex.keywords || []).find(function (k) { return k.id === id; });
        if (!row) return 1;
        var boost = 1 + Math.min(row.sourceCount, 40) / 40;
        if (row.label.toLowerCase() === qLower) boost *= 4;
        else if (row.label.toLowerCase().startsWith(qLower)) boost *= 2;
        var tokens = String(row.searchText || "").toLowerCase().split(/\s+/);
        if (tokens.indexOf(qLower) !== -1) boost *= 3.5;
        return boost;
      },
    }).map(function (hit) {
      return Object.assign({}, hit, { kind: "keyword" });
    });

    var sourceHits = [];
    if (titleSearch) {
      sourceHits = titleSearch
        .search(q, {
          prefix: true,
          fuzzy: q.length > 5 ? 0.15 : false,
          boost: { title: 6, author: 2, publication: 1 },
          boostDocument: function (id) {
            var row = (corpus.sources || []).find(function (s) {
              return s.source_key === id;
            });
            if (!row) return 1;
            var title = String(row.title || "").toLowerCase();
            var boost = 1;
            if (title === qLower) boost *= 8;
            else if (title.indexOf(qLower) === 0) boost *= 3;
            else if (title.indexOf(qLower) !== -1) boost *= 1.8;
            return boost;
          },
        })
        .map(function (hit) {
          return {
            kind: "source",
            id: hit.id,
            label: hit.title,
            typeLabel: hit.content_kind_label || "Source",
            chapter: hit.chapter,
            sourceCount: 1,
            score: hit.score,
          };
        });
    }

    // Authority keywords first so short names (e.g. "China") are not crowded
    // out by many titles that start with the same word. Then strong title
    // matches, then other title hits. Dropdown still caps at 8.
    var strongTitles = [];
    var otherTitles = [];
    sourceHits.forEach(function (hit) {
      var title = String(hit.label || "").toLowerCase();
      if (title === qLower || title.indexOf(qLower) === 0) strongTitles.push(hit);
      else otherTitles.push(hit);
    });
    var seen = {};
    var merged = [];
    [keywordHits, strongTitles, otherTitles].forEach(function (group) {
      group.forEach(function (hit) {
        var key = hit.kind + ":" + hit.id;
        if (seen[key]) return;
        seen[key] = true;
        merged.push(hit);
      });
    });
    renderSuggestions(merged);
  }

  function chapterFullName(ch) {
    // Chapters list: "5. Pangolins" (not "Chapter 5 — Pangolins").
    // Prologue keeps its own title wording.
    if (ch.number === 0) {
      return ch.title || ch.name || "Prologue";
    }
    if (ch.title) return ch.number + ". " + ch.title;
    return ch.number + ". " + (ch.name || chapterLabel(ch.number));
  }

  function renderChapterList(chapters) {
    if (!chapterSelectEl) return;
    chapterSelectEl.innerHTML = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a chapter…";
    chapterSelectEl.appendChild(placeholder);
    chapters.forEach(function (ch) {
      var opt = document.createElement("option");
      opt.value = String(ch.number);
      opt.textContent = chapterFullName(ch);
      chapterSelectEl.appendChild(opt);
    });
    chapterSelectEl.disabled = false;

    if (chapterMenuEl && chapterTriggerEl) {
      chapterMenuEl.innerHTML = "";
      var clearOpt = document.createElement("li");
      clearOpt.setAttribute("role", "option");
      clearOpt.setAttribute("tabindex", "-1");
      clearOpt.setAttribute("data-value", "");
      clearOpt.textContent = "Select a chapter…";
      chapterMenuEl.appendChild(clearOpt);
      chapters.forEach(function (ch) {
        var item = document.createElement("li");
        item.setAttribute("role", "option");
        item.setAttribute("tabindex", "-1");
        item.setAttribute("data-value", String(ch.number));
        item.textContent = chapterFullName(ch);
        chapterMenuEl.appendChild(item);
      });
      chapterTriggerEl.disabled = false;
    }

    setChapterActive(view.chapter);
  }

  function renderExploreShelf() {
    if (!searchIndex) return;
    var preferredTypes = { person: 1, org: 1, topic: 1, work: 1 };
    var picks = (searchIndex.keywords || [])
      .filter(function (k) { return preferredTypes[k.type] && k.sourceCount >= 8; })
      .sort(function (a, b) { return b.sourceCount - a.sourceCount; })
      .slice(0, 8);

    exploreEl.innerHTML = "";
    picks.forEach(function (k) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-explore-chip";
      btn.setAttribute("data-id", k.id);
      btn.setAttribute(
        "aria-label",
        k.label + ", " + k.typeLabel + ", " + sourceCountLabel(k.sourceCount)
      );
      btn.innerHTML =
        '<span class="catalog-explore-chip-label">' + escapeHtml(k.label) + "</span>" +
        '<span class="catalog-explore-chip-meta">' + escapeHtml(String(k.sourceCount)) + "</span>";
      btn.addEventListener("click", function () {
        openKeyword(k, "explore");
      });
      exploreEl.appendChild(btn);
    });
  }

  function clearChapterActive() {
    setChapterActive(null);
  }

  // Events
  if (chapterSelectEl) {
    chapterSelectEl.addEventListener("change", function () {
      var raw = chapterSelectEl.value;
      if (raw === "") {
        showIdle();
        return;
      }
      openChapter(Number(raw));
    });
  }

  function chooseChapterValue(raw) {
    closeChapterMenu();
    if (raw === "") {
      showIdle();
      return;
    }
    openChapter(Number(raw));
  }

  if (chapterTriggerEl && chapterMenuEl) {
    chapterTriggerEl.addEventListener("click", function (e) {
      e.preventDefault();
      // Mouse open: keep focus on the trigger so the menu isn't dismissed mid-click.
      // openChapterMenu pins the Chapters label after the list expands.
      toggleChapterMenu({ focusOption: false });
    });
    chapterTriggerEl.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openChapterMenu({ focusOption: true });
      } else if (e.key === "Escape") {
        closeChapterMenu();
      }
    });
    chapterMenuEl.addEventListener("click", function (e) {
      var opt = e.target.closest('[role="option"]');
      if (!opt || !chapterMenuEl.contains(opt)) return;
      chooseChapterValue(opt.getAttribute("data-value") || "");
    });
    chapterMenuEl.addEventListener("keydown", function (e) {
      var options = Array.prototype.slice.call(chapterMenuEl.querySelectorAll('[role="option"]'));
      if (!options.length) return;
      var current = document.activeElement;
      var idx = options.indexOf(current);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        options[(idx + 1 + options.length) % options.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        options[(idx - 1 + options.length) % options.length].focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        options[0].focus();
      } else if (e.key === "End") {
        e.preventDefault();
        options[options.length - 1].focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (idx >= 0) chooseChapterValue(options[idx].getAttribute("data-value") || "");
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeChapterMenu();
        chapterTriggerEl.focus();
      }
    });
    document.addEventListener("mousedown", function (e) {
      if (!listEl || listEl.contains(e.target)) return;
      if (chapterMenuEl.contains(e.target)) return;
      closeChapterMenu();
    });
  }

  inputEl.addEventListener("input", function () {
    closeChapterMenu();
    syncClearButton();
    runPredictiveSearch();
  });

  inputEl.addEventListener("keydown", function (e) {
    if (suggestEl.hidden || !currentSuggestions.length) {
      if (e.key === "Escape") hideSuggestions();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion(activeSuggestion + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion(activeSuggestion - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeSuggestion >= 0) openSuggestion(currentSuggestions[activeSuggestion]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideSuggestions();
    }
  });

  suggestEl.addEventListener("mousedown", function (e) {
    var btn = e.target.closest(".sources-search-suggestion");
    if (!btn) return;
    e.preventDefault();
    var idx = Number(btn.getAttribute("data-index"));
    if (!Number.isNaN(idx) && currentSuggestions[idx]) {
      openSuggestion(currentSuggestions[idx]);
    }
  });

  clearEl.addEventListener("click", function () {
    clearKeywordFilter();
  });

  headingEl.addEventListener("click", function (e) {
    var chapterLink = e.target.closest("[data-open-chapter]");
    if (!chapterLink || !headingEl.contains(chapterLink)) return;
    e.preventDefault();
    var chapter = Number(chapterLink.getAttribute("data-open-chapter"));
    if (Number.isNaN(chapter)) return;
    openChapter(chapter, { entry: true });
  });

  pagerEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-page]");
    if (!btn || btn.disabled) return;
    var total = sourcesForView().length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (btn.getAttribute("data-page") === "prev") view.page = Math.max(1, view.page - 1);
    if (btn.getAttribute("data-page") === "next") view.page = Math.min(pages, view.page + 1);
    renderResults();
    headingEl.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function onCatalogClick(e) {
    var exitLink = e.target.closest("[data-source-exit]");
    if (exitLink) {
      e.preventDefault();
      exitEntryTo(exitLink.getAttribute("data-source-exit"));
      return true;
    }
    return false;
  }

  outEl.addEventListener("click", function (e) {
    if (e.target.closest(".catalog-empty-clear")) {
      e.preventDefault();
      clearKeywordFilter();
      return;
    }
    if (onCatalogClick(e)) return;
    var btn = e.target.closest(".source-expand-btn");
    if (!btn) return;
    e.preventDefault();
    var item = btn.closest(".source-item-expandable");
    if (!item) return;
    var detail = item.querySelector(".source-item-detail");
    if (!detail) return;
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    detail.hidden = open;
    item.classList.toggle("is-expanded", !open);
    btn.title = open ? "Show source details" : "Hide source details";
    if (!open) ensureTwitterWidgets(detail);
  });

  notesEl.addEventListener("click", function (e) {
    onCatalogClick(e);
  });

  outEl.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList.contains("catalog-card-image")) return;
    var media = img.closest(".catalog-card-media");
    if (media) media.remove();
  }, true);

  function sourcePreviewLinkFromEvent(e, root) {
    if (!root) return null;
    var notesLink = e.target.closest("a.notes-source-ref[data-source-key]");
    if (notesLink && root.contains(notesLink)) return notesLink;
    var bibLink = e.target.closest(".sources-list .source-ref a");
    if (bibLink && root.contains(bibLink)) return bibLink;
    return null;
  }

  function sourcePreviewKeyFromLink(link) {
    if (!link) return "";
    var key = link.getAttribute("data-source-key");
    if (key) return key;
    var item = link.closest(".source-item");
    return (item && item.getAttribute("data-source-key")) || "";
  }

  function bindSourcePreviewRoot(root) {
    if (!root) return;
    root.addEventListener("mouseover", function (e) {
      if (!isDesktopSourcePreview()) return;
      var link = sourcePreviewLinkFromEvent(e, root);
      var key = sourcePreviewKeyFromLink(link);
      if (!link || !key) return;
      rememberSourcePreviewPointer(e);
      if (sourcePreviewHideTimer) {
        clearTimeout(sourcePreviewHideTimer);
        sourcePreviewHideTimer = null;
      }
      scheduleShowSourcePreview(link, key);
    });
    root.addEventListener("mousemove", function (e) {
      if (!isDesktopSourcePreview()) return;
      var link = sourcePreviewLinkFromEvent(e, root);
      if (!link) return;
      rememberSourcePreviewPointer(e);
    });
    root.addEventListener("mouseout", function (e) {
      if (!isDesktopSourcePreview()) return;
      var link = sourcePreviewLinkFromEvent(e, root);
      if (!link) return;
      var related = e.relatedTarget;
      if (related && (link.contains(related) || (sourcePreviewEl && sourcePreviewEl.contains(related)))) {
        return;
      }
      scheduleHideSourcePreview();
    });
  }

  // Desktop: bibliography + notes source cites → compact catalog-card preview.
  bindSourcePreviewRoot(outEl);
  bindSourcePreviewRoot(notesEl);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hideSourcePreview();
  });
  window.addEventListener(
    "scroll",
    function () {
      if (sourcePreviewEl && !sourcePreviewEl.hidden) hideSourcePreview();
    },
    true
  );
  window.addEventListener("resize", function () {
    if (!isDesktopSourcePreview()) hideSourcePreview();
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest("#sources-search")) hideSuggestions();
    if (
      sourcePreviewEl &&
      !sourcePreviewEl.hidden &&
      !e.target.closest("#source-hover-preview") &&
      !e.target.closest(".sources-list .source-ref a") &&
      !e.target.closest("a.notes-source-ref")
    ) {
      hideSourcePreview();
    }
  });

  // Boot
  Promise.all([
    fetch(CORPUS_URL, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("corpus " + r.status);
      return r.json();
    }),
    fetch(SEARCH_URL, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("search " + r.status);
      return r.json();
    }),
    fetch(CHAPTER_INDEX_URL, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("chapters " + r.status);
      return r.json();
    }),
  ])
    .then(function (parts) {
      corpus = parts[0];
      searchIndex = parts[1];
      chapterMeta = parts[2].chapters || [];

      if (typeof MiniSearch !== "function") throw new Error("MiniSearch missing");
      miniSearch = new MiniSearch({
        fields: ["label", "searchText", "typeLabel"],
        storeFields: ["label", "type", "typeLabel", "sourceCount"],
        searchOptions: {
          boost: { label: 4, searchText: 2, typeLabel: 1 },
          prefix: true,
          fuzzy: 0.15,
        },
      });
      miniSearch.addAll(searchIndex.keywords || []);

      // Second index: source titles (plus author/publication) so typing a
      // paper/article/book title can hit that catalog record directly.
      titleSearch = new MiniSearch({
        idField: "source_key",
        fields: ["title", "author", "publication"],
        storeFields: [
          "title",
          "author",
          "publication",
          "chapter",
          "source_key",
          "section",
          "content_kind_label",
        ],
        searchOptions: {
          boost: { title: 6, author: 2, publication: 1 },
          prefix: true,
          fuzzy: 0.15,
        },
      });
      titleSearch.addAll(
        (corpus.sources || []).filter(function (s) {
          return !!(s.source_key && s.title);
        })
      );

      inputEl.disabled = false;
      syncSearchPlaceholder();
      renderChapterList(chapterMeta);
      syncChapterPickerA11y();
      renderExploreShelf();
      // Read hash before replaceState (catalog URLs omit the fragment).
      var hashFocus = catalogFocusFromHash();
      showIdle({ history: false });
      applyCatalogState(parseLocationState(), { scroll: true });
      if (window.history && typeof window.history.replaceState === "function") {
        history.replaceState(catalogHistoryState(), "", catalogUrlFromState(catalogHistoryState()));
      }
      // Deep-link hashes from source-entry nav: activate search or chapters (no scroll).
      if (view.mode === "idle" && hashFocus) {
        requestAnimationFrame(function () {
          activateCatalogTarget(hashFocus);
        });
      }
    })
    .catch(function (err) {
      console.error(err);
      inputEl.disabled = true;
      inputEl.placeholder = "Catalog unavailable";
      listEl.innerHTML = '<span class="error">Could not load the sources catalog.</span>';
      outEl.innerHTML = '<p class="error">' + escapeHtml(err.message) + "</p>";
    });

  window.addEventListener("popstate", function (e) {
    if (!corpus || !searchIndex) return;
    // Same-document fragment navigations (e.g. legacy #sources-top) can fire
    // popstate with null state while pathname/search still look like idle.
    // Don't wipe an active in-page chapter/keyword/source view.
    if (e.state == null) {
      var parsed = parseLocationState();
      if (parsed.mode === "idle" && view.mode !== "idle") {
        if (typeof history.replaceState === "function") {
          history.replaceState(
            catalogHistoryState(),
            "",
            catalogUrlFromState(catalogHistoryState())
          );
        }
        return;
      }
      applyCatalogState(parsed, { scroll: true });
      return;
    }
    applyCatalogState(e.state, { scroll: true });
  });

  // Back to Top: scroll without a hash navigation. Fragment links fire popstate
  // with null state after History API use and would otherwise clear the view.
  if (backEl) {
    backEl.addEventListener("click", function (e) {
      var link = e.target.closest('a[href="#sources-top"]');
      if (!link || !backEl.contains(link)) return;
      e.preventDefault();
      var top = document.getElementById("sources-top");
      if (top && typeof top.scrollIntoView === "function") {
        top.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  if (window.matchMedia) {
    var desktopMq = window.matchMedia("(min-width: 640px)");
    function onDesktopMqChange() {
      syncSearchPlaceholder();
      closeChapterMenu();
      syncChapterPickerA11y();
    }
    if (typeof desktopMq.addEventListener === "function") {
      desktopMq.addEventListener("change", onDesktopMqChange);
    } else if (typeof desktopMq.addListener === "function") {
      desktopMq.addListener(onDesktopMqChange);
    }
  }
})();
