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
    keyword: null,
    sourceKey: null,
    page: 1,
  };

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

  function renderCard(s) {
    var biblio = [s.author, s.publication, s.date].filter(Boolean).map(escapeHtml).join(" · ");
    var url = s.url || "#";
    var media = cardMedia(s);
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
      '<article class="catalog-card">' +
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
        parts.embed +
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

  function renderResults() {
    var rows = sourcesForView();
    var total = rows.length;

    backEl.hidden = false;
    headingEl.hidden = false;
    syncClearButton();

    if (view.mode === "keyword" || view.mode === "explore" || view.mode === "source") {
      var label =
        view.mode === "source"
          ? (rows[0] && rows[0].title) || "Source"
          : (view.keyword && view.keyword.label) || "Sources";
      headingEl.innerHTML =
        '<span class="sources-heading-label">' + escapeHtml(label) + "</span>" +
        '<span class="sources-heading-count"> · ' + escapeHtml(sourceCountLabel(total)) + "</span>";
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
            '<button type="button" class="catalog-empty-clear">Clear search</button>' +
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
    outEl.innerHTML = renderChapterSourceList(rows);
    return loadNotes(view.chapter);
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
        notesEl.innerHTML = '<hr class="notes-divider">' + html;
        return true;
      })
      .catch(function () {
        notesEl.innerHTML = "";
        notesEl.hidden = true;
        return false;
      });
  }

  function setChapterActive(number) {
    if (!chapterSelectEl) return;
    var value = number == null || number === "" ? "" : String(number);
    if (chapterSelectEl.value !== value) chapterSelectEl.value = value;
  }

  function clearExploreActive() {
    Array.prototype.forEach.call(exploreEl.querySelectorAll("button"), function (b) {
      b.classList.remove("active");
    });
  }

  function showIdle() {
    view.mode = "idle";
    view.chapter = null;
    view.keyword = null;
    view.sourceKey = null;
    view.page = 1;
    inputEl.value = "";
    hideSuggestions();
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
  }

  function openChapter(number) {
    view.mode = "chapter";
    view.chapter = number;
    view.keyword = null;
    view.sourceKey = null;
    view.page = 1;
    inputEl.value = "";
    hideSuggestions();
    setChapterActive(number);
    clearExploreActive();
    if (shelvesEl) shelvesEl.classList.remove("is-filtered");
    renderResults();
    headingEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openKeyword(hit, mode) {
    view.mode = mode || "keyword";
    view.keyword = hit;
    view.sourceKey = null;
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
    renderResults();
    headingEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openSource(hit) {
    view.mode = "source";
    view.sourceKey = hit.id;
    view.keyword = null;
    view.chapter = null;
    view.page = 1;
    inputEl.value = hit.label || "";
    hideSuggestions();
    clearChapterActive();
    clearExploreActive();
    if (shelvesEl) shelvesEl.classList.add("is-filtered");
    renderResults();
    headingEl.scrollIntoView({ behavior: "smooth", block: "start" });
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
      openChapter(view.chapter);
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

  inputEl.addEventListener("input", function () {
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

  outEl.addEventListener("click", function (e) {
    if (e.target.closest(".catalog-empty-clear")) {
      e.preventDefault();
      clearKeywordFilter();
      return;
    }
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

  outEl.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList.contains("catalog-card-image")) return;
    var media = img.closest(".catalog-card-media");
    if (media) media.remove();
  }, true);

  document.addEventListener("click", function (e) {
    if (!e.target.closest("#sources-search")) hideSuggestions();
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
      inputEl.placeholder = "Search people, organizations, topics, titles…";
      renderChapterList(chapterMeta);
      renderExploreShelf();
      showIdle();
      // Desktop only: avoid opening the mobile keyboard on load.
      if (window.matchMedia("(min-width: 640px)").matches) {
        inputEl.focus();
      }
    })
    .catch(function (err) {
      console.error(err);
      inputEl.disabled = true;
      inputEl.placeholder = "Catalog unavailable";
      listEl.innerHTML = '<span class="error">Could not load the sources catalog.</span>';
      outEl.innerHTML = '<p class="error">' + escapeHtml(err.message) + "</p>";
    });
})();
