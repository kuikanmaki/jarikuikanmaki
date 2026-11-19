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
  var outEl = document.getElementById("sources-output");
  var headingEl = document.getElementById("sources-heading");
  var pagerEl = document.getElementById("catalog-pager");
  var notesEl = document.getElementById("catalog-notes");
  var backEl = document.getElementById("back-to-top");
  var historyBackEl = document.getElementById("sources-history-back");
  var inputEl = document.getElementById("authority-search-input");
  var suggestEl = document.getElementById("authority-search-suggestions");
  var clearEl = document.getElementById("authority-search-clear");
  var shelvesEl = document.getElementById("catalog-shelves");
  var topicCloudWrapEl = document.getElementById("sources-topic-cloud");
  var topicCloudEl = document.getElementById("topic-cloud");

  var corpus = null;
  var searchIndex = null;
  var keywordById = Object.create(null);
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
  // Source-page ← Back: only when we can return to a same-site prior entry.
  var sourceHistoryBackEnabled = false;
  // Chapter Back restore: re-apply scrollY after async notes HTML lands (page grows).
  var pendingRestoreScrollY = null;
  // Own scroll stamping/restore — avoid the browser's animated scroll restoration.
  if (window.history && "scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  // Site CSS uses html { scroll-behavior: smooth }, and scrollTo({ behavior:"auto" })
  // still follows that. Force an instant jump for SPA source enter/back.
  function scrollWindowInstant(y) {
    var top = Math.max(0, Number(y) || 0);
    var root = document.documentElement;
    var prev = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    try {
      window.scrollTo({ top: top, left: 0, behavior: "instant" });
    } catch (err) {
      window.scrollTo(0, top);
    }
    root.style.scrollBehavior = prev;
  }

  // Gradual page roll for Chapters / Search pin (not for Back / source enter).
  function scrollWindowSmooth(y) {
    var top = Math.max(0, Number(y) || 0);
    try {
      window.scrollTo({ top: top, left: 0, behavior: "smooth" });
    } catch (err) {
      window.scrollTo(0, top);
    }
  }

  function windowScrollY() {
    return window.scrollY || window.pageYOffset || 0;
  }
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

  function hideBrokenCardImage(img) {
    // Remote hotlinks (Science, Archive, CDNs) often 403/404 — drop the slot
    // entirely so cards/previews never show a broken-image icon.
    if (!img || !img.classList || !img.classList.contains("catalog-card-image")) return;
    var media = img.closest(".catalog-card-media");
    var layout = img.closest(".catalog-card-layout--media");
    if (media) media.remove();
    else img.remove();
    if (layout) layout.classList.remove("catalog-card-layout--media");
  }

  // error does not bubble — capture so late-loading thumbs can clear themselves.
  document.addEventListener(
    "error",
    function (e) {
      hideBrokenCardImage(e.target);
    },
    true
  );

  function cardImageHtml(url) {
    if (!url) return "";
    return (
      '<div class="catalog-card-media">' +
        '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="catalog-card-image">' +
      "</div>"
    );
  }

  function cardMedia(s) {
    // Prefer live embed over a static thumbnail when the host is YouTube/X.
    if (hostEmbed(s) || !s.image_url) return "";
    return cardImageHtml(s.image_url);
  }

  function sourceAccessLabel(s) {
    var embed = hostEmbed(s);
    if (s.status === "paywall") {
      return {
        short: "May be paywalled",
        long: "Source access note: Full text may be paywalled.",
      };
    }
    if (s.status === "skipped" && embed) return null;
    if (s.status && s.status !== "ok") {
      return {
        short: String(s.status),
        long: "Access note: " + String(s.status),
      };
    }
    return null;
  }

  function pushChipItem(items, seen, id, label, opts, limit) {
    if (!id || seen[id] || items.length >= limit) return;
    seen[id] = true;
    var text = escapeHtml(label || id);
    var inner = opts.plain
      ? text
      : '<a class="catalog-keyword-link" href="' + escapeHtml(keywordPageHref(id)) + '"' +
          ' data-keyword-id="' + escapeHtml(id) + '">' + text + "</a>";
    items.push('<li class="catalog-card-topic">' + inner + "</li>");
  }

  function topicChipsHtml(s, opts) {
    opts = opts || {};
    // Authority-only chips: topics first, then linked entities (people/orgs/places/works/events).
    // Skip author_ids / publication_ids — those are already linked in the biblio line.
    var limit = 8;
    var items = [];
    var seen = Object.create(null);
    var authorIds = s.author_ids || [];
    var publicationIds = s.publication_ids || [];
    for (var a = 0; a < authorIds.length; a++) {
      if (authorIds[a]) seen[authorIds[a]] = true;
    }
    for (var p = 0; p < publicationIds.length; p++) {
      if (publicationIds[p]) seen[publicationIds[p]] = true;
    }

    var topicIds = s.topic_ids || [];
    var topicLabels = s.topics || [];
    for (var i = 0; i < topicIds.length && items.length < limit; i++) {
      pushChipItem(items, seen, topicIds[i], topicLabels[i] || topicIds[i], opts, limit);
    }

    var entIds = s.entity_ids || {};
    var ents = s.entities || {};
    var buckets = ["people", "orgs", "places", "works", "events"];
    for (var b = 0; b < buckets.length; b++) {
      var bucket = buckets[b];
      var ids = entIds[bucket] || [];
      var labels = ents[bucket] || [];
      for (var j = 0; j < ids.length && items.length < limit; j++) {
        // entities.* may append orphan strings after id-backed labels; only chip linked ids.
        pushChipItem(items, seen, ids[j], labels[j] || ids[j], opts, limit);
      }
    }

    if (!items.length) return "";
    return (
      '<ul class="catalog-card-topics" aria-label="Topics and entities">' + items.join("") + "</ul>"
    );
  }

  function cardCopyParts(s, opts) {
    opts = opts || {};
    var topicLine = topicChipsHtml(s, opts);
    var role = SHOW_CARD_COPY && s.book_role
      ? '<p class="catalog-card-role"><span>In the book</span> ' + escapeHtml(s.book_role) + "</p>"
      : "";
    var embed = hostEmbed(s);
    var access = sourceAccessLabel(s);
    var statusNote = access
      ? '<p class="catalog-card-status">' + escapeHtml(access.long) + "</p>"
      : "";
    var summary =
      SHOW_CARD_COPY && s.summary
        ? '<p class="catalog-card-summary">' + escapeHtml(s.summary) + "</p>"
        : "";
    return {
      summary: summary,
      role: role,
      topicLine: topicLine,
      statusNote: statusNote,
      access: access,
      embed: embed,
      hasCopy: !!(summary || role || topicLine || statusNote),
    };
  }

  function sourcePageHref(sourceKey) {
    if (!sourceKey) return "#";
    return location.pathname + "?source=" + encodeURIComponent(sourceKey);
  }

  function chapterPageHref(chapterNumber) {
    return (
      location.pathname +
      "?chapter=" +
      encodeURIComponent(String(chapterNumber))
    );
  }

  function renderCardChapterMeta(s) {
    var chNum =
      s.chapter != null && !Number.isNaN(Number(s.chapter))
        ? Number(s.chapter)
        : null;
    var chapterLink =
      chNum != null
        ? '<a class="catalog-chapter-link" href="' + escapeHtml(chapterPageHref(chNum)) + '"' +
            ' data-open-chapter="' + escapeHtml(String(chNum)) + '">' +
            escapeHtml(chapterLabel(chNum)) +
          "</a>"
        : "";
    // Source panel: "Sources: Chapter N" — Sources clears to idle/search; chapter opens that chapter.
    if (view.mode === "source") {
      var path = location.pathname || "/origins/sources/";
      var sourcesLink =
        '<a class="catalog-sources-link" href="' + escapeHtml(path) + '#sources-search" data-source-exit="search">Sources</a>';
      if (!chapterLink) {
        return '<p class="catalog-card-meta">' + sourcesLink + "</p>";
      }
      return (
        '<p class="catalog-card-meta">' +
          sourcesLink +
          '<span class="catalog-card-meta-sep">: </span>' +
          chapterLink +
        "</p>"
      );
    }
    if (!chapterLink) return "";
    return '<p class="catalog-card-meta">' + chapterLink + "</p>";
  }

  function displayHostFromUrl(url) {
    if (!url) return "";
    try {
      var host = new URL(url, location.href).hostname || "";
      if (host.indexOf("www.") === 0) host = host.slice(4);
      if (!host) return "";
      // Keep long hosts readable without blowing the actions line.
      if (host.length > 32) host = host.slice(0, 29) + "…";
      return host;
    } catch (err) {
      return "";
    }
  }

  function openOriginalHtml(url, opts) {
    if (!url) return "";
    opts = opts || {};
    var host =
      opts.showHost ? displayHostFromUrl(url) : "";
    return (
      '<a class="source-open-original" href="' +
      escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">Open URL<span aria-hidden="true"> ↗</span></a>' +
      (host
        ? '<span class="source-open-host"> · ' + escapeHtml(host) + "</span>"
        : "")
    );
  }

  function keywordPageHref(keywordId) {
    if (!keywordId) return "#";
    return location.pathname + "?keyword=" + encodeURIComponent(keywordId);
  }

  // Clear match: exactly one authority id that resolves in the keyword index.
  function clearAuthorityMatch(ids) {
    if (!ids || ids.length !== 1) return null;
    var id = ids[0];
    if (!id || !keywordById[id]) return null;
    return keywordById[id];
  }

  function authorityFieldHtml(label, ids, opts) {
    opts = opts || {};
    if (!label) return "";
    var text = escapeHtml(label);
    if (opts.plain) return text;
    var hit = clearAuthorityMatch(ids);
    if (!hit || !hit.id) return text;
    return (
      '<a class="catalog-keyword-link" href="' + escapeHtml(keywordPageHref(hit.id)) + '"' +
        ' data-keyword-id="' + escapeHtml(hit.id) + '">' +
        text +
      "</a>"
    );
  }

  function renderBiblioHtml(s, opts) {
    opts = opts || {};
    var parts = [];
    if (s.author) parts.push(authorityFieldHtml(s.author, s.author_ids, opts));
    if (s.publication) parts.push(authorityFieldHtml(s.publication, s.publication_ids, opts));
    if (s.date) parts.push(escapeHtml(s.date));
    return parts.join(" · ");
  }

  function renderCard(s, opts) {
    opts = opts || {};
    // Previews wrap the whole card in a link — keep biblio plain (no nested anchors).
    var biblio = renderBiblioHtml(s, { plain: !!opts.preview });
    var key = s.source_key || "";
    var pageHref = sourcePageHref(key);
    var external = typeof s.url === "string" && s.url ? s.url : "";
    // Hover previews: image/copy only — no YouTube/X embeds (avoids autoplay / heavy widgets).
    var media = opts.preview ? cardImageHtml(s.image_url) : cardMedia(s);
    // Previews: plain topic chips (card is already one link — no nested anchors).
    var parts = cardCopyParts(s, { plain: !!opts.preview });
    var onSourcePage = view.mode === "source";
    // Keyword/explore/source: Chapter N on the card (same chrome). Skip hover previews.
    var chapterMetaHtml =
      !opts.preview &&
      (view.mode === "keyword" || view.mode === "explore" || view.mode === "source")
        ? renderCardChapterMeta(s)
        : "";
    // Full catalog cards (Source page + search/explore) share the same content chrome.
    // Hover previews stay compact (no Open URL / access line).
    var original = opts.preview
      ? ""
      : openOriginalHtml(external, { showHost: true });
    var accessInline =
      !opts.preview && parts.access
        ? '<span class="source-open-access"> · ' + escapeHtml(parts.access.short) + "</span>"
        : "";
    var actionsHtml = original + accessInline;
    // Preview: whole card is the link (plain title). Source page: plain title (no self-link).
    // Search/explore: title links to the Source page.
    var titleText = escapeHtml(s.title || "Untitled source");
    var titleHtml =
      opts.preview || onSourcePage
        ? titleText
        : '<a class="source-page-link" href="' + escapeHtml(pageHref) + '"' +
            (key ? ' data-source-key="' + escapeHtml(key) + '"' : "") +
          ">" + titleText + "</a>";
    // Access notes live on the Open URL line for full cards (not a separate block).
    var hasCopyBody = !!(parts.summary || parts.role || parts.topicLine);
    var restInner =
      (biblio ? '<p class="catalog-card-biblio">' + biblio + "</p>" : "") +
      (actionsHtml ? '<p class="catalog-card-actions">' + actionsHtml + "</p>" : "") +
      (hasCopyBody
        ? '<div class="catalog-card-copy">' +
            parts.summary +
            parts.role +
            parts.topicLine +
          "</div>"
        : "");
    var cardHtml =
      '<article class="catalog-card' + (opts.preview ? " catalog-card--preview" : "") + '">' +
        chapterMetaHtml +
        '<div class="catalog-card-layout' + (media ? " catalog-card-layout--media" : "") + '">' +
          '<h3 class="catalog-card-title">' + titleHtml + "</h3>" +
          media +
          (restInner
            ? '<div class="catalog-card-rest">' + restInner + "</div>"
            : "") +
        "</div>" +
        (opts.preview ? "" : parts.embed) +
      "</article>";
    if (opts.preview && key) {
      return (
        '<a class="source-hover-preview-link source-page-link" href="' + escapeHtml(pageHref) + '"' +
          ' data-source-key="' + escapeHtml(key) + '">' +
          cardHtml +
        "</a>"
      );
    }
    return cardHtml;
  }

  function renderChapterSourceList(rows) {
    if (!rows.length) {
      return '<p class="status">No sources listed for this chapter.</p>';
    }
    var items = rows.map(function (s) {
      var id = escapeHtml(s.id != null ? s.id : "?");
      var external = typeof s.url === "string" && s.url ? s.url : "";
      var author = escapeHtml(s.author || "");
      var title = escapeHtml(s.title || "");
      var publication = escapeHtml(s.publication || "");
      var date = escapeHtml(s.date || "");
      var keyRaw = s.source_key || ("ch" + s.chapter + "-s" + s.id);
      var key = escapeHtml(keyRaw);
      var pageHref = escapeHtml(sourcePageHref(keyRaw));
      // Compact bibliography → Source page (details live there / hover preview).
      return (
        '<li class="source-item" data-source-key="' + key + '">' +
          '<div class="source-item-main">' +
            '<span class="source-id" aria-hidden="true">' + id + ".</span>" +
            '<span class="source-ref">' +
              '<a class="source-page-link" href="' + pageHref + '" data-source-key="' + key + '">' +
                (author ? author + ", " : "") +
                "<em>" + title + "</em>" +
                (publication ? ", " + publication : "") +
                (date ? ", " + date : "") +
              "</a>" +
              (external ? " " + openOriginalHtml(external) : "") +
            "</span>" +
          "</div>" +
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
    // Keep the card almost under the pointer so the path to it has no dead gap
    // (a larger offset lets mouseleave fire before mouseenter on the preview).
    var gapX = 2;
    var gapY = 2;
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

    // Chapter / search keep Back to top; source reading view is a short card page.
    backEl.hidden = view.mode === "source";
    // Source panel: no extra heading — "Sources: Chapter N" lives on the card.
    headingEl.hidden = view.mode === "source";
    syncSourceHistoryBack();
    syncClearButton();
    syncDocumentHead();

    if (view.mode === "keyword" || view.mode === "explore" || view.mode === "source") {
      var label = (view.keyword && view.keyword.label) || "Sources";
      if (view.mode === "source") {
        headingEl.classList.remove("sources-heading--breadcrumb");
        headingEl.innerHTML = "";
      } else {
        headingEl.classList.remove("sources-heading--breadcrumb");
        // Type label deferred until the classification scheme is reviewed.
        // var typeLabel =
        //   view.keyword && view.keyword.typeLabel
        //     ? String(view.keyword.typeLabel)
        //     : "";
        headingEl.innerHTML =
          '<span class="sources-heading-label">' + escapeHtml(label) + "</span>" +
          // (typeLabel
          //   ? '<span class="sources-heading-type"> · ' + escapeHtml(typeLabel) + "</span>"
          //   : "") +
          '<span class="sources-heading-count"> · ' + escapeHtml(sourceCountLabel(total)) + "</span>";
      }
      notesEl.hidden = true;
      notesEl.innerHTML = "";

      var start = (view.page - 1) * PAGE_SIZE;
      var pageRows = rows.slice(start, start + PAGE_SIZE);
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
          "</div>";
        renderPager(0);
        return;
      }
      outEl.innerHTML =
        '<div class="catalog-card-list">' +
        pageRows.map(renderCard).join("") +
        "</div>";
      ensureTwitterWidgets(outEl);
      renderPager(total);
      return;
    }

    headingEl.classList.remove("sources-heading--breadcrumb");
    headingEl.textContent = chapterDocumentHeading(view.chapter);
    pagerEl.hidden = true;
    pagerEl.innerHTML = "";
    outEl.innerHTML = renderChapterSourceList(rows);
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
    // Notes HTML: wire corpus cites to the Source page (same as bibliography titles).
    // (1) stable ?source= cross-refs; (2) Notes hyperlinks whose URL matches a corpus row.
    // External originals stay available via Open URL on the Source page card.
    if (!root || !corpus) return;
    function wireNotesSourcePageLink(a, key) {
      if (!a || !key) return;
      a.setAttribute("data-source-key", key);
      a.classList.add("notes-source-ref", "source-page-link");
      a.setAttribute("href", sourcePageHref(key));
      a.removeAttribute("target");
      a.removeAttribute("rel");
    }
    Array.prototype.forEach.call(root.querySelectorAll('a[href^="?source="]'), function (a) {
      wireNotesSourcePageLink(a, sourceKeyFromHref(a.getAttribute("href") || ""));
    });
    var byUrl = sourceKeyByNormalizedUrl();
    Array.prototype.forEach.call(root.querySelectorAll('a[href^="http"]'), function (a) {
      if (a.getAttribute("data-source-key")) return;
      var key = byUrl[normalizeSourceUrl(a.getAttribute("href") || "")];
      if (!key) return;
      wireNotesSourcePageLink(a, key);
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
        // Stale response after the user picked another chapter — ignore.
        if (view.mode !== "chapter" || view.chapter !== chapterNumber) {
          return false;
        }
        notesEl.innerHTML = '<hr class="notes-divider">' + html;
        enhanceNotesSourceLinks(notesEl);
        // History ← Back may need scrollY re-applied after notes HTML grows the page.
        if (applyPendingRestoreScroll()) {
          return true;
        }
        // Permalinks: keep Chapters pinned after notes land.
        // Desktop selector: only if the user is still above the shelf (don't yank back).
        // Mobile selector: rescue if the title ended above the fold.
        if (view.chapterEntry) {
          pinChaptersShelf();
        } else if (isDesktopLayout()) {
          pinChaptersShelfIfUserAbove();
        } else {
          pinResultsHeadingIfObscured();
        }
        return true;
      })
      .catch(function () {
        if (view.mode === "chapter" && view.chapter === chapterNumber) {
          notesEl.innerHTML = "";
          notesEl.hidden = true;
        }
        applyPendingRestoreScroll();
        return false;
      });
  }

  function isDesktopChapterPicker() {
    // Custom listbox at all widths — native <select> popups break on narrow desktop/macOS.
    return true;
  }

  function isDesktopLayout() {
    return window.matchMedia("(min-width: 640px)").matches;
  }

  function chapterOptionLabel(value) {
    if (!chapterSelectEl) return "Choose a chapter…";
    if (value === "" || value == null) return "Choose a chapter…";
    var opt = chapterSelectEl.querySelector('option[value="' + String(value).replace(/"/g, '\\"') + '"]');
    return (opt && opt.textContent) || "Choose a chapter…";
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

  function chapterMenuRowHeight() {
    if (!chapterMenuEl) return 44;
    var sample = chapterMenuEl.querySelector('[role="option"]');
    if (!sample || chapterMenuEl.hidden) return 44;
    var h = sample.getBoundingClientRect().height;
    return h > 0 ? Math.ceil(h) : 44;
  }

  function chapterMenuComfortHeight() {
    return 10 * chapterMenuRowHeight() + 12;
  }

  function fitChapterMenuToViewport() {
    // In-flow dropdown: ~10 rows, or whatever still fits under the trigger after pin.
    if (!chapterMenuEl || !chapterTriggerEl || chapterMenuEl.hidden) return;
    if (!isDesktopChapterPicker()) {
      chapterMenuEl.style.maxHeight = "";
      return;
    }
    var comfort = chapterMenuComfortHeight();
    var roomBelow = Math.floor(
      window.innerHeight - chapterTriggerEl.getBoundingClientRect().bottom - 12
    );
    var next = roomBelow > 0 ? Math.min(comfort, roomBelow) : comfort;
    chapterMenuEl.style.maxHeight = next + "px";
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
      chapterMenuEl.style.maxHeight = "";
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

  function stickyHeaderEl() {
    return (
      document.querySelector(".site-header") ||
      document.querySelector("#site-header") ||
      document.querySelector("header.sticky")
    );
  }

  function stickyClearancePx(el, gapPx) {
    var gap = typeof gapPx === "number" ? gapPx : 12;
    var header = stickyHeaderEl();
    var headerH = header ? header.getBoundingClientRect().height : 0;
    if (headerH > 0) return headerH + gap;
    // Header markup may still be hydrating; honor scroll-margin.
    if (el) {
      var sm = parseFloat(window.getComputedStyle(el).scrollMarginTop);
      if (!isNaN(sm) && sm > 0) return sm;
    }
    return gap;
  }

  function chaptersPinScrollTarget() {
    var target =
      document.getElementById("sources-chapters") ||
      document.getElementById("chapters-label");
    if (!target) return null;
    return Math.max(
      0,
      target.getBoundingClientRect().top +
        windowScrollY() -
        stickyClearancePx(target, 12)
    );
  }

  function maxWindowScroll() {
    return Math.max(
      0,
      (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0)
    );
  }

  function canScrollChaptersToPin() {
    var desired = chaptersPinScrollTarget();
    if (desired == null) return false;
    return desired <= maxWindowScroll() + 8;
  }

  function scrollBelowStickyHeader(el, gapPx, mode) {
    if (!el) return;
    var top = Math.max(
      0,
      el.getBoundingClientRect().top + windowScrollY() - stickyClearancePx(el, gapPx)
    );
    // Clamp to what the page can scroll — in-flow menu growth may still be settling.
    top = Math.min(top, maxWindowScroll());
    // Already parked — don't start a second animation / jump.
    if (Math.abs(windowScrollY() - top) < 10) return;
    if (mode === "smooth") scrollWindowSmooth(top);
    else scrollWindowInstant(top);
  }

  function scrollSearchBarIntoView(mode) {
    // Pin the Search field below the sticky header (small top margin).
    var target = document.getElementById("sources-search") || inputEl;
    if (!target) return;
    scrollBelowStickyHeader(target, 12, mode || "smooth");
  }

  function pinSearchBar() {
    // One smooth roll (double rAF + instant scroll felt jumpy).
    requestAnimationFrame(function () {
      scrollSearchBarIntoView("smooth");
    });
  }

  function scrollChaptersShelfIntoView(mode) {
    // Pin the Chapters selector below the sticky header (small top margin).
    var target =
      document.getElementById("sources-chapters") ||
      document.getElementById("chapters-label");
    if (!target) return;
    scrollBelowStickyHeader(target, 12, mode || "smooth");
  }

  function pinChaptersShelf() {
    requestAnimationFrame(function () {
      scrollChaptersShelfIntoView("smooth");
    });
  }

  function chaptersShelfIsBelowPinLine() {
    // True when the user is still above the Chapters shelf (shelf sits below the
    // sticky clear zone). False when already pinned or scrolled past it.
    var target =
      document.getElementById("sources-chapters") ||
      document.getElementById("chapters-label");
    if (!target) return false;
    return target.getBoundingClientRect().top > stickyClearancePx(target, 12) + 10;
  }

  function pinChaptersShelfIfUserAbove(mode) {
    // Park only when the user is above the shelf and the page can already scroll there.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!chaptersShelfIsBelowPinLine()) return;
        if (!canScrollChaptersToPin()) return;
        scrollChaptersShelfIntoView(mode || "smooth");
      });
    });
  }

  function resultsHeadingIsAboveClearZone() {
    // True when the chapter/result title sits above the area under the sticky header.
    if (!headingEl || headingEl.hidden) return false;
    var header = document.querySelector(".site-header");
    var headerH = header ? header.getBoundingClientRect().height : 0;
    return headingEl.getBoundingClientRect().top < headerH + 12;
  }

  function pinResultsHeadingIfObscured() {
    // Selector browse safety net: only scroll if the new title is off-screen above.
    requestAnimationFrame(function () {
      if (!resultsHeadingIsAboveClearZone()) return;
      scrollBelowStickyHeader(headingEl, 12, "smooth");
    });
  }

  function scrollOptionIntoChapterMenu(opt) {
    // Keep page scroll still; only move the capped menu's scrollTop.
    if (!opt || !chapterMenuEl || !chapterMenuEl.contains(opt)) return;
    var menu = chapterMenuEl;
    var optTop = opt.offsetTop;
    var optBottom = optTop + opt.offsetHeight;
    var viewTop = menu.scrollTop;
    var viewBottom = viewTop + menu.clientHeight;
    if (optTop < viewTop) menu.scrollTop = optTop;
    else if (optBottom > viewBottom) menu.scrollTop = Math.max(0, optBottom - menu.clientHeight);
  }

  function openChapterMenu(opts) {
    opts = opts || {};
    if (!chapterMenuEl || !chapterTriggerEl || chapterTriggerEl.disabled) return;
    if (!isDesktopChapterPicker()) return;
    hideSuggestions();
    // One paint: pin first, pre-size to comfort, then reveal — no short stub → grow → jump.
    if (isDesktopLayout() && chaptersShelfIsBelowPinLine()) {
      scrollChaptersShelfIntoView("instant");
    }
    chapterMenuEl.style.maxHeight = chapterMenuComfortHeight() + "px";
    setChapterMenuOpen(true);
    fitChapterMenuToViewport();
    if (isDesktopLayout() && chaptersShelfIsBelowPinLine()) {
      scrollChaptersShelfIntoView("instant");
      fitChapterMenuToViewport();
    }
    var selected = chapterMenuEl.querySelector('[role="option"][aria-selected="true"]');
    var focusOpt = selected || chapterMenuEl.querySelector('[role="option"]');
    scrollOptionIntoChapterMenu(selected || focusOpt);
    if (opts.focusOption === false) return;
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

  function sameOriginReferrer() {
    if (!document.referrer) return false;
    try {
      return new URL(document.referrer).origin === location.origin;
    } catch (err) {
      return false;
    }
  }

  function landingAllowsSourceHistoryBack() {
    if (!sameOriginReferrer()) return false;
    try {
      // New tab / direct open often reports length 1 even with a referrer.
      if (history.length <= 1) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  function stampCurrentHistoryScroll() {
    if (!window.history || typeof history.replaceState !== "function") return;
    var base =
      history.state && typeof history.state === "object"
        ? Object.assign({}, history.state)
        : catalogHistoryState();
    if (!base.mode) base = catalogHistoryState();
    base.scrollY = window.scrollY || window.pageYOffset || 0;
    history.replaceState(base, "", location.pathname + location.search);
  }

  function restoreHistoryScroll(state) {
    if (!state || typeof state.scrollY !== "number") return false;
    var y = state.scrollY;
    // Chapter views reload notes async. Defer the snap until notes HTML is in —
    // applying early clamps to a short page, then jumps again when notes arrive.
    if (state.mode === "chapter") {
      pendingRestoreScrollY = y;
      return true;
    }
    pendingRestoreScrollY = null;
    scrollWindowInstant(y);
    requestAnimationFrame(function () {
      scrollWindowInstant(y);
    });
    return true;
  }

  function applyPendingRestoreScroll() {
    if (pendingRestoreScrollY == null) return false;
    var y = pendingRestoreScrollY;
    pendingRestoreScrollY = null;
    scrollWindowInstant(y);
    requestAnimationFrame(function () {
      scrollWindowInstant(y);
    });
    return true;
  }

  function syncSourceHistoryBack() {
    if (!historyBackEl) return;
    historyBackEl.hidden = !(view.mode === "source" && sourceHistoryBackEnabled);
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
      // ?chapter=N is a shareable chapter URL (same stable chrome as in-page browse).
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

  var CATALOG_DOC_TITLE =
    "Sources and Notes — Origins of Coronavirus | Jari Kuikanmäki";
  var CATALOG_DOC_DESCRIPTION =
    "Chapter-by-chapter sources and author's notes for Origins of Coronavirus by Jari Kuikanmäki — over 400 primary documents behind the investigation.";

  function ensureMetaByName(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    if (el) return el;
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
    return el;
  }

  function chapterDocumentHeading(chapterNumber) {
    var chName = chapterLabel(chapterNumber);
    var meta = (corpus && corpus.chapters ? corpus.chapters : []).find(function (c) {
      return c.number === chapterNumber;
    });
    if (meta && meta.title) {
      var titleStartsWithName = meta.name && meta.title.indexOf(meta.name) === 0;
      return titleStartsWithName ? meta.title : meta.name + " — " + meta.title;
    }
    return chName;
  }

  function syncDocumentHead() {
    // Human/tab UX only — social crawlers read the static shell (branded catalog OG).
    // Keep Sources out of search indexes.
    ensureMetaByName("robots").setAttribute("content", "noindex, nofollow");

    var title = CATALOG_DOC_TITLE;
    var description = CATALOG_DOC_DESCRIPTION;

    if (view.mode === "source" && view.sourceKey && corpus) {
      var row = (corpus.sources || []).find(function (s) {
        return s.source_key === view.sourceKey;
      });
      if (row && row.title) {
        title = row.title + " — Sources | Origins of Coronavirus";
        if (row.summary) description = String(row.summary);
      }
    } else if (view.mode === "chapter" && view.chapter != null) {
      var chapterHeading = chapterDocumentHeading(view.chapter);
      title = chapterHeading + " — Sources | Origins of Coronavirus";
      description =
        "Sources and notes for " +
        chapterHeading +
        " in Origins of Coronavirus by Jari Kuikanmäki.";
    } else if (
      (view.mode === "keyword" || view.mode === "explore") &&
      view.keyword &&
      view.keyword.label
    ) {
      title =
        view.keyword.label + " — Sources | Origins of Coronavirus";
      description =
        "Sources tagged “" +
        view.keyword.label +
        "” in Origins of Coronavirus by Jari Kuikanmäki.";
    }

    document.title = title;
    ensureMetaByName("description").setAttribute("content", description);
  }

  function syncTopicCloudVisibility() {
    // Show under Search only when there is no active search (idle / chapter browse).
    if (!topicCloudWrapEl) return;
    var show = view.mode === "idle" || view.mode === "chapter";
    topicCloudWrapEl.hidden = !show;
    if (show) {
      topicCloudWrapEl.removeAttribute("aria-hidden");
    } else {
      topicCloudWrapEl.setAttribute("aria-hidden", "true");
    }
  }

  function syncEntryLayout() {
    // Catalog modes (idle / chapter / search): stable shell.
    // Source reading view: stripped — card (+ optional ← Back) only.
    var isSource = view.mode === "source";
    document.body.classList.toggle("sources-view-source", isSource);
    document.body.classList.toggle("sources-view-chapter", view.mode === "chapter");
    // Drop legacy entry classes if a stale tab still has them.
    document.body.classList.remove("sources-entry-source", "sources-entry-chapter");
    var intro = document.querySelector(".sources-intro");
    var pageTitle = document.getElementById("sources-top");
    [intro, pageTitle, document.getElementById("sources-search"), shelvesEl].forEach(function (el) {
      if (!el) return;
      if (isSource) {
        el.setAttribute("aria-hidden", "true");
        el.inert = true;
      } else {
        el.removeAttribute("aria-hidden");
        el.inert = false;
      }
    });
    syncTopicCloudVisibility();
    syncDocumentHead();
  }

  function clearTopicCloudActive() {
    if (!topicCloudEl) return;
    Array.prototype.forEach.call(topicCloudEl.querySelectorAll("button"), function (b) {
      b.classList.remove("is-active");
      b.removeAttribute("aria-current");
    });
  }

  function syncTopicCloudActive() {
    if (!topicCloudEl) return;
    clearTopicCloudActive();
    var id =
      (view.mode === "keyword" || view.mode === "explore") && view.keyword
        ? view.keyword.id
        : "";
    if (!id) return;
    var btn = topicCloudEl.querySelector('[data-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (!btn) return;
    btn.classList.add("is-active");
    btn.setAttribute("aria-current", "true");
  }

  function renderTopicCloud() {
    // Weighted, clickable topic tags under Search (font size ∝ sourceCount).
    if (!topicCloudEl || !searchIndex) return;
    var picks = (searchIndex.keywords || [])
      .filter(function (k) {
        return k && k.type === "topic" && (k.sourceCount || 0) >= 5;
      })
      .sort(function (a, b) {
        return (b.sourceCount || 0) - (a.sourceCount || 0);
      })
      .slice(0, 18);
    topicCloudEl.innerHTML = "";
    if (!picks.length) {
      topicCloudEl.innerHTML = '<span class="status">No topics yet.</span>';
      return;
    }
    var max = picks[0].sourceCount || 1;
    var min = picks[picks.length - 1].sourceCount || 1;
    var span = Math.max(1, max - min);
    picks.forEach(function (k) {
      var w = (k.sourceCount - min) / span;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-topic-cloud-tag";
      btn.setAttribute("data-id", k.id);
      btn.style.setProperty("--w", String(Math.round(w * 1000) / 1000));
      btn.setAttribute(
        "aria-label",
        k.label + ", " + sourceCountLabel(k.sourceCount)
      );
      btn.title = sourceCountLabel(k.sourceCount);
      btn.textContent = k.label;
      btn.addEventListener("click", function () {
        openKeyword(k, "explore");
      });
      topicCloudEl.appendChild(btn);
    });
    syncTopicCloudActive();
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
    clearTopicCloudActive();
    headingEl.hidden = true;
    headingEl.classList.remove("sources-heading--breadcrumb");
    headingEl.textContent = "";
    outEl.innerHTML = "";
    pagerEl.hidden = true;
    pagerEl.innerHTML = "";
    notesEl.hidden = true;
    notesEl.innerHTML = "";
    backEl.hidden = true;
    syncSourceHistoryBack();
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
    clearTopicCloudActive();
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    if (opts.scroll === false) return;
    // Internal Chapter links / ?chapter=: always pin Chapters at the top.
    if (view.chapterEntry) {
      pinChaptersShelf();
      return;
    }
    // Desktop selector: pin only when the user is still above the shelf.
    // (Menu is an overlay — closed before render — so page length is stable here.)
    if (isDesktopLayout()) {
      pinChaptersShelfIfUserAbove();
      return;
    }
    pinResultsHeadingIfObscured();
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
    syncTopicCloudActive();
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    // Keyword links / suggestions: pin the Search bar at the top.
    if (opts.scroll !== false) {
      pinSearchBar();
    }
  }

  function openSource(hit, opts) {
    opts = opts || {};
    var willPush =
      opts.history !== false && !opts.replace && !applyingHistory;
    if (willPush) {
      // Remember scroll on the current entry so ← Back can restore it.
      stampCurrentHistoryScroll();
      sourceHistoryBackEnabled = true;
    }
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
    dismissMobileKeyboard();
    syncEntryLayout();
    if (opts.history !== false) syncCatalogUrl({ replace: !!opts.replace });
    renderResults();
    // Stripped reading view: land at page top so the card is in view (not catalog pin-scroll).
    if (opts.scroll !== false) {
      scrollWindowInstant(0);
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
      ? "Search names, topics, titles…"
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
    placeholder.textContent = "Choose a chapter…";
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
      clearOpt.textContent = "Choose a chapter…";
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
    if (onCatalogClick(e)) return;
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

  function openSourceFromPageLink(link) {
    if (!link) return false;
    var key = link.getAttribute("data-source-key");
    if (!key) return false;
    hideSourcePreview();
    openSource({ id: key, label: (link.textContent || "").trim() || key });
    return true;
  }

  outEl.addEventListener("click", function (e) {
    if (e.target.closest(".catalog-empty-clear")) {
      e.preventDefault();
      clearKeywordFilter();
      return;
    }
    if (onCatalogClick(e)) return;
    var pageLink = e.target.closest("a.source-page-link[data-source-key]");
    if (pageLink && outEl.contains(pageLink)) {
      e.preventDefault();
      openSourceFromPageLink(pageLink);
      return;
    }
    var keywordLink = e.target.closest("a.catalog-keyword-link[data-keyword-id]");
    if (keywordLink && outEl.contains(keywordLink)) {
      e.preventDefault();
      var kid = keywordLink.getAttribute("data-keyword-id");
      var khit = kid && keywordById[kid];
      if (khit) openKeyword(khit, "keyword");
      return;
    }
    var chapterLink = e.target.closest("[data-open-chapter]");
    if (chapterLink && outEl.contains(chapterLink)) {
      e.preventDefault();
      var chapterNum = Number(chapterLink.getAttribute("data-open-chapter"));
      if (!Number.isNaN(chapterNum)) openChapter(chapterNum, { entry: true });
    }
  });

  notesEl.addEventListener("click", function (e) {
    if (onCatalogClick(e)) return;
    var pageLink = e.target.closest("a.notes-source-ref[data-source-key]");
    if (pageLink && notesEl.contains(pageLink)) {
      e.preventDefault();
      openSourceFromPageLink(pageLink);
    }
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
    // Title → Source page (not "Open original").
    var bibLink = e.target.closest(".sources-list .source-ref a.source-page-link");
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
    var previewPageLink = e.target.closest(
      "#source-hover-preview a.source-hover-preview-link[data-source-key], #source-hover-preview a.source-page-link[data-source-key]"
    );
    if (previewPageLink) {
      e.preventDefault();
      openSourceFromPageLink(previewPageLink);
      return;
    }
    if (
      sourcePreviewEl &&
      !sourcePreviewEl.hidden &&
      !e.target.closest("#source-hover-preview") &&
      !e.target.closest(".sources-list .source-ref a.source-page-link") &&
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
      keywordById = Object.create(null);
      (searchIndex.keywords || []).forEach(function (k) {
        if (k && k.id) keywordById[k.id] = k;
      });

      // Second index: titles plus author/publication/summary so org names and
      // other entities mentioned in card copy are findable even before/without
      // a keyword authority hit.
      titleSearch = new MiniSearch({
        idField: "source_key",
        fields: ["title", "author", "publication", "summary"],
        storeFields: [
          "title",
          "author",
          "publication",
          "summary",
          "chapter",
          "source_key",
          "section",
          "content_kind_label",
        ],
        searchOptions: {
          boost: { title: 6, author: 2, publication: 2, summary: 1 },
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
      renderTopicCloud();
      renderChapterList(chapterMeta);
      syncChapterPickerA11y();
      // Read hash before replaceState (catalog URLs omit the fragment).
      var hashFocus = catalogFocusFromHash();
      var landingState = parseLocationState();
      // Cold-loaded ?source= from another page on this site → offer ← Back.
      sourceHistoryBackEnabled =
        landingState.mode === "source" && landingAllowsSourceHistoryBack();
      showIdle({ history: false });
      applyCatalogState(landingState, { scroll: true });
      if (window.history && typeof window.history.replaceState === "function") {
        history.replaceState(catalogHistoryState(), "", catalogUrlFromState(catalogHistoryState()));
      }
      syncSourceHistoryBack();
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
      syncSourceHistoryBack();
      return;
    }
    // Restore view first, then snap scroll (instant) so Back isn't a smooth pan.
    var hasStampedScroll = e.state && typeof e.state.scrollY === "number";
    applyCatalogState(e.state, { scroll: !hasStampedScroll });
    if (hasStampedScroll) restoreHistoryScroll(e.state);
    syncSourceHistoryBack();
  });

  if (historyBackEl) {
    historyBackEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".sources-history-back");
      if (!btn || !historyBackEl.contains(btn)) return;
      e.preventDefault();
      if (!sourceHistoryBackEnabled) return;
      if (window.history && typeof history.back === "function") {
        history.back();
      }
    });
  }

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

  window.addEventListener("resize", function () {
    if (chapterMenuEl && !chapterMenuEl.hidden) fitChapterMenuToViewport();
  });
})();
