// @ts-check
const { test, expect } = require("@playwright/test");

const SOURCES = "/origins/sources/";

async function waitForCatalog(page) {
  await page.goto(SOURCES);
  await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });
}

function isMobile(projectName) {
  return projectName === "mobile";
}

async function pickChapter(page, value) {
  await page.locator("#sources-chapters").scrollIntoViewIfNeeded();
  await expect(page.locator("#chapter-custom-trigger")).toBeEnabled();
  await page.locator("#chapter-custom-trigger").click();
  await expect(page.locator("#chapter-custom-list")).toBeVisible();
  await page.locator(`#chapter-custom-list [data-value="${value}"]`).click();
}

async function expectStableChrome(page) {
  await expect(page.locator("#sources-top")).toBeVisible();
  await expect(page.locator(".sources-intro")).toBeVisible();
  await expect(page.locator("#sources-search")).toBeVisible();
  await expect(page.locator("#catalog-shelves")).toBeVisible();
  await expect(page.locator("#sources-chapters")).toBeVisible();
}

test.describe("Sources catalog smoke", () => {
  test("idle catalog chrome is ready", async ({ page }, testInfo) => {
    await waitForCatalog(page);

    await expectStableChrome(page);
    await expect(page.locator("body")).not.toHaveClass(/sources-view-source/);
    await expect(page.locator("body")).not.toHaveClass(/sources-view-chapter/);

    if (isMobile(testInfo.project.name)) {
      await expect(page.locator("#authority-search-input")).toHaveAttribute(
        "placeholder",
        "Search…"
      );
    }
    // Custom listbox at all widths (native <select> is visually hidden / synced only).
    await expect(page.locator("#chapter-custom-trigger")).toBeEnabled();
    await expect(page.locator(".catalog-chapter-custom")).toBeVisible();
    await expect(page.locator("#chapter-select")).toHaveAttribute("aria-hidden", "true");
  });

  test("Chapters selector browses in-page without ?chapter=", async ({
    page,
  }, testInfo) => {
    await waitForCatalog(page);

    await page.locator("#sources-chapters").scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY || window.pageYOffset || 0);
    await page.locator("#chapter-custom-trigger").click();
    await expect(page.locator("#chapter-custom-list")).toBeVisible();
    // Idle/short page: open in place — no invented page length / white-space pad.
    await expect
      .poll(async () => page.evaluate(() => window.scrollY || window.pageYOffset || 0))
      .toBe(scrollBefore);
    const noFakePad = await page.evaluate(() => {
      const main = document.querySelector("main");
      return !(
        main &&
        (main.getAttribute("data-chapters-pin-pad") ||
          main.style.marginBottom ||
          document.getElementById("chapters-pin-spacer"))
      );
    });
    expect(noFakePad).toBe(true);
    // Overlay menu sits below the trigger (not flipped above) and scrolls internally.
    const triggerBox = await page.locator("#chapter-custom-trigger").boundingBox();
    const menuBox = await page.locator("#chapter-custom-list").boundingBox();
    expect(triggerBox).toBeTruthy();
    expect(menuBox).toBeTruthy();
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 2);
    await expect
      .poll(async () =>
        page.locator("#chapter-custom-list").evaluate((el) => getComputedStyle(el).overflowY)
      )
      .toMatch(/auto|scroll/);
    // Menu stays in-viewport and is a normal ~10-row dropdown (not full-viewport).
    const menuFits = await page.locator("#chapter-custom-list").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom <= window.innerHeight + 1;
    });
    expect(menuFits).toBe(true);
    const menuSized = await page.evaluate(() => {
      const trigger = document.getElementById("chapter-custom-trigger");
      const menu = document.getElementById("chapter-custom-list");
      const opt = menu.querySelector('[role="option"]');
      const rowH = opt ? opt.getBoundingClientRect().height : 44;
      const room = window.innerHeight - trigger.getBoundingClientRect().bottom - 12;
      const h = menu.getBoundingClientRect().height;
      const comfort = rowH * 10 + 12;
      return h <= Math.min(comfort, Math.max(room, 0)) + 12 && h >= rowH * 3 - 4;
    });
    expect(menuSized).toBe(true);
    await page.locator('#chapter-custom-list [data-value="5"]').click();

    await expect(page.locator("#sources-heading")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Pangolin/i);
    await expect(page.locator("#sources-output .source-item").first()).toBeVisible();
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });

    // Stable chrome; URL stays clean (no ?chapter=).
    await expectStableChrome(page);
    await expect(page.locator("body")).toHaveClass(/sources-view-chapter/);
    await expect(page).toHaveURL(/\/origins\/sources\/?$/);
    expect(new URL(page.url()).search).toBe("");

    // Desktop: with chapter content (page long enough), opening from above pins;
    // already-pinned stays put.
    if (!isMobile(testInfo.project.name)) {
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
      await page.locator("#chapter-custom-trigger").click();
      await expect(page.locator("#chapter-custom-list")).toBeVisible();
      await expect
        .poll(async () =>
          page.locator("#sources-chapters").evaluate((el) => {
            const sm = parseFloat(getComputedStyle(el).scrollMarginTop);
            if (!Number.isNaN(sm) && sm > 0) {
              return el.getBoundingClientRect().top - sm;
            }
            const header = document.querySelector(".site-header");
            const headerH = header ? header.getBoundingClientRect().height : 0;
            return el.getBoundingClientRect().top - headerH - 12;
          })
        )
        .toBeLessThan(24);
      const pinnedScroll = await page.evaluate(() => window.scrollY || window.pageYOffset || 0);
      await page.locator('#chapter-custom-list [data-value="7"]').click();
      await expect(page.locator("#sources-heading")).toContainText(/Everything Is Under Control/i);
      await expectStableChrome(page);
      await expect
        .poll(async () =>
          page.evaluate((y0) => Math.abs((window.scrollY || window.pageYOffset || 0) - y0), pinnedScroll)
        )
        .toBeLessThan(24);
    }
  });

  test("Chapters menu fits short and narrow viewports", async ({ page }, testInfo) => {
    if (isMobile(testInfo.project.name)) {
      await page.setViewportSize({ width: 390, height: 700 });
    } else {
      await page.setViewportSize({ width: 1280, height: 560 });
    }
    await waitForCatalog(page);

    await page.locator("#chapter-custom-trigger").click();
    await expect(page.locator("#chapter-custom-list")).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const trigger = document.getElementById("chapter-custom-trigger");
          const el = document.getElementById("chapter-custom-list");
          const opt = el.querySelector('[role="option"]');
          const rowH = opt ? opt.getBoundingClientRect().height : 44;
          const room = Math.floor(
            window.innerHeight - trigger.getBoundingClientRect().bottom - 12
          );
          const comfort = rowH * 10 + 12;
          const r = el.getBoundingClientRect();
          const expected = Math.min(comfort, Math.max(room, rowH * 3));
          const sized = Math.abs(el.clientHeight - expected) <= 16;
          const inView = r.bottom <= window.innerHeight + 1;
          const scrolls = el.scrollHeight > el.clientHeight;
          return sized && inView && scrolls;
        })
      )
      .toBe(true);
  });

  test("Back to Top keeps in-page chapter selection", async ({ page }, testInfo) => {
    await waitForCatalog(page);

    await pickChapter(page, "12");

    await expect(page.locator("#sources-heading")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12|Wuhan/i);
    await expect(page.locator("#back-to-top")).toBeVisible();
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });

    await page.locator("#back-to-top a").click();

    // Must not clear the chapter filter (hash navigation used to fire idle via popstate).
    await expect(page.locator("#sources-heading")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12|Wuhan/i);
    await expect(page.locator("#sources-output .source-item").first()).toBeVisible();
    await expect(page.locator("#back-to-top")).toBeVisible();
    await expect(page).toHaveURL(/\/origins\/sources\/?$/);
    expect(new URL(page.url()).hash).toBe("");
    await expectStableChrome(page);

    await expect(page.locator("#chapter-custom-trigger-label")).toContainText(/12\./);
    await expect(page.locator("#chapter-select")).toHaveValue("12");
  });

  test("?chapter=N keeps stable chrome and loads chapter panel", async ({ page }) => {
    await page.goto(`${SOURCES}?chapter=12`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });

    await expect(page.locator("body")).toHaveClass(/sources-view-chapter/);
    await expectStableChrome(page);
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12/i);
    await expect(page.locator("#sources-output .source-item").first()).toBeVisible();
    await expect(page.locator("#back-to-top")).toBeVisible();
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });
    // No stripped-entry exit nav — search/chapters are always in the shell.
    await expect(page.locator("[data-source-exit]")).toHaveCount(0);
  });

  test("?source= strips catalog chrome; chapter link and history back work", async ({
    page,
  }) => {
    await waitForCatalog(page);
    // Resolve a real source_key from the corpus so the test stays data-driven.
    const sample = await page.evaluate(async () => {
      const corpus = await fetch("/origins/sources/data/corpus-index.json").then((r) =>
        r.json()
      );
      const row = (corpus.sources || []).find((s) => s.source_key && s.chapter != null);
      return row && { key: row.source_key, chapter: row.chapter };
    });
    expect(sample && sample.key).toBeTruthy();

    await page.goto(`${SOURCES}?source=${encodeURIComponent(sample.key)}`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });

    await expect(page.locator("body")).toHaveClass(/sources-view-source/);
    await expect(page.locator("#sources-top")).toBeHidden();
    await expect(page.locator(".sources-intro")).toBeHidden();
    await expect(page.locator("#sources-search")).toBeHidden();
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page.locator("#sources-output .catalog-card")).toHaveCount(1);
    // No extra heading; card meta is "Sources: Chapter N".
    await expect(page.locator("#sources-heading")).toBeHidden();
    await expect(page.locator("#sources-output [data-source-exit=\"search\"]")).toBeVisible();
    await expect(page.locator("#sources-output [data-open-chapter]")).toBeVisible();
    await expect(page.locator("#back-to-top")).toBeHidden();
    // Direct deep link has no same-site history → no ← Back.
    await expect(page.locator("#sources-history-back")).toBeHidden();

    await page.locator("#sources-output [data-open-chapter]").click();
    await expect(page.locator("body")).toHaveClass(/sources-view-chapter/);
    await expectStableChrome(page);
    await expect(page).toHaveURL(new RegExp(`[?&]chapter=${sample.chapter}\\b`));

    await page.goBack();
    await expect(page.locator("body")).toHaveClass(/sources-view-source/);
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`[?&]source=`));
  });

  test("in-catalog source open shows ← Back and restores prior view", async ({
    page,
  }, testInfo) => {
    await waitForCatalog(page);

    await pickChapter(page, "12");
    await expect(page.locator("#sources-output .source-page-link").first()).toBeVisible({
      timeout: 10_000,
    });
    await page.locator("#sources-output .source-page-link").first().click();

    await expect(page.locator("body")).toHaveClass(/sources-view-source/);
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page.locator("#sources-history-back")).toBeVisible();
    await expect(page.locator("#sources-output .catalog-card")).toHaveCount(1);

    await page.locator("#sources-history-back .sources-history-back").click();
    await expect(page.locator("body")).toHaveClass(/sources-view-chapter/);
    await expect(page.locator("body")).not.toHaveClass(/sources-view-source/);
    await expectStableChrome(page);
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12|What Did They Study/i);
    await expect(page.locator("#sources-history-back")).toBeHidden();
  });

  test("closed Chapters menu stays out of the accessibility tree", async ({
    page,
  }) => {
    await waitForCatalog(page);
    await expect(page.locator("#chapter-custom-list")).toBeHidden();
    await expect(page.locator("#chapter-custom-list")).toHaveAttribute("aria-hidden", "true");
    const optionCount = await page.locator('#chapter-custom-list [role="option"]').count();
    expect(optionCount).toBeGreaterThan(0);
    // Closed / inert listbox options must not be reachable as roles.
    await expect(page.getByRole("option", { name: /Pangolins/ })).toHaveCount(0);
    await expect(page.locator("#chapter-select")).toHaveAttribute("aria-hidden", "true");
  });

  test("chapter source link hover shows a desktop card preview", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "Hover previews are desktop-only");
    await page.goto(`${SOURCES}?chapter=5`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });
    await expectStableChrome(page);
    const link = page.locator(".sources-list .source-ref a").first();
    await expect(link).toBeVisible();
    await link.hover();
    const preview = page.locator("#source-hover-preview");
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview.locator(".catalog-card--preview")).toBeVisible();
    await expect(preview.locator(".catalog-card-embed")).toHaveCount(0);
    // Whole preview card is the Source-page link; title is plain text.
    await expect(preview.locator("a.source-hover-preview-link")).toHaveAttribute(
      "data-source-key",
      /.+/
    );
    await expect(preview.locator(".catalog-card-title a")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
  });

  test("notes source cites open Source pages and show desktop hover preview", async ({
    page,
  }, testInfo) => {
    await page.goto(`${SOURCES}?chapter=1`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });
    await expectStableChrome(page);

    const cite = page.locator("#catalog-notes a.notes-source-ref").first();
    await expect(cite).toBeVisible();
    await expect(cite).toHaveAttribute("data-source-key", /.+/);
    await expect(cite).toHaveAttribute("href", /\?source=/);
    await expect(cite).not.toHaveAttribute("target", "_blank");

    if (isMobile(testInfo.project.name)) return;

    await cite.hover();
    const preview = page.locator("#source-hover-preview");
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview.locator(".catalog-card--preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
  });

  test("notes Further Reading source hyperlinks open Source pages + hover preview", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "Hover previews are desktop-only");
    await page.goto(`${SOURCES}?chapter=1`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });

    const noteSource = page.locator(
      '#catalog-notes a.notes-source-ref[data-source-key="ch01-n01"]'
    );
    await expect(noteSource).toBeVisible();
    await expect(noteSource).toHaveAttribute("href", /\?source=ch01-n01\b/);

    await noteSource.hover();
    const preview = page.locator("#source-hover-preview");
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview.locator(".catalog-card--preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();

    await noteSource.click();
    await expect(page.locator("body")).toHaveClass(/sources-view-source/);
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page).toHaveURL(/\?source=ch01-n01\b/);
  });

  test("search suggestion opens keyword results (desktop meta)", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "Suggestion density differs on mobile; covered by idle + select paths");

    await waitForCatalog(page);
    const input = page.locator("#authority-search-input");
    await input.fill("Shi");
    const suggestion = page.locator(".sources-search-suggestion").first();
    await expect(suggestion).toBeVisible();
    // Catalog uses mousedown (not click) so blur does not race the selection.
    await suggestion.dispatchEvent("mousedown");
    await expect(page.locator("#sources-heading")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Shi/i);
    await expect(page).toHaveURL(/keyword=/);
    await expect(page.locator("#sources-output .catalog-card").first()).toBeVisible();
    await expectStableChrome(page);
  });
});
