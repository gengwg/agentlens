import assert from "node:assert/strict";
import { test } from "node:test";
import { safeHttpsHref, sessionHref } from "../src/url.ts";

test("session links encode the complete session id", () => {
  const id = "agent:one/two & three?#";
  assert.equal(sessionHref(id), "?session=agent%3Aone%2Ftwo%20%26%20three%3F%23");
  assert.equal(new URLSearchParams(sessionHref(id).slice(1)).get("session"), id);
});

test("MR badges accept absolute https URLs only", () => {
  assert.equal(
    safeHttpsHref("https://gitlab.example/group/project/-/merge_requests/7"),
    "https://gitlab.example/group/project/-/merge_requests/7",
  );
  assert.equal(safeHttpsHref("HTTPS://GITLAB.EXAMPLE/group/project"), "https://gitlab.example/group/project");

  for (const value of [
    null,
    undefined,
    "",
    "http://gitlab.example/group/project",
    "javascript:alert(1)",
    "data:text/html,bad",
    "//gitlab.example/group/project",
    "not a URL",
    "https://",
  ]) {
    assert.equal(safeHttpsHref(value), null, String(value));
  }
});
