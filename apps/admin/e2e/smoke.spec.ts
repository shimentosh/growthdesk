import { expect, test } from "@playwright/test";

test("the login page renders the staff sign-in form", async ({ page }) => {
  const res = await page.goto("/login");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Sign in to the console" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // Staff accounts are never self-registered here.
  await expect(page.getByRole("link", { name: /create an account/i })).toHaveCount(0);
});

test("a signed-out visit to /users is sent to /login?next=/users", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/users");
  await expect(page).toHaveURL(/\/login\?next=%2Fusers$/);
  await expect(page.getByRole("heading", { name: "Sign in to the console" })).toBeVisible();
});

test("the /users redirect happens before any page renders", async ({ request }) => {
  const res = await request.get("/users", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toContain("/login?next=%2Fusers");
});
