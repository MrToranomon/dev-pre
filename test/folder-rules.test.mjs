import assert from "node:assert/strict";
import test from "node:test";

import {
  findFolderRuleConflicts,
  orderFolderRules,
  overlappingPatternExample,
  prioritizeFolderRule,
} from "../src/folder-rules.mjs";

test("detects overlapping folder patterns and produces a matching example", () => {
  const example = overlappingPatternExample("Office-*", "*Tool*");
  assert.notEqual(example, null);
  assert.match(example, /^Office-/i);
  assert.match(example, /Tool/i);
  assert.equal(overlappingPatternExample("Photos-*", "Docs-*"), null);
});

test("defaults to exact and more specific folder-name patterns", () => {
  const ordered = orderFolderRules({
    Broad: ["*"],
    Medium: ["Office-*"],
    Exact: ["Office-Tool"],
  });
  assert.deepEqual(ordered.map((rule) => rule.category), ["Exact", "Medium", "Broad"]);
  const conflicts = findFolderRuleConflicts(ordered);
  assert.equal(conflicts.length, 3);
  assert.equal(conflicts[0].rules[0].category, "Exact");
  assert.equal(conflicts[0].rules[0].preferred, true);
});

test("manual order wins and later rules are inserted by specificity", () => {
  const manuallyOrdered = orderFolderRules({
    Specific: ["Office-*"],
    Broad: ["*Tool*"],
  }, [
    { category: "Broad", pattern: "*Tool*" },
    { category: "Specific", pattern: "Office-*" },
  ]);
  assert.deepEqual(manuallyOrdered.map((rule) => rule.category), ["Broad", "Specific"]);

  const withNewExactRule = orderFolderRules({
    Specific: ["Office-*"],
    Broad: ["*Tool*"],
    Exact: ["Office-Tool"],
  }, manuallyOrdered);
  assert.deepEqual(withNewExactRule.map((rule) => rule.category), ["Exact", "Broad", "Specific"]);

  const reprioritized = prioritizeFolderRule(withNewExactRule, withNewExactRule[2], withNewExactRule[1]);
  assert.deepEqual(reprioritized.map((rule) => rule.category), ["Exact", "Specific", "Broad"]);
});
