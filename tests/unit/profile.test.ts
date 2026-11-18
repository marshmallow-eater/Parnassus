import { describe, expect, test } from "bun:test";
import { GENERIC_PROFILE, resolveProfile } from "../../src/shared/profile";

describe("resolveProfile", () => {
  test("a project with no overrides uses the generic goal and soul", () => {
    const resolved = resolveProfile({ goal: null, soul: null }, GENERIC_PROFILE);
    expect(resolved.goal).toBe(GENERIC_PROFILE.goal);
    expect(resolved.soul).toBe(GENERIC_PROFILE.soul);
    expect(resolved.goalInherited).toBe(true);
    expect(resolved.soulInherited).toBe(true);
  });

  test("missing fields also inherit", () => {
    const resolved = resolveProfile({}, GENERIC_PROFILE);
    expect(resolved.goalInherited).toBe(true);
    expect(resolved.soulInherited).toBe(true);
  });

  test("a project override wins for that field only", () => {
    const resolved = resolveProfile({ goal: "Ship the field guide", soul: null }, GENERIC_PROFILE);
    expect(resolved.goal).toBe("Ship the field guide");
    expect(resolved.goalInherited).toBe(false);
    expect(resolved.soul).toBe(GENERIC_PROFILE.soul);
    expect(resolved.soulInherited).toBe(true);
  });

  test("no project at all resolves to the generic profile", () => {
    const resolved = resolveProfile(null, GENERIC_PROFILE);
    expect(resolved.goal).toBe(GENERIC_PROFILE.goal);
    expect(resolved.soulInherited).toBe(true);
  });

  test("updated generic values flow to inheriting projects", () => {
    const updated = { goal: "New generic goal", soul: "New generic soul" };
    const resolved = resolveProfile({ goal: null, soul: null }, updated);
    expect(resolved.goal).toBe("New generic goal");
    expect(resolved.soul).toBe("New generic soul");
  });
});
