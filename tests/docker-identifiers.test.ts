import assert from "node:assert/strict";
import { test } from "node:test";
import { containerNameForService, safeDockerIdentifier, safeSlug } from "../src/server/docker-identifiers.js";

test("clients and managed deployments share the existing canonical container naming", () => {
  for (const [id, name] of [["Z5YnAetfsG", "deploy-z5ynaetfsg"], ["_A_-B__C..D_", "deploy-a-b__c-d"], ["Test.ID", "deploy-test.id"], ["___", "deploy-service"]]) assert.equal(containerNameForService(id), name);
  assert.equal(safeDockerIdentifier("A__B", "fallback"), "a__b");
  assert.equal(safeSlug("A".repeat(100)).length, 48);
});
