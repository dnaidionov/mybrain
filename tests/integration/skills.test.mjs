// Structural/existence tests for plugin skills and configuration
// Covers SK-01 through SK-17
// These tests verify file presence, structure, and schema correctness
// without requiring a running server or database.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");

function readJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── SK-01 Plugin manifest ────────────────────────────────────────────────────

describe("SK-01 plugin.json manifest", () => {
  it("SK-01 plugin.json exists and is valid JSON", () => {
    expect(exists(".claude-plugin/plugin.json")).toBe(true);
    expect(() => readJSON(".claude-plugin/plugin.json")).not.toThrow();
  });

  it("SK-02 plugin.json has required fields: name, version, skills", () => {
    const plugin = readJSON(".claude-plugin/plugin.json");
    expect(plugin).toHaveProperty("name");
    expect(plugin).toHaveProperty("version");
    expect(plugin).toHaveProperty("skills");
    expect(Array.isArray(plugin.skills)).toBe(true);
  });

  it("SK-03 plugin.json lists exactly 5 skills", () => {
    const plugin = readJSON(".claude-plugin/plugin.json");
    expect(plugin.skills).toHaveLength(5);
  });

  it("SK-04 all skill paths in plugin.json resolve to existing directories", () => {
    const plugin = readJSON(".claude-plugin/plugin.json");
    for (const skillPath of plugin.skills) {
      // Paths like "./skills/mybrain-setup" are relative to the repo root
      const resolved = path.join(ROOT, skillPath);
      expect(fs.existsSync(resolved), `skill dir not found: ${skillPath}`).toBe(true);
    }
  });
});

// ─── SK-05 Marketplace manifest ──────────────────────────────────────────────

describe("SK-05 marketplace.json manifest", () => {
  it("SK-05 marketplace.json exists and is valid JSON", () => {
    expect(exists(".claude-plugin/marketplace.json")).toBe(true);
    expect(() => readJSON(".claude-plugin/marketplace.json")).not.toThrow();
  });
});

// ─── SK-06 Each skill has a SKILL.md ─────────────────────────────────────────

describe("SK-06 skill files exist", () => {
  const SKILLS = [
    "mybrain-setup",
    "mybrain-overview",
    "autocapture-status",
    "autocapture-on",
    "autocapture-off",
  ];

  for (const skill of SKILLS) {
    it(`SK-06 skills/${skill}/SKILL.md exists`, () => {
      expect(exists(`skills/${skill}/SKILL.md`)).toBe(true);
    });
  }
});

// ─── SK-07 SKILL.md content checks ───────────────────────────────────────────

describe("SK-07 mybrain-setup SKILL.md", () => {
  it("SK-07 mybrain-setup SKILL.md is non-empty and mentions setup", () => {
    const content = fs.readFileSync(path.join(ROOT, "skills/mybrain-setup/SKILL.md"), "utf8");
    expect(content.length).toBeGreaterThan(100);
    // Should reference setup-related keywords
    expect(content.toLowerCase()).toMatch(/setup|install|config/);
  });

  it("SK-08 autocapture-on SKILL.md is non-empty and references enabling autocapture", () => {
    const content = fs.readFileSync(path.join(ROOT, "skills/autocapture-on/SKILL.md"), "utf8");
    expect(content.length).toBeGreaterThan(50);
    expect(content.toLowerCase()).toMatch(/autocapture|capture|enable/);
  });

  it("SK-09 autocapture-off SKILL.md is non-empty and references disabling autocapture", () => {
    const content = fs.readFileSync(path.join(ROOT, "skills/autocapture-off/SKILL.md"), "utf8");
    expect(content.length).toBeGreaterThan(50);
    expect(content.toLowerCase()).toMatch(/autocapture|capture|disable|off/);
  });

  it("SK-10 autocapture-status SKILL.md is non-empty", () => {
    const content = fs.readFileSync(path.join(ROOT, "skills/autocapture-status/SKILL.md"), "utf8");
    expect(content.length).toBeGreaterThan(50);
  });

  it("SK-11 mybrain-overview SKILL.md is non-empty and references tools", () => {
    const content = fs.readFileSync(path.join(ROOT, "skills/mybrain-overview/SKILL.md"), "utf8");
    expect(content.length).toBeGreaterThan(100);
    expect(content.toLowerCase()).toMatch(/tool|capture|search|browse/);
  });
});

// ─── SK-12 Hook scripts exist ─────────────────────────────────────────────────

describe("SK-12 hook scripts", () => {
  it("SK-12 hooks/stop-autocapture.mjs exists", () => {
    expect(exists("hooks/stop-autocapture.mjs")).toBe(true);
  });

  it("SK-13 hooks/stop-process.mjs exists", () => {
    expect(exists("hooks/stop-process.mjs")).toBe(true);
  });

  it("SK-14 hooks/sweep.mjs exists", () => {
    expect(exists("hooks/sweep.mjs")).toBe(true);
  });
});

// ─── SK-15 Server files ───────────────────────────────────────────────────────

describe("SK-15 server files", () => {
  it("SK-15 server.mjs exists at root", () => {
    expect(exists("server.mjs")).toBe(true);
  });

  it("SK-16 templates/server.mjs exists", () => {
    expect(exists("templates/server.mjs")).toBe(true);
  });

  it("SK-17 templates/schema.sql exists", () => {
    expect(exists("templates/schema.sql")).toBe(true);
  });
});

// ─── SK-bonus package.json checks ────────────────────────────────────────────

describe("package.json test scripts", () => {
  it("package.json has test script", () => {
    const pkg = readJSON("package.json");
    expect(pkg.scripts).toHaveProperty("test");
  });

  it("package.json has test:unit script", () => {
    const pkg = readJSON("package.json");
    expect(pkg.scripts).toHaveProperty("test:unit");
  });

  it("package.json has test:integration script", () => {
    const pkg = readJSON("package.json");
    expect(pkg.scripts).toHaveProperty("test:integration");
  });

  it("vitest is listed as a devDependency", () => {
    const pkg = readJSON("package.json");
    expect(pkg.devDependencies || pkg.dependencies).toHaveProperty("vitest");
  });
});
