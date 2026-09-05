function tokens(pattern) {
  return [...pattern.toLocaleLowerCase("ja")];
}

function consumes(token) {
  return token !== undefined;
}

function compatible(left, right) {
  if (!consumes(left) || !consumes(right)) return false;
  if (left === "*" || left === "?" || right === "*" || right === "?") return true;
  return left === right;
}

function sampleCharacter(left, right) {
  if (left !== "*" && left !== "?") return left;
  if (right !== "*" && right !== "?") return right;
  return "x";
}

export function overlappingPatternExample(leftPattern, rightPattern) {
  const left = tokens(leftPattern);
  const right = tokens(rightPattern);
  const queue = [{ leftIndex: 0, rightIndex: 0, sample: "" }];
  const visited = new Set();
  while (queue.length) {
    const state = queue.shift();
    const key = `${state.leftIndex}:${state.rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (state.leftIndex === left.length && state.rightIndex === right.length) return state.sample || "任意のフォルダ名";

    const leftToken = left[state.leftIndex];
    const rightToken = right[state.rightIndex];
    if (leftToken === "*") queue.push({ ...state, leftIndex: state.leftIndex + 1 });
    if (rightToken === "*") queue.push({ ...state, rightIndex: state.rightIndex + 1 });
    if (state.leftIndex >= left.length || state.rightIndex >= right.length || !compatible(leftToken, rightToken)) continue;
    const nextLeft = leftToken === "*" ? state.leftIndex : state.leftIndex + 1;
    const nextRight = rightToken === "*" ? state.rightIndex : state.rightIndex + 1;
    if (nextLeft === state.leftIndex && nextRight === state.rightIndex) continue;
    queue.push({ leftIndex: nextLeft, rightIndex: nextRight, sample: state.sample + sampleCharacter(leftToken, rightToken) });
  }
  return null;
}

function specificity(pattern) {
  const wildcardCount = [...pattern].filter((character) => character === "*" || character === "?").length;
  return {
    exact: wildcardCount === 0 ? 1 : 0,
    literalCount: pattern.length - wildcardCount,
    wildcardCount,
    length: pattern.length,
  };
}

function ruleKey(category, pattern) {
  return `${category}\u0000${pattern.toLocaleLowerCase("ja")}`;
}

function compareBySpecificity(left, right) {
  const a = specificity(left.pattern);
  const b = specificity(right.pattern);
  return b.exact - a.exact
    || b.literalCount - a.literalCount
    || a.wildcardCount - b.wildcardCount
    || b.length - a.length
    || left.declarationIndex - right.declarationIndex;
}

export function orderFolderRules(folderCategories = {}, configuredOrder = []) {
  const rules = [];
  let declarationIndex = 0;
  for (const [category, patterns] of Object.entries(folderCategories)) {
    for (const pattern of patterns) rules.push({ category, pattern, declarationIndex: declarationIndex++ });
  }
  const ruleByKey = new Map(rules.map((rule) => [ruleKey(rule.category, rule.pattern), rule]));
  const explicitlyOrdered = [];
  const explicitlyOrderedKeys = new Set();
  if (Array.isArray(configuredOrder)) {
    for (const rule of configuredOrder) {
      if (rule && typeof rule.category === "string" && typeof rule.pattern === "string") {
        const key = ruleKey(rule.category, rule.pattern);
        if (ruleByKey.has(key) && !explicitlyOrderedKeys.has(key)) {
          explicitlyOrdered.push(ruleByKey.get(key));
          explicitlyOrderedKeys.add(key);
        }
      }
    }
  }
  const defaultOrder = [...rules].sort(compareBySpecificity);
  if (!explicitlyOrdered.length) return defaultOrder.map(({ category, pattern }) => ({ category, pattern }));

  // Keep the user's relative ordering, then place newly added rules at their
  // natural specificity position without erasing that manual decision.
  for (const rule of defaultOrder) {
    const key = ruleKey(rule.category, rule.pattern);
    if (explicitlyOrderedKeys.has(key)) continue;
    const insertionIndex = explicitlyOrdered.findIndex((existing) => compareBySpecificity(rule, existing) < 0);
    if (insertionIndex === -1) explicitlyOrdered.push(rule);
    else explicitlyOrdered.splice(insertionIndex, 0, rule);
  }
  return explicitlyOrdered.map(({ category, pattern }) => ({ category, pattern }));
}

export function findFolderRuleConflicts(orderedRules) {
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < orderedRules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedRules.length; rightIndex += 1) {
      const left = orderedRules[leftIndex];
      const right = orderedRules[rightIndex];
      if (left.category === right.category) continue;
      const example = overlappingPatternExample(left.pattern, right.pattern);
      if (example === null) continue;
      conflicts.push({
        id: `${encodeURIComponent(left.category)}:${encodeURIComponent(left.pattern)}|${encodeURIComponent(right.category)}:${encodeURIComponent(right.pattern)}`,
        reason: `「${example}」のようなフォルダ名が両方に一致します`,
        example,
        rules: [
          { ...left, priority: leftIndex + 1, preferred: true },
          { ...right, priority: rightIndex + 1, preferred: false },
        ],
      });
    }
  }
  return conflicts;
}

export function prioritizeFolderRule(orderedRules, preferredRule, otherRule) {
  const preferredKey = ruleKey(preferredRule.category, preferredRule.pattern);
  const otherKey = ruleKey(otherRule.category, otherRule.pattern);
  const result = orderedRules.filter((rule) => ruleKey(rule.category, rule.pattern) !== preferredKey);
  const preferred = orderedRules.find((rule) => ruleKey(rule.category, rule.pattern) === preferredKey);
  if (!preferred || !result.some((rule) => ruleKey(rule.category, rule.pattern) === otherKey)) throw new Error("The selected folder rules no longer exist.");
  const otherIndex = result.findIndex((rule) => ruleKey(rule.category, rule.pattern) === otherKey);
  result.splice(otherIndex, 0, preferred);
  return result;
}
