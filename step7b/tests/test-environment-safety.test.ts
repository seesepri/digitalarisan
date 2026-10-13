import test from "node:test";
import assert from "node:assert/strict";
import { assertIsolatedTestDatabaseUrl } from "../scripts/test-database-guard.mjs";

test("financial tests reject production URLs, ordinary databases, and URL host overrides before connecting", () => {
  for (const url of [undefined, "postgresql://user@production.example/app_test", "postgresql://user@127.0.0.1/digital_arisan", "postgresql://user@localhost/postgres", "postgresql://user@localhost/isolated_test?host=production.example", "postgresql://user@localhost/isolated_test?options=-csearch_path=production"]) {
    assert.throws(() => assertIsolatedTestDatabaseUrl(url));
  }
});
test("only explicit loopback *_test URLs are accepted by the test pre-connection gate", () => {
  const url = "postgresql://audit@127.0.0.1:55432/digitalarisan_test";
  assert.equal(assertIsolatedTestDatabaseUrl(url), url);
});
