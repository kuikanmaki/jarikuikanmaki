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

test.describe("Sources catalog smoke", () => {
  test("idle catalog chrome is ready", async ({ page }, testInfo) => {
    await waitForCatalog(page);

    await expect(page.locator(".sources-intro")).toBeVisible();
    await expect(page.locator("#sources-search")).toBeVisible();
    await expect(page.locator("#catalog-shelves")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-source/);
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-chapter/);

    if (isMobile(testInfo.project.name)) {
      await expect(page.locator("#authority-search-input")).toHaveAttribute(
        "placeholder",
        "Search…"
      );
      await expect(page.locator("#chapter-select")).toBeVisible();
      await expect(page.locator(".catalog-chapter-custom")).toBeHidden();
      await expect(page.locator(".catalog-shelf-examples")).toBeHidden();
    } else {
      await expect(page.locator("#chapter-custom-trigger")).toBeEnabled();
      await expect(page.locator("#chapter-select")).toBeHidden();
      await expect(page.locator(".catalog-shelf-examples")).toBeVisible();
    }
  });

  test("Chapters selector browses in-page without ?chapter= and without entry chrome", async ({
    page,
  }, testInfo) => {
    await waitForCatalog(page);

    if (isMobile(testInfo.project.name)) {
      await page.locator("#chapter-select").selectOption("5");
    } else {
      await page.locator("#chapter-custom-trigger").click();
      await expect(page.locator("#chapter-custom-list")).toBeVisible();
      // Opening the picker pins "Chapters" near the top of the viewport.
      await expect
        .poll(async () =>
          page.locator("#chapters-label").evaluate((el) => el.getBoundingClientRect().top)
        )
        .toBeLessThan(100);
      // In-flow menu sits below the trigger (not flipped above).
      const triggerBox = await page.locator("#chapter-custom-trigger").boundingBox();
      const menuBox = await page.locator("#chapter-custom-list").boundingBox();
      expect(triggerBox).toBeTruthy();
      expect(menuBox).toBeTruthy();
      expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 2);
      await page.locator('#chapter-custom-list [data-value="5"]').click();
      // Selecting a chapter re-pins Chapters at the top.
      await expect
        .poll(async () =>
          page.locator("#chapters-label").evaluate((el) => el.getBoundingClientRect().top)
        )
        .toBeLessThan(100);
    }

    await expect(page.locator("#sources-heading")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Pangolin/i);
    await expect(page.locator("#sources-output .source-item").first()).toBeVisible();
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });

    // In-page browse: chrome stays; URL stays clean (no ?chapter=).
    await expect(page.locator(".sources-intro")).toBeVisible();
    await expect(page.locator("#catalog-shelves")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-chapter/);
    await expect(page).toHaveURL(/\/origins\/sources\/?$/);
    expect(new URL(page.url()).search).toBe("");

    // After scrolling away, picking another chapter should pin Chapters again.
    if (!isMobile(testInfo.project.name)) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.locator("#chapter-custom-trigger").click();
      await expect(page.locator("#chapter-custom-list")).toBeVisible();
      await page.locator('#chapter-custom-list [data-value="7"]').click();
      await expect(page.locator("#sources-heading")).toContainText(/Everything Is Under Control/i);
      await expect
        .poll(async () =>
          page.locator("#chapters-label").evaluate((el) => el.getBoundingClientRect().top)
        )
        .toBeLessThan(100);
    }
  });

  test("Back to Top keeps in-page chapter selection", async ({ page }, testInfo) => {
    await waitForCatalog(page);

    if (isMobile(testInfo.project.name)) {
      await page.locator("#chapter-select").selectOption("12");
    } else {
      await expect(page.locator("#chapter-custom-trigger")).toBeEnabled();
      await page.locator("#sources-chapters").scrollIntoViewIfNeeded();
      await page.locator("#chapter-custom-trigger").click();
      await expect(page.locator("#chapter-custom-list")).toBeVisible();
      await page.locator('#chapter-custom-list [data-value="12"]').click();
    }

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

    if (isMobile(testInfo.project.name)) {
      await expect(page.locator("#chapter-select")).toHaveValue("12");
    } else {
      await expect(page.locator("#chapter-custom-trigger-label")).toContainText(/12\./);
    }
  });

  test("?chapter=N loads stripped chapter entry; exit links restore idle", async ({
    page,
  }, testInfo) => {
    await page.goto(`${SOURCES}?chapter=12`);
    await expect(page.locator("#authority-search-input")).toBeEnabled({ timeout: 15_000 });

    await expect(page.locator("body")).toHaveClass(/sources-entry-chapter/);
    await expect(page.locator(".sources-intro")).toBeHidden();
    await expect(page.locator("#sources-search")).toBeHidden();
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12/i);
    await expect(page.locator("#sources-output .source-item").first()).toBeVisible();
    await expect(page.locator("#sources-output [data-source-exit]")).toHaveCount(2);
    await expect(page.locator("#back-to-top")).toBeVisible();
    // Exit nav is repeated after notes for long chapter pages.
    await expect(page.locator("#catalog-notes")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#catalog-notes [data-source-exit]")).toHaveCount(2);

    // Browse by chapter: focus only (closed control), idle chrome back near page top.
    // Prefer the after-notes copy (covers the long-page exit path).
    await page.locator("#catalog-notes [data-source-exit=\"chapters\"]").click({ force: true });
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-chapter/);
    await expect(page.locator("#catalog-shelves")).toBeVisible();
    await expect(page).toHaveURL(/\/origins\/sources\/?$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(40);

    if (isMobile(testInfo.project.name)) {
      await expect(page.locator("#chapter-select")).toBeFocused();
      await expect(page.locator(".catalog-chapter-custom")).toBeHidden();
    } else {
      await expect(page.locator("#chapter-custom-trigger")).toBeFocused();
      await expect(page.locator("#chapter-custom-list")).toBeHidden();
    }

    // Return to chapter entry, then Search all sources.
    await page.goto(`${SOURCES}?chapter=12`);
    await expect(page.locator("body")).toHaveClass(/sources-entry-chapter/);
    await page.locator("#catalog-notes [data-source-exit=\"search\"]").click({ force: true });
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-chapter/);
    await expect(page.locator("#sources-search")).toBeVisible();
    await expect(page.locator("#authority-search-input")).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(40);
  });

  test("?source= loads stripped source entry; chapter link and history back work", async ({
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

    await expect(page.locator("body")).toHaveClass(/sources-entry-source/);
    await expect(page.locator("#sources-top")).toBeHidden();
    await expect(page.locator(".sources-intro")).toBeHidden();
    await expect(page.locator("#catalog-shelves")).toBeHidden();
    await expect(page.locator("#sources-output .catalog-card")).toHaveCount(1);
    // Chapter lives on the card (same chrome as search), not in the breadcrumb.
    await expect(page.locator("#sources-heading [data-open-chapter]")).toHaveCount(0);
    await expect(page.locator("#sources-output [data-open-chapter]")).toBeVisible();
    await expect(page.locator("#back-to-top")).toBeHidden();
    // Direct deep link has no same-site history → no ← Back.
    await expect(page.locator("#sources-history-back")).toBeHidden();

    await page.locator("#sources-output [data-open-chapter]").click();
    await expect(page.locator("body")).toHaveClass(/sources-entry-chapter/);
    await expect(page).toHaveURL(new RegExp(`[?&]chapter=${sample.chapter}\\b`));

    await page.goBack();
    await expect(page.locator("body")).toHaveClass(/sources-entry-source/);
    await expect(page).toHaveURL(new RegExp(`[?&]source=`));
  });

  test("in-catalog source open shows ← Back and restores prior view", async ({
    page,
  }, testInfo) => {
    await waitForCatalog(page);

    if (isMobile(testInfo.project.name)) {
      await page.locator("#chapter-select").selectOption("12");
    } else {
      await page.locator("#chapter-custom-trigger").click();
      await page.locator('#chapter-custom-list [data-value="12"]').click();
    }
    await expect(page.locator("#sources-output .source-page-link").first()).toBeVisible({
      timeout: 10_000,
    });
    await page.locator("#sources-output .source-page-link").first().click();

    await expect(page.locator("body")).toHaveClass(/sources-entry-source/);
    await expect(page.locator("#sources-history-back")).toBeVisible();
    await expect(page.locator("#sources-output .catalog-card")).toHaveCount(1);

    await page.locator("#sources-history-back .sources-history-back").click();
    await expect(page.locator("body")).not.toHaveClass(/sources-entry-source/);
    await expect(page.locator("#sources-search")).toBeVisible();
    await expect(page.locator("#sources-heading")).toContainText(/Chapter 12|What Did They Study/i);
    await expect(page.locator("#sources-history-back")).toBeHidden();
  });

  test("closed Chapters menu stays out of the accessibility tree (desktop)", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), "Mobile uses the native select");
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
    await expect(page.locator("body")).toHaveClass(/sources-entry-source/);
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
  });
});
