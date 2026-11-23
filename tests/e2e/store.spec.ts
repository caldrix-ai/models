import { expect, test, type Page } from "@playwright/test";

// The store of made models on Chromium's own private file system, from workers.

const inWorker = (page: Page, scenario: string, opts: { hold?: boolean } = {}) =>
  page.evaluate(([s, o]) => (window as unknown as { inWorker: (s: string, o: object) => Promise<unknown> }).inWorker(s, o), [
    scenario,
    opts,
  ] as const);

test("a model written in parts is committed, listed, read back and removed", async ({ page }) => {
  await page.goto("/store.html");
  const r = (await inWorker(page, "roundtrip")) as Record<string, unknown>;
  expect(r.error).toBeUndefined();
  expect(r.listed).toEqual(["e2e"]);
  expect(r.size).toBe(150_000);
  expect(r.same).toBe(true);
  expect(r.again).toContain('a model named "e2e" is already kept');
  expect(r.after).toEqual([]);
});

test("a name another worker is writing is refused, not cleared", async ({ page }) => {
  await page.goto("/store.html");
  expect(await inWorker(page, "hold", { hold: true })).toEqual({ begun: true });
  const r = (await inWorker(page, "contend")) as { error?: string };
  expect(r.error).toBe('request: the model "held" is being written elsewhere (another tab or worker)');
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
});

test("a browser that cannot move a file is refused by name", async ({ page }) => {
  await page.goto("/store.html");
  const r = (await inWorker(page, "nomove")) as { error?: string };
  expect(r.error).toContain("backend: ");
  expect(r.error).toContain("FileSystemFileHandle.move");
});
